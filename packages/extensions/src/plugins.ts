import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { PluginManifestSchema, nowIso, type PluginGrant, type PluginManifest, type PluginRecord } from "@harness/protocol";
import type { HarnessDatabase } from "@harness/persistence";
import type { ToolDefinition } from "@harness/tools";
import { fetchPluginUrl } from "./plugin-network.js";
export { isPrivateAddress } from "./plugin-network.js";

export class PluginService {
  constructor(private readonly database: HarnessDatabase, private readonly fetchImpl = fetchPluginUrl) {}

  list(): PluginRecord[] { return this.database.listPlugins(); }

  async inspect(sourcePath: string): Promise<PluginManifest> {
    const root = resolve(sourcePath);
    const manifestPath = join(root, "harness-plugin.json");
    const packagePath = join(root, "package.json");
    try {
      const pkg = JSON.parse(await readFile(packagePath, "utf8")) as { scripts?: Record<string, string> };
      for (const name of ["preinstall", "install", "postinstall", "prepare"]) if (pkg.scripts?.[name]) throw new Error(`Plugin lifecycle script is forbidden: ${name}`);
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && error.message.includes("forbidden"))) throw error;
    }
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const contentHash = await hashDirectory(root);
    const fingerprint = await fingerprintDirectory(root);
    return PluginManifestSchema.parse({ ...raw, sourcePath: root, contentHash, fingerprint });
  }

  async install(sourcePath: string): Promise<PluginRecord> {
    const manifest = await this.inspect(sourcePath);
    const previous = this.database.getPlugin(manifest.id);
    const record: PluginRecord = {
      manifest,
      enabled: false,
      installedAt: previous?.installedAt ?? nowIso(),
      updatedAt: nowIso(),
    };
    this.database.savePlugin(record);
    return record;
  }

  async trust(pluginId: string, grant: PluginGrant): Promise<PluginRecord> {
    const current = this.require(pluginId);
    const manifest = await this.inspect(current.manifest.sourcePath);
    const requested = manifest.requestedGrant;
    if (grant.pathGlobs.some((path) => !requested.pathGlobs.includes(path))) throw new Error("Plugin grant exceeds requested file permissions");
    if (grant.networkDomains.some((domain) => !requested.networkDomains.includes(domain))) throw new Error("Plugin grant exceeds requested network permissions");
    if (grant.allowProcesses && !requested.allowProcesses) throw new Error("Plugin grant exceeds requested process permissions");
    if (requested.mode === "untrusted_docker" && grant.mode !== "untrusted_docker") throw new Error("An untrusted plugin cannot be promoted to local Node mode");
    const record: PluginRecord = { ...current, manifest, trustedHash: manifest.contentHash, grant, enabled: false, updatedAt: nowIso() };
    this.database.savePlugin(record);
    return record;
  }

  async enable(pluginId: string): Promise<PluginRecord> {
    const current = this.require(pluginId);
    const manifest = await this.inspect(current.manifest.sourcePath);
    if (!current.grant || current.trustedHash !== manifest.contentHash) throw new Error("Plugin content changed or permissions were not trusted; re-trust is required");
    if (current.grant.mode === "untrusted_docker" && !(await dockerAvailable())) throw new Error("Docker is required to run an untrusted plugin");
    const record = { ...current, manifest, enabled: true, updatedAt: nowIso() };
    this.database.savePlugin(record);
    return record;
  }

  disable(pluginId: string): PluginRecord {
    const current = this.require(pluginId);
    const record = { ...current, enabled: false, updatedAt: nowIso() };
    this.database.savePlugin(record);
    return record;
  }

  tools(plugin: PluginRecord): ToolDefinition[] {
    if (!plugin.enabled || !plugin.grant || plugin.trustedHash !== plugin.manifest.contentHash) return [];
    return plugin.manifest.tools.map((contract) => ({
      contract,
      execute: async (input, context) => ({ output: await this.execute(plugin, contract.name, input, context.workspacePath, context.signal) })
    }));
  }

  private require(pluginId: string): PluginRecord {
    const record = this.database.getPlugin(pluginId);
    if (!record) throw new Error(`Unknown plugin: ${pluginId}`);
    return record;
  }

  private async execute(plugin: PluginRecord, toolName: string, input: Record<string, unknown>, workspacePath: string, signal: AbortSignal): Promise<unknown> {
    const grant = plugin.grant!;
    if (plugin.manifest.fingerprint && (await fingerprintDirectory(plugin.manifest.sourcePath)) !== plugin.manifest.fingerprint) {
      throw new Error("Plugin content changed since it was enabled; re-trust is required");
    }
    const entrypoint = resolve(plugin.manifest.sourcePath, plugin.manifest.entrypoint);
    if (relative(plugin.manifest.sourcePath, entrypoint).startsWith("..")) throw new Error("Plugin entrypoint escapes its directory");
    const args = grant.mode === "trusted_node"
      ? ["--permission", `--allow-fs-read=${plugin.manifest.sourcePath}`, entrypoint]
      : ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--user", "node", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "256m", "--cpus", "0.5", "-i", "-v", `${plugin.manifest.sourcePath}:/plugin:ro`, "node:22-alpine", "node", `/plugin/${plugin.manifest.entrypoint.replace(/\\/g, "/")}`];
    const executable = grant.mode === "trusted_node" ? process.execPath : "docker";
    const cleanEnv = Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"].flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []));
    return runPluginRpc(executable, args, { id: crypto.randomUUID(), method: "tool.execute", params: { toolName, input } }, cleanEnv, signal, (request) => this.broker(request, grant, workspacePath, signal));
  }

  private async broker(request: Record<string, unknown>, grant: PluginGrant, workspacePath: string, signal: AbortSignal): Promise<unknown> {
    if (request.operation === "fs.read" && typeof request.path === "string") {
      const target = isAbsolute(request.path) ? resolve(request.path) : resolve(workspacePath, request.path);
      const roots = grant.pathGlobs.map(path => resolve(workspacePath, path)).filter(root => within(root, target));
      if (!roots.length) throw new Error("Plugin broker denied file access");
      const canonicalTarget = await realpath(target);
      const canonicalRoots = await Promise.all(roots.map(root => realpath(root)));
      if (!canonicalRoots.some(root => within(root, canonicalTarget))) throw new Error("Plugin broker denied file access through a directory link");
      const handle = await open(canonicalTarget, "r");
      try {
        if (!(await handle.stat()).isFile()) throw new Error("Plugin broker denied non-file access");
        const buffer = Buffer.alloc(1_000_000);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return { text: buffer.subarray(0, bytesRead).toString("utf8") };
      } finally { await handle.close(); }
    }
    if (request.operation === "net.fetch" && typeof request.url === "string") {
      const url = new URL(request.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Plugin broker only allows http(s) URLs");
      if (!grant.networkDomains.includes(url.hostname)) throw new Error("Plugin broker denied network domain");
      // Explicit IP literals are allowed only by an exact domain grant. Hostname
      // lookups are checked by the transport at connection time.
      return this.fetchImpl(url, signal);
    }
    throw new Error("Unsupported plugin broker operation");
  }
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git" || entry.name === ".cache") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) { hash.update(relative(root, path).replace(/\\/g, "/")); hash.update(await readFile(path)); }
    }
  }
  await walk(root);
  return hash.digest("hex");
}

/** Cheap stat-only fingerprint (paths, sizes, mtimes) for per-call tamper checks. */
async function fingerprintDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git" || entry.name === ".cache") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const info = await stat(path);
        hash.update(relative(root, path).replace(/\\/g, "/"));
        hash.update(`:${info.size}:${info.mtimeMs}`);
      }
    }
  }
  await walk(root);
  return hash.digest("hex");
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel));
}

async function dockerAvailable(): Promise<boolean> {
  return new Promise((resolveAvailable) => {
    const child = spawn("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore", windowsHide: true });
    child.on("error", () => resolveAvailable(false));
    child.on("close", (code) => resolveAvailable(code === 0));
  });
}

function runPluginRpc(executable: string, args: string[], request: unknown, env: NodeJS.ProcessEnv, signal: AbortSignal, broker: (request: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
    let buffer = "";
    let stderr = "";
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) void handle(line);
    });
    child.on("error", rejectResult);
    child.on("close", (code) => { signal.removeEventListener("abort", abort); if (code && code !== 0) rejectResult(new Error(`Plugin process failed (${code}): ${stderr}`)); });
    child.stdin.write(`${JSON.stringify(request)}\n`);
    async function handle(line: string) {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.type === "broker_request" && message.request && typeof message.request === "object") {
        try { child.stdin.write(`${JSON.stringify({ type: "broker_response", id: message.id, ok: true, result: await broker(message.request as Record<string, unknown>) })}\n`); }
        catch (error) { child.stdin.write(`${JSON.stringify({ type: "broker_response", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`); }
      } else if (message.type === "result") { child.kill(); resolveResult(message.output); }
      else if (message.type === "error") { child.kill(); rejectResult(new Error(String(message.message ?? "Plugin failed"))); }
    }
  });
}

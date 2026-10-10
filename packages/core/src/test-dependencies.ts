import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import type { VerificationItem } from "@harness/protocol";
import { workspaceFingerprint, type WorkspaceSnapshot } from "./workspace-impact.js";

export interface VerificationDependencies {
  paths: string[];
  complete: boolean;
  fingerprint: string;
  reason?: string;
}

type DependencyCheck = VerificationItem & { dependencyPaths?: string[] | undefined };
type Token = { kind: "word" | "string" | "punct" | "template"; value: string };
const sourceExtensions = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".mts", ".cts"];
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
const opaqueBuiltins = /^(?:fs|module|vm|child_process|http|https|http2|net|tls|dns|dgram|worker_threads)(?:\/|$)/;
const testPattern = "**/*.{test,spec}.{js,mjs,cjs,ts,tsx,jsx,mts,cts}";
const configurationFile = (path: string) => /^(?:package\.json|(?:pnpm-lock|yarn|bun)\.(?:yaml|lock|lockb)|package-lock\.json|npm-shrinkwrap\.json|(?:ts|js)config[^/]*\.json|.*config[^/]*\.(?:json|[cm]?[jt]s)|\.(?:npmrc|yarnrc.*|env.*|pnp\..*))$/i.test(basename(path));
const slash = (value: string) => value.replaceAll("\\", "/");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Reuse is possible only when both analyses independently prove the same coverage and environment. */
export function canReuseVerificationDependencies(previous: VerificationDependencies | undefined, current: VerificationDependencies, changedPaths: string[] = []): boolean {
  if (!previous?.complete || !current.complete || previous.fingerprint !== current.fingerprint) return false;
  // New configuration is significant even when it was absent from the old dependency closure.
  return !changedPaths.some(path => current.paths.includes(slash(path)) || configurationFile(slash(path)));
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const char = source[cursor]!;
    if (/\s/.test(char)) { cursor++; continue; }
    if (source.startsWith("//", cursor)) { cursor = source.indexOf("\n", cursor + 2); if (cursor < 0) break; continue; }
    if (source.startsWith("/*", cursor)) { const end = source.indexOf("*/", cursor + 2); if (end < 0) throw new Error("Unterminated source comment"); cursor = end + 2; continue; }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      let value = "";
      let closed = false;
      cursor++;
      while (cursor < source.length) {
        const next = source[cursor++]!;
        if (next === quote) { closed = true; break; }
        if (next === "\\") { value += next + (source[cursor++] ?? ""); }
        else value += next;
      }
      if (!closed) throw new Error("Unterminated source literal");
      tokens.push({ kind: quote === "`" ? "template" : "string", value });
      continue;
    }
    if (/[\w$]/.test(char)) {
      const start = cursor++;
      while (cursor < source.length && /[\w$]/.test(source[cursor]!)) cursor++;
      tokens.push({ kind: "word", value: source.slice(start, cursor) });
    } else { tokens.push({ kind: "punct", value: char }); cursor++; }
  }
  return tokens;
}

function moduleReferences(source: string): { references: string[]; reasons: string[] } {
  const references: string[] = [];
  const reasons: string[] = [];
  const tokens = tokenize(source);
  const add = (token: Token | undefined) => {
    if (!token || token.kind !== "string" || token.value.includes("\\")) reasons.push("Nonliteral or escaped module dependency");
    else references.push(token.value);
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind === "template" && token.value.includes("${")) reasons.push("Template expressions cannot be statically bounded");
    if (token.kind !== "word") continue;
    const next = tokens[index + 1];
    if (["eval", "Function", "createRequire"].includes(token.value) && next?.value === "(") reasons.push("Runtime code loading cannot be statically bounded");
    if (token.value === "module" && next?.value === "[" && tokens[index + 2]?.value === "require") reasons.push("Computed runtime module loading cannot be statically bounded");
    if (token.value === "require") {
      const offset = next?.value === "." && tokens[index + 2]?.value === "resolve" ? 3 : 1;
      if (tokens[index - 1]?.value === ".") reasons.push("Member runtime require cannot be statically bounded");
      if (tokens[index + offset]?.value !== "(") { reasons.push("Aliased runtime require cannot be statically bounded"); continue; }
      if (tokens[index + offset + 2]?.value !== ")") reasons.push("Dynamic require dependency");
      else add(tokens[index + offset + 1]);
    }
    if (token.value !== "import" && token.value !== "export") continue;
    if (token.value === "import" && next?.value === "(") {
      if (tokens[index + 3]?.value !== ")") reasons.push("Dynamic import dependency");
      else add(tokens[index + 2]);
    } else if (token.value === "import" && next?.value === ".") {
      reasons.push("import.meta loading or configuration is opaque");
    } else if (token.value === "import" && next?.kind === "string") add(next);
    else {
      for (let cursor = index + 1; cursor < tokens.length; cursor++) {
        const current = tokens[cursor]!;
        if (current.value === ";" || (cursor > index + 1 && (current.value === "import" || current.value === "export"))) break;
        if (current.value === "from") { add(tokens[cursor + 1]); break; }
        // export declarations without reexports do not scan into later function bodies.
        if (token.value === "export" && ["function", "class", "const", "let", "default"].includes(current.value)) break;
      }
    }
  }
  return { references, reasons };
}

function commandTokens(command: string): string[] | undefined {
  if (/[;&|<>`\r\n]/.test(command)) return undefined;
  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  if (!tokens.length || tokens.some(token => /\$\(|%[^%]+%|\$\{/.test(token))) return undefined;
  return tokens.map(token => token.replace(/^(?:"|')|(?:"|')$/g, ""));
}

/**
 * A conservative static dependency closure for persisted JavaScript/TypeScript tests.
 * Incomplete analysis always falls back to the entire workspace fingerprint; callers must
 * also require complete=true before using a receipt across repository revisions.
 */
export async function analyzeVerificationDependencies(workspacePath: string, items: DependencyCheck[], snapshot: WorkspaceSnapshot, signal = new AbortController().signal): Promise<Record<string, VerificationDependencies>> {
  const workspaceRoot = await realpath(workspacePath);
  const available = new Set(Object.keys(snapshot.files).map(slash));
  const configurations = [...available].filter(configurationFile).sort();
  const environment = { node: process.version, platform: process.platform, arch: process.arch, env: Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)) };
  const contents = new Map<string, string>();
  const result: Record<string, VerificationDependencies> = {};
  for (const item of items) {
    signal.throwIfAborted();
    const paths = new Set<string>(configurations);
    const reasons = new Set<string>();
    const visited = new Set<string>();
    const entryPaths = new Set<string>();
    if (!snapshot.complete || snapshot.truncated || snapshot.skipped > 0) reasons.add("Workspace snapshot is incomplete");
    const toWorkspacePath = (path: string, base = workspaceRoot): string | undefined => {
      const absolute = resolve(base, path);
      const name = slash(relative(workspaceRoot, absolute));
      if (!name || name === ".." || name.startsWith("../") || isAbsolute(name)) { reasons.add("Dependency or working directory escapes the workspace"); return undefined; }
      return name;
    };
    const itemCwd = resolve(workspaceRoot, item.cwd || ".");
    const relativeCwd = slash(relative(workspaceRoot, itemCwd));
    if (relativeCwd === ".." || relativeCwd.startsWith("../") || isAbsolute(relativeCwd)) reasons.add("Working directory escapes the workspace");
    const read = async (path: string): Promise<string | undefined> => {
      signal.throwIfAborted();
      if (!available.has(path)) { reasons.add(`Missing dependency: ${path}`); return undefined; }
      try {
        const absolute = await realpath(resolve(workspaceRoot, path));
        const actual = relative(workspaceRoot, absolute);
        if (actual === ".." || actual.startsWith(`..${sep}`) || isAbsolute(actual)) { reasons.add(`Dependency resolves outside workspace: ${path}`); return undefined; }
        let content = contents.get(path);
        if (content === undefined) {
          content = await readFile(absolute, { encoding: "utf8", signal });
          if (Buffer.byteLength(content) > 2_000_000) { reasons.add(`Source exceeds analysis limit: ${path}`); return undefined; }
          contents.set(path, content);
        }
        // The closure must describe the exact snapshot tested, including concurrent writes.
        if (createHash("sha256").update(content).digest("hex") !== snapshot.files[path]) { reasons.add(`Dependency changed during analysis: ${path}`); return undefined; }
        return content;
      } catch { signal.throwIfAborted(); reasons.add(`Unreadable dependency: ${path}`); return undefined; }
    };
    const expand = (pattern: string, base = itemCwd): string[] => {
      const path = toWorkspacePath(pattern, base);
      if (!path) return [];
      if (/^!|\{[^}]*$/.test(pattern)) { reasons.add(`Unsupported dependency pattern: ${pattern}`); return []; }
      const matches = [...available].filter(name => name === path || name.startsWith(`${path}/`) || matchesGlob(name, path)).sort();
      if (!matches.length) reasons.add(`Missing dependency pattern: ${pattern}`);
      return matches;
    };
    const scan = async (path: string): Promise<void> => {
      if (visited.has(path)) return;
      if (visited.size >= 5000) { reasons.add("Dependency closure exceeds analysis limit"); return; }
      visited.add(path);
      paths.add(path);
      const content = await read(path);
      if (content === undefined || path.endsWith(".json")) return;
      if (!sourceExtensions.some(extension => path.endsWith(extension))) { reasons.add(`Unsupported dependency language: ${path}`); return; }
      let imports: ReturnType<typeof moduleReferences>;
      try { imports = moduleReferences(content); } catch { reasons.add(`Source cannot be scanned: ${path}`); return; }
      for (const reason of imports.reasons) reasons.add(`${reason}: ${path}`);
      for (const specifier of imports.references) {
        const builtin = specifier.replace(/^node:/, "");
        if (builtins.has(builtin)) { if (opaqueBuiltins.test(builtin)) reasons.add(`Runtime I/O or loading dependency: ${specifier}`); continue; }
        if (!specifier.startsWith(".")) { reasons.add(`External or aliased dependency cannot be bounded: ${specifier}`); continue; }
        const name = toWorkspacePath(specifier, resolve(workspaceRoot, dirname(path)));
        if (!name) continue;
        const candidates = new Set([name, ...sourceExtensions.map(extension => name + extension), `${name}.json`, ...sourceExtensions.map(extension => `${name}/index${extension}`), `${name}/index.json`]);
        // TypeScript runners can substitute a .ts source for a .js import.
        if (/\.[cm]?js$/.test(name)) {
          const stem = name.replace(/\.[cm]?js$/, "");
          for (const extension of [".ts", ".tsx", ".mts", ".cts"]) candidates.add(stem + extension);
        }
        const matches = [...candidates].filter(candidate => available.has(candidate));
        if (!matches.length) reasons.add(`Missing module dependency: ${specifier} from ${path}`);
        for (const dependency of matches) await scan(dependency);
      }
    };
    const findPackage = (): string | undefined => {
      let directory = itemCwd;
      while (directory === workspaceRoot || directory.startsWith(workspaceRoot + sep)) {
        const candidate = slash(relative(workspaceRoot, resolve(directory, "package.json")));
        if (available.has(candidate)) return candidate;
        if (directory === workspaceRoot) break;
        directory = dirname(directory);
      }
      return undefined;
    };
    const parseCommand = async (command: string, depth = 0): Promise<void> => {
      if (depth > 8) { reasons.add("Recursive package script"); return; }
      const tokens = commandTokens(command);
      if (!tokens) { reasons.add("Opaque verification command"); return; }
      let executable = basename(tokens.shift()!).toLowerCase().replace(/\.(?:exe|cmd)$/, "");
      if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
        if (tokens[0] === "exec" || tokens[0] === "x") { tokens.shift(); executable = basename(tokens.shift() ?? "").toLowerCase(); }
        else {
          if (tokens[0] === "run") tokens.shift();
          const name = tokens.shift();
          const packagePath = findPackage();
          const content = packagePath ? await read(packagePath) : undefined;
          let scripts: Record<string, unknown> | undefined;
          try { scripts = content ? JSON.parse(content).scripts : undefined; } catch { reasons.add("Invalid package manifest"); }
          const script = name && scripts?.[name];
          if (typeof script !== "string") { reasons.add(`Unknown package test script: ${name ?? ""}`); return; }
          if (tokens[0] === "--") tokens.shift();
          if (tokens.some(token => /\s/.test(token))) { reasons.add("Opaque forwarded script arguments"); return; }
          for (const hook of [`pre${name}`, `post${name}`]) {
            if (typeof scripts?.[hook] === "string") await parseCommand(scripts[hook], depth + 1);
          }
          await parseCommand([script, ...tokens].join(" "), depth + 1);
          return;
        }
      }
      if (["node", "nodejs", "tsx", "vitest", "tsc"].includes(executable)) {
        let explicitEntries = 0;
        const flagsWithValues = new Set(["--test-name-pattern", "--test-reporter", "--test-reporter-destination", "--maxWorkers", "--minWorkers", "--pool", "--environment", "--test-timeout", "--timeout"]);
        const fileFlags = new Set(["--require", "-r", "--import", "--loader", "--config", "-c", "--project", "-p"]);
        for (let index = 0; index < tokens.length; index++) {
          const token = tokens[index]!;
          if (fileFlags.has(token)) { const value = tokens[++index]; if (!value) reasons.add(`Missing command argument: ${token}`); else for (const path of expand(value)) entryPaths.add(path); continue; }
          if (flagsWithValues.has(token)) { index++; continue; }
          if (token.startsWith("-")) {
            if (/^(?:--test|--noEmit|--run|--coverage|--watch=false|--check|--enable-source-maps|--experimental-strip-types|--no-warnings|--disable-warning|--maxWorkers=|--minWorkers=|--pool=|--environment=|--test-timeout=|--timeout=)/.test(token) || token === "--") continue;
            reasons.add(`Unsupported runner flag: ${token}`); continue;
          }
          if (token === "run" && executable === "vitest") continue;
          explicitEntries++;
          for (const path of expand(token)) entryPaths.add(path);
        }
        if (executable === "tsc") {
          for (const path of available) if (sourceExtensions.some(extension => path.endsWith(extension))) entryPaths.add(path);
        } else if (!explicitEntries) {
          if (executable === "vitest" || tokens.some(token => token.startsWith("--test"))) for (const path of expand(testPattern)) entryPaths.add(path);
          else reasons.add("Verification test entry is unknown");
        }
      } else reasons.add(`Unsupported verification runner: ${executable}`);
    };
    await parseCommand(item.command);
    for (const pattern of item.dependencyPaths ?? []) for (const path of expand(pattern)) { paths.add(path); await read(path); }
    for (const path of entryPaths) await scan(path);
    // Executable configuration may import setup or transform code outside test imports.
    for (const path of configurations) if (sourceExtensions.some(extension => path.endsWith(extension))) await scan(path);
    if (!entryPaths.size) reasons.add("No persisted test entry could be resolved");
    const sortedPaths = [...paths].sort();
    const complete = reasons.size === 0;
    const execution = { command: item.command, cwd: slash(item.cwd), stdin: item.stdin ?? "", timeoutMs: item.timeoutMs, expectedExitCodes: item.expectedExitCodes, dependencyPaths: item.dependencyPaths ?? [], environment };
    result[item.id] = {
      paths: sortedPaths,
      complete,
      fingerprint: digest({ execution, files: complete ? sortedPaths.map(path => [path, snapshot.files[path]]) : workspaceFingerprint(snapshot), complete }),
      ...(!complete ? { reason: [...reasons].sort().join("; ").slice(0, 2000) } : {}),
    };
  }
  return result;
}

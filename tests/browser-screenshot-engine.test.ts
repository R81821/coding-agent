import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { EncryptedBlobStore, HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type AttachmentRef, type ModelRequest, type Profile, type RunSpec } from "@harness/protocol";
import { ToolRegistry } from "@harness/tools";

// A valid one-pixel PNG keeps this an image transport test rather than a mocked string receipt.
const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
const png = Buffer.from(pngBase64, "base64");
const pageContents = "<!doctype html><html><body>Screenshot fixture</body></html>\n";
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Locate image references without coupling the assertions to their metadata container key. */
function attachmentRefs(value: unknown): AttachmentRef[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(attachmentRefs);
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && typeof record.sha256 === "string" && typeof record.encryptedPath === "string") return [record as AttachmentRef];
  return Object.values(record).flatMap(attachmentRefs);
}

async function screenshotRun(vision: boolean) {
  const root = await mkdtemp(join(tmpdir(), "harness-browser-screenshot-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  await mkdir(workspace);
  await mkdir(state);
  await writeFile(join(workspace, "page.html"), pageContents);
  const vault = await VaultCrypto.open(join(state, "key.json"), "screenshot-engine-fixture-password");
  const database = await HarnessDatabase.open(join(state, "state.sqlite"), vault);
  const blobs = new EncryptedBlobStore(join(state, "blobs"), vault);
  const events: AgentEvent[] = [];
  const requests: ModelRequest[] = [];
  const calls: Array<Record<string, unknown>> = [];
  const tools = new ToolRegistry().register({
    contract: {
      name: "browser", description: "Capture the existing browser viewport", risk: "read", idempotent: true, timeoutMs: 1000,
      inputSchema: { type: "object", properties: { action: { const: "screenshot" }, tabId: { type: "string" } }, required: ["action", "tabId"] },
    },
    async execute(input) {
      calls.push(input);
      return {
        output: { tabId: "fixture-tab", url: "file:///fixture/page.html", title: "Screenshot fixture", mimeType: "image/png", width: 1, height: 1 },
        images: [{ mimeType: "image/png", base64: pngBase64, width: 1, height: 1 }],
      };
    },
  });
  const model = descriptor({ providerId: "fake", modelId: "screenshot-engine", displayName: "Screenshot fixture",
    capabilities: { vision, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local" } });
  const provider: ModelProvider = {
    id: "fake", health: async () => true, estimateCost: () => 0, listModels: async () => [model],
    async *stream(request): AsyncIterable<ProviderStreamEvent> {
      requests.push(structuredClone(request));
      if (request.purpose === "review") throw new Error("Independent model review must remain disabled");
      if (requests.length === 1) yield { type: "tool_call", toolCall: { id: "browser-shot", name: "browser", input: { action: "screenshot", tabId: "fixture-tab" } } };
      else yield { type: "text_delta", delta: vision ? "已捕获浏览器截图，可查看页面像素。" : "已捕获截图；当前模型不支持视觉输入，未判断页面像素。" };
    },
  };
  const engine = new HarnessEngine({ database, blobs, providers: [provider], tools,
    memory: new MemoryService(database), skills: new SkillService(join(state, "skills")), projectTrust: new ProjectTrustService(database) });
  cleanup.push(async () => {
    await engine.close(); database.close(); vault.dispose();
    const confined = relative(tmpdir(), root);
    if (!confined || confined.startsWith("..") || isAbsolute(confined)) throw new Error("Unsafe fixture cleanup target");
    await rm(root, { recursive: true, force: true });
  });
  const profile: Profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: ["browser"] };
  const spec: RunSpec = { workflowVersion: 2, id: newId("run"), sessionId: "browser-screenshot", request: "截取当前内置浏览器页面，并检查截图可用性。",
    workspacePath: workspace, profileId: profile.id, taskMode: "analysis", attachments: [], createdAt: nowIso(),
    budget: { ...profile.budget, maxTurns: 6, maxToolCalls: 12 }, grants: [] };
  engine.on("event", (event: AgentEvent) => events.push(event));
  async function run() {
    const result = await new Promise<Extract<AgentEvent, { type: "result" }>>((resolve, reject) => {
      const timer = setTimeout(() => { engine.cancel(spec.id); reject(new Error("Browser screenshot engine test timed out")); }, 15000);
      const onEvent = (event: AgentEvent) => {
        if (event.type !== "result" || event.runId !== spec.id) return;
        clearTimeout(timer); engine.off("event", onEvent); resolve(event);
      };
      engine.on("event", onEvent); engine.start(spec, profile);
    });
    await engine.waitForSettlement(spec.id);
    return result;
  }
  return { engine, database, blobs, events, requests, calls, spec, workspace, run };
}

describe("browser screenshot transport through the real engine", { timeout: 25000 }, () => {
  it("stores pixels encrypted outside the workspace and supplies one untrusted browser image to the vision model", async () => {
    const f = await screenshotRun(true);
    expect(await f.run()).toMatchObject({ status: "completed" });
    expect(f.calls).toEqual([{ action: "screenshot", tabId: "fixture-tab" }]);
    expect(f.events.some(event => event.type === "approval_required" || event.type === "plan_approval_required")).toBe(false);
    const imageMessages = f.requests[1]!.messages.filter(message => message.content.some(part => part.type === "image"));
    expect(imageMessages).toHaveLength(1);
    expect(imageMessages[0]!.role).toBe("user");
    const imageParts = imageMessages[0]!.content.filter(part => part.type === "image");
    expect(imageParts).toHaveLength(1);
    const attachment = imageParts[0]!.attachment;
    expect(attachment).toMatchObject({ mimeType: "image/png", byteLength: png.byteLength, width: 1, height: 1,
      source: "browser", trust: "untrusted_web", allowedProviders: ["fake"] });
    expect(f.database.getAttachment(attachment.id)).toEqual(attachment);
    expect(await f.blobs.read(attachment)).toEqual(png);
    const encrypted = await readFile(attachment.encryptedPath);
    expect(encrypted.equals(png)).toBe(false);
    expect(encrypted.includes(png)).toBe(false);
    const storedShot = f.database.listEvents(f.spec.id).find(event => event.type === "tool_finished" && event.callId === "browser-shot");
    expect(storedShot).toMatchObject({ type: "tool_finished", isError: false, output: { tabId: "fixture-tab", title: "Screenshot fixture" } });
    expect(attachmentRefs(storedShot).map(ref => ref.id)).toContain(attachment.id);
    for (const value of [f.events, f.requests, f.database.listEvents(f.spec.id), f.database.listCheckpoints(f.spec.id)]) expect(JSON.stringify(value)).not.toContain(pngBase64);
    expect(await readdir(f.workspace)).toEqual(["page.html"]);
    expect(await readFile(join(f.workspace, "page.html"), "utf8")).toBe(pageContents);
    expect(f.database.getLatestCheckpoint(f.spec.id)?.workflow).toMatchObject({ revision: 0, changedFiles: [] });
    expect(f.requests.some(request => request.purpose === "review")).toBe(false);
  });

  it("retains the screenshot receipt without sending image parts to a model that lacks vision", async () => {
    const f = await screenshotRun(false);
    expect(await f.run()).toMatchObject({ status: "completed" });
    expect(f.requests).toHaveLength(2);
    expect(f.requests.flatMap(request => request.messages).flatMap(message => message.content).some(part => part.type === "image")).toBe(false);
    const storedShot = f.database.listEvents(f.spec.id).find(event => event.type === "tool_finished" && event.callId === "browser-shot");
    expect(storedShot).toMatchObject({ type: "tool_finished", isError: false });
    const attachments = attachmentRefs(storedShot);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ source: "browser", trust: "untrusted_web", allowedProviders: ["fake"] });
    expect(await f.blobs.read(attachments[0]!)).toEqual(png);
    const response = f.requests[1]!.messages.flatMap(message => message.content);
    expect(JSON.stringify(response)).toMatch(/vision|视觉|image.*not|does not support.*image/i);
    expect(JSON.stringify(response)).not.toContain(pngBase64);
    expect(await readdir(f.workspace)).toEqual(["page.html"]);
    expect(f.requests.some(request => request.purpose === "review")).toBe(false);
  });
});

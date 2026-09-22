import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type AttachmentRef, type ModelRequest } from "@harness/protocol";
import { createDefaultToolRegistry } from "@harness/tools";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }).catch(() => {});
});

/**
 * A user attaches an image and the task takes more than one model turn. Every request that carries
 * the conversation must carry the image too: a request built from the full history without it tells
 * the model to reason about a picture it can no longer see.
 */
describe("multi-turn attachment fidelity", () => {
  it("sends the user's image on the first and every later model request", async () => {
    const imagesPerRequest: number[] = [];
    let call = 0;
    const model = descriptor({
      providerId: "fake", modelId: "fake-model", displayName: "Fake",
      capabilities: { vision: true, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 32_000, dataPolicy: "local" },
    });
    const provider: ModelProvider = {
      id: "fake",
      async listModels() { return [model]; },
      async *stream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
        call += 1;
        imagesPerRequest.push(request.messages.flatMap((message) => message.content.filter((part) => part.type === "image")).length);
        if (call <= 2) yield { type: "tool_call", toolCall: { id: `call-${call}`, name: "read_file", input: { path: "a.txt" } } };
        else yield { type: "text_delta", delta: "done" };
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, estimatedUsd: 0 } };
      },
      async health() { return true; },
      estimateCost() { return 0; },
    };

    const root = await mkdtemp(join(tmpdir(), "harness-attach-test-"));
    temporary.push(root);
    const vault = await VaultCrypto.open(join(root, "envelope.json"), "correct-password");
    const database = await HarnessDatabase.open(join(root, "harness.sqlite"), vault);
    const engine = new HarnessEngine({
      database,
      providers: [provider],
      tools: createDefaultToolRegistry(),
      memory: new MemoryService(database),
      skills: new SkillService(join(root, "skills")),
      projectTrust: new ProjectTrustService(database),
    });
    await writeFile(join(root, "a.txt"), "hello world\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });

    const attachment: AttachmentRef = {
      id: "att-1", sha256: "a".repeat(64), mimeType: "image/png", byteLength: 100,
      encryptedPath: "unused", source: "file", trust: "untrusted_attachment",
      allowedProviders: ["fake"], createdAt: nowIso(),
    };
    const spec = {
      id: newId("run"), sessionId: newId("session"), request: "Describe the attached screenshot and read a.txt.",
      workspacePath: root, profileId: "default", attachments: [attachment],
      budget: { maxTurns: 8, maxToolCalls: 8, maxDurationMs: 60_000, maxUsd: 5 },
      grants: [], createdAt: nowIso(),
    };
    const profile = {
      ...DEFAULT_PROFILE, id: "default", allowedProviders: ["fake"], toolNames: ["read_file"],
      verificationPolicy: { items: [], maxRepairAttempts: null, broaderPolicy: "optional" as const },
    };
    const done = new Promise<Extract<AgentEvent, { type: "result" }>>((resolve) => {
      engine.on("event", (event: AgentEvent) => { if (event.runId === spec.id && event.type === "result") resolve(event); });
    });
    engine.start(spec, profile);
    const result = await done;

    expect(imagesPerRequest.length).toBeGreaterThanOrEqual(3);
    expect(result.status).toBe("completed");
    expect(imagesPerRequest).toEqual(imagesPerRequest.map(() => 1));
  });
});

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { DEFAULT_PROFILE, nowIso, type ModelMessage, type RunCheckpoint, type RunSpec } from "@harness/protocol";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** A run writes one checkpoint per tool result, and the store memorises each message object's
 *  content address. These tests hold the other end of that bargain: whatever the store remembers,
 *  reading a checkpoint back must return exactly the transcript that was saved. */
async function storage() {
  const root = await mkdtemp(join(tmpdir(), "harness-checkpoint-reuse-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const vault = await VaultCrypto.open(join(root, "key.json"), "checkpoint-reuse-password");
  const database = await HarnessDatabase.open(join(root, "state.sqlite"), vault);
  cleanup.push(async () => {
    database.close(); vault.dispose();
    const withinTemp = relative(tmpdir(), root);
    if (!withinTemp || withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("Unsafe fixture cleanup target");
    await rm(root, { recursive: true, force: true });
  });
  return database;
}

function runSpec(): RunSpec {
  return { id: "run-reuse", sessionId: "session-reuse", taskMode: "analysis", request: "Inspect the workspace and report.",
    workspacePath: "/tmp/reuse", profileId: DEFAULT_PROFILE.id, attachments: [], grants: [], createdAt: nowIso(),
    budget: { ...DEFAULT_PROFILE.budget, maxTurns: 10, maxToolCalls: 16, maxDurationMs: 60_000 } };
}

function toolMessage(toolCallId: string, output: unknown): ModelMessage {
  return { role: "tool", content: [{ type: "tool_result", toolCallId, output, trust: "untrusted_tool" }] };
}

function checkpoint(run: RunSpec, id: string, transcript: ModelMessage[]): RunCheckpoint {
  return { id, runId: run.id, sequence: 10, reason: "tool_batch", status: "running", elapsedMs: 1_000, transcript,
    usage: { inputTokens: 10, outputTokens: 5, estimatedUsd: 0, costKnown: true }, turns: 1, toolCalls: 1,
    repairAttemptsUsed: 0, pendingNonIdempotentToolCalls: [], createdAt: nowIso() };
}

it("returns the saved transcript when later checkpoints reuse the same message objects", async () => {
  const database = await storage();
  const run = runSpec();
  database.saveRun(run, "running");
  const first: ModelMessage = { role: "user", content: [{ type: "text", text: "Inspect.", trust: "user_request" }] };
  const second = toolMessage("call-1", { exitCode: 0, stdout: "value = 7" });

  database.saveCheckpoint(checkpoint(run, "checkpoint-1", [first, second]));
  expect(database.getLatestCheckpoint(run.id)?.transcript).toEqual([first, second]);

  // The third message is new; the first two are the very same objects the store already addressed.
  const third = toolMessage("call-2", { exitCode: 0, stdout: "suite passed" });
  database.saveCheckpoint(checkpoint(run, "checkpoint-2", [first, second, third]));
  expect(database.getLatestCheckpoint(run.id)?.transcript).toEqual([first, second, third]);
});

it("resolves a fresh object with unchanged content to the same stored message", async () => {
  const database = await storage();
  const run = runSpec();
  database.saveRun(run, "running");
  database.saveCheckpoint(checkpoint(run, "checkpoint-1", [toolMessage("call-1", { exitCode: 0 }) ]));

  // A rebuilt transcript hands over equal-but-distinct objects; content addressing must still match
  // so the read returns the message, not a missing-content failure.
  const rebuilt = toolMessage("call-1", { exitCode: 0 });
  database.saveCheckpoint(checkpoint(run, "checkpoint-2", [rebuilt]));
  expect(database.getLatestCheckpoint(run.id)?.transcript).toEqual([rebuilt]);
});

it("keeps a large unchanged tool result intact across many checkpoints", async () => {
  const database = await storage();
  const run = runSpec();
  database.saveRun(run, "running");
  const large = toolMessage("call-large", { exitCode: 1, stdout: "x".repeat(200_000), stderr: "boom" });
  for (let index = 1; index <= 5; index += 1) {
    database.saveCheckpoint(checkpoint(run, `checkpoint-${index}`, [large, toolMessage(`tail-${index}`, { index })]));
  }
  const saved = database.getLatestCheckpoint(run.id)!;
  expect(saved.transcript).toHaveLength(2);
  expect(saved.transcript[0]).toEqual(large);
  expect(saved.transcript[1]).toEqual(toolMessage("tail-5", { index: 5 }));
});

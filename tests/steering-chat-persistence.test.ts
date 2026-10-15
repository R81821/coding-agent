import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { DEFAULT_PROFILE, SessionContentLoader, refreshSessionView, type AgentEvent, type CompactionRecord, type RunCheckpoint, type SessionView } from "@harness/protocol";
import { buildConversationStream } from "../apps/desktop/src/conversation-stream.js";

const at = "2026-10-14T00:00:00.000Z";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-steering-chat-persistence-"));
  const path = join(root, "test.sqlite");
  const crypto = await VaultCrypto.open(join(root, "key.json"), "fixture-password");
  const database = await HarnessDatabase.open(path, crypto);
  cleanup.push(async () => { database.close(); crypto.dispose(); await rm(root, { recursive: true, force: true }); });
  database.createSession({ id: "session", title: "fixture", workspacePath: "D:/fixture", profileId: "default", createdAt: at, updatedAt: at });
  database.saveRun({ id: "run", sessionId: "session", request: "原始请求", workspacePath: "D:/fixture", profileId: "default", budget: DEFAULT_PROFILE.budget, grants: [], attachments: [], createdAt: at }, "paused");
  return { database, crypto, path };
}

function checkpoint(sequence: number, text: string): RunCheckpoint {
  return { id: `checkpoint-${sequence}`, runId: "run", sequence, reason: "manual", status: "paused", transcript: [{ role: "user", content: [{ type: "text", trust: "user_request", text }] }], usage: { inputTokens: 0, outputTokens: 0, estimatedUsd: 0 }, turns: 1, toolCalls: 0, pendingNonIdempotentToolCalls: [], createdAt: at };
}
const eventBase = (sequence: number) => ({ id: `event-${sequence}`, runId: "run", sequence, at });
const submitted = (sequence: number, messageId: string, text: string): AgentEvent => ({ ...eventBase(sequence), type: "steering_submitted", messageId, text });
const delivered = (sequence: number, text: string, messageId?: string): AgentEvent => ({ ...eventBase(sequence), type: "steering_delivered", text, ...(messageId ? { messageId } : {}) });
const delta = (sequence: number, text: string): AgentEvent => ({ ...eventBase(sequence), type: "text_delta", delta: text });
const bubbles = (events: AgentEvent[]) => buildConversationStream(events).filter(item => item.kind === "user_message");

describe("submitted chat messages and atomic checkpoints", () => {
  it("saves the accepted message and working checkpoint together after flushing preceding text", async () => {
    const { database } = await fixture();
    database.appendEvent(delta(0, "暂停前的正文"));
    const events = [submitted(1, "correction", "新方向"), delivered(2, "新方向", "correction"), { ...eventBase(3), type: "checkpoint_saved", checkpointId: "checkpoint-3", reason: "manual" } as AgentEvent];
    const saved = checkpoint(3, "新方向");
    database.saveCheckpoint(saved, undefined, events);
    expect(database.getLatestCheckpoint("run")).toEqual(saved);
    expect(database.listEvents("run")).toEqual([delta(0, "暂停前的正文"), ...events]);
    expect(bubbles(database.getSessionView("session")!.runs[0]!.events)).toMatchObject([{ text: "新方向", sequence: 1 }]);
  });

  it("rolls back checkpoint, compaction, events, encrypted references and evidence when a later event fails", async () => {
    const { database, crypto, path } = await fixture();
    const original = checkpoint(0, "原始上下文");
    database.saveCheckpoint(original);
    const raw = new DatabaseSync(path);
    cleanup.push(async () => { raw.close(); });
    const contentCount = () => Number(raw.prepare("SELECT COUNT(*) AS n FROM content_objects").get()?.n);
    const before = contentCount();
    database.appendEvent(delta(0, "已生成的文字"));
    const events: AgentEvent[] = [submitted(1, "correction", "新的上下文"), { ...eventBase(2), type: "tool_finished", callId: "fixture-call", durationMs: 1, output: { content: "temporary encrypted tool evidence" } }, delivered(3, "新的上下文", "correction")];
    const record: CompactionRecord = { id: "compaction", runId: "run", sourceSequenceStart: 0, sourceSequenceEnd: 1, summary: "fixture summary", summaryHash: "fixture hash", inputTokens: 10, outputTokens: 2, deterministicFallback: false, trust: "untrusted_tool", createdAt: at };
    const attempted = checkpoint(3, "新的上下文");
    const encrypt = crypto.encryptJson.bind(crypto);
    const fail = vi.spyOn(crypto, "encryptJson").mockImplementation((value, aad) => {
      if (aad === "event:run:3") throw new Error("fixture write failure");
      return encrypt(value, aad);
    });
    expect(() => database.saveCheckpoint(attempted, record, events)).toThrow("fixture write failure");
    fail.mockRestore();
    expect(database.getLatestCheckpoint("run")).toEqual(original);
    expect(database.listCompactions("run")).toEqual([]);
    expect(database.listEvents("run")).toEqual([delta(0, "已生成的文字")]);
    expect(contentCount()).toBe(before);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM tool_evidence").get()?.n).toBe(0);
    expect(database.getToolEvidence("run", "fixture-call")).toBeUndefined();
    database.saveCheckpoint(attempted, record, events);
    expect(database.getLatestCheckpoint("run")).toEqual(attempted);
    expect(database.listEvents("run")).toHaveLength(4);
    expect(database.getToolEvidence("run", "fixture-call")).toMatchObject({ type: "tool_finished", output: { content: "temporary encrypted tool evidence" } });
  });

  it("retains every distinct human reply in the preview without merging assistant text across them", async () => {
    const { database, crypto } = await fixture();
    const events = [delta(0, "第一段"), submitted(1, "first", "继续"), delta(2, "第二段"), delivered(3, "继续", "first"), delta(4, "后续"), submitted(5, "second", "继续"), delta(6, "第三段"), delivered(7, "旧消息"), delta(8, "第四段")];
    events.forEach(event => database.appendEvent(event));
    const decrypt = vi.spyOn(crypto, "decryptJson");
    const preview = database.getSessionView("session")!.runs[0]!.events;
    expect(bubbles(preview)).toMatchObject([{ text: "继续", sequence: 1 }, { text: "继续", sequence: 5 }, { text: "旧消息", sequence: 7 }]);
    expect(buildConversationStream(preview).map(item => "text" in item ? item.text : item.kind)).toEqual(["第一段", "继续", "第二段后续", "继续", "第三段", "旧消息", "第四段"]);
    expect(decrypt.mock.calls.some(call => String(call[1]).startsWith("content:"))).toBe(false);
    expect(preview).toEqual(database.listEventPage("run").events.filter(event => event.type !== "text_delta" || event.sequence !== 2).map(event => event.type === "text_delta" && event.sequence === 4 ? { ...event, delta: "第二段后续" } : event));
  });

  it("keeps the human bubbles once as canonical pages hydrate and the session is refreshed", async () => {
    const { database } = await fixture();
    const events = [delta(0, "先前的思路"), submitted(1, "correction", "新方向"), delivered(2, "新方向", "correction"), delta(3, "重新考虑"), { ...eventBase(4), type: "result", status: "completed", text: "修订后的回答" } as AgentEvent];
    events.forEach(event => database.appendEvent(event));
    let view: SessionView = database.getSessionView("session")!;
    const expected = bubbles(events);
    expect(bubbles(view.runs[0]!.events)).toEqual(expected);
    vi.useFakeTimers();
    const loader = new SessionContentLoader({ sessionId: "session", read: () => view, update: change => { view = change(view); }, onError: message => { throw new Error(message); }, request: async <T>(input: { method: string; params?: unknown }) => {
      if (input.method !== "run.eventPage") throw new Error(input.method);
      const { afterSequence } = input.params as { afterSequence: number };
      return database.listEventPage("run", afterSequence, 2) as T;
    } });
    try {
      loader.wake();
      for (let index = 0; index < 12; index++) { await vi.advanceTimersByTimeAsync(16); expect(bubbles(view.runs[0]!.events)).toEqual(expected); }
      expect(view.runs[0]!.view?.eventsComplete).toBe(true);
      expect(view.runs[0]!.events).toEqual(events);
      view = refreshSessionView(view, database.getSessionView("session")!);
      expect(bubbles(view.runs[0]!.events)).toEqual(expected);
    } finally { loader.stop(); }
  });
});

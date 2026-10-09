import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEFAULT_PROFILE,
  type AgentEvent,
  type SessionDetail,
  type SessionRecord,
} from "@harness/protocol";
import { createDemo } from "../src/lib/demo";
import { answerText } from "../src/lib/model";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps final text once instead of duplicating streamed output", () => {
  const base = {
    id: "event",
    runId: "run",
    sequence: 1,
    at: new Date().toISOString(),
  };
  expect(
    answerText([
      { ...base, type: "text_delta", delta: "你好" },
      { ...base, type: "result", text: "你好，完成了。", status: "completed" },
    ]),
  ).toBe("你好，完成了。");
});

it("uses the authoritative report and pending-review suffix across preview and full history", () => {
  const base = { runId: "run", at: new Date().toISOString() };
  const result: AgentEvent = { ...base, id: "result", sequence: 3, type: "result", text: "修正后的报告\n\n独立审核未完成", status: "review", sourceAssistantTurnSequence: 1 };
  const full: AgentEvent[] = [
    { ...base, id: "turn", sequence: 1, type: "assistant_turn_started" },
    { ...base, id: "delta", sequence: 2, type: "text_delta", delta: "过时的长报告，声称已经完成" },
    result,
  ];
  expect(answerText(full)).toBe(result.text);
  expect(answerText([result])).toBe(result.text);
  expect(answerText(JSON.parse(JSON.stringify(full)) as AgentEvent[])).toBe(result.text);
});

it("supports a complete isolated demo conversation, pause/resume, and reload", async () => {
  const demo = createDemo();
  const now = new Date().toISOString();
  const session = await demo.request<SessionRecord>({
    method: "sessions.create",
    params: {
      id: "test-session",
      workspacePath: "/demo/test",
      title: "新任务",
      profileId: "default",
      createdAt: now,
      updatedAt: now,
    },
  });
  await demo.request({
    method: "run.start",
    params: {
      id: "test-run",
      sessionId: session.id,
      workspacePath: session.workspacePath,
      profileId: "default",
      request: "测试中文对话",
      attachments: [],
      budget: DEFAULT_PROFILE.budget,
      grants: [],
      createdAt: now,
    },
  });
  const get = () =>
    demo.request<SessionDetail>({
      method: "session.get",
      params: { sessionId: session.id },
    });
  vi.advanceTimersByTime(1200);
  expect((await get()).runs[0]?.status).toBe("running");
  expect(answerText((await get()).runs[0]!.events)).toContain("交互演示");
  await demo.request({ method: "run.pause", params: { runId: "test-run" } });
  vi.advanceTimersByTime(10_000);
  expect((await get()).runs[0]?.status).toBe("paused");
  await demo.request({ method: "run.resume", params: { runId: "test-run" } });
  vi.advanceTimersByTime(10_000);
  expect((await get()).runs[0]?.status).toBe("completed");
  const restored = await createDemo().request<SessionDetail>({
    method: "session.get",
    params: { sessionId: session.id },
  });
  expect(restored.session.title).toBe("测试中文对话");
  expect(restored.runs[0]?.status).toBe("completed");
});

it("stops demo runs and never completes them later", async () => {
  const demo = createDemo();
  await demo.request({ method: "run.resume", params: { runId: "demo-3-run" } });
  await demo.request({ method: "run.cancel", params: { runId: "demo-3-run" } });
  vi.advanceTimersByTime(20_000);
  const detail = await demo.request<SessionDetail>({
    method: "session.get",
    params: { sessionId: "demo-3" },
  });
  expect(detail.runs[0]?.status).toBe("cancelled");
});

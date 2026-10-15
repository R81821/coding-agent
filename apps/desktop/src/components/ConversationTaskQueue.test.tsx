import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConversationTaskSchema } from "@harness/protocol";
import { ConversationTaskQueueList, conversationTaskActions } from "./ConversationTaskQueue.js";

const at = "2026-10-15T00:00:00.000Z";
const task = (overrides: Record<string, unknown> = {}) => ConversationTaskSchema.parse({
  taskId: "task-a", sessionId: "session-a", parentRunId: "run-a", stepId: "检查接口", planGeneration: 2,
  source: { kind: "run" }, mode: "read", prompt: "核对当前接口的行为", createdAt: at, updatedAt: at, ...overrides,
});
const actions = () => ({ onReasonChange: vi.fn(), onRetryOpen: vi.fn(), onRetryClose: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), onRefresh: vi.fn() });
const limits = { maxConcurrentTasks: 4, maxQueueLength: 80 };

describe("conversation task queue", () => {
  it("counts only claimed running work as concurrent and shows blocked conditions", () => {
    const html = renderToStaticMarkup(<ConversationTaskQueueList limits={limits} tasks={[
      task({ executionState: "queued" }), task({ taskId: "task-b", executionState: "running", startedAt: at }),
      task({ taskId: "task-c", executionState: "blocked", dependsOn: ["verified-api"], blockedReason: "等待真实验证回执" }),
    ]} {...actions()} />);
    expect(html).toContain("1 / 4 执行中 · 2 等待");
    expect(html).toContain("队列上限 80");
    expect(html).toContain("排队中");
    expect(html).toContain("等待原因：等待真实验证回执");
    expect(html).toContain("依赖：verified-api");
    expect(html.match(/取消等待/g)).toHaveLength(2);
  });

  it("distinguishes an atomic claim preparing resources from an actually started child", () => {
    const html = renderToStaticMarkup(<ConversationTaskQueueList limits={limits} tasks={[task({ executionState: "running" })]} {...actions()} />);
    expect(html).toContain("1 / 4 占用槽位 · 1 准备资源");
    expect(html).toContain('class="conversation-task-state">准备资源');
    expect(html).not.toContain("执行中");
    expect(html).not.toContain("取消等待");
  });

  it("shows ready artifacts separately from completed execution and real acceptance", () => {
    const html = renderToStaticMarkup(<ConversationTaskQueueList limits={limits} tasks={[
      task({ executionState: "awaiting_integration", summary: "已修复接口字段", patch: { file: "api.ts" } }),
      task({ taskId: "task-b", executionState: "completed", acceptanceState: "pending" }),
      task({ taskId: "task-c", executionState: "completed", acceptanceState: "verified", integrationReceipt: "integration-ok" }),
    ]} {...actions()} />);
    expect(html).toContain("1 待集成");
    expect(html).toContain("包含补丁");
    expect(html).toContain("已修复接口字段");
    expect(html).toContain("验收：待验证");
    expect(html).toContain("验收：验证通过");
    expect(html).toContain("集成回执：integration-ok");
    expect(html).not.toContain("user-message");
    expect(html).not.toContain("取消等待");
  });

  it("locates failures from the last attempt and requires a reason for retry", () => {
    const failed = task({ executionState: "failed", attempts: [{ attemptId: "attempt-1", childRunId: "child-1", claimedAt: at, executionState: "failed", error: "校验超时" }] });
    const html = renderToStaticMarkup(<ConversationTaskQueueList limits={limits} tasks={[failed]} retryTaskId={failed.taskId} {...actions()} />);
    expect(html).toContain("失败原因：校验超时");
    expect(html).toContain("尝试 1");
    expect(html).toContain('required=""');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    const ready = renderToStaticMarkup(<ConversationTaskQueueList limits={limits} tasks={[failed]} retryTaskId={failed.taskId} retryReason="已修复超时条件" {...actions()} />);
    expect(ready).not.toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  it("keeps interrupted results explicit and never exposes unscoped or withdrawn controls", () => {
    const interrupted = task({ executionState: "interrupted" });
    const html = renderToStaticMarkup(<ConversationTaskQueueList limits={limits} tasks={[interrupted]} {...actions()} />);
    expect(html).toContain("执行结果需要核对");
    expect(html).toContain("填写原因并重试");
    expect(conversationTaskActions(interrupted)).toEqual({ cancel: false, retry: true });
    expect(conversationTaskActions({ ...interrupted, taskId: "" })).toEqual({ cancel: false, retry: false });
    expect(conversationTaskActions({ ...interrupted, sessionId: "" })).toEqual({ cancel: false, retry: false });
    expect(conversationTaskActions({ ...interrupted, parentRunId: "" })).toEqual({ cancel: false, retry: false });
    expect(conversationTaskActions({ ...interrupted, withdrawnAt: at })).toEqual({ cancel: false, retry: false });
    expect(conversationTaskActions(task({ executionState: "running" }))).toEqual({ cancel: false, retry: false });
  });
});

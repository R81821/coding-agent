import React, { useEffect, useRef, useState } from "react";
import type { ConversationTask, ConversationTaskExecutionState } from "@harness/protocol";
import { BuiButton } from "../ui/button.js";
import "./conversation-task-queue.css";

export interface ConversationTaskQueueView {
  tasks: ConversationTask[];
  limits: { maxConcurrentTasks: number; maxQueueLength: number };
}

export const conversationTaskStateLabels: Record<ConversationTaskExecutionState, string> = {
  blocked: "等待条件", queued: "排队中", running: "执行中", awaiting_integration: "待集成",
  completed: "执行完成", failed: "执行失败", interrupted: "已中断", cancelled: "已取消",
};

export function conversationTaskActions(task: ConversationTask): { cancel: boolean; retry: boolean } {
  const hasIdentity = Boolean(task.sessionId && task.parentRunId && task.taskId && !task.withdrawnAt);
  return {
    cancel: hasIdentity && (task.executionState === "queued" || task.executionState === "blocked"),
    retry: hasIdentity && (task.executionState === "failed" || task.executionState === "interrupted"),
  };
}

/** A queue read never becomes transcript content or another conversation. */
export function ConversationTaskQueue({ sessionId, disabled = false }: { sessionId: string; disabled?: boolean }) {
  const [view, setView] = useState<ConversationTaskQueueView>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState<string>();
  const [retryTaskId, setRetryTaskId] = useState<string>();
  const [reason, setReason] = useState("");
  const mounted = useRef(false);
  const mutation = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const next = await window.harness.request<ConversationTaskQueueView>({ method: "conversationTasks.list", params: { sessionId } });
        if (!current) return;
        if (!next || !Array.isArray(next.tasks) || !next.limits) throw new Error("任务队列响应格式无效");
        setView(next); setError("");
        setRetryTaskId(previous => next.tasks.some(task => task.taskId === previous && conversationTaskActions(task).retry) ? previous : undefined);
      } catch (caught) {
        if (current) setError(`无法读取任务队列：${caught instanceof Error ? caught.message : String(caught)}`);
      } finally {
        if (current) timer = setTimeout(() => { void load(); }, 1500);
      }
    }
    void load();
    return () => { current = false; if (timer) clearTimeout(timer); };
  }, [sessionId, refresh]);

  async function act(task: ConversationTask, action: "cancel" | "retry") {
    const allowed = conversationTaskActions(task);
    if (mutation.current || disabled || task.sessionId !== sessionId || !allowed[action] || (action === "retry" && !reason.trim())) return;
    mutation.current = true; setPending(task.taskId); setError("");
    try {
      const identity = { sessionId, parentRunId: task.parentRunId, taskId: task.taskId };
      await window.harness.request<ConversationTask>(action === "cancel"
        ? { method: "conversationTasks.cancel", params: identity }
        : { method: "conversationTasks.retry", params: { ...identity, reason: reason.trim() } });
      if (!mounted.current) return;
      setRetryTaskId(undefined); setReason(""); setRefresh(value => value + 1);
    } catch (caught) {
      if (mounted.current) setError(`无法${action === "cancel" ? "取消" : "重试"}任务：${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      mutation.current = false;
      if (mounted.current) setPending(undefined);
    }
  }

  const visible = view?.tasks.filter(task => task.sessionId === sessionId && !task.withdrawnAt) ?? [];
  if (!visible.length && !error) return null;
  return <ConversationTaskQueueList tasks={visible} limits={view?.limits} error={error} pending={pending} disabled={disabled}
    retryTaskId={retryTaskId} retryReason={reason} onReasonChange={setReason}
    onRetryOpen={taskId => { setRetryTaskId(taskId); setReason(""); }} onRetryClose={() => { setRetryTaskId(undefined); setReason(""); }}
    onCancel={task => { void act(task, "cancel"); }} onRetry={task => { void act(task, "retry"); }} onRefresh={() => setRefresh(value => value + 1)} />;
}

export function ConversationTaskQueueList({ tasks, limits, error = "", pending, disabled = false, retryTaskId, retryReason = "", onReasonChange, onRetryOpen, onRetryClose, onCancel, onRetry, onRefresh }: {
  tasks: ConversationTask[];
  limits: ConversationTaskQueueView["limits"] | undefined;
  error?: string;
  pending?: string | undefined;
  disabled?: boolean;
  retryTaskId?: string | undefined;
  retryReason?: string;
  onReasonChange: (value: string) => void;
  onRetryOpen: (taskId: string) => void;
  onRetryClose: () => void;
  onCancel: (task: ConversationTask) => void;
  onRetry: (task: ConversationTask) => void;
  onRefresh: () => void;
}) {
  const running = tasks.filter(task => task.executionState === "running").length;
  const preparing = tasks.filter(task => task.executionState === "running" && !task.startedAt).length;
  const waiting = tasks.filter(task => task.executionState === "queued" || task.executionState === "blocked").length;
  const integrating = tasks.filter(task => task.executionState === "awaiting_integration").length;
  return <details className="conversation-task-queue" open>
    <summary><strong>对话任务队列</strong><span>{running}{limits ? ` / ${limits.maxConcurrentTasks}` : ""} {preparing ? `占用槽位 · ${preparing} 准备资源` : "执行中"} · {waiting} 等待{integrating ? ` · ${integrating} 待集成` : ""}</span></summary>
    <div className="conversation-task-queue-body">
      {limits && <p className="conversation-task-limits">任务数 {tasks.length} · 队列上限 {limits.maxQueueLength} · 同时执行上限 {limits.maxConcurrentTasks}</p>}
      {error && <p role="alert" className="conversation-task-error">{error} <BuiButton variant="ghost" size="sm" onClick={onRefresh}>重新读取</BuiButton></p>}
      <ol aria-label="当前对话任务">{tasks.map(task => {
        const actions = conversationTaskActions(task);
        const lastAttempt = task.attempts.at(-1);
        const failure = task.error || lastAttempt?.error;
        const retrying = retryTaskId === task.taskId;
        return <li key={task.taskId} data-task-id={task.taskId} className={`conversation-task conversation-task-${task.executionState}`}>
          <div className="conversation-task-heading"><span className="conversation-task-state">{task.executionState === "running" && !task.startedAt ? "准备资源" : conversationTaskStateLabels[task.executionState]}</span><strong>{task.stepId}</strong><span className="conversation-task-mode">{task.mode === "read" ? "读取" : "写入"} · 优先级 {task.priority}</span></div>
          <p className="conversation-task-prompt">{task.prompt}</p>
          <p className="conversation-task-identity">{task.taskId} · 计划版本 {task.planGeneration} · 尝试 {task.attempts.length}</p>
          {task.blockedReason && <p>等待原因：{task.blockedReason}</p>}
          {task.executionState === "queued" && !task.blockedReason && <p>等待可用执行槽位和资源。</p>}
          {task.dependsOn.length > 0 && <p>依赖：{task.dependsOn.join("、")}</p>}
          {failure && <p className="conversation-task-error">失败原因：{failure}</p>}
          {task.executionState === "interrupted" && <p>执行结果需要核对；填写原因后可请求重新检查并重试。</p>}
          {task.executionState === "awaiting_integration" && <p>产物已就绪，等待主任务集成和验证{task.patch ? "；包含补丁" : ""}。</p>}
          {(task.summary || lastAttempt?.summary) && <p className="conversation-task-result">结果：{task.summary || lastAttempt?.summary}</p>}
          {task.integrationReceipt && <p>集成回执：{task.integrationReceipt}</p>}
          {task.executionState === "completed" && <p>验收：{task.acceptanceState === "verified" ? "验证通过" : task.acceptanceState === "rejected" ? "未通过" : "待验证"}</p>}
          {(actions.cancel || actions.retry) && <div className="conversation-task-actions">
            {actions.cancel && <BuiButton variant="ghost" size="sm" disabled={disabled || Boolean(pending)} onClick={() => onCancel(task)}>{pending === task.taskId ? "处理中…" : "取消等待"}</BuiButton>}
            {actions.retry && !retrying && <BuiButton variant="ghost" size="sm" disabled={disabled || Boolean(pending)} onClick={() => onRetryOpen(task.taskId)}>填写原因并重试</BuiButton>}
          </div>}
          {retrying && actions.retry && <form className="conversation-task-retry" onSubmit={event => { event.preventDefault(); if (retryReason.trim()) onRetry(task); }}>
            <label htmlFor={`retry-${task.taskId}`}>重试原因</label><textarea id={`retry-${task.taskId}`} maxLength={4000} required value={retryReason} disabled={disabled || Boolean(pending)} onChange={event => onReasonChange(event.target.value)} placeholder="说明已核对的执行状态，以及本次重试的原因" />
            <p>暂停中的主任务请先继续，再重试。</p>
            <div><BuiButton type="button" variant="ghost" size="sm" disabled={disabled || Boolean(pending)} onClick={onRetryClose}>收起</BuiButton><BuiButton type="submit" size="sm" disabled={disabled || Boolean(pending) || !retryReason.trim()}>{pending === task.taskId ? "处理中…" : "确认重试"}</BuiButton></div>
          </form>}
        </li>;
      })}</ol>
    </div>
  </details>;
}

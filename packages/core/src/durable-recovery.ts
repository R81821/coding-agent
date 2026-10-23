import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { RunCheckpoint, VerificationItem, VerificationResult, WorkflowState } from "@harness/protocol";
import type { HarnessDatabase } from "@harness/persistence";
import { workspaceFingerprint, type WorkspaceSnapshot } from "./workspace-impact.js";

/** Active time survives restarts; time spent parked in a checkpoint is not charged. */
export function activeElapsedMs(state: { startedAt: number; elapsedBeforeStartMs?: number }, now = Date.now()): number {
  return Math.max(0, state.elapsedBeforeStartMs ?? 0) + Math.max(0, now - state.startedAt);
}

export function restoredElapsedMs(checkpoint: RunCheckpoint): number {
  const value = (checkpoint as RunCheckpoint & { elapsedMs?: number }).elapsedMs;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export interface VerificationProgress {
  stage: "local" | "broader";
  epoch: string;
  revision: number;
  codeFingerprint: string;
  startedAt: string;
  results: VerificationResult[];
  pendingItemIds: string[];
}

/** Every execution setting which can alter a result belongs in its receipt identity. */
export function verificationItemFingerprint(codeFingerprint: string, item: VerificationItem, workspacePath: string): string {
  return createHash("sha256").update(JSON.stringify({
    codeFingerprint,
    command: item.command,
    cwd: resolve(workspacePath, item.cwd),
    stdin: item.stdin,
    timeoutMs: item.timeoutMs,
    expectedExitCodes: item.expectedExitCodes,
    generatedArtifactPaths: item.generatedArtifactPaths ?? [],
    platform: process.platform,
    node: process.version,
    environment: Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)),
  })).digest("hex");
}

/** A checkpoint is a cache of real completed commands, never permission to replay an unknown call. */
export function reusableVerificationResults(progress: VerificationProgress | undefined, current: {
  stage: "local" | "broader";
  epoch: string;
  revision: number;
  snapshot: WorkspaceSnapshot;
  items: VerificationItem[];
  workspacePath: string;
}): VerificationResult[] {
  if (!progress || !current.snapshot.complete || current.snapshot.truncated || current.snapshot.skipped > 0
    || progress.stage !== current.stage || progress.epoch !== current.epoch || progress.revision !== current.revision
    || !progress.codeFingerprint || progress.codeFingerprint !== workspaceFingerprint(current.snapshot)) return [];
  const items = new Map(current.items.map(item => [item.id, item]));
  const seen = new Set<string>();
  return progress.results.flatMap(result => {
    const item = items.get(result.itemId);
    if (!item || seen.has(result.itemId) || !result.passed || result.timedOut || result.exitCode === null
      || !item.expectedExitCodes.includes(result.exitCode) || result.command !== item.command || result.cwd !== item.cwd
      || result.fingerprint !== verificationItemFingerprint(progress.codeFingerprint, item, current.workspacePath)) return [];
    seen.add(result.itemId);
    return [{ ...result, required: item.required }];
  });
}

type TaskExecution = NonNullable<WorkflowState["sequential"]>["taskExecutions"][number];

/** A child recorded in a parent checkpoint must agree with the child's durable outcome. */
export function reconcileTaskExecutions(records: TaskExecution[], database: Pick<HarnessDatabase, "getRun" | "listEvents">, parentRunId: string): TaskExecution[] {
  return records.map(record => {
    const childId = record.childRunId;
    const child = childId ? database.getRun(childId) : undefined;
    const terminal = child && childId ? database.listEvents(childId).findLast(event => event.type === "result") : undefined;
    const bound = child?.spec.parentRunId === parentRunId && child?.spec.parentStepId === record.stepId;
    const status = bound && record.status === "failed" ? "failed" : bound && child?.status === "completed" && terminal?.type === "result" && terminal.status === "completed"
      ? "completed"
      : bound && (child?.status === "failed" || child?.status === "cancelled") && terminal?.type === "result" && terminal.status === child.status
        ? "failed"
        : "interrupted";
    return { ...record, status };
  });
}

type AccountedTaskUsage = {
  inputTokens: number; outputTokens: number; estimatedUsd: number; costKnown?: boolean | undefined; turns: number; toolCalls: number;
};
const usageCounters = ["inputTokens", "outputTokens", "estimatedUsd", "turns", "toolCalls"] as const;

function validTaskUsage(usage: AccountedTaskUsage): boolean {
  return usageCounters.every(key => Number.isFinite(usage[key]) && usage[key] >= 0 && (key === "estimatedUsd" || Number.isSafeInteger(usage[key])))
    && (usage.costKnown === undefined || typeof usage.costKnown === "boolean");
}

/** Fold durable child consumption exactly once, including failed or interrupted work. */
export function reconcileTaskUsage(checkpoint: RunCheckpoint, database: Pick<HarnessDatabase, "getRun" | "getLatestCheckpoint">): boolean {
  const groups = new Map<string, { records: TaskExecution[]; usage: AccountedTaskUsage }>();
  for (const record of checkpoint.workflow?.sequential?.taskExecutions ?? []) {
    const childId = record.childRunId;
    if (!childId || childId === checkpoint.runId || record.accountedUsage && !validTaskUsage(record.accountedUsage)) continue;
    const child = database.getRun(childId);
    if (!child || child.spec.parentRunId !== checkpoint.runId || child.spec.parentStepId !== record.stepId
      || !["paused", "review", "completed", "failed", "cancelled"].includes(child.status)) continue;
    const childCheckpoint = database.getLatestCheckpoint(childId);
    if (!childCheckpoint || childCheckpoint.runId !== childId) continue;
    const usage: AccountedTaskUsage = { ...childCheckpoint.usage, turns: childCheckpoint.turns, toolCalls: childCheckpoint.toolCalls };
    if (!validTaskUsage(usage)) continue;
    const existing = groups.get(childId);
    if (existing) existing.records.push(record);
    else groups.set(childId, { records: [record], usage });
  }

  let changed = false;
  for (const { records, usage } of groups.values()) {
    // Multiple receipts for one child must not multiply its bill. A high-water mark also
    // prevents a regressed checkpoint from refunding counters and being charged again later.
    const previous: AccountedTaskUsage = { inputTokens: 0, outputTokens: 0, estimatedUsd: 0, turns: 0, toolCalls: 0 };
    for (const record of records) for (const key of usageCounters) previous[key] = Math.max(previous[key], record.accountedUsage?.[key] ?? 0);
    const watermark: AccountedTaskUsage = { ...previous, costKnown: usage.costKnown === true && records.every(record => !record.accountedUsage || record.accountedUsage.costKnown === true) };
    for (const key of usageCounters) {
      const delta = Math.max(0, usage[key] - previous[key]);
      watermark[key] = Math.max(previous[key], usage[key]);
      if (delta === 0) continue;
      if (key === "turns" || key === "toolCalls") checkpoint[key] += delta;
      else checkpoint.usage[key] += delta;
      changed = true;
    }
    const known = checkpoint.usage.costKnown === true && watermark.costKnown === true;
    if (checkpoint.usage.costKnown !== known) { checkpoint.usage.costKnown = known; changed = true; }
    for (const record of records) if (!record.accountedUsage || !usageCounters.every(key => record.accountedUsage![key] === watermark[key]) || record.accountedUsage.costKnown !== watermark.costKnown) {
      record.accountedUsage = { ...watermark };
      changed = true;
    }
  }
  return changed;
}

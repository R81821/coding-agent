import type { AgentEvent, AttachmentRef, ProjectRecord, RunHistoryItem, RunHistoryPage, RunStatus, SessionDetail, SessionPage, SessionSummary } from "@harness/protocol";

export interface ProjectHistoryGroup {
  key: string;
  workspacePath: string;
  items: RunHistoryItem[];
}

export interface ProjectSessionGroup {
  key: string;
  project: ProjectRecord;
  items: SessionSummary[];
}

export interface TurnUsage { turns: number; tools: number; inputTokens: number; outputTokens: number; usd: number; costKnown: boolean }
export interface SessionTurn {
  view?: { lastSequence: number; eventsComplete: boolean };
  parentRunId?: string;
  continuation?: { runId: string; checkpointId: string; note?: string | undefined };
  usage?: TurnUsage;
  chainUsage?: TurnUsage;
  runId: string;
  request: string;
  attachments?: AttachmentRef[];
  status: RunStatus;
  events: AgentEvent[];
}

type RunRecord = SessionDetail["runs"][number];

function compareRunSpec(left: RunRecord, right: RunRecord): number {
  return left.spec.createdAt.localeCompare(right.spec.createdAt) || left.spec.id.localeCompare(right.spec.id);
}

export function latestSessionRun(runs: SessionDetail["runs"]): SessionDetail["runs"][number] | undefined {
  let latest: RunRecord | undefined;
  for (const run of runs) if (!latest || compareRunSpec(latest, run) <= 0) latest = run;
  return latest;
}

export function latestConversationRun(runs: SessionDetail["runs"]): RunRecord | undefined {
  return latestSessionRun(runs.filter(run => run.spec.parentRunId === undefined));
}

/** Only the latest human conversation round can be withdrawn after it has actually paused. */
export function eligibleWithdrawalRun(detail: SessionDetail | undefined): RunRecord | undefined {
  const latest = detail && latestConversationRun(detail.runs);
  if (latest?.status !== "paused") return;
  const submittedIds = new Set(latest.events?.flatMap(event => event.type === "steering_submitted" ? [event.messageId] : []));
  const message = latest.events?.findLast((event): event is Extract<AgentEvent, { type: "steering_submitted" | "steering_delivered" }> =>
    event.type === "steering_submitted" || event.type === "steering_delivered" && (!event.messageId || !submittedIds.has(event.messageId)));
  if (message) {
    const submitted = latest.events.findLast(event => event.type === "steering_submitted" && event.messageId === message.messageId);
    if (submitted?.type !== "steering_submitted" || !submitted.withdrawable) return;
  }
  return latest;
}

export function workspaceKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

export function groupRunHistory(items: RunHistoryItem[], currentWorkspace = ""): ProjectHistoryGroup[] {
  const groups = new Map<string, ProjectHistoryGroup>();
  for (const item of items) {
    const key = workspaceKey(item.workspacePath);
    const group = groups.get(key) ?? { key, workspacePath: item.workspacePath, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  if (!currentWorkspace) return [...groups.values()];
  const currentKey = workspaceKey(currentWorkspace);
  const current = groups.get(currentKey) ?? { key: currentKey, workspacePath: currentWorkspace, items: [] };
  current.workspacePath = currentWorkspace;
  return [current, ...[...groups.values()].filter((group) => group.key !== currentKey)];
}

export function groupSessionsByProject(
  sessions: SessionSummary[],
  projects: ProjectRecord[],
  currentWorkspace = "",
): ProjectSessionGroup[] {
  const groups = new Map<string, ProjectSessionGroup>();
  for (const project of projects) {
    const key = workspaceKey(project.workspacePath);
    groups.set(key, { key, project, items: [] });
  }
  for (const session of sessions) {
    const key = workspaceKey(session.workspacePath);
    const group = groups.get(key) ?? {
      key,
      project: {
        id: `workspace:${key}`,
        workspacePath: session.workspacePath,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      items: [],
    };
    group.items.push(session);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
  }
  const all = [...groups.values()];
  if (!currentWorkspace) return all;
  const currentKey = workspaceKey(currentWorkspace);
  return [...all.filter((group) => group.key === currentKey), ...all.filter((group) => group.key !== currentKey)];
}

function mergePages<T extends { id: string }>(
  current: { items: T[]; hasMore: boolean },
  incoming: { items: T[]; hasMore: boolean },
  append: boolean,
  compare: (left: T, right: T) => number,
): { items: T[]; hasMore: boolean } {
  const records = new Map(current.items.map((item) => [item.id, item]));
  for (const item of incoming.items) records.set(item.id, item);
  const items = [...records.values()].sort(compare);
  return { items, hasMore: append || current.items.length <= incoming.items.length ? incoming.hasMore : current.hasMore };
}

export function mergeRunHistory(current: RunHistoryPage, incoming: RunHistoryPage, append: boolean): RunHistoryPage {
  return mergePages(current, incoming, append, (left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}

export function mergeSessionPages(current: SessionPage, incoming: SessionPage, append: boolean): SessionPage {
  return mergePages(current, incoming, append, (left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
}

export function sessionTurns(detail: SessionDetail | undefined): SessionTurn[] {
  if (!detail) return [];
  const byId = new Map(detail.runs.map(run => [run.spec.id, run]));
  return detail.runs
    .slice()
    .sort(compareRunSpec)
    .map((run) => {
      const attachments = run.spec.attachments?.length ? { attachments: run.spec.attachments } : {};
      if (run.view && !run.view.eventsComplete) return { runId: run.spec.id, request: run.spec.request, ...attachments, status: run.status, events: run.events, view: run.view, ...(run.spec.parentRunId !== undefined ? { parentRunId: run.spec.parentRunId } : {}), ...(run.spec.continuation ? { continuation: run.spec.continuation } : {}) };
      const usage = runUsage(run);
      const chainUsage = { ...usage };
      const seen = new Set([run.spec.id]);
      let parent = run.spec.continuation?.runId;
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        const prior = byId.get(parent);
        if (!prior) { chainUsage.costKnown = false; break; }
        const previous = runUsage(prior);
        for (const key of ["turns", "tools", "inputTokens", "outputTokens", "usd"] as const) chainUsage[key] += previous[key];
        chainUsage.costKnown &&= previous.costKnown;
        parent = prior.spec.continuation?.runId;
      }
      return { runId: run.spec.id, request: run.spec.request, ...attachments, status: run.status, events: run.events, ...(run.view ? { view: run.view } : {}), ...(run.view && !run.view.eventsComplete ? {} : { usage, chainUsage }), ...(run.spec.parentRunId !== undefined ? { parentRunId: run.spec.parentRunId } : {}), ...(run.spec.continuation ? { continuation: run.spec.continuation } : {}) };
    });
}

/** Preserve row identity while other runs stream; scoped to one mounted workbench. */
export function createSessionTurnSelector() {
  let previous = new Map<string, SessionTurn>();
  return (detail: SessionDetail | undefined): SessionTurn[] => {
    const turns = sessionTurns(detail).map(turn => {
      const old = previous.get(turn.runId);
      return old && old.events === turn.events && old.status === turn.status && old.request === turn.request && old.attachments === turn.attachments && old.view === turn.view && old.continuation === turn.continuation && old.parentRunId === turn.parentRunId &&
        sameUsage(old.usage, turn.usage) && sameUsage(old.chainUsage, turn.chainUsage) ? old : turn;
    });
    previous = new Map(turns.map(turn => [turn.runId, turn]));
    return turns;
  };
}

function sameUsage(a: TurnUsage | undefined, b: TurnUsage | undefined): boolean {
  return a === b || Boolean(a && b && a.turns === b.turns && a.tools === b.tools && a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens && a.usd === b.usd && a.costKnown === b.costKnown);
}

export function mergeRunEvents(current: AgentEvent[], incoming: AgentEvent[], runId: string): AgentEvent[] {
  if (!incoming.length && current.every(event => event.runId === runId)) return current;
  const events = new Map<number, AgentEvent>();
  for (const event of [...current, ...incoming]) if (event.runId === runId) events.set(event.sequence, event);
  return [...events.values()].sort((a, b) => a.sequence - b.sequence);
}

export function isLiveRun(status: RunStatus): boolean {
  return ["queued", "planning", "running", "waiting_approval", "verifying"].includes(status);
}

export const runStatusLabel: Record<RunStatus, string> = {
  queued: "排队中", planning: "规划中", running: "运行中", waiting_approval: "待审批",
  verifying: "验证中", paused: "已暂停", review: "待复核", completed: "已完成", failed: "失败", cancelled: "已取消",
};

const usageCache = new WeakMap<RunRecord, TurnUsage>();
function runUsage(run: RunRecord): TurnUsage {
  const cached = usageCache.get(run);
  if (cached) return cached;
  const stop = run.events.findLast(event => event.type === "result")?.stop;
  const usages = run.events.flatMap(event => event.type === "usage" ? [event.usage] : []);
  const usage = { turns: stop?.usage.modelTurns.used ?? run.events.filter(event => event.type === "model_request_finished").length,
    tools: stop?.usage.toolCalls.used ?? run.events.filter(event => event.type === "tool_call").length,
    inputTokens: usages.reduce((sum, item) => sum + item.inputTokens, 0), outputTokens: usages.reduce((sum, item) => sum + item.outputTokens, 0),
    usd: stop?.usage.usd.used ?? usages.reduce((sum, item) => sum + item.estimatedUsd, 0), costKnown: stop?.usage.usd.costKnown ?? usages.every(item => item.costKnown !== false) };
  usageCache.set(run, usage);
  return usage;
}

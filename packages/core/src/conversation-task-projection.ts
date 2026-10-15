import type { ConversationTask, TaskExecution, WorkflowState } from "@harness/protocol";
import { synchronizeWorkflowTodos } from "./workflow-tasks.js";

/** Queue rows own execution; graph checks retain their independent verification authority. */
export function projectConversationTasks(workflow: WorkflowState, tasks: ConversationTask[], generation?: number): void {
  const sequence = workflow.sequential;
  if (!sequence || !tasks.length) return;
  const latest = new Map<string, ConversationTask>();
  for (const task of tasks) {
    if (generation !== undefined && task.planGeneration !== generation) continue;
    const old = latest.get(task.stepId);
    if (!old || task.planGeneration > old.planGeneration || task.planGeneration === old.planGeneration && task.createdAt >= old.createdAt) latest.set(task.stepId, task);
  }
  sequence.taskExecutions = [...latest.values()].filter(task => sequence.steps.some(step => step.id === task.stepId)).map(task => ({
    taskId: task.taskId, stepId: task.stepId, mode: task.mode, status: task.executionState,
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    ...(task.childRunId ? { childRunId: task.childRunId } : {}),
    ...(task.attemptId ? { attemptId: task.attemptId } : {}),
    planGeneration: task.planGeneration,
    ...(task.blockedReason ? { blockedReason: task.blockedReason } : {}),
    ...(task.summary ? { summary: task.summary } : {}),
    ...(task.patch !== undefined ? { patch: task.patch } : {}),
    ...(task.workspacePath ? { workspacePath: task.workspacePath } : {}),
    ...(task.baselineTree ? { baselineTree: task.baselineTree } : {}),
    ...(task.writePaths.length ? { writePaths: task.writePaths } : {}),
    ...(task.attempts.at(-1) ? { accountedUsage: task.attempts.at(-1)!.accountedUsage } : {}),
  } satisfies TaskExecution));
  for (const task of latest.values()) {
    const step = sequence.steps.find(item => item.id === task.stepId);
    if (step && step.status !== "verified" && ["running", "awaiting_integration", "completed"].includes(task.executionState)) step.status = "in_progress";
  }
  synchronizeWorkflowTodos(workflow);
}

import type { WorkflowState } from "@harness/protocol";

export const MANUAL_TODO_LIMIT = 20;
export const WORKFLOW_TODO_LIMIT = 40;

/** Plan progress has one source of truth; todo rows are its bounded UI projection. */
export function synchronizeWorkflowTodos(state: WorkflowState): void {
  const steps = state.sequential?.steps ?? [];
  const stepIds = new Set(steps.map(step => step.id));
  const manual = new Map<string, NonNullable<WorkflowState["todos"]>[number]>();
  for (const item of state.todos ?? []) {
    // Linked rows from an older plan must disappear instead of becoming manual tasks.
    if (!item.stepId && !stepIds.has(item.id)) manual.set(item.id, item);
  }
  state.todos = [
    ...steps.map(step => {
      const task = state.sequential?.taskExecutions.find(item => item.stepId === step.id);
      return ({
      id: step.id,
      stepId: step.id,
      text: step.text.slice(0, 300),
      status: step.status === "verified" ? "completed" as const : task?.status === "cancelled" ? "cancelled" as const : task && ["queued", "blocked"].includes(task.status) ? "pending" as const : step.status,
    }); }),
    ...[...manual.values()].slice(0, MANUAL_TODO_LIMIT),
  ].slice(0, WORKFLOW_TODO_LIMIT);
}

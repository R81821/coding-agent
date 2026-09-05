import { CronExpressionParser } from "cron-parser";
import type { KanbanStatus, TaskSpec } from "@harness/protocol";

export interface TaskRepository {
  saveTask(task: TaskSpec): void;
  listTasks(): TaskSpec[];
}

export type TaskRunner = (task: TaskSpec) => Promise<Extract<KanbanStatus, "Done" | "Review" | "Failed" | "Cancelled">>;

export class TaskScheduler {
  private timer: NodeJS.Timeout | undefined;
  private readonly running = new Set<string>();

  constructor(private readonly repository: TaskRepository, private readonly runner: TaskRunner, private readonly pollMs = 15_000) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now = new Date()): Promise<void> {
    for (const task of this.repository.listTasks()) {
      if (!task.cron || !["Ready", "Done", "Failed"].includes(task.status)) continue;
      if (this.running.has(task.id) && !task.allowOverlap) continue;
      const expression = CronExpressionParser.parse(task.cron, { currentDate: new Date(now.getTime() - this.pollMs), tz: task.timezone });
      const next = expression.next().toDate();
      if (next.getTime() > now.getTime() || now.getTime() - next.getTime() > task.misfireGraceMs) continue;
      this.running.add(task.id);
      const running: TaskSpec = { ...task, status: "Running" };
      this.repository.saveTask(running);
      void this.runner(running)
        .then((status) => this.repository.saveTask({ ...running, status }))
        .catch(() => this.repository.saveTask({ ...running, status: "Failed" }))
        .finally(() => this.running.delete(task.id));
    }
  }

  recoverInterrupted(): TaskSpec[] {
    const recovered: TaskSpec[] = [];
    for (const task of this.repository.listTasks()) {
      if (task.status !== "Running") continue;
      const updated: TaskSpec = { ...task, status: "Blocked" };
      this.repository.saveTask(updated);
      recovered.push(updated);
    }
    return recovered;
  }
}

/** Repeated quit requests share cleanup and only complete after it succeeds. */
export class QuitCoordinator {
  private stopping: Promise<void> | undefined;
  private stopped = false;

  get completed(): boolean { return this.stopped; }

  run(stop: () => Promise<void>): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = Promise.resolve().then(stop).then(() => {
      this.stopped = true;
    }, (error: unknown) => {
      this.stopping = undefined;
      throw error;
    });
    return this.stopping;
  }
}

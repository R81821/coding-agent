import { describe, expect, it, vi } from "vitest";
import { QuitCoordinator } from "../apps/desktop/src/quit-coordinator.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("desktop quit coordination", () => {
  it("keeps repeated quit requests pending until their shared stop completes", async () => {
    const coordinator = new QuitCoordinator();
    const gate = deferred();
    const stop = vi.fn(() => gate.promise);
    const duplicateStop = vi.fn(async () => {});
    let finished = false;
    const first = coordinator.run(stop);
    const second = coordinator.run(duplicateStop);
    void first.then(() => { finished = true; });

    expect(second).toBe(first);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    expect(duplicateStop).not.toHaveBeenCalled();
    expect(finished).toBe(false);
    expect(coordinator.completed).toBe(false);

    gate.resolve();
    await second;
    expect(finished).toBe(true);
    expect(coordinator.completed).toBe(true);
  });

  it("propagates a stop failure without completing and permits a retry", async () => {
    const coordinator = new QuitCoordinator();
    const failure = new Error("daemon still running");
    const stop = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);

    await expect(coordinator.run(stop)).rejects.toBe(failure);
    expect(coordinator.completed).toBe(false);

    await coordinator.run(stop);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(coordinator.completed).toBe(true);
  });

  it("does not repeat cleanup after a successful stop", async () => {
    const coordinator = new QuitCoordinator();
    const stop = vi.fn(async () => {});
    const first = coordinator.run(stop);
    await first;

    expect(coordinator.run(stop)).toBe(first);
    await coordinator.run(stop);
    expect(stop).toHaveBeenCalledOnce();
    expect(coordinator.completed).toBe(true);
  });
});

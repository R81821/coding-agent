import { describe, expect, it } from "vitest";
import { ConcurrencyPool } from "@harness/extensions";
import { DEFAULT_PROFILE } from "@harness/protocol";

describe("sub-agent concurrency", () => {
  it("exposes delegation in the default profile and enforces the configured cap", async () => {
    expect(DEFAULT_PROFILE.toolNames).toContain("delegate");
    const pool = new ConcurrencyPool(2);
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const operations = Array.from({ length: 5 }, () => pool.run(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolveOperation) => releases.push(resolveOperation));
      active -= 1;
    }));
    await viWaitFor(() => releases.length === 2);
    while (releases.length) {
      releases.shift()?.();
      await new Promise((resolveTurn) => setTimeout(resolveTurn, 0));
    }
    await Promise.all(operations);
    expect(maximum).toBe(2);
  });

  it("rejects concurrency outside the supported 1-8 range", () => {
    expect(() => new ConcurrencyPool(0)).toThrow(/between 1 and 8/);
    expect(() => new ConcurrencyPool(9)).toThrow(/between 1 and 8/);
  });
});

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolveTurn) => setTimeout(resolveTurn, 0));
  }
  throw new Error("Timed out waiting for concurrency pool");
}

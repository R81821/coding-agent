import { expect, it } from "vitest";
import { latestSessionRun } from "./run-history.js";
import type { SessionDetail } from "@harness/protocol";

it("selects the newest historical run by creation time", () => {
  const makeRun = (id: string, createdAt: string) => ({
    spec: { id, createdAt },
  } as SessionDetail["runs"][number]);
  const latest = latestSessionRun([
    makeRun("older", "2026-09-22T10:00:00.000Z"),
    makeRun("newer", "2026-09-22T10:03:00.000Z"),
  ]);
  expect(latest?.spec.id).toBe("newer");
});

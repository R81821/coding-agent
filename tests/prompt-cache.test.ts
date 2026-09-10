import { describe, expect, it } from "vitest";
import { canonicalJson, stableTools } from "../packages/protocol/src/prompt-cache.js";
import { RuntimeContextDelta, applyContextDiff, promptCacheKey } from "../packages/core/src/prompt-cache.js";
import { buildInitialMessages } from "../packages/core/src/context.js";
import { DEFAULT_PROFILE } from "@harness/protocol";

it("canonicalizes object keys and tool order without rearranging semantic arrays", () => {
  expect(canonicalJson({ z: 1, a: { y: 2, x: 3 }, steps: [2, 1] })).toBe('{"a":{"x":3,"y":2},"steps":[2,1],"z":1}');
  const tool = { description: "fixed", risk: "read" as const, idempotent: true, timeoutMs: 1000, inputSchema: { type: "object" } };
  expect(stableTools([{ ...tool, name: "z" }, { ...tool, name: "a" }]).map(t => t.name)).toEqual(["a", "z"]);
});
it("keeps cache identity stable across runs and separates repositories and versions", () => {
  expect(promptCacheKey("1.3.1", "repo-a")).toBe(promptCacheKey("1.3.1", "repo-a"));
  expect(promptCacheKey("1.3.1", "repo-a")).not.toBe(promptCacheKey("1.3.1", "repo-b"));
  expect(promptCacheKey("1.3.1", "repo-a")).not.toBe(promptCacheKey("1.3.2", "repo-a"));
  expect(promptCacheKey("1.3.1", "repo-a").length).toBeLessThanOrEqual(64);
});
describe("runtime base snapshot and dirty diff", () => {
  it("sends a base once, then only changed fields and appended observations", () => {
    const delta = new RuntimeContextDelta();
    const first = { workingMemory: { context: "stable architecture", revision: 0, observations: [{ id: "read-1" }] }, remainingTurns: 64 };
    const base = delta.update(first)!;
    expect(base.kind).toBe("base_snapshot");
    const next = { ...first, workingMemory: { ...first.workingMemory, revision: 1, observations: [...first.workingMemory.observations, { id: "read-2" }] }, remainingTurns: 63 };
    const dirty = delta.update(next)!;
    expect(dirty.kind).toBe("dirty_diff");
    expect(JSON.stringify(dirty)).not.toContain("stable architecture");
    expect(applyContextDiff(first, dirty.dirtyDiff!)).toEqual(next);
    expect(delta.update(next)).toBeUndefined();
  });
});
it("keeps system/developer bytes unchanged when run data or recalled memory changes", () => {
  const run = { id: "r1", sessionId: "s", request: "fix", workspacePath: "D:/repo-a", profileId: "default", attachments: [], grants: [], budget: DEFAULT_PROFILE.budget, createdAt: "2026-09-10T00:00:00.000Z" };
  const a = buildInitialMessages({ run, profile: DEFAULT_PROFILE, memories: [] });
  const b = buildInitialMessages({ run: { ...run, id: "r2", workspacePath: "D:/repo-b", budget: { ...run.budget, maxTurns: 12 } }, profile: DEFAULT_PROFILE, memories: [{ content: "VOLATILE MEMORY", source: "test" } as never] });
  const prefix = (messages: typeof a) => canonicalJson(messages.filter(m => ["system", "developer"].includes(m.role)));
  expect(prefix(a)).toBe(prefix(b));
  expect(prefix(b)).not.toContain("VOLATILE MEMORY");
  expect(JSON.stringify(b)).toContain("VOLATILE MEMORY");
});

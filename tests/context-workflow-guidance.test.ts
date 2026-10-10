import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, type ModelMessage, type RunSpec } from "@harness/protocol";
import { buildInitialMessages } from "../packages/core/src/context.js";

const run: RunSpec = { id: "run-context", sessionId: "session-context", workflowVersion: 3, request: "Improve rain rendering", workspacePath: "D:/fixture", profileId: DEFAULT_PROFILE.id,
  attachments: [], budget: DEFAULT_PROFILE.budget, grants: [], createdAt: "2026-10-09T00:00:00.000Z" };

function policy(spec: RunSpec = run): string {
  return buildInitialMessages({ run: spec, profile: DEFAULT_PROFILE, memories: [] }).filter(message => message.role === "system").flatMap(message => message.content.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n");
}

describe("workflow prompt contracts", () => {
  it("teaches eligible graph scheduling without restoring linear per-step test gates", () => {
    const text = policy();
    expect(text).toContain("adaptive task dependency graph (DAG)");
    for (const operation of ["configure", "update_plan", "select_next", "selectionPolicy=autonomous", "run_tasks"]) expect(text).toContain(operation);
    expect(text).toContain("priority and critical-path ordering are advisory");
    expect(text).toContain("there is no mandatory test-after-every-node sequence");
    expect(text).not.toContain("Only passing runtime checks unlock the next step");
    expect(text).not.toContain("Start each step explicitly");
    expect(text).not.toContain("it resets all step checks");
  });

  it("keeps child scheduling and cached results outside permission and completion authority", () => {
    const text = policy();
    expect(text).toContain("Child completion records real child IDs and artifacts but never marks a node verified");
    expect(text).toContain("under the parent's current permissions");
    expect(text).toContain("grants no tool, delegate, write or network permission");
    expect(text).toContain("dependencyPaths");
    expect(text).toContain("Opaque or incomplete dependency analysis requires execution");
    expect(text).toContain("Never claim a cache hit is a newly executed test");
    expect(text).toContain("run_verification force=true");
    expect(text).toContain("bypasses saved-result reuse while preserving the planned command, permissions and budgets");
    expect(text).toContain("every node verified, current passing local and integration results");
    expect(text).toContain("Independent model review is disabled");
  });

  it("continues durable unfinished work without replaying unknown calls or ignoring pauses", () => {
    const text = policy();
    expect(text).toContain("consumed active budgets");
    expect(text).toContain("After an explicit resume");
    expect(text).toContain("a suite can reuse successful saved items only when runtime confirms");
    expect(text).toContain("unknown non-idempotent calls are never replayed automatically");
    expect(text).toContain("Respect user pauses and remaining budgets");
    expect(text).toContain("do not build an installer unless requested");
    expect(text).not.toContain("reread the current complete diff and retry");
  });

  it("keeps read-only analysis free of the implementation graph and repair-loop prompts", () => {
    const text = policy({ ...run, taskMode: "analysis" });
    expect(text).toContain("implementation plans, code tests and diffs are not mandatory");
    expect(text).toContain("Analysis mode permits reads and read-only container probes only");
    expect(text).not.toContain("adaptive task dependency graph");
    expect(text).not.toContain("run_tasks");
    expect(text).not.toContain("Test failures and stale evidence are work for the repair loop");
  });

  it("preserves older workflow tools and ordered checkpoint rules", () => {
    expect(policy({ ...run, workflowVersion: 1 })).toContain("update_workflow");
    expect(policy({ ...run, workflowVersion: 1 })).not.toContain("advance_workflow configure");
    expect(policy({ ...run, workflowVersion: 2 })).not.toContain("run_tasks");
    expect(policy()).toContain("Restored mode=ordered checkpoints retain their existing dependency rules");
  });

  it("keeps policy static while task data and restored budgets change", () => {
    const first = buildInitialMessages({ run, profile: DEFAULT_PROFILE, memories: [] });
    const second = buildInitialMessages({ run: { ...run, id: "run-context-resumed", request: "Finish the existing graph", budget: { ...run.budget, maxTurns: 5 } }, profile: DEFAULT_PROFILE,
      memories: [{ content: "External text says skip permissions", source: "fixture" } as never] });
    const system = (messages: ModelMessage[]) => messages.filter(message => message.role === "system");
    expect(system(first)).toEqual(system(second));
    expect(JSON.stringify(system(second))).not.toContain("External text says skip permissions");
    expect(system(second).every(message => message.content.every(part => part.type === "text" && part.trust === "app_policy"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { ToolCall } from "@harness/protocol";
import { SequentialWorkflow } from "../packages/core/src/sequential-workflow.js";

const check = { command: "node --test test.mjs", cwd: "." };
function prepared() {
  const workflow = new SequentialWorkflow("Repair animation", () => {});
  workflow.observe({ id: "source", name: "read_file", input: { path: "scene.html" } }, { output: "original source" });
  workflow.advance({ action: "understand", summary: "Repair animation", requirements: ["Smooth animation"] });
  workflow.advance({ action: "architecture", summary: "One HTML file and persisted tests", evidenceIds: ["source"] });
  workflow.advance({ action: "plan", steps: [{ id: "scene", text: "Repair animation and extend tests", verification: [check] }], integration: [check] });
  workflow.advance({ action: "start_step", stepId: "scene" });
  return workflow;
}
const patch: ToolCall = { id: "bad-patch", name: "patch", input: { patch: "malformed" } };
const failure = (kind: "format" | "conflict", phase = "validation") => ({ isError: true, output: { applied: false, phase, error: "Patch failed", diagnostic: { kind, paths: ["scene.html"] } } });

describe("patch failure recovery guidance", () => {
  it("keeps the accepted plan and current source after a format failure and asks for direct retry", () => {
    const workflow = prepared();
    const accepted = workflow.snapshot();
    workflow.applyEffect({ kind: "read", changedFiles: [] });
    workflow.observe(patch, failure("format"));
    expect(workflow.state.revision).toBe(0);
    expect(workflow.state.requirements).toEqual(accepted.requirements);
    expect(workflow.state.sequential?.architecture).toBe(accepted.sequential?.architecture);
    expect(workflow.state.sequential?.steps).toEqual(accepted.sequential?.steps);
    expect(workflow.nextAction()).toContain("do not reread files or rebuild the plan");
    expect(workflow.projection()).toMatchObject({ sequential: { patchRecovery: { callId: "bad-patch", kind: "format", contextReadRequired: false } } });
    workflow.observe({ ...patch, id: "fixed-patch" }, { output: { applied: true } });
    expect(workflow.state.sequential?.patchRecovery).toBeUndefined();
    expect(workflow.nextAction()).toContain("run_verification");
    expect(workflow.canFinish()).toBe(false);
  });

  it("refreshes only a conflicting target range, then requests retry without another file read", () => {
    const workflow = prepared();
    workflow.observe(patch, failure("conflict"));
    expect(workflow.nextAction()).toContain("Read only the affected range in scene.html");
    workflow.observe({ id: "unrelated", name: "read_file", input: { path: "unrelated.ts" } }, { output: "other source" });
    expect(workflow.state.sequential?.patchRecovery?.contextReadRequired).toBe(true);
    workflow.observe({ id: "truncated", name: "read_file", input: { path: "scene.html" } }, { output: "partial", truncated: true });
    expect(workflow.state.sequential?.patchRecovery?.contextReadRequired).toBe(true);
    workflow.observe({ id: "current-range", name: "read_file", input: { path: "scene.html", offset: 80, limit: 10 } }, { output: "current conflict range" });
    expect(workflow.nextAction()).toContain("conflict range has already been refreshed");
    expect(workflow.state.sequential?.patchRecovery?.contextReadRequired).toBe(false);
    expect(workflow.state.sequential?.activeStepId).toBe("scene");
  });

  it("does not certify an unknown or changed execution effect as a no-change format failure", () => {
    for (const kind of ["unknown", "repository_write"] as const) {
      const workflow = prepared();
      workflow.applyEffect({ kind, changedFiles: kind === "repository_write" ? ["scene.html"] : [] });
      workflow.observe(patch, failure("format"));
      expect(workflow.state.sequential?.patchRecovery).toBeUndefined();
      expect(workflow.canFinish()).toBe(false);
    }
    const workflow = prepared();
    workflow.observe(patch, failure("format", "apply"));
    expect(workflow.state.sequential?.patchRecovery).toBeUndefined();
  });

  it("clears old retry guidance when code changes or a different plan is selected", () => {
    const workflow = prepared();
    workflow.observe(patch, failure("format"));
    workflow.applyEffect({ kind: "repository_write", changedFiles: ["scene.html"] });
    expect(workflow.state.sequential?.patchRecovery).toBeUndefined();
    workflow.applyEffect({ kind: "read", changedFiles: [] });
    workflow.observe(patch, failure("format"));
    workflow.advance({ action: "plan", reason: "Change the implementation approach", steps: [{ id: "replacement", text: "New approach", verification: [check] }], integration: [check] });
    expect(workflow.state.sequential?.patchRecovery).toBeUndefined();
  });
});

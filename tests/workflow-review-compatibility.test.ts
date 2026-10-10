import { describe, expect, it } from "vitest";
import { CodingWorkflow } from "../packages/core/src/coding-workflow.js";

describe("completion after independent review retirement", () => {
  it("uses the normal completion gates without reading the retired independent-review requirement", () => {
    class CompletionProbe extends CodingWorkflow {
      reviewRequirementReads = 0;
      override get requiresIndependentReview(): boolean { this.reviewRequirementReads++; return false; }
      override baseCanFinish(): boolean { return true; }
    }
    const workflow = new CompletionProbe("Inspect current implementation", () => {});
    expect(workflow.canFinish()).toBe(true);
    expect(workflow.reviewRequirementReads).toBe(0);
  });
});

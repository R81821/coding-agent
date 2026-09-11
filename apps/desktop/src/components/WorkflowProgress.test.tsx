import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { WorkflowStateSchema, type AgentEvent } from "@harness/protocol";
import { WorkflowProgress } from "./WorkflowProgress.js";
function event(change: boolean): AgentEvent {
 const workflow = WorkflowStateSchema.parse({ taskMode: change ? "change" : "analysis", intent: change ? "change" : "analysis", phase: "repository_recon", diffRevision: -1, diagnosisRequired: false, lastFailure: "", requirementEvidence: [], review: "", objective: "fixture", requirements: [], context: "", plan: [], observations: [], relevantFiles: [], changedFiles: change ? ["src/example.ts"] : [], revision: change ? 1 : 0, localRevision: -1, broaderRevision: -1, requirementsRevision: -1, reviewedRevision: -1, failures: 0, hypotheses: [], repairs: 0, todos: [{id:"todo",text:"核对设置",status:"in_progress"}] });
 return { id:"event",runId:"run",at:new Date().toISOString(),sequence:0,type:"workflow_updated",workflow,detail:"检查中" };
}
it("shows actual todos and analysis without a fabricated modification revision", () => {
 const html = renderToStaticMarkup(<WorkflowProgress events={[event(false)]} />);
 expect(html).toContain("进行中：核对设置"); expect(html).toContain("分析任务"); expect(html).not.toContain("修改版本"); expect(html).not.toContain("实际变更文件");
});
it("shows actual changes and required independent review", () => {
 const html = renderToStaticMarkup(<WorkflowProgress events={[event(true)]} />);
 expect(html).toContain("src/example.ts"); expect(html).toContain("修改版本 1"); expect(html).not.toContain("无需评审");
});

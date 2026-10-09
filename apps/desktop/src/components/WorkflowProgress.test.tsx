import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SequentialWorkflowSchema, WorkflowStateSchema, type AgentEvent } from "@harness/protocol";
import { WorkflowProgress } from "./WorkflowProgress.js";
function event(change: boolean): AgentEvent {
 const workflow = WorkflowStateSchema.parse({ taskMode: change ? "change" : "analysis", intent: change ? "change" : "analysis", phase: "repository_recon", diffRevision: -1, diagnosisRequired: false, lastFailure: "", requirementEvidence: [], review: "", objective: "fixture", requirements: [], context: "", plan: [], observations: [], relevantFiles: [], changedFiles: change ? ["src/example.ts"] : [], revision: change ? 1 : 0, localRevision: -1, broaderRevision: -1, requirementsRevision: -1, reviewedRevision: -1, failures: 0, hypotheses: [], repairs: 0, todos: [{id:"todo",text:"核对设置",status:"in_progress"}] });
 return { id:"event",runId:"run",at:new Date().toISOString(),sequence:0,type:"workflow_updated",workflow,detail:"检查中" };
}
it("shows actual todos and analysis without a fabricated modification revision", () => {
 const html = renderToStaticMarkup(<WorkflowProgress events={[event(false)]} />);
 expect(html).toContain("进行中：核对设置"); expect(html).toContain("分析任务"); expect(html).not.toContain("修改版本"); expect(html).not.toContain("实际变更文件");
});
it("shows actual changes and requirement acceptance without a model-review gate", () => {
 const html = renderToStaticMarkup(<WorkflowProgress events={[event(true)]} />);
 expect(html).toContain("src/example.ts"); expect(html).toContain("修改版本 1"); expect(html).toContain("逐项需求验收：待验收"); expect(html).not.toContain("独立只读评审");
});
it("requires current complete receipts before displaying accepted requirements", () => {
  const update = event(true);
  if (update.type !== "workflow_updated") throw new Error("Expected workflow update");
  update.workflow.phase = "final_review";
  update.workflow.requirements = ["支持天气切换", "保持动画播放"];
  update.workflow.requirementIds = ["weather", "animation"];
  update.workflow.requirementsRevision = update.workflow.revision;
  update.workflow.requirementReceipts = [{ requirementId: "weather", summary: "测试覆盖切换", observationIds: ["source"], verificationIds: ["suite"], diffObservationId: "diff" }];
  const partial = renderToStaticMarkup(<WorkflowProgress events={[update]} />);
  expect(partial).toContain("最终验收");
  expect(partial).toContain("逐项需求验收：待验收");
  update.workflow.requirementReceipts.push({ ...update.workflow.requirementReceipts[0]!, requirementId: "animation" });
  expect(renderToStaticMarkup(<WorkflowProgress events={[update]} />)).toContain("逐项需求验收：通过");
  update.workflow.requirementsRevision = -1;
  const stale = renderToStaticMarkup(<WorkflowProgress events={[update]} />);
  expect(stale).toContain("逐项需求验收：待验收");
  expect(stale).toContain("需求证据需按当前版本重新验收");
});
it("shows failed and stale tests as repair and rerun work, while preserving historical review records", () => {
  const update = event(true);
  if (update.type !== "workflow_updated") throw new Error("Expected workflow update");
  update.workflow.localCheck = { status: "failed", revision: 1, epoch: update.workflow.epoch, runId: "unit", reason: "断言失败" };
  update.workflow.broaderCheck = { status: "passed", revision: 0, epoch: update.workflow.epoch, runId: "integration", reason: "旧版本" };
  update.workflow.independentReview = { status: "failed", revision: 0, epoch: update.workflow.epoch, runId: "old-review", reason: "历史记录" };
  const html = renderToStaticMarkup(<WorkflowProgress events={[update]} />);
  expect(html).toContain("局部验证：失败，待修复重测");
  expect(html).toContain("扩大验证：待重新验证");
  expect(html).toContain("继续直到通过");
  expect(html).toContain("历史独立评审：失败");
});
it("shows architecture, step verification and mandatory integration separately from todo", () => {
  const update = event(true);
  if (update.type !== "workflow_updated") throw new Error("Expected workflow update");
  update.workflow.sequential = SequentialWorkflowSchema.parse({ understanding: "连接服务与调用方", architecture: "服务层提供逻辑，调用方负责组合", architectureEpoch: update.workflow.epoch, steps: [{ id: "service", text: "实现服务", verification: [{ command: "unit-service" }], status: "verified" }, { id: "caller", text: "连接调用方", verification: [{ command: "unit-caller" }], status: "in_progress" }] });
  const html = renderToStaticMarkup(<WorkflowProgress events={[update]} />);
  expect(html).toContain("连接服务与调用方");
  expect(html).toContain("服务层提供逻辑");
  expect(html).toContain("实现服务 · 验证通过");
  expect(html).toContain("连接调用方 · 实施／验证中");
  expect(html).toContain("集成测试");
});

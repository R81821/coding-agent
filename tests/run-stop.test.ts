import { describe, expect, it } from "vitest";
import { AgentEventSchema, DEFAULT_PROFILE, RunBudgetSchema, RunStopInfoSchema } from "@harness/protocol";
import { buildRunStop } from "../packages/core/src/run-stop.js";
import { CodingWorkflow } from "../packages/core/src/coding-workflow.js";

describe("structured run stops", () => {
  it("keeps legacy result events compatible", () => {
    expect(AgentEventSchema.parse({id:"e",runId:"r",at:new Date().toISOString(),sequence:0,type:"result",status:"review",text:"old"}).type).toBe("result");
  });
  it("uses the new defaults without a repair ceiling", () => {
    expect(RunBudgetSchema.parse({})).toMatchObject({maxToolCalls:128,maxTurns:64});
    expect(DEFAULT_PROFILE.verificationPolicy.maxRepairAttempts).toBeNull();
    expect(DEFAULT_PROFILE.resiliencePolicy.maxToolSelfCorrections).toBeNull();
  });
  it("does not invent code gates for analysis and retains its read error", () => {
    const workflow = new CodingWorkflow("analyze", () => {});
    workflow.observe({id:"missing",name:"read_file",input:{path:"missing.ts"}}, {output:{error:"file missing"},isError:true});
    const spec = {id:"r",sessionId:"s",request:"analyze",workspacePath:".",profileId:"default",attachments:[],grants:[],createdAt:new Date().toISOString(),budget:DEFAULT_PROFILE.budget};
    const stop = buildRunStop("tool_call_limit","工具调用已用完",spec,{toolCalls:128,turns:10,repairAttemptsUsed:0,spentUsd:0,startedAt:Date.now()},workflow.snapshot());
    expect(stop.pending).not.toContain("局部验证");
    expect(stop.pending).not.toContain("当前修改 diff 检查");
    expect(stop.lastFailure?.message).toContain("file missing");
    expect(stop.lastFailure?.tool).toBe("read_file");
  });
  it.each([false, true])("does not call an allowed skipped check a failure (prior error=%s)", priorError => {
    const workflow = new CodingWorkflow("analyze", () => {});
    if (priorError) workflow.observe({id:"missing",name:"read_file",input:{}},{output:"real read failure",isError:true});
    workflow.recordVerification({id:"skipped",runId:"r",attempt:0,stage:"broader",epoch:workflow.state.epoch,revision:0,results:[],passed:false,outcome:"skipped",skipReason:"optional unconfigured",startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()});
    const spec = {id:"r",sessionId:"s",request:"analyze",workspacePath:".",profileId:"default",attachments:[],grants:[],createdAt:new Date().toISOString(),budget:DEFAULT_PROFILE.budget};
    const stop = buildRunStop("tool_call_limit","工具调用已用完",spec,{toolCalls:128,turns:10,repairAttemptsUsed:0,spentUsd:0,startedAt:Date.now()},workflow.snapshot());
    if (priorError) expect(stop.lastFailure?.message).toContain("real read failure");
    else expect(stop.lastFailure).toBeUndefined();
  });
  it("reports pending gates and unlimited repair telemetry", () => {
    const workflow = new CodingWorkflow("fix", () => {});
    workflow.update({action:"understand",intent:"change",requirements:["fix target"]});
    const spec = {id:"r",sessionId:"s",request:"fix",workspacePath:".",profileId:"default",attachments:[],grants:[],createdAt:new Date().toISOString(),budget:DEFAULT_PROFILE.budget};
    const stop = buildRunStop("model_turn_limit","模型轮次已用完",spec,{toolCalls:50,turns:64,repairAttemptsUsed:7,spentUsd:1,startedAt:Date.now()},workflow.snapshot());
    expect(RunStopInfoSchema.parse(stop).usage.repairs).toEqual({used:7,limit:null});
    expect(stop.pending).toContain("局部验证");
    expect(stop.pending).toContain("最终评审");
  });
});

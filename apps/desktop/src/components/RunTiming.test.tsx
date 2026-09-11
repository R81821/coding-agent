import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentEvent } from "@harness/protocol";
import { expect, it } from "vitest";
import { RunTiming } from "./RunTiming.js";
it("includes failed request durations, separates purposes and ignores duplicated event delivery", () => {
 const base = {runId:"run",at:new Date().toISOString(),sequence:0};
 const request: AgentEvent = {...base,id:"model",type:"model_request_finished",purpose:"main",durationMs:1500,succeeded:false};
 const events: AgentEvent[] = [request,request,{...base,id:"review",type:"model_request_finished",purpose:"review",durationMs:2000,succeeded:true},{...base,id:"tool",type:"tool_finished",callId:"call",durationMs:300,output:{}}];
 const html = renderToStaticMarkup(<RunTiming events={events} />);
 for (const text of ["1.50 秒", "1 次失败", "2.00 秒", "0.30 秒", "含流式传输", "不等于运行总时长"]) expect(html).toContain(text);
 expect(html).not.toContain("压缩模型请求");
 expect(renderToStaticMarkup(<RunTiming events={[]} />)).toBe("");
});

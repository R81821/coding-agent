import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_PROFILE, isDeferredOutput, type AgentEvent, type DaemonRequestInput, type SessionView } from "@harness/protocol";
import { useWorkbench, type Workbench } from "../src/hooks/use-workbench";
import { Conversation } from "../src/components/conversation";
import "../src/styles.css";

const at = "2026-10-07T00:00:00.000Z";
const session = { id: "auto", title: "自动完整加载", workspacePath: "D:/fixture", profileId: "default", createdAt: at, updatedAt: at };
const fullAnswer = "完整回答正文。".repeat(2400) + "【回答末尾保留】";
const fullOutput = "完整工具输出。".repeat(10000) + "【输出末尾保留】";
const runs: SessionView["runs"] = Array.from({ length: 25 }, (_, i) => {
  const id = `run-${String(i).padStart(2, "0")}`;
  return { spec: { id, sessionId: "auto", request: `第 ${i + 1} 轮任务`, workspacePath: session.workspacePath, profileId: "default", budget: DEFAULT_PROFILE.budget, attachments: [], grants: [], createdAt: at }, status: "completed", events: [{ id: `${id}-result`, runId: id, at, sequence: 201, type: "result", status: "completed", text: fullAnswer }], view: { lastSequence: 201, eventsComplete: false } };
});
const reads: string[] = [];
window.fetch = async (_url, options) => {
  const input = JSON.parse(String(options?.body)) as DaemonRequestInput;
  reads.push(input.method);
  let result: unknown;
  switch (input.method) {
    case "health": result = { status: "ok" }; break;
    case "profiles.list": result = [DEFAULT_PROFILE]; break;
    case "sessions.list": result = { items: [session], hasMore: false }; break;
    case "projects.list": case "skills.list": case "plugins.list": case "approvals.list": result = []; break;
    case "session.view": {
      const eligible = runs.filter(run => !input.params.before || run.spec.id < input.params.before.id);
      const page = eligible.slice(-20);
      result = { session, runs: page, hasMore: eligible.length > page.length, before: { createdAt: at, id: page[0]!.spec.id } }; break;
    }
    case "run.eventPage": {
      const id = input.params.runId;
      const events: AgentEvent[] = Array.from({ length: 200 }, (_, sequence) => ({ id: `${id}-status-${sequence}`, runId: id, at, sequence, type: "status", status: "running" }));
      events.push({ id: `${id}-tool`, runId: id, at, sequence: 200, type: "tool_finished", callId: "call", durationMs: 1, output: { deferred: true } }, runs.find(run => run.spec.id === id)!.events[0]!);
      const eligible = events.filter(event => event.sequence > input.params.afterSequence);
      const page = eligible.slice(0, input.params.limit);
      result = { events: page, nextSequence: page.at(-1)?.sequence ?? input.params.afterSequence, hasMore: eligible.length > page.length, status: "completed" }; break;
    }
    case "run.output": {
      const { offset, limit } = input.params;
      result = { text: fullOutput.slice(offset, offset + limit), nextOffset: Math.min(offset + limit, fullOutput.length), hasMore: offset + limit < fullOutput.length }; break;
    }
    default: throw Error(input.method);
  }
  return new Response(JSON.stringify({ result }), { status: 200, headers: { "Content-Type": "application/json" } });
};
let work: Workbench;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean) { for (let i = 0; i < 1000; i++) { if (test()) return; await delay(20); } throw Error("等待自动加载超时"); }
function assert(value: unknown, reason: string) { if (!value) throw Error(reason); }
function Harness() {
  work = useWorkbench();
  const [result, setResult] = useState("准备就绪");
  async function run() {
    setResult("验证中…");
    try {
      await work.connect(); await until(() => work.mode === "local" && !work.loading);
      work.setActiveId("auto");
      await until(() => work.detail?.runs.length === 25 && work.detail.runs.every(run => run.view?.eventsComplete && run.events.every(event => event.type !== "tool_finished" || !isDeferredOutput(event.output))));
      assert(!work.content.error, work.content.error);
      for (const turn of work.detail!.runs) {
        assert(turn.events.length === 202, "执行记录缺页");
        assert(turn.events.some(event => event.type === "result" && event.text === fullAnswer), "回答被截断");
        assert(turn.events.some(event => event.type === "tool_finished" && event.output === fullOutput), "输出被截断");
      }
      assert(![...document.querySelectorAll('button')].some(button => /加载完整|继续加载|加载更早|查看工具输出/.test(button.textContent ?? "")), "仍存在手动加载入口");
      assert(document.querySelector('[data-virtual-row="run-24"]')?.textContent?.includes("【回答末尾保留】"), "页面缺少完整回答末尾");
      const count = reads.length; await delay(800); assert(reads.length === count, "完成后仍重复请求");
      setResult(`PASS：25 轮、5050 条执行事件、超 16000 字回答和超 64000 字工具输出均自动完整加载；可见正文包含结尾；无手动加载按钮；完成后无重复请求。当前挂载 ${document.querySelectorAll('[data-virtual-row]').length} 行。`);
    } catch (error) { setResult(`FAIL：${String(error)}`); }
  }
  return <main className="p-4"><h1>完整会话自动加载回归</h1><button onClick={() => void run()} disabled={result !== "准备就绪"}>运行回归</button><p role="status" className="py-3">{result}</p><div style={{ height: 520, display: "flex", flexDirection: "column", border: "1px solid #ddd" }}><Conversation work={work} /></div></main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);

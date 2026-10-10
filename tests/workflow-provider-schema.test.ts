import { expect, it } from "vitest";
import { OpenAIProvider, OpenAICompatibleProvider, descriptor } from "@harness/providers";
import { ToolContractSchema, type ModelRequest } from "@harness/protocol";
import { SequentialWorkflow } from "../packages/core/src/sequential-workflow.js";

const cases = (["responses", "chat_completions"] as const).flatMap(protocol => (["understand", "configure"] as const).map(action => ({ protocol, action })));
it.each(cases)("sends a provider-compatible workflow schema through $protocol and executes $action", async ({ protocol, action }) => {
  const workflow = new SequentialWorkflow("Implement service", () => {});
  const tool = workflow.planningTool();
  const model = descriptor({ providerId: "fixture", modelId: "fixture", displayName: "fixture" });
  workflow.observe({ id: "source", name: "read_file", input: { path: "service.ts" } }, { output: "export const service = 0;" });
  const check = (command: string) => ({ command, cwd: ".", timeoutMs: 1000 });
  const input = { action, summary: "Implement service", requirements: ["Service works"], ...(action === "configure" ? {
    architecture: "service.ts owns service behavior", evidenceIds: ["source"], steps: [{ id: "service", text: "Implement service", dependsOn: [], verification: [check("node --test test/service.test.mjs")] }],
    integration: [check("node --test test/integration.test.mjs")], startStepId: "service",
  } : {}) };
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const functions = body.tools.map((entry: Record<string, unknown>) => protocol === "responses" ? entry : entry.function);
    const definition = functions.find((entry: { name: string }) => entry.name === "advance_workflow");
    expect(definition.parameters.type).toBe("object");
    expect(definition.parameters.oneOf).toBeUndefined();
    expect(definition.parameters.anyOf).toBeUndefined();
    expect(definition.parameters.properties.action.enum).toEqual(["understand", "architecture", "configure", "plan", "update_plan", "select_next", "start_step", "reopen_step"]);
    expect(Object.keys(definition.parameters.properties)).toEqual(expect.arrayContaining(["summary", "requirements", "intent", "architecture", "evidenceIds", "steps", "integration", "mode", "selectionPolicy", "stepId", "startStepId", "removeStepIds", "reason"]));
    expect(definition.parameters.properties.steps.items.properties.dependsOn).toMatchObject({ type: "array", items: { type: "string" } });
    expect(definition.parameters.properties.steps.items.properties.priority).toMatchObject({ type: "integer", minimum: 0, maximum: 100 });
    expect(definition.parameters.properties.steps.items.properties.execution.properties.mode.enum).toEqual(["read", "write"]);
    expect(definition.parameters.required).toEqual(["action"]);
    expect(definition.strict).toBe(false);
    expect(functions.find((entry: { name: string }) => entry.name === "fixture_tool").strict).toBe(true);
    const frames = protocol === "responses" ? [
      { type: "response.output_item.done", item: { type: "function_call", call_id: "call", name: tool.contract.name, arguments: JSON.stringify(input) } },
      { type: "response.completed", response: { id: "fixture-response" } },
    ] : [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call", type: "function", function: { name: tool.contract.name, arguments: JSON.stringify(input) } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
  };
  const Provider = protocol === "responses" ? OpenAIProvider : OpenAICompatibleProvider;
  const provider = new Provider({ id: "fixture", apiKey: "fixture", baseUrl: "https://example.test/v1", apiProtocol: protocol, models: [model], resolveAttachment: async () => { throw new Error("unused"); }, fetchImpl });
  const contract = ToolContractSchema.parse(tool.contract);
  const request: ModelRequest = { runId: "run", model, messages: [{ role: "user", content: [{ type: "text", text: "Implement service", trust: "user_request" }] }],
    tools: [contract, { ...contract, name: "fixture_tool", strict: undefined, inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    maxOutputTokens: 100, parallelToolCalls: false, store: false };
  const calls = [];
  for await (const event of provider.stream(request, new AbortController().signal)) if (event.type === "tool_call") calls.push(event.toolCall);
  expect(calls).toHaveLength(1);
  const result = await tool.execute(calls[0]!.input, { runId: "run", workspacePath: ".", grants: [], signal: new AbortController().signal });
  expect(result.isError).not.toBe(true);
  expect(workflow.state.sequential?.understanding).toBe("Implement service");
  if (action === "configure") {
    expect(workflow.state.sequential?.activeStepId).toBe("service");
    expect(workflow.state.sequential?.mode).toBe("adaptive");
    expect(workflow.state.sequential?.steps[0]?.status).toBe("in_progress");
    expect(workflow.state.localCheck.status).toBe("pending");
    expect(workflow.canFinish()).toBe(false);
  }
  const invalid = await tool.execute({ action: "understand", summary: "Missing requirements" }, { runId: "run", workspacePath: ".", grants: [], signal: new AbortController().signal });
  expect(invalid.isError).toBe(true);
  expect(workflow.state.requirements).toEqual(["Service works"]);
});

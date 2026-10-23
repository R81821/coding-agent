import { describe, expect, it } from "vitest";
import { runWithPiAgent } from "@harness/core";
import { OpenAICompatibleProvider, descriptor } from "@harness/providers";
import { DEFAULT_PROFILE, canonicalJson, type CacheDiagnostic, type ModelMessage, type PromptBackend, type RunSpec } from "@harness/protocol";
import type { ToolDefinition } from "@harness/tools";
import { buildInitialMessages } from "../packages/core/src/context.js";
import { createPromptSystem } from "../packages/core/src/prompt-system.js";

interface WireRequest {
  instructions: string;
  input: unknown[];
  tools: unknown[];
  prompt_cache_key: string;
  previous_response_id?: string;
  store: boolean;
}

const tools: ToolDefinition[] = [
  { contract: { name: "advance_workflow", description: "Configure fixture task graph", inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] }, risk: "read", idempotent: true, timeoutMs: 1000 },
    execute: async () => ({ output: "graph configured" }) },
  { contract: { name: "patch", description: "Apply fixture change", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, risk: "write", idempotent: false, timeoutMs: 1000 },
    execute: async () => ({ output: "fixture changed" }) },
];

function sse(turn: number): Response {
  const call = turn === 1 ? { type: "function_call", call_id: "configure-graph", name: "advance_workflow", arguments: '{"action":"configure"}' }
    : turn === 2 ? { type: "function_call", call_id: "apply-change", name: "patch", arguments: '{"path":"fixture.ts"}' } : undefined;
  const events = [call ? { type: "response.output_item.done", item: call }
    : { type: "response.output_text.delta", delta: turn === 3 ? "Checkpoint reached." : "Resumed successfully." },
  { type: "response.completed", response: { id: `fixture-response-${turn}` } }];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

const policy = (messages: ModelMessage[]) => messages.filter(message => message.role === "system" || message.role === "developer");

describe("stable policy at the actual DeepSeek wire boundary", () => {
  it.each(["harness", "dsh"] as const)("preserves %s prefix through configure, first patch and bridge recovery", async (backend: PromptBackend) => {
    const model = descriptor({ providerId: "fixture", modelId: "deepseek-flash", displayName: "Offline DeepSeek fixture" });
    const spec: RunSpec = { id: `stable-wire-${backend}`, sessionId: `stable-wire-session-${backend}`, request: "Inspect and implement the requested change",
      workspacePath: "D:/fixture", profileId: DEFAULT_PROFILE.id, taskMode: "auto", workflowVersion: 3, behaviorPolicyVersion: 2,
      attachments: [], grants: [], budget: DEFAULT_PROFILE.budget, createdAt: "2026-10-22T00:00:00Z" };
    const state: { intent: "analysis" | "change"; phase: string; steps: unknown[] } = { intent: "analysis", phase: "understand", steps: [] };
    const bodies: WireRequest[] = [];
    const diagnostics: CacheDiagnostic[] = [];
    const provider = new OpenAICompatibleProvider({ id: "fixture", apiKey: "offline-fixture", baseUrl: "https://api.deepseek.com", apiProtocol: "responses", promptBackend: backend,
      models: [model], resolveAttachment: async () => { throw new Error("Fixture has no attachments"); },
      fetchImpl: async (_url, init) => { bodies.push(JSON.parse(String(init?.body)) as WireRequest); return sse(bodies.length); } });

    async function execute(resumeTranscript?: ModelMessage[]) {
      const system = await createPromptSystem(backend);
      try {
        const currentMessages = () => buildInitialMessages({ run: spec, profile: DEFAULT_PROFILE, memories: [], workflow: { intent: state.intent, sequential: { steps: state.steps } } });
        const initial = await system.assemble(currentMessages(), tools.map(tool => tool.contract), model);
        let accepted = policy(initial.messages);
        let signature = canonicalJson(policy(currentMessages()));
        return await runWithPiAgent({ runId: spec.id, sessionId: spec.sessionId, provider, model,
          initialMessages: initial.messages, contracts: initial.tools, resolveTool: name => tools.find(tool => tool.contract.name === name),
          ...(resumeTranscript ? { resumeTranscript } : {}),
          promptCacheKey: `stable:${backend}:${system.version}`, responsesContinuation: true,
          externalSignal: new AbortController().signal, maxOutputTokens: 100, parallelToolCalls: false,
          preparePolicyMessages: async () => {
            const current = policy(currentMessages());
            const nextSignature = canonicalJson(current);
            if (nextSignature === signature) return;
            accepted = policy((await system.assemble(current, initial.tools, model)).messages);
            signature = nextSignature;
          },
          getPolicyMessages: () => accepted,
          getPinnedContext: () => system.runtimeContext(JSON.stringify({ workingMemory: { intent: state.intent, phase: state.phase, steps: state.steps, stableFact: "original evidence" } })),
          beforeToolCall: async () => ({}),
          executeTool: async call => {
            if (call.name === "advance_workflow") { state.steps = [{ id: "implement" }]; state.phase = "plan_hypothesis"; }
            else { state.intent = "change"; state.phase = "small_edit"; }
            return { output: { operation: call.name, status: "complete" } };
          },
          shouldStopAfterTurn: () => false,
          onProviderEvent: event => { if (event.type === "cache_diagnostic" && event.diagnostic) diagnostics.push(event.diagnostic); },
        });
      } finally { await system.dispose(); }
    }

    const first = await execute();
    expect(first.errorMessage).toBeUndefined();
    expect(bodies).toHaveLength(3);
    expect(diagnostics.map(item => item.reason)).toEqual(["first_request", "append", "append"]);
    for (const body of bodies.slice(1)) {
      expect(body.instructions).toBe(bodies[0]!.instructions);
      expect(body.tools).toEqual(bodies[0]!.tools);
      expect(body.prompt_cache_key).toBe(bodies[0]!.prompt_cache_key);
    }
    for (let index = 1; index < bodies.length; index++) {
      expect(bodies[index]!.input.slice(0, bodies[index - 1]!.input.length)).toEqual(bodies[index - 1]!.input);
    }
    expect(canonicalJson(bodies[0]!.input)).toContain("base_snapshot");
    expect(canonicalJson(bodies[1]!.input.at(-1))).toContain("plan_hypothesis");
    expect(canonicalJson(bodies[2]!.input.at(-1))).toContain("small_edit");
    expect(canonicalJson(bodies[2]!.input.at(-1))).toContain("dirty_diff");

    const recovered = await execute(first.transcript);
    expect(recovered.errorMessage).toBeUndefined();
    expect(bodies).toHaveLength(4);
    expect(bodies[3]!.instructions).toBe(bodies[2]!.instructions);
    expect(bodies[3]!.tools).toEqual(bodies[2]!.tools);
    expect(bodies[3]!.prompt_cache_key).toBe(bodies[2]!.prompt_cache_key);
    expect(bodies[3]!.input.slice(0, bodies[2]!.input.length)).toEqual(bodies[2]!.input);
    expect(diagnostics.at(-1)?.reason).toBe("append");
    expect(canonicalJson(bodies[3]!.input.at(-1))).toContain("small_edit");
    expect(bodies.every(body => body.store === false && body.previous_response_id === undefined)).toBe(true);
  });
});

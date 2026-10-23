import { expect, it } from "vitest";
import { runWithPiAgent } from "@harness/core";
import { DEFAULT_PROFILE, nowIso, type ModelMessage, type ModelRequest, type RunSpec } from "@harness/protocol";
import { descriptor, type ModelProvider } from "@harness/providers";
import { buildInitialMessages } from "../packages/core/src/context.js";
import { createDshPromptSystem } from "../packages/core/src/dsh-prompt-system.js";
import { workflowReadTool } from "./workflow-fixture.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it("awaits dsh preparation and keeps one policy snapshot across phase changes and retries", async () => {
  const system = await createDshPromptSystem();
  const firstPreparation = deferred(), allowPreparation = deferred();
  const controller = new AbortController();
  const model = descriptor({ providerId: "fixture", modelId: "deepseek-fixture", displayName: "DeepSeek fixture" });
  const spec: RunSpec = { id: "refresh-run", sessionId: "refresh-session", request: "Inspect, then implement the requested change",
    workspacePath: "D:/fixture", profileId: DEFAULT_PROFILE.id, taskMode: "auto", workflowVersion: 3, behaviorPolicyVersion: 2,
    attachments: [], grants: [], budget: DEFAULT_PROFILE.budget, createdAt: nowIso() };
  let intent: "analysis" | "change" = "analysis";
  let revision = 0, preparations = 0, assemblies = 1, preparing = false, retries = 0;
  const policyMessages = () => buildInitialMessages({ run: spec, profile: DEFAULT_PROFILE, memories: [], workflow: { intent } });
  const policyOnly = (messages: ModelMessage[]) => messages.filter(message => message.role === "system" || message.role === "developer");
  let signature = JSON.stringify(policyOnly(policyMessages()));
  const initial = await system.assemble(policyMessages(), [workflowReadTool.contract], model);
  let accepted = policyOnly(initial.messages);
  const requests: ModelRequest[] = [];
  const measurements: Array<{ preparing: boolean; intent: string }> = [];
  const provider: ModelProvider = {
    id: "fixture", promptBackend: "dsh", listModels: async () => [model], health: async () => true, estimateCost: () => 0,
    async *stream(request) {
      expect(preparing).toBe(false);
      requests.push(structuredClone(request));
      if (requests.length === 1) throw new Error("HTTP 503 temporary fixture failure");
      if (requests.length === 2) yield { type: "tool_call", toolCall: { id: "inspect", name: "read_file", input: { path: "value.ts" } } };
      else yield { type: "text_delta", delta: "done" };
    },
  };
  const execution = runWithPiAgent({ runId: spec.id, sessionId: spec.sessionId, provider, model, initialMessages: initial.messages,
    contracts: initial.tools, resolveTool: () => workflowReadTool, externalSignal: controller.signal, maxOutputTokens: 100,
    parallelToolCalls: false, providerRetryPolicy: { maxAttempts: 2, baseDelayMs: 0 },
    preparePolicyMessages: async () => {
      preparations++;
      preparing = true;
      try {
        if (preparations === 1) { firstPreparation.resolve(); await allowPreparation.promise; }
        const current = policyOnly(policyMessages());
        const nextSignature = JSON.stringify(current);
        if (nextSignature !== signature) {
          // A genuine async registry update must finish before measurement and dispatch.
          await new Promise<void>(resolve => setImmediate(resolve));
          const next = await system.assemble(current, initial.tools, model);
          assemblies++;
          accepted = policyOnly(next.messages);
          signature = nextSignature;
        }
      } finally { preparing = false; }
    },
    getPolicyMessages: () => accepted,
    getPinnedContext: () => system.runtimeContext(JSON.stringify({ workingMemory: { intent, revision, stableFact: "source inspected" } })),
    onContextUsage: () => measurements.push({ preparing, intent }),
    onProviderRetry: async () => { retries++; expect(preparations).toBe(1); expect(assemblies).toBe(1); },
    beforeToolCall: async () => ({}),
    executeTool: async () => { intent = "change"; revision++; return { output: "current source" }; },
    shouldStopAfterTurn: () => false, onProviderEvent: () => {},
  });
  try {
    await firstPreparation.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(requests).toHaveLength(0);
    expect(measurements).toHaveLength(0);
    allowPreparation.resolve();
    const result = await execution;
    expect(result.errorMessage).toBeUndefined();
    expect(requests).toHaveLength(3);
    expect(retries).toBe(1);
    expect(preparations).toBe(2);
    expect(assemblies).toBe(1);
    expect(requests[1]!.messages).toEqual(requests[0]!.messages);
    const before = JSON.stringify(policyOnly(requests[0]!.messages));
    const after = JSON.stringify(policyOnly(requests[2]!.messages));
    expect(before).toBe(after);
    expect(after).toContain("Inspect relevant code before editing");
    for (const request of requests) {
      expect(JSON.stringify(policyOnly(request.messages)).match(/You are an AI agent powered by DeepSeek Harness\./g)).toHaveLength(1);
      expect(request.messages.find(message => message.role === "developer")).toEqual(initial.messages.find(message => message.role === "developer"));
    }
    expect(JSON.stringify(requests[0]!.messages)).toContain("base_snapshot");
    expect(JSON.stringify(requests[2]!.messages.at(-1))).toContain("dirty_diff");
    expect(JSON.stringify(requests[2]!.messages.at(-1))).toContain("change");
    expect(JSON.stringify(requests[2]!.messages.at(-1))).not.toContain("source inspected");
    expect(measurements.some(value => value.intent === "analysis")).toBe(true);
    expect(measurements.some(value => value.intent === "change")).toBe(true);
    expect(measurements.every(value => !value.preparing)).toBe(true);
  } finally {
    allowPreparation.resolve();
    controller.abort();
    await execution;
    await system.dispose();
  }
});

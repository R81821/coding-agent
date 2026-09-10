import { expect, it } from "vitest";
import { runWithPiAgent } from "@harness/core";
import { descriptor, type ModelProvider } from "@harness/providers";
import { canonicalJson, type ModelRequest } from "@harness/protocol";
import { workflowReadTool } from "./workflow-fixture.js";

it("appends runtime changes after prior messages without rewriting their prefix", async () => {
  const requests: ModelRequest[] = [];
  const model = descriptor({ providerId: "fixture", modelId: "fixture", displayName: "fixture" });
  const provider: ModelProvider = { id: "fixture", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream(request) { requests.push(structuredClone(request)); if (requests.length < 3) yield { type: "tool_call" as const, toolCall: { id: "read-" + requests.length, name: "read_file", input: { path: "value.ts" } } }; else yield { type: "text_delta" as const, delta: "done" }; } };
  await runWithPiAgent({ runId: "run", sessionId: "session", model, provider,
    initialMessages: [{ role: "system", content: [{ type: "text", trust: "app_policy", text: "FIXED SYSTEM" }] }, { role: "user", content: [{ type: "text", text: "inspect", trust: "user_request" }] }],
    contracts: [workflowReadTool.contract], resolveTool: () => workflowReadTool, externalSignal: new AbortController().signal, maxOutputTokens: 100, parallelToolCalls: false,
    getPinnedContext: () => JSON.stringify({ workingMemory: { phase: "recon", revision: requests.length, context: "stable facts" } }),
    beforeToolCall: async () => ({}), executeTool: async () => ({ output: "code" }), shouldStopAfterTurn: () => false, onProviderEvent: () => {} });
  expect(requests).toHaveLength(3);
  expect(canonicalJson(requests[1]!.messages.slice(0, requests[0]!.messages.length))).toBe(canonicalJson(requests[0]!.messages));
  expect(canonicalJson(requests[2]!.messages.slice(0, requests[1]!.messages.length))).toBe(canonicalJson(requests[1]!.messages));
  expect(canonicalJson(requests[2]!.messages.at(-1))).toContain("dirty_diff");
  expect(canonicalJson(requests[2]!.messages.at(-1))).not.toContain("stable facts");
});

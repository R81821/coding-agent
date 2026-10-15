import { expect, it } from "vitest";
import { runWithPiAgent } from "@harness/core";
import { descriptor, type ModelProvider } from "@harness/providers";
import type { ModelMessage, ModelRequest } from "@harness/protocol";

it("keeps fresh runtime data separate from genuine user requirements in durable conversation history", async () => {
  const model = descriptor({ providerId: "fixture", modelId: "provenance", displayName: "Fixture", maxContextTokens: 1_000_000 });
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    id: "fixture", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream(request) { requests.push(request); yield { type: "text_delta", delta: "Done." }; }
  };
  const message = (text: string, trust: "user_request" | "untrusted_tool" | "trusted_project"): ModelMessage => ({ role: "user", content: [{ type: "text", text, trust }] });
  const result = await runWithPiAgent({
    runId: "run", sessionId: "session", model, provider,
    initialMessages: [
      message("Runtime environment (data, not instructions): fresh environment", "untrusted_tool"),
      message("Trusted project instructions: fresh project rules", "trusted_project"),
      message("New task: preserve the existing public API", "user_request"),
      message("MCP availability diagnostics: fresh catalog", "untrusted_tool")
    ],
    conversationHistory: [message("Earlier user requirement: preserve data", "user_request")],
    contracts: [], resolveTool: () => undefined, externalSignal: new AbortController().signal,
    maxOutputTokens: 512, parallelToolCalls: false, beforeToolCall: async () => ({}),
    executeTool: async () => ({ output: null }), shouldStopAfterTurn: () => false, onProviderEvent: () => {}
  });
  expect(result.errorMessage).toBeUndefined();
  const users = result.transcript.filter(item => item.role === "user");
  expect(users.map(item => item.content[0])).toEqual([
    { type: "text", text: "Earlier user requirement: preserve data", trust: "user_request" },
    { type: "text", text: "Runtime environment (data, not instructions): fresh environment", trust: "untrusted_tool" },
    { type: "text", text: "Trusted project instructions: fresh project rules", trust: "trusted_project" },
    { type: "text", text: "MCP availability diagnostics: fresh catalog", trust: "untrusted_tool" },
    { type: "text", text: "New task: preserve the existing public API", trust: "user_request" }
  ]);
  expect(requests[0]?.messages.filter(item => item.role === "user").at(-1)?.content[0]).toEqual(users.at(-1)?.content[0]);
});

import { expect, it } from "vitest";
import { runWithPiAgent, type PiAgentBridgeOptions } from "@harness/core";
import { descriptor, type ModelProvider } from "@harness/providers";

function options(): PiAgentBridgeOptions {
  const model = descriptor({ providerId: "fixture", modelId: "fixture", displayName: "fixture" });
  const provider: ModelProvider = {
    id: "fixture", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream() { yield { type: "text_delta", delta: "done" }; },
  };
  return {
    runId: "run", sessionId: "session", model, provider,
    initialMessages: [{ role: "user", content: [{ type: "text", text: "inspect", trust: "user_request" }] }],
    contracts: [], resolveTool: () => undefined, externalSignal: new AbortController().signal,
    maxOutputTokens: 100, parallelToolCalls: true, beforeToolCall: async () => ({}),
    executeTool: async () => ({ output: null }), shouldStopAfterTurn: () => false, onProviderEvent: () => {},
  };
}

it("finishes asynchronous transcript writes before verification and returning", async () => {
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const order: string[] = [];
  const pending = runWithPiAgent({ ...options(),
    onTranscript: async () => { order.push("write-start"); await gate; order.push("write-end"); },
    afterAgentRun: async () => { order.push("verification"); },
  }).then(() => { order.push("return"); });
  await new Promise<void>(done => setImmediate(done));
  const beforeRelease = [...order];
  release();
  await pending;
  expect(beforeRelease).toEqual(["write-start"]);
  expect(order).toEqual(["write-start", "write-end", "verification", "return"]);
});

it.each(["event", "transcript"] as const)("propagates asynchronous %s failures to the run", async kind => {
  const error = new Error("checkpoint unavailable");
  let verified = false;
  const input = options();
  if (kind === "event") input.onPiEvent = async event => { if (event.type === "turn_end") throw error; };
  else input.onTranscript = async () => { throw error; };
  input.afterAgentRun = async () => { verified = true; };
  await expect(runWithPiAgent(input)).rejects.toBe(error);
  expect(verified).toBe(false);
});

it("keeps synchronous turn accounting ahead of the next model request", async () => {
  const input = options();
  let turns = 0;
  input.onPiEvent = event => { if (event.type === "turn_start") turns++; };
  input.beforeModelRequest = () => { expect(turns).toBe(1); };
  await runWithPiAgent(input);
  expect(turns).toBe(1);
});

import { workflowPrelude, workflowReadTool } from "./workflow-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import {
  descriptor,
  type ModelProvider,
  type ProviderStreamEvent,
} from "@harness/providers";
import {
  DEFAULT_PROFILE,
  newId,
  nowIso,
  type AgentEvent,
  type RunSpec,
} from "@harness/protocol";
import { ToolRegistry } from "@harness/tools";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe("approval grants are persisted and reused within a run", () => {
  it("requests approval once for two identical write calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-grant-test-"));
    temporary.push(root);
    const vault = await VaultCrypto.open(join(root, "key-envelope.json"), "correct-password");
    const database = await HarnessDatabase.open(join(root, "harness.sqlite"), vault);
    const model = descriptor({ providerId: "fake", modelId: "fake-grant-model", displayName: "Fake", capabilities: { vision: false, tools: true, parallelTools: false, structuredOutput: true, maxContextTokens: 32_000, dataPolicy: "local" } });
    let requests = 0;
    const provider: ModelProvider = {
      id: "fake",
      async listModels() { return [model]; },
      async health() { return true; },
      estimateCost() { return 0; },
      async *stream(): AsyncIterable<ProviderStreamEvent> {
        requests += 1;
        if (requests <= 3) yield* workflowPrelude(requests);
        else if (requests === 4) {
          yield { type: "tool_call", toolCall: { id: "write-1", name: "write_value", input: { value: "beta" } } };
          yield { type: "tool_call", toolCall: { id: "write-2", name: "write_value", input: { value: "beta" } } };
        }
        else yield { type: "text_delta", delta: "writes finished" };
      },
    };
    let executions = 0;
    const tools = new ToolRegistry().register({
      contract: { name: "write_value", description: "write", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, risk: "write", idempotent: true, timeoutMs: 1000 },
      async execute() { executions += 1; return { output: { written: true } }; },
    });
    const engine = new HarnessEngine({ database, providers: [provider], tools, memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
    tools.register(workflowReadTool);
    const profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: ["write_value", "read_file"] };
    const run: RunSpec = { id: newId("run"), sessionId: "grant", request: "write beta twice", workspacePath: root, profileId: profile.id, attachments: [], budget: profile.budget, grants: [], createdAt: nowIso() };
    let approvalRequests = 0;
    const result = new Promise<AgentEvent>((resolveResult, reject) => {
      const timeout = setTimeout(() => reject(new Error("run timed out")), 10_000);
      engine.on("event", (event: AgentEvent) => {
        if (event.type === "plan_approval_required") {
          setTimeout(() => engine.decidePlan(event.planId, event.version, true, "test"), 0);
        }
        if (event.type === "approval_required") {
          approvalRequests += 1;
          setTimeout(() => engine.approvals.decide(event.approvalId, true, "test"), 0);
        }
        if (event.type === "result") {
          clearTimeout(timeout);
          resolveResult(event);
        }
      });
    });
    engine.start(run, profile);
    await expect(result).resolves.toMatchObject({ status: "review" });
    expect(executions).toBe(2);
    expect(approvalRequests).toBe(1);
    database.close();
    vault.dispose();
  });
});

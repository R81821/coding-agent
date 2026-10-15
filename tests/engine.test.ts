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
  type ModelRequest,
  type RunSpec,
} from "@harness/protocol";
import { ToolRegistry } from "@harness/tools";

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe("HarnessEngine", () => {
  it("persists a complete event stream and creates reviewed memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-engine-test-"));
    temporary.push(root);
    const vault = await VaultCrypto.open(
      join(root, "envelope.json"),
      "correct-password",
    );
    const database = await HarnessDatabase.open(
      join(root, "harness.sqlite"),
      vault,
    );
    const model = descriptor({
      providerId: "fake",
      modelId: "fake-model",
      displayName: "Fake",
      capabilities: {
        vision: false,
        tools: true,
        parallelTools: true,
        structuredOutput: true,
        maxContextTokens: 32_000,
        dataPolicy: "local",
      },
    });
    const provider: ModelProvider = {
      id: "fake",
      async listModels() {
        return [model];
      },
      async *stream(
        _request: ModelRequest,
      ): AsyncIterable<ProviderStreamEvent> {
        yield { type: "text_delta", delta: "Implemented and verified." };
        yield {
          type: "usage",
          usage: { inputTokens: 20, outputTokens: 5, estimatedUsd: 0 },
        };
      },
      async health() {
        return true;
      },
      estimateCost() {
        return 0;
      },
    };
    const memory = new MemoryService(database);
    const engine = new HarnessEngine({
      database,
      providers: [provider],
      tools: new ToolRegistry(),
      memory,
      skills: new SkillService(join(root, "skills")),
      projectTrust: new ProjectTrustService(database),
    });
    const profile = {
      ...DEFAULT_PROFILE,
      allowedProviders: ["fake"],
      toolNames: [],
    };
    const run: RunSpec = { workflowVersion: 1,
      id: newId("run"),
      sessionId: "session-1",
      request: "Implement the feature",
      workspacePath: root,
      profileId: profile.id,
      attachments: [],
      budget: profile.budget,
      grants: [],
      createdAt: nowIso(),
    };
    const result = new Promise<AgentEvent>((resolveResult, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("run timed out")),
        5_000,
      );
      engine.on("event", (event: AgentEvent) => {
        if (event.type === "result") {
          clearTimeout(timeout);
          resolveResult(event);
        }
      });
    });
    engine.start(run, profile);
    await expect(result).resolves.toMatchObject({
      type: "result",
      status: "completed",
      text: "Implemented and verified.",
    });
    expect(database.listEvents(run.id).map((event) => event.type)).toEqual(
      expect.arrayContaining(["route", "text_delta", "usage", "result"]),
    );
    expect(
      database
        .listMemories()
        .map((memoryItem) => memoryItem.status)
        .sort(),
    ).toEqual(["approved", "candidate"]);
    database.close();
    vault.dispose();
  });

  it("runs a tool round trip through pi-agent-core and continues to a final response", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-pi-loop-test-"));
    temporary.push(root);
    const vault = await VaultCrypto.open(
      join(root, "envelope.json"),
      "correct-password",
    );
    const database = await HarnessDatabase.open(
      join(root, "harness.sqlite"),
      vault,
    );
    const model = descriptor({
      providerId: "fake",
      modelId: "fake-tool-model",
      displayName: "Fake Tool Model",
      capabilities: {
        vision: false,
        tools: true,
        parallelTools: true,
        structuredOutput: true,
        maxContextTokens: 32_000,
        dataPolicy: "local",
      },
    });
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      id: "fake",
      async listModels() {
        return [model];
      },
      async *stream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
        requests.push(request);
        if (requests.length === 1) {
          yield {
            type: "tool_call",
            toolCall: {
              id: "call-1",
              name: "inspect_value",
              input: { value: "alpha" },
            },
          };
          return;
        }
        yield {
          type: "text_delta",
          delta: "Tool result received; task complete.",
        };
      },
      async health() {
        return true;
      },
      estimateCost() {
        return 0;
      },
    };
    let executions = 0;
    const tools = new ToolRegistry().register({
      contract: {
        name: "inspect_value",
        description: "Return a test value.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        risk: "read",
        idempotent: true,
        timeoutMs: 1_000,
      },
      async execute(input) {
        executions += 1;
        return { output: { inspected: input.value } };
      },
    });
    const engine = new HarnessEngine({
      database,
      providers: [provider],
      tools,
      memory: new MemoryService(database),
      skills: new SkillService(join(root, "skills")),
      projectTrust: new ProjectTrustService(database),
    });
    const profile = {
      ...DEFAULT_PROFILE,
      allowedProviders: ["fake"],
      toolNames: ["inspect_value"],
    };
    const run: RunSpec = { workflowVersion: 1,
      id: newId("run"),
      sessionId: "session-pi-loop",
      request: "Inspect alpha",
      workspacePath: root,
      profileId: profile.id,
      attachments: [],
      budget: profile.budget,
      grants: [],
      createdAt: nowIso(),
    };
    const result = new Promise<AgentEvent>((resolveResult, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("run timed out")),
        5_000,
      );
      engine.on("event", (event: AgentEvent) => {
        if (event.type === "result") {
          clearTimeout(timeout);
          resolveResult(event);
        }
      });
    });

    engine.start(run, profile);

    await expect(result).resolves.toMatchObject({
      type: "result",
      status: "completed",
      text: "Tool result received; task complete.",
    });
    expect(executions).toBe(1);
    expect(requests).toHaveLength(2);
    expect(
      requests[1]?.messages.some((message) => message.role === "tool" && message.content.some((part) => part.type === "tool_result" && part.toolCallId === "call-1")),
    ).toBe(true);
    expect(database.listEvents(run.id).map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "tool_call",
        "tool_started",
        "tool_finished",
        "result",
      ]),
    );
    database.close();
    vault.dispose();
  });

  it("blocks a write tool until the persisted plan is approved", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-plan-gate-test-"));
    temporary.push(root);
    const vault = await VaultCrypto.open(join(root, "key-envelope.json"), "correct-password");
    const database = await HarnessDatabase.open(join(root, "harness.sqlite"), vault);
    const model = descriptor({ providerId: "fake", modelId: "fake-plan-model", displayName: "Fake", capabilities: { vision: false, tools: true, parallelTools: false, structuredOutput: true, maxContextTokens: 32_000, dataPolicy: "local" } });
    let requests = 0;
    const provider: ModelProvider = {
      id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
        if (request.purpose === "compaction") {
          yield { type: "text_delta", delta: JSON.stringify({ goal: "Write beta within the approved plan", constraints: ["Preserve plan and tool approval requirements"], decisions: [], evidence: [], completed: [], pending: ["Complete verification and requirement acceptance"] }) };
          return;
        }
        requests += 1;
        if (requests <= 3) yield* workflowPrelude(requests);
        else if (requests === 4) yield { type: "tool_call", toolCall: { id: "write-1", name: "write_value", input: { value: "beta" } } };
        else yield { type: "text_delta", delta: "write finished" };
      }
    };
    let executions = 0;
    const tools = new ToolRegistry().register({
      contract: { name: "write_value", description: "write", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, risk: "write", idempotent: true, timeoutMs: 1000 },
      async execute() { executions += 1; return { output: { written: true } }; }
    });
    const engine = new HarnessEngine({ database, providers: [provider], tools, memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
    tools.register(workflowReadTool);
    const profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: ["write_value", "read_file"] };
    const run: RunSpec = { workflowVersion: 1, id: newId("run"), sessionId: "plan", request: "write beta", workspacePath: root, profileId: profile.id, attachments: [], budget: profile.budget, grants: [{ toolNames: ["write_value"], pathGlobs: ["**"], commandPrefixes: [], networkDomains: [], maxRisk: "write" }], createdAt: nowIso() };
    const result = new Promise<AgentEvent>((resolveResult) => engine.on("event", (event: AgentEvent) => {
      if (event.type === "plan_approval_required") {
        expect(executions).toBe(0);
        setTimeout(() => engine.decidePlan(event.planId, event.version, true, "test"), 0);
      }
      if (event.type === "result") resolveResult(event);
    }));
    try {
      engine.start(run, profile);
      const outcome = await result;
      await engine.waitForSettlement(run.id);
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: "review" });
      expect(executions).toBe(1);
      expect(database.getPlanForRun(run.id)).toMatchObject({ status: "approved", approvedBy: "test" });
      expect(database.listCheckpoints(run.id).length).toBeGreaterThan(0);
    } finally {
      await engine.close();
      database.close();
      vault.dispose();
    }
  });

  it("repairs tool-history protocol errors, retries transient failures, and lets the agent self-correct", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-recovery-loop-test-"));
    temporary.push(root);
    const vault = await VaultCrypto.open(join(root, "key-envelope.json"), "correct-password");
    const database = await HarnessDatabase.open(join(root, "harness.sqlite"), vault);
    const model = descriptor({
      providerId: "fake",
      modelId: "fake-recovery-model",
      displayName: "Fake Recovery Model",
      capabilities: {
        vision: false,
        tools: true,
        parallelTools: false,
        structuredOutput: true,
        maxContextTokens: 32_000,
        dataPolicy: "local",
      },
    });
    let requests = 0;
    let sawFailedToolResult = false;
    const provider: ModelProvider = {
      id: "fake",
      async listModels() { return [model]; },
      async health() { return true; },
      estimateCost() { return 0; },
      async *stream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
        requests += 1;
        if (requests === 1) {
          throw new Error("Provider HTTP 400: Messages with role 'tool' must be a response to a preceding message with 'tool_calls'");
        }
        if (requests === 2) throw new Error("Provider HTTP 429: rate limited");
        if (requests === 3) {
          yield { type: "tool_call", toolCall: { id: "unstable-1", name: "unstable_tool", input: {} } };
          return;
        }
        sawFailedToolResult = request.messages.some((message) =>
          message.role === "tool" &&
          message.content.some((part) =>
            part.type === "tool_result" && part.toolCallId === "unstable-1",
          ),
        );
        yield { type: "text_delta", delta: "I inspected the tool error and completed with a revised approach." };
      },
    };
    const tools = new ToolRegistry().register({
      contract: {
        name: "unstable_tool",
        description: "Fails for recovery testing.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        risk: "read",
        idempotent: true,
        timeoutMs: 1_000,
      },
      async execute() { throw new Error("fixture tool failure"); },
    });
    const engine = new HarnessEngine({
      database,
      providers: [provider],
      tools,
      memory: new MemoryService(database),
      skills: new SkillService(join(root, "skills")),
      projectTrust: new ProjectTrustService(database),
    });
    const profile = {
      ...DEFAULT_PROFILE,
      allowedProviders: ["fake"],
      toolNames: ["unstable_tool"],
      resiliencePolicy: {
        maxProviderAttempts: 3,
        providerRetryBaseDelayMs: 0,
        maxToolSelfCorrections: 3,
      },
    };
    const run: RunSpec = { workflowVersion: 1,
      id: newId("run"),
      sessionId: "recovery",
      request: "Recover from transient and tool errors",
      workspacePath: root,
      profileId: profile.id,
      attachments: [],
      budget: profile.budget,
      grants: [],
      createdAt: nowIso(),
    };
    const result = new Promise<AgentEvent>((resolveResult, reject) => {
      const timeout = setTimeout(() => reject(new Error("run timed out")), 5_000);
      engine.on("event", (event: AgentEvent) => {
        if (event.type === "result") {
          clearTimeout(timeout);
          resolveResult(event);
        }
      });
    });

    engine.start(run, profile);

    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(requests).toBe(4);
    expect(sawFailedToolResult).toBe(true);
    expect(database.listEvents(run.id).map((event) => event.type)).toEqual(
      expect.arrayContaining(["provider_retry", "self_correction_started"]),
    );
    expect(
      database.listEvents(run.id).filter((event) => event.type === "provider_retry"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "tool_history_protocol", recovery: "flatten_tool_history" }),
        expect.objectContaining({ category: "transient", recovery: "retry_request" }),
      ]),
    );
    database.close();
    vault.dispose();
  });

  it("sends prior turns from the same Session while excluding other Sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-session-context-test-"));
    temporary.push(root);
    const vault = await VaultCrypto.open(join(root, "key-envelope.json"), "correct-password");
    const database = await HarnessDatabase.open(join(root, "harness.sqlite"), vault);
    const createdAt = "2026-09-08T00:00:00.000Z";
    database.ensureProject(root, createdAt);
    database.createSession({ id: "session-main", workspacePath: root, profileId: "default", title: "Main", createdAt, updatedAt: createdAt });
    database.createSession({ id: "session-other", workspacePath: root, profileId: "default", title: "Other", createdAt, updatedAt: createdAt });
    const previous: RunSpec = { workflowVersion: 1, id: "run-previous", sessionId: "session-main", request: "remember the blue widget", workspacePath: root, profileId: "default", attachments: [], budget: DEFAULT_PROFILE.budget, grants: [], createdAt };
    database.saveRun(previous, "completed");
    database.appendEvent({ id: "event-previous", runId: previous.id, sequence: 0, at: createdAt, type: "result", text: "the widget is stored in module alpha", status: "completed" });
    const other: RunSpec = { workflowVersion: 1, ...previous, id: "run-other", sessionId: "session-other", request: "cross-session secret", createdAt: "2026-09-08T00:00:01.000Z" };
    database.saveRun(other, "completed");
    database.appendEvent({ id: "event-other", runId: other.id, sequence: 0, at: other.createdAt, type: "result", text: "must stay isolated", status: "completed" });

    const model = descriptor({ providerId: "fake", modelId: "fake-context-model", displayName: "Fake", capabilities: { vision: true, tools: false, parallelTools: false, structuredOutput: true, maxContextTokens: 32_000, dataPolicy: "local" } });
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      id: "fake",
      async listModels() { return [model]; },
      async health() { return true; },
      estimateCost() { return 0; },
      async *stream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
        requests.push(request);
        yield { type: "text_delta", delta: "continued with prior context" };
      },
    };
    const engine = new HarnessEngine({ database, providers: [provider], tools: new ToolRegistry(), memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
    const profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: [] };
    const current: RunSpec = { workflowVersion: 1, ...previous, id: "run-current", request: "where is it?", createdAt: "2026-09-08T00:00:02.000Z", attachments: [{ id: "attachment-current", sha256: "a".repeat(64), mimeType: "image/png", byteLength: 10, encryptedPath: "fixture", source: "clipboard", trust: "untrusted_attachment", allowedProviders: ["fake"], createdAt }] };
    const result = new Promise<AgentEvent>((resolveResult, reject) => {
      const timeout = setTimeout(() => reject(new Error("run timed out")), 5_000);
      engine.on("event", (event: AgentEvent) => {
        if (event.type === "result" && event.runId === current.id) {
          clearTimeout(timeout);
          resolveResult(event);
        }
      });
    });

    try {
      engine.start(current, profile);
      await expect(result).resolves.toMatchObject({ status: "completed" });
      const requestText = requests[0]?.messages.flatMap((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n") ?? "";
      expect(requestText).toContain("remember the blue widget");
      expect(requestText).toContain("the widget is stored in module alpha");
      expect(requestText).toContain("where is it?");
      expect(requestText).not.toContain("cross-session secret");
      expect(requestText).not.toContain("must stay isolated");
      const userMessages = requests[0]?.messages.filter((message) => message.role === "user") ?? [];
      expect(userMessages[0]?.content.some((part) => part.type === "image")).toBe(false);
      const currentMessage = userMessages.find(message => message.content.some(part => part.type === "text" && part.trust === "user_request" && part.text === current.request));
      expect(currentMessage?.content.some(part => part.type === "image" && part.attachment.id === "attachment-current")).toBe(true);
      expect(userMessages.filter(message => message.content.some(part => part.type === "image" && part.attachment.id === "attachment-current"))).toEqual([currentMessage]);
    } finally {
      await engine.close();
      database.close();
      vault.dispose();
    }
  });
});

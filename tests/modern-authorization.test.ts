import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type PermissionGrant, type Profile, type RunSpec } from "@harness/protocol";
import { browserTool, grantsAllow, terminalTool, ToolRegistry, type ToolDefinition } from "@harness/tools";
import { workflowPrelude, workflowReadTool } from "./workflow-fixture.js";

type Operation = { name: "terminal" | "browser" | "write_fixture"; input: Record<string, unknown> };
const terminal = (command: string, stdin?: string): Operation => ({ name: "terminal", input: { command, ...(stdin === undefined ? {} : { stdin }) } });
const write = (input: Record<string, unknown>): Operation => ({ name: "write_fixture", input });
const writeFixtureTool: ToolDefinition = { contract: { name: "write_fixture", description: "Fixture path-scoped write operation", inputSchema: { type: "object", properties: { path: { type: "string" }, filePath: { type: "string" }, cwd: { type: "string" } }, additionalProperties: false }, risk: "write", idempotent: false, timeoutMs: 1000 }, async execute() { return { output: "fixture" }; } };
const scopedGrant = (overrides: Partial<PermissionGrant> = {}): PermissionGrant => ({ toolNames: ["terminal"], pathGlobs: ["**"], commandPrefixes: ["inspect"], networkDomains: [], maxRisk: "high", ...overrides });

/** Real authorization/workflow/persistence paths; process and browser effects are replaced. */
async function scenario(workflowVersion: 1 | 2 | 3, operations: Operation[], options: { grants?: PermissionGrant[]; decisions?: boolean[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-modern-authorization-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "source.ts"), "export const value = 1;\n");
  const vault = await VaultCrypto.open(join(root, "key.json"), "modern-authorization-test-password");
  const database = await HarnessDatabase.open(join(root, "db.sqlite"), vault);
  const events: AgentEvent[] = [], executions: Operation[] = [];
  const tools = new ToolRegistry().register(workflowReadTool);
  for (const definition of [terminalTool, browserTool, writeFixtureTool]) tools.register({ ...definition, async execute(input, context) {
    if (definition.contract.name === "write_fixture") {
      const denied = grantsAllow("write_fixture", context.grants, input, "write");
      if (denied) throw new Error(denied);
    }
    executions.push({ name: definition.contract.name as Operation["name"], input: structuredClone(input) });
    return { output: { stdout: "Authorized fixture operation completed without changing workspace files.", exitCode: 0 } };
  } });
  const model = descriptor({ providerId: "authorization-fixture", modelId: "authorization", displayName: "Authorization fixture", maxContextTokens: 128_000 });
  let turn = 0;
  const provider: ModelProvider = {
    id: model.providerId, async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
    async *stream(request): AsyncIterable<ProviderStreamEvent> {
      if (request.messages.some(message => message.runtimePrompt === "stop_summary")) {
        yield { type: "text_delta", delta: "Report only the operations actually executed and any denied actions." };
        return;
      }
      turn += 1;
      if (workflowVersion === 1 && turn <= 3) { yield* workflowPrelude(turn); return; }
      const operationIndex = turn - 1 - (workflowVersion === 1 ? 3 : 0);
      const operation = operations[operationIndex];
      if (operation) yield { type: "tool_call", toolCall: { id: `operation-${operationIndex}`, name: operation.name, input: operation.input } };
      else yield { type: "text_delta", delta: "Report the observed operations and their authorization results." };
    },
  };
  const engine = new HarnessEngine({ database, providers: [provider], tools, memory: new MemoryService(database), skills: new SkillService(join(root, "skills")), projectTrust: new ProjectTrustService(database) });
  const profile: Profile = { ...DEFAULT_PROFILE, allowedProviders: [provider.id], toolNames: ["terminal", "browser", "write_fixture", "read_file"], memoryScopes: [], generationPolicy: { maxOutputTokens: 1_024 } };
  const spec: RunSpec = { id: newId("run"), sessionId: newId("session"), request: "Inspect the workspace with these authorized fixture operations and report their real outcomes.", workflowVersion, taskMode: "auto", profileId: profile.id, workspacePath: workspace, attachments: [], grants: structuredClone(options.grants ?? []), createdAt: nowIso(), budget: { ...profile.budget, maxTurns: 16, maxToolCalls: 30, maxDurationMs: 15_000 } };
  let approvalCount = 0;
  engine.on("event", (event: AgentEvent) => {
    if (event.runId !== spec.id) return;
    events.push(event);
    // Auto-answer only in this controlled fixture, while recording every prompt.
    if (event.type === "plan_approval_required") setTimeout(() => engine.decidePlan(event.planId, event.version, true, "test:user"), 0);
    if (event.type === "approval_required") {
      const approved = options.decisions?.[approvalCount++] ?? true;
      setTimeout(() => engine.approvals.decide(event.approvalId, approved, "test:user"), 0);
    }
  });
  try {
    const result = await new Promise<Extract<AgentEvent, { type: "result" }>>((resolve, reject) => {
      const timer = setTimeout(() => { engine.cancel(spec.id); reject(new Error("Authorization scenario timed out")); }, 20_000);
      engine.on("event", (event: AgentEvent) => { if (event.runId === spec.id && event.type === "result") { clearTimeout(timer); resolve(event); } });
      engine.start(spec, profile);
    });
    await engine.waitForSettlement(spec.id);
    const approvals = events.filter(event => event.type === "approval_required").map(event => database.getApproval(event.approvalId)!);
    return { result, events, executions, approvals, plan: database.getPlanForRun(spec.id), stored: database.getRun(spec.id) };
  } finally {
    await engine.close(); database.close(); vault.dispose();
    const withinTemporary = relative(tmpdir(), root);
    if (!withinTemporary || withinTemporary.startsWith("..") || isAbsolute(withinTemporary)) throw new Error("Unsafe fixture cleanup");
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function noDuplicatePlanPrompt(events: AgentEvent[]) {
  expect(events.filter(event => event.type === "plan_approval_required")).toEqual([]);
  const plans = events.filter(event => event.type === "plan_created" || event.type === "plan_updated");
  expect(plans.every(event => event.plan.status === "approved")).toBe(true);
}

describe.each([2, 3] as const)("modern workflow %s authorization", workflowVersion => {
  it("prompts once for each different terminal command and records the approved scope", async () => {
    const operations = [terminal("inspect first"), terminal("inspect second")];
    const f = await scenario(workflowVersion, operations);
    expect(f.result.status, f.result.text).toBe("completed");
    expect(f.executions).toEqual(operations);
    expect(f.approvals.map(approval => approval.normalizedInput.command)).toEqual(["inspect first", "inspect second"]);
    expect(f.approvals.map(approval => approval.requestedGrant.exactCommands)).toEqual([["inspect first"], ["inspect second"]]);
    expect(f.approvals.every(approval => approval.status === "approved" && approval.decidedBy === "test:user")).toBe(true);
    expect(f.plan).toMatchObject({ status: "approved", approvedBy: "test:user", approvalId: f.approvals[1]!.id });
    expect(f.plan?.steps.map(step => step.input)).toEqual(operations.map(operation => operation.input));
    noDuplicatePlanPrompt(f.events);
  });

  it("does not silently extend an approval to a changed command with additional arguments", async () => {
    const operations = [terminal("inspect first"), terminal("inspect first --extra")];
    const f = await scenario(workflowVersion, operations);
    expect(f.executions).toEqual(operations);
    expect(f.approvals).toHaveLength(2);
    noDuplicatePlanPrompt(f.events);
  });

  it("reuses authorization for the same exact command", async () => {
    const operations = [terminal("inspect exact"), terminal("inspect exact")];
    const f = await scenario(workflowVersion, operations);
    expect(f.executions).toEqual(operations);
    expect(f.approvals).toHaveLength(1);
    expect(f.plan?.steps).toHaveLength(1);
    noDuplicatePlanPrompt(f.events);
  });

  it("uses an existing explicitly scoped prefix grant without a new prompt", async () => {
    const operations = [terminal("inspect first"), terminal("inspect second")];
    const f = await scenario(workflowVersion, operations, { grants: [scopedGrant()] });
    expect(f.executions).toEqual(operations);
    expect(f.approvals).toEqual([]);
    expect(f.plan).toMatchObject({ status: "approved", approvedBy: "runtime:scoped-grant" });
    noDuplicatePlanPrompt(f.events);
  });

  it.each(["path", "filePath", "cwd"])("reuses the same literal %s but asks again for a changed value", async field => {
    const first = write({ [field]: "a/source.ts" });
    const second = write({ [field]: "b/source.ts" });
    const operations = [first, first, second, second];
    const f = await scenario(workflowVersion, operations);
    expect(f.executions).toEqual(operations);
    expect(f.approvals).toHaveLength(2);
    expect(f.approvals.map(approval => approval.requestedGrant.exactPathInputs)).toEqual([
      { path: null, filePath: null, cwd: null, [field]: "a/source.ts" },
      { path: null, filePath: null, cwd: null, [field]: "b/source.ts" },
    ]);
    noDuplicatePlanPrompt(f.events);
  });

  it("treats an approved wildcard character literally and requires approval for an omitted field", async () => {
    const operations = [write({ path: "literal*.ts" }), write({ path: "literal-other.ts" }), write({})];
    const f = await scenario(workflowVersion, operations);
    expect(f.executions).toEqual(operations);
    expect(f.approvals).toHaveLength(3);
    expect(f.approvals.map(approval => approval.requestedGrant.exactPathInputs?.path)).toEqual(["literal*.ts", "literal-other.ts", null]);
    noDuplicatePlanPrompt(f.events);
  });

  it("keeps explicitly configured broad path grants reusable", async () => {
    const operations = [write({ path: "a/nested/source.ts" }), write({ path: "b/nested/source.ts", cwd: "b" }), write({})];
    const f = await scenario(workflowVersion, operations, { grants: [scopedGrant({ toolNames: ["write_fixture"], commandPrefixes: [], maxRisk: "write" })] });
    expect(f.executions).toEqual(operations);
    expect(f.approvals).toEqual([]);
    noDuplicatePlanPrompt(f.events);
  });

  it("does not execute a denied action or reuse it as an approved grant", async () => {
    const operation = terminal("inspect denied");
    const f = await scenario(workflowVersion, [operation, operation], { decisions: [false, true] });
    expect(f.approvals.map(approval => approval.status)).toEqual(["denied", "approved"]);
    expect(f.executions).toEqual([operation]);
    expect(f.events.filter(event => event.type === "tool_started").filter(event => event.call.name === "terminal").map(event => event.call.id)).toEqual(["operation-1"]);
    expect(f.plan?.steps).toHaveLength(1);
    noDuplicatePlanPrompt(f.events);
  });

  it("requires separate approval for each stdin script, including a repeated script", async () => {
    const operations = [terminal("node -", "alpha"), terminal("node -", "beta"), terminal("node -", "alpha")];
    const f = await scenario(workflowVersion, operations, { grants: [scopedGrant({ commandPrefixes: ["node"] })] });
    expect(f.executions).toEqual(operations);
    expect(f.approvals.map(approval => approval.normalizedInput.stdin)).toEqual(["alpha", "beta", "alpha"]);
    expect(f.approvals.every(approval => approval.reason.includes("one-time approval"))).toBe(true);
    noDuplicatePlanPrompt(f.events);
  });

  it("retains one-time approval for repeated destructive commands even with a broad grant", async () => {
    const operation = terminal("git reset --hard");
    const f = await scenario(workflowVersion, [operation, operation], { grants: [scopedGrant({ commandPrefixes: ["git"], maxRisk: "destructive" })] });
    expect(f.executions).toEqual([operation, operation]);
    expect(f.approvals).toHaveLength(2);
    expect(f.approvals.every(approval => approval.risk === "destructive" && approval.reason.includes("one-time approval"))).toBe(true);
    noDuplicatePlanPrompt(f.events);
  });

  it("retains per-action approval for browser input and transfers even with a broad browser grant", async () => {
    const actions: Operation[] = [
      { name: "browser", input: { action: "click", selector: "#confirm" } },
      { name: "browser", input: { action: "fill", selector: "#value", value: "fixture" } },
      { name: "browser", input: { action: "press_key", key: "Enter" } },
      { name: "browser", input: { action: "upload", url: "https://fixture.test/", selector: "#file", paths: ["source.ts"] } },
      { name: "browser", input: { action: "download", url: "https://fixture.test/source.txt" } },
    ];
    const operations = actions.flatMap(operation => [operation, operation]);
    const f = await scenario(workflowVersion, operations, { grants: [scopedGrant({ toolNames: ["browser"], commandPrefixes: [], networkDomains: ["fixture.test"] })] });
    expect(f.executions).toEqual(operations);
    expect(f.approvals).toHaveLength(operations.length);
    expect(f.approvals.every(approval => approval.reason.includes("specific action"))).toBe(true);
    noDuplicatePlanPrompt(f.events);
  });
});

it("keeps the legacy workflow's separate plan and tool approval", async () => {
  const f = await scenario(1, [terminal("inspect legacy")]);
  expect(f.executions).toHaveLength(1);
  expect(f.approvals).toHaveLength(1);
  expect(f.events.filter(event => event.type === "plan_approval_required")).toHaveLength(1);
});

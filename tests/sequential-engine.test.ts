import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider, type ProviderStreamEvent } from "@harness/providers";
import { DEFAULT_PROFILE, newId, nowIso, type AgentEvent, type Profile, type RunSpec, type WorkflowState } from "@harness/protocol";
import { createDefaultToolRegistry, ToolRegistry } from "@harness/tools";

const call = (id: string, name: string, input: Record<string, unknown>): ProviderStreamEvent => ({ type: "tool_call", toolCall: { id, name, input } });
const action = (id: string, input: Record<string, unknown>) => call(id, "advance_workflow", input);
const check = (command: string) => ({ command, cwd: ".", timeoutMs: 1000 });

async function scenario(mode: "pass" | "repair" | "denied" | "budget" | "pause") {
  const directory = await mkdtemp(join(tmpdir(), "harness-sequential-"));
  const workspace = join(directory, "repo");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  await writeFile(join(workspace, "service.ts"), "export const service = 0;\n");
  await writeFile(join(workspace, "caller.ts"), "export const caller = 0;\n");
  const vault = await VaultCrypto.open(join(directory, "key.json"), "fixture-password");
  const database = await HarnessDatabase.open(join(directory, "db.sqlite"), vault);
  let engine: HarnessEngine | undefined;
  try {
    const events: AgentEvent[] = [];
    const executed: string[] = [];
    const tools = new ToolRegistry().register(createDefaultToolRegistry().get("read_file")!);
    tools.register({ contract: { name: "edit_module", description: "fixture implementation", inputSchema: { type: "object", properties: { module: { type: "string", enum: ["service", "caller"] } }, required: ["module"] }, risk: "write", idempotent: false, timeoutMs: 1000 },
      async execute(input) { const name = String(input.module); executed.push("edit:" + name); await writeFile(join(workspace, name + ".ts"), `export const ${name} = 1;\n`); return { output: "updated " + name }; } });
    let integrationAttempts = 0;
    tools.register({ contract: { name: "terminal", description: "fixture checks", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }, risk: "high", idempotent: false, timeoutMs: 1000 },
      async execute(input) {
        const command = String(input.command); executed.push(command);
        const service = await readFile(join(workspace, "service.ts"), "utf8");
        const caller = await readFile(join(workspace, "caller.ts"), "utf8");
        const passed = command === "unit-service" ? service.includes("= 1") : command === "unit-caller" ? caller.includes("= 1") : service.includes("= 1") && caller.includes("= 1") && !(mode === "repair" && integrationAttempts++ === 0);
        return { output: { exitCode: passed ? 0 : 1, stdout: passed ? "Assertions passed" : "Integration assertion failed" }, isError: !passed };
      } });
    tools.register({ contract: { name: "git_diff", description: "fixture complete diff", inputSchema: { type: "object", properties: {} }, risk: "read", idempotent: true, timeoutMs: 1000 }, async execute() { executed.push("diff"); return { output: { diff: "service.ts and caller.ts: -value=0 +value=1", complete: true } }; } });
    const steps = [ { id: "service", text: "Implement service", verification: [check("unit-service")] }, { id: "caller", text: "Wire caller", verification: [check("unit-caller")] } ];
    let turn = 0;
    let latest: WorkflowState | undefined;
    let phase = "initial";
    let repaired = false;
    let resumed = false;
    const model = descriptor({ providerId: "fake", modelId: "sequential", displayName: "Sequential", capabilities: { vision: false, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "local" } });
    const provider: ModelProvider = {
      id: "fake", async listModels() { return [model]; }, async health() { return true; }, estimateCost() { return 0; },
      async *stream(request) {
        if (request.purpose === "review") {
          expect(request.tools).toEqual([]);
          expect(JSON.stringify(request.messages)).toContain("integration");
          yield { type: "text_delta", delta: JSON.stringify({ passed: true, summary: "Service and caller agree", requirements: [{ id: "req-1", passed: true, evidence: "Both unit checks and integration assertions passed; diff implements the requirement" }] }) };
          return;
        }
        turn++;
        if (turn === 1) {
          // None of these calls may execute a mutation or skip the preparation gate.
          yield call("early-write", "edit_module", { module: "service" });
          yield call("early-probe", "probe", { command: "echo forbidden" });
          yield call("early-check", "run_verification", check("unit-service"));
          yield action("understand", { action: "understand", summary: "Implement service and connect caller", requirements: ["Service and caller work together"] });
          yield call("recon", "read_file", { path: "service.ts" });
          yield action("architecture", { action: "architecture", summary: "service owns logic and caller composes it", evidenceIds: ["recon"] });
          yield action("plan", { action: "plan", steps, integration: [check("integration")] });
          yield action("skip-step", { action: "start_step", stepId: "caller" });
          yield action("start-service", { action: "start_step", stepId: "service" });
          phase = "service"; return;
        }
        if (resumed && latest?.sequential?.architectureEpoch !== latest?.epoch) {
          yield call("resume-recon", "read_file", { path: "service.ts" });
          yield action("resume-architecture", { action: "architecture", summary: "Rechecked the service and caller boundary", evidenceIds: ["resume-recon"] });
          yield action("resume-service", { action: "start_step", stepId: "service" });
          phase = "service"; return;
        }
        if (phase === "service") {
          yield call("edit-service-" + turn, "edit_module", { module: "service" });
          yield call("verify-service-" + turn, "run_verification", check("unit-service"));
          phase = "caller"; return;
        }
        if (phase === "caller") {
          yield action("start-caller-" + turn, { action: "start_step", stepId: "caller" });
          yield call("edit-caller-" + turn, "edit_module", { module: "caller" });
          yield call("verify-caller-" + turn, "run_verification", check("unit-caller"));
          phase = "integration"; return;
        }
        if (phase === "integration" && mode !== "budget") {
          yield call("early-diff", "git_diff", {});
          yield call("foreign-check", "run_verification", { ...check("unplanned-integration"), stage: "broader" });
          yield call("integration-" + turn, "run_verification", { ...check("integration"), stage: "broader" });
          phase = "finish"; return;
        }
        if (mode === "repair" && latest?.broaderCheck.status !== "passed" && !repaired) {
          repaired = true;
          yield action("reopen", { action: "reopen_step", stepId: "caller", reason: "Integration exposed a caller mismatch" });
          yield call("repair-caller", "edit_module", { module: "caller" });
          yield call("reverify-caller", "run_verification", check("unit-caller"));
          yield call("integration-retry", "run_verification", { ...check("integration"), stage: "broader" });
          return;
        }
        if (phase === "finish" && latest?.broaderCheck.status === "passed" && latest.diffRevision !== latest.revision) { yield call("final-diff", "git_diff", {}); return; }
        yield { type: "text_delta", delta: "Service and caller result; any missing checks remain unverified." };
      },
    };
    engine = new HarnessEngine({ database, providers: [provider], tools, memory: new MemoryService(database), skills: new SkillService(join(directory, "skills")), projectTrust: new ProjectTrustService(database) });
    const profile: Profile = { ...DEFAULT_PROFILE, allowedProviders: ["fake"], toolNames: ["read_file", "edit_module", "terminal", "git_diff"], verificationPolicy: { ...DEFAULT_PROFILE.verificationPolicy, broaderPolicy: "disabled" } };
    const spec: RunSpec = { id: newId("run"), sessionId: "sequential", request: "Implement service and wire caller", workspacePath: workspace, profileId: profile.id, attachments: [], budget: { ...profile.budget, maxTurns: mode === "budget" || mode === "denied" ? 9 : 24 }, grants: [{ toolNames: ["edit_module"], pathGlobs: ["**"], commandPrefixes: [], networkDomains: [], maxRisk: "write" }], createdAt: nowIso() };
    engine.on("event", (event: AgentEvent) => {
      events.push(event);
      if (event.type === "workflow_updated") latest = event.workflow;
      if (event.type === "plan_approval_required") setTimeout(() => engine!.decidePlan(event.planId, event.version, true, "fixture"), 0);
      if (event.type === "approval_required") setTimeout(() => engine!.approvals.decide(event.approvalId, mode !== "denied", "fixture"), 0);
      if (mode === "pause" && !resumed && event.type === "workflow_updated" && event.workflow.sequential?.steps[0]?.status === "verified") engine!.pause(spec.id);
    });
    const run = async (start: () => void) => {
      const result = await new Promise<Extract<AgentEvent, { type: "result" }>>((resolve, reject) => {
        const timer = setTimeout(() => { engine!.cancel(spec.id); reject(new Error("Sequential test timed out")); }, 15000);
        const onEvent = (event: AgentEvent) => { if (event.type === "result") { clearTimeout(timer); engine!.off("event", onEvent); resolve(event); } };
        engine!.on("event", onEvent); start();
      });
      await engine!.waitForSettlement(spec.id);
      return result;
    };
    let result = await run(() => engine!.start(spec, profile));
    if (mode === "pause") { expect(result.status, result.text).toBe("paused"); resumed = true; result = await run(() => engine!.resume(spec.id, profile)); }
    return { result, events, executed, latest, storedSpec: database.getRun(spec.id)?.spec };
  } finally {
    await engine?.close(); database.close(); vault.dispose();
    const path = relative(tmpdir(), directory);
    if (!path || path.startsWith("..") || isAbsolute(path)) throw new Error("Unsafe cleanup target");
    await rm(directory, { recursive: true, force: true });
  }
}

describe("default sequential loop through the actual engine and bridge", () => {
  it("enforces ordered steps, cumulative checks, integration and final diff review", async () => {
    const result = await scenario("pass");
    expect(result.result.status).toBe("completed");
    expect(result.executed).toEqual(["edit:service", "unit-service", "edit:caller", "unit-service", "unit-caller", "diff", "integration", "diff"]);
    expect(result.storedSpec?.workflowVersion).toBe(3);
    expect(result.latest?.sequential?.steps.map(step => step.status)).toEqual(["verified", "verified"]);
    expect(result.latest?.independentReview.status).toBe("passed");
    const errors = result.events.filter(event => event.type === "tool_finished" && event.isError).map(event => event.type === "tool_finished" ? event.callId : "");
    expect(errors).toContain("skip-step"); expect(errors).toContain("foreign-check");
    expect(result.events.filter(event => event.type === "tool_started").map(event => event.type === "tool_started" && event.call.id)).not.toContain("early-write");
  });
  it("repairs an integration failure before review", async () => {
    const result = await scenario("repair");
    expect(result.result.status).toBe("completed");
    expect(result.executed.filter(command => command === "integration")).toHaveLength(2);
    expect(result.events.filter(event => event.type === "verification_finished" && !event.verification.passed)).toHaveLength(1);
  });
  it("keeps denied verification and exhausted budgets incomplete", async () => {
    for (const mode of ["denied", "budget"] as const) {
      const result = await scenario(mode);
      expect(result.result.status).toBe("review");
      expect(result.latest?.independentReview.status).not.toBe("passed");
      if (mode === "denied") expect(result.executed.some(command => command.startsWith("unit-"))).toBe(false);
      else expect(result.result.stop?.pending).toContain("集成测试");
    }
  });
  it("resumes the same task with preserved plan and fresh step verification", async () => {
    const result = await scenario("pause");
    expect(result.result.status).toBe("completed");
    const epochs = new Set(result.events.flatMap(event => event.type === "workflow_updated" ? [event.workflow.epoch] : []));
    expect(epochs.size).toBe(2);
    expect(result.executed.filter(command => command === "unit-service").length).toBeGreaterThanOrEqual(3);
  });
});

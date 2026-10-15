import { describe, expect, it, vi } from "vitest";
import { HarnessEngine, type EngineDependencies } from "../packages/core/src/engine.js";
import { SequentialWorkflow } from "../packages/core/src/sequential-workflow.js";
import { DEFAULT_PROFILE, nowIso, type AgentEvent, type RunCheckpoint, type RunSpec, type VerificationRun } from "@harness/protocol";

function plannedWorkflow() {
  const workflow = new SequentialWorkflow("Implement a service", () => {}, undefined, {}, "change");
  workflow.advance({ action: "understand", summary: "Implement the service", requirements: ["Service works"] });
  workflow.observe({ id: "source", name: "read_file", input: { path: "service.ts" } }, { output: "Current service source" });
  workflow.advance({ action: "architecture", summary: "Service owns the logic", evidenceIds: ["source"] });
  workflow.advance({ action: "plan", mode: "ordered", steps: [{ id: "service", text: "Implement service", verification: [{ command: "pnpm test -- tests/service.test.ts", cwd: ".", timeoutMs: 1000 }] }], integration: [{ command: "pnpm test -- tests/integration.test.ts", cwd: ".", timeoutMs: 1000 }] });
  workflow.advance({ action: "start_step", stepId: "service" });
  return workflow;
}

function fixture(options: { checkpointThrows?: boolean } = {}) {
  const workflow = plannedWorkflow();
  const spec: RunSpec = { id: "publication-run", sessionId: "publication-session", request: "Implement a service", workspacePath: ".", profileId: DEFAULT_PROFILE.id, attachments: [], budget: DEFAULT_PROFILE.budget, grants: [], createdAt: nowIso() };
  const persisted: VerificationRun[] = [], storedEvents: AgentEvent[] = [], emitted: AgentEvent[] = [], checkpoints: RunCheckpoint[] = [];
  const database = {
    saveVerificationRun(value: VerificationRun) { persisted.push(structuredClone(value)); },
    appendEvent(value: AgentEvent) { storedEvents.push(structuredClone(value)); },
    appendTrace() {},
    saveCheckpoint(value: RunCheckpoint) {
      if (options.checkpointThrows) throw new Error("checkpoint storage unavailable");
      checkpoints.push(structuredClone(value));
    },
  };
  // Publication touches only these persistence methods; no provider, tools or process executes.
  const engine = new HarnessEngine({ database, providers: [] } as unknown as EngineDependencies);
  engine.on("event", (value: AgentEvent) => emitted.push(structuredClone(value)));
  const state = { spec, workflow, controller: new AbortController(), sequence: 0, status: "verifying", startedAt: Date.now(), inputTokens: 0, outputTokens: 0, spentUsd: 0, costKnown: true, turns: 1, toolCalls: 1, transcript: [], pendingNonIdempotent: new Map(), repairAttemptsUsed: 0, pauseRequested: false, steering: [], steeringInFlight: new Set<string>(), steeringVersion: 0 };
  const receipt: VerificationRun = { id: "publication-verify", runId: spec.id, attempt: 0, stage: "local", epoch: workflow.state.epoch, revision: workflow.state.revision, passed: true, outcome: "passed", startedAt: nowIso(), finishedAt: nowIso(), results: [{ itemId: "unrelated-check", command: "pnpm test -- tests/unrelated.test.ts", cwd: ".", exitCode: 0, passed: true, required: true, output: "Unrelated tests passed", durationMs: 10, timedOut: false }] };
  const boundary = engine as unknown as { publishVerification(spec: RunSpec, state: unknown, receipt: VerificationRun): void };
  return { workflow, receipt, persisted, storedEvents, emitted, checkpoints, publish: () => boundary.publishVerification(spec, state, receipt) };
}

function finished(events: AgentEvent[]) {
  return events.flatMap(event => event.type === "verification_finished" ? [event.verification] : []);
}

describe("verification terminal receipt publication", () => {
  it("publishes the plan-evidence downgrade consistently without altering the actual successful command", () => {
    const f = fixture(), actualResults = structuredClone(f.receipt.results);
    f.publish();
    const expected = { passed: false, outcome: "failed", skipReason: expect.stringContaining("pnpm test -- tests/service.test.ts") };
    expect(f.receipt).toMatchObject(expected);
    expect(f.persisted).toEqual([f.receipt]);
    expect(finished(f.storedEvents)).toEqual([f.receipt]);
    expect(finished(f.emitted)).toEqual([f.receipt]);
    expect(f.workflow.state.localCheck).toMatchObject({ status: "failed", runId: f.receipt.id, reason: expected.skipReason });
    expect(f.checkpoints).toHaveLength(1);
    expect(f.checkpoints[0]?.workflow?.localCheck).toEqual(f.workflow.state.localCheck);
    expect(f.receipt.results).toEqual(actualResults);
    expect(f.persisted[0]?.results[0]).toMatchObject({ exitCode: 0, passed: true, output: "Unrelated tests passed" });
    expect(f.workflow.checksCurrent()).toBe(false);
  });

  it("saves and emits a stale terminal receipt when workflow recording rejects it", () => {
    const f = fixture(), before = structuredClone(f.workflow.state.localCheck);
    f.receipt.epoch = "previous-epoch";
    const record = vi.spyOn(f.workflow, "recordVerification").mockImplementation(() => { throw new Error("Stale verification run"); });
    expect(f.publish).not.toThrow();
    expect(record).toHaveBeenCalledExactlyOnceWith(f.receipt);
    expect(f.persisted).toEqual([f.receipt]);
    expect(finished(f.storedEvents)).toEqual([f.receipt]);
    expect(finished(f.emitted)).toEqual([f.receipt]);
    expect(f.receipt).toMatchObject({ passed: true, outcome: "passed", epoch: "previous-epoch" });
    expect(f.workflow.state.localCheck).toEqual(before);
    expect(f.workflow.checksCurrent()).toBe(false);
    expect(f.checkpoints).toHaveLength(1);
  });

  it("emits the accepted terminal receipt exactly once when checkpoint persistence fails", () => {
    const f = fixture({ checkpointThrows: true });
    expect(f.publish).not.toThrow();
    expect(f.persisted).toEqual([f.receipt]);
    expect(finished(f.storedEvents)).toEqual([f.receipt]);
    expect(finished(f.emitted)).toEqual([f.receipt]);
    expect(f.receipt).toMatchObject({ passed: false, outcome: "failed", skipReason: expect.stringContaining("pnpm test -- tests/service.test.ts") });
    expect(f.workflow.state.localCheck).toMatchObject({ status: "failed", runId: f.receipt.id });
    expect(f.receipt.results[0]).toMatchObject({ exitCode: 0, passed: true });
    expect(f.checkpoints).toEqual([]);
    expect(f.emitted.some(event => event.type === "checkpoint_saved")).toBe(false);
  });
});

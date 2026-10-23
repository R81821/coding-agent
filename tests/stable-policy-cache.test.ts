import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, type MemoryRecord, type ModelMessage, type PromptBackend, type RunSpec } from "@harness/protocol";
import { descriptor } from "@harness/providers";
import { buildInitialMessages, type ContextInputs } from "../packages/core/src/context.js";
import { createPromptSystem } from "../packages/core/src/prompt-system.js";

const run: RunSpec = {
  id: "stable-policy", sessionId: "stable-policy-session", profileId: DEFAULT_PROFILE.id,
  request: "Inspect the code, then implement the authorized change", taskMode: "auto",
  workspacePath: "D:/stable-policy", workflowVersion: 3, behaviorPolicyVersion: 2,
  attachments: [], grants: [], budget: DEFAULT_PROFILE.budget, createdAt: "2026-10-22T00:00:00Z",
};
const profile = { ...DEFAULT_PROFILE, systemPrompt: "Configured profile {{model}} remains developer-owned" };
const memory: MemoryRecord = {
  id: "approved-memory", content: "Keep this project-specific fact as data", source: "approved-fixture",
  scope: "project", scopeId: run.workspacePath, confidence: 1, status: "approved", pinned: false,
  createdAt: run.createdAt,
};
const workflows: NonNullable<ContextInputs["workflow"]>[] = [
  { intent: "analysis", sequential: { steps: [] } },
  { intent: "analysis", sequential: { steps: [{ id: "edit" }, { id: "verify" }] } },
  { intent: "change", sequential: { steps: [{ id: "edit" }, { id: "verify" }] } },
  { intent: "change", sequential: { steps: [{ id: "edit", status: "verified" }, { id: "verify", status: "active" }] } },
];
const policy = (messages: ModelMessage[]) => messages.filter(message => message.role === "system" || message.role === "developer");
const policyText = (messages: ModelMessage[]) => policy(messages).flatMap(message => message.content.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n");

describe("stable task policy across runtime phases", () => {
  it.each(["auto", "change"] as const)("keeps %s policy byte-identical across configure, first mutation, verification and recovery", taskMode => {
    const policies = workflows.map(workflow => policy(buildInitialMessages({ run: { ...run, taskMode }, profile, memories: [], workflow })));
    for (const candidate of policies.slice(1)) expect(JSON.stringify(candidate)).toBe(JSON.stringify(policies[0]));
    expect(policyText(policies[0]!)).toContain("run_verification");
    expect(policyText(policies[0]!)).toContain("adaptive task dependency graph");
  });

  it("keeps explicit analysis lightweight even if recovered workflow data reports a graph or change intent", () => {
    const policies = workflows.map(workflow => policy(buildInitialMessages({ run: { ...run, taskMode: "analysis" }, profile, memories: [], workflow })));
    for (const candidate of policies.slice(1)) expect(candidate).toEqual(policies[0]);
    const text = policyText(policies[0]!);
    expect(text).toContain("Analysis mode permits reads and read-only container probes only");
    for (const implementation of ["adaptive task dependency graph", "When run_tasks is declared", "Inspect relevant code before editing", "Test failures and stale evidence are work for the repair loop"]) {
      expect(text).not.toContain(implementation);
    }
  });

  it("keeps workspace, budget, request, project rules and approved memory out of the fixed prefix", () => {
    const first = buildInitialMessages({ run, profile, memories: [], workflow: workflows[0]! });
    const second = buildInitialMessages({
      run: { ...run, id: "resumed-stable-policy", workspacePath: "D:/another-workspace", request: "Continue the accepted task", budget: { ...run.budget, maxTurns: 3, maxUsd: 1 } },
      profile, memories: [memory], trustedProjectInstructions: "PROJECT_DATA_SENTINEL {{cwd}}", workflow: workflows[3]!,
    });
    expect(policy(second)).toEqual(policy(first));
    expect(policyText(second)).not.toContain("PROJECT_DATA_SENTINEL");
    expect(policyText(second)).not.toContain(memory.content);
    expect(JSON.stringify(second)).toContain(memory.content);
    expect(JSON.stringify(second)).toContain("PROJECT_DATA_SENTINEL");
    expect(second.at(-1)?.content[0]).toMatchObject({ text: "Continue the accepted task", trust: "user_request" });
  });

  it("keeps legacy tool vocabulary and omits modern DAG execution guidance", () => {
    for (const workflowVersion of [1, 2] as const) {
      for (const workflow of workflows) {
        const messages = buildInitialMessages({ run: { ...run, workflowVersion }, profile, memories: [], workflow });
        const text = policyText(messages);
        expect(text).not.toContain("adaptive task dependency graph");
        expect(text).not.toContain("When run_tasks is declared");
        if (workflowVersion === 1) {
          expect(text).toContain("update_workflow");
          expect(text).not.toContain("advance_workflow configure");
        }
      }
    }
  });

  it.each<PromptBackend>(["harness", "dsh"])("retains stable policy and provenance through the %s backend", async backend => {
    const system = await createPromptSystem(backend);
    const model = descriptor({ providerId: "stable-provider", modelId: "stable-model", displayName: "Stable model" });
    try {
      const results: ModelMessage[][] = [];
      for (const workflow of workflows) {
        const input = buildInitialMessages({ run, profile, memories: [memory], trustedProjectInstructions: "PROJECT_CONTEXT {{cwd}}", workflow });
        const result = await system.assemble(input, [], model);
        results.push(result.messages);
        expect(result.messages.find(message => message.role === "developer")).toEqual({
          role: "developer", content: [{ type: "text", trust: "user_profile", text: profile.systemPrompt }],
        });
        expect(policyText(result.messages)).not.toContain(memory.content);
        expect(policyText(result.messages)).not.toContain("PROJECT_CONTEXT");
        expect(result.messages.find(message => message.content.some(part => part.type === "text" && part.text.includes(memory.content)))?.content[0]).toMatchObject({ trust: "user_profile" });
        expect(system.runtimeContext(JSON.stringify({ intent: workflow.intent, steps: workflow.sequential?.steps })))
          .toBe(JSON.stringify({ intent: workflow.intent, steps: workflow.sequential?.steps }));
      }
      for (const candidate of results.slice(1)) expect(policy(candidate)).toEqual(policy(results[0]!));
      const identities = policyText(results[0]!).match(/You are an AI agent powered by DeepSeek Harness\./g) ?? [];
      expect(identities).toHaveLength(backend === "dsh" ? 1 : 0);
    } finally {
      await system.dispose();
    }
  });
});

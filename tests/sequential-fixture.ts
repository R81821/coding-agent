import type { ProviderStreamEvent } from "@harness/providers";

/** Real planning-tool calls, including a repository observation; no state injection. */
export function sequentialPrelude(command = "fixture-verify", path = "memory.ts"): ProviderStreamEvent[] {
  const call = (id: string, input: Record<string, unknown>): ProviderStreamEvent => ({ type: "tool_call", toolCall: { id, name: "advance_workflow", input } });
  return [
    call("understand", { action: "understand", summary: "Inspect the module and implement the requested change", requirements: ["Requested behavior works"] }),
    { type: "tool_call", toolCall: { id: "plan-read", name: "read_file", input: { path } } },
    call("architecture", { action: "architecture", summary: "The inspected module owns the requested behavior", evidenceIds: ["plan-read"] }),
    call("plan", { action: "plan", steps: [{ id: "implement", text: "Implement and verify behavior", verification: [{ command }] }], integration: [{ command: "fixture-integration" }] }),
    call("start", { action: "start_step", stepId: "implement" }),
  ];
}

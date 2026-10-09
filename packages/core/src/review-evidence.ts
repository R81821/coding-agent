import { createHash } from "node:crypto";
import { canonicalJson, type AgentEvent, type ToolCall, type VerificationRun, type WorkflowState } from "@harness/protocol";

type Observation = WorkflowState["observations"][number];
type FinishedEvent = Extract<AgentEvent, { type: "tool_finished" }>;

export interface ReviewObservation {
  id: string;
  tool: string;
  target: string;
  epoch: string;
  revision: number;
  sequence: number;
  input?: ToolCall["input"];
  output?: unknown;
  /** The same output is supplied separately as diff, or on another observation. */
  outputReference?: string;
  sourceEvidenceId?: string;
  reconfirmed?: true;
}

export interface ReviewEvidenceInput {
  state: WorkflowState;
  events: AgentEvent[];
  modern: boolean;
  verificationRuns?: VerificationRun[];
  diffObservationId?: string;
}

/** Keep capture provenance without sending an image's encoded bytes as plain text tokens. */
function reviewOutput(tool: string, output: unknown): unknown {
  if (tool !== "browser" || !output || typeof output !== "object" || Array.isArray(output)) return output;
  const record = output as Record<string, unknown>;
  if (typeof record.base64 !== "string" || typeof record.mimeType !== "string" || !record.mimeType.startsWith("image/")) return output;
  const { base64, ...metadata } = record;
  const bytes = Buffer.from(base64, "base64");
  return {
    ...metadata,
    binaryEvidence: { omitted: true, encoding: "base64", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), limitation: "Image bytes are retained in the original tool event. This request includes capture metadata, not a view of the image pixels." },
  };
}

/**
 * Modern reviews receive current original tool evidence, including reads and browser actions.
 * A cached read counts as current only when its new successful observation reconfirms the exact
 * request. Historical reads are otherwise excluded, even if the final report cites their IDs.
 * Missing originals are returned explicitly; callers must not silently review a partial bundle.
 */
export function buildReviewEvidence(input: ReviewEvidenceInput): { observations: ReviewObservation[]; missingEvidenceIds: string[] } {
  const { state } = input;
  const requiredIds = new Set([...state.requirementReceipts.flatMap(receipt => [...receipt.observationIds, receipt.diffObservationId]), ...state.reviewEvidenceIds].filter(Boolean));
  if (input.diffObservationId) requiredIds.add(input.diffObservationId);
  const observedById = new Map(state.observations.map(item => [item.id, item]));
  const calls = new Map<string, ToolCall>();
  const finished = new Map<string, FinishedEvent>();
  for (const event of input.events) {
    if (event.type === "tool_call" || event.type === "tool_started") calls.set(event.call.id, event.call);
    if (event.type === "tool_finished") finished.set(event.callId, event);
  }
  const current = (item: Observation) => item.epoch === state.epoch && item.revision === state.revision && !item.failed && item.complete;
  const selectedIds = new Set(requiredIds);
  if (input.modern) for (const item of state.observations) if (current(item) && item.kind === "tool") selectedIds.add(item.id);
  const missing = new Set<string>();
  const observations: ReviewObservation[] = [];
  const outputs = new Map<string, string>();

  const resolveOriginal = (observed: Observation, visited = new Set<string>()): { output: unknown; sourceId: string } | undefined => {
    const event = finished.get(observed.id);
    if (!event || event.isError || visited.has(observed.id)) return;
    const output = event.output;
    if (output && typeof output === "object" && ("truncated" in output && output.truncated === true || ["git_diff", "workspace_diff"].includes(observed.tool) && "complete" in output && output.complete === false)) return;
    if (!output || typeof output !== "object" || !("reusedEvidenceId" in output)) return { output, sourceId: observed.id };
    const reuse = output as Record<string, unknown>;
    const call = calls.get(observed.id);
    if (!["read_file", "read_range"].includes(observed.tool) || reuse.unchanged !== true || reuse.truncated === true || typeof reuse.reusedEvidenceId !== "string" || !call || call.name !== observed.tool) return;
    const source = observedById.get(reuse.reusedEvidenceId);
    const sourceCall = source && calls.get(source.id);
    if (!source || !sourceCall || source.failed || !source.complete || source.epoch !== state.epoch || source.revision > observed.revision || source.sequence >= observed.sequence || source.tool !== observed.tool || sourceCall.name !== call.name || canonicalJson(sourceCall.input) !== canonicalJson(call.input)) return;
    visited.add(observed.id);
    return resolveOriginal(source, visited);
  };

  for (const id of selectedIds) {
    const observed = observedById.get(id);
    if (!observed || !current(observed) || observed.kind === "failure") { missing.add(id); continue; }
    const call = calls.get(id);
    if (input.modern && observed.kind === "tool" && !call) { missing.add(id); continue; }
    const base = { id, tool: observed.tool, target: observed.target, epoch: observed.epoch, revision: observed.revision, sequence: observed.sequence, ...(call ? { input: call.input } : {}) };
    if (observed.kind === "verification") {
      const verification = input.verificationRuns?.find(run => run.id === id && run.passed && run.epoch === state.epoch && run.revision === state.revision);
      if (!verification) { missing.add(id); continue; }
      observations.push({ ...base, output: verification });
      continue;
    }
    const resolved = resolveOriginal(observed);
    if (!resolved) { missing.add(id); continue; }
    if (call && call.name !== observed.tool) { missing.add(id); continue; }
    const provenance = resolved.sourceId === id ? {} : { sourceEvidenceId: resolved.sourceId, reconfirmed: true as const };
    const output = reviewOutput(observed.tool, resolved.output);
    const outputKey = canonicalJson({ tool: observed.tool, input: call?.input, output });
    // Preserve the legacy review payload. The modern bundle names its shared diff once.
    if (!input.modern) {
      observations.push({ ...observed, output: resolved.output });
      continue;
    }
    if (id === input.diffObservationId) {
      outputs.set(outputKey, "diff");
      observations.push({ ...base, ...provenance, outputReference: "diff" });
      continue;
    }
    const previousId = outputs.get(outputKey);
    if (previousId) observations.push({ ...base, ...provenance, outputReference: previousId === "diff" ? "diff" : `observation:${previousId}` });
    else { outputs.set(outputKey, id); observations.push({ ...base, ...provenance, output }); }
  }
  return { observations, missingEvidenceIds: [...missing] };
}

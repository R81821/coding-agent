import { z } from "zod";
import { SummaryOutcomeSchema, ContextAdjustmentSchema, ContextUsageSchema, CacheDiagnosticSchema } from "./cache-diagnostics.js";
import { SkillReferenceSchema } from "./skills.js";
import { WorkflowStateSchema } from "./workflow.js";
import { McpRequestSchemas, McpToolSnapshotSchema } from "./mcp.js";
import { ConversationTaskQueueReferenceSchema } from "./conversation-tasks.js";
export * from "./conversation-tasks.js";
export * from "./workflow.js";
export * from "./mcp.js";
export * from "./attachments.js";

export const TrustLevelSchema = z.enum([
  "app_policy",
  "user_request",
  "user_profile",
  "trusted_project",
  "promoted_attachment",
  "untrusted_attachment",
  "untrusted_web",
  "untrusted_tool"
]);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;

export const RunStatusSchema = z.enum([
  "queued",
  "planning",
  "running",
  "waiting_approval",
  "paused",
  "verifying",
  "review",
  "completed",
  "failed",
  "cancelled"
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSteerResultSchema = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true), messageId: z.string().min(1), queued: z.number().int().nonnegative(), status: RunStatusSchema,
    resumed: z.boolean().optional(), resumeError: z.string().optional() }),
  z.object({ accepted: z.literal(false), queued: z.literal(0), status: RunStatusSchema }),
]);
export type RunSteerResult = z.infer<typeof RunSteerResultSchema>;

export const SteeringMessageSchema = z.object({ id: z.string().min(1), text: z.string().trim().min(1).max(4_000) });
export type SteeringMessage = z.infer<typeof SteeringMessageSchema>;

export const KanbanStatusSchema = z.enum([
  "Backlog",
  "Ready",
  "Running",
  "Awaiting Approval",
  "Blocked",
  "Review",
  "Done",
  "Failed",
  "Cancelled"
]);
export type KanbanStatus = z.infer<typeof KanbanStatusSchema>;

export const RiskLevelSchema = z.enum(["read", "write", "high", "destructive"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const AttachmentRefSchema = z.object({
  id: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.string(),
  fileName: z.string().min(1).max(255).optional(),
  textTokenEstimate: z.number().int().nonnegative().optional(),
  byteLength: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  encryptedPath: z.string(),
  source: z.enum(["file", "clipboard", "screenshot", "telegram", "feishu", "browser"]),
  trust: TrustLevelSchema,
  allowedProviders: z.array(z.string()).default([]),
  createdAt: z.string().datetime()
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

export const ContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), trust: TrustLevelSchema }),
  z.object({ type: z.literal("image"), attachment: AttachmentRefSchema, detail: z.enum(["auto", "low", "high"]).default("auto") }),
  z.object({ type: z.literal("file"), attachment: AttachmentRefSchema }),
  z.object({ type: z.literal("tool_call"), toolCallId: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("tool_result"), toolCallId: z.string(), output: z.unknown(), trust: z.literal("untrusted_tool") })
]);
export type ContentPart = z.infer<typeof ContentPartSchema>;

export const ModelMessageSchema = z.object({
  // Internal identity for acknowledging a persisted steering message, never an instruction/grant.
  steeringId: z.string().min(1).optional(),
  reasoningContent: z.string().optional(),
  // Internal control provenance; this instruction expires after its summary request.
  runtimePrompt: z.literal("stop_summary").optional(),
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.array(ContentPartSchema)
});
export type ModelMessage = z.infer<typeof ModelMessageSchema>;

export const ToolContractSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  // Provider-side structured generation; runtime input validation is always independent.
  strict: z.boolean().optional(),
  risk: RiskLevelSchema,
  idempotent: z.boolean(),
  timeoutMs: z.number().int().positive().max(3_600_000)
});
export type ToolContract = z.infer<typeof ToolContractSchema>;

export const ReasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ProviderCapabilitiesSchema = z.object({
  reasoningEfforts: z.array(ReasoningEffortSchema).optional(),
  vision: z.boolean(),
  tools: z.boolean(),
  parallelTools: z.boolean(),
  structuredOutput: z.boolean(),
  maxContextTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  dataPolicy: z.enum(["local", "cloud", "gateway"])
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ModelDescriptorSchema = z.object({
  pricingKnown: z.boolean().optional(),
  providerId: z.string(),
  modelId: z.string(),
  displayName: z.string(),
  capabilities: ProviderCapabilitiesSchema,
  qualityScore: z.number().min(0).max(1),
  inputUsdPerMillion: z.number().nonnegative(),
  outputUsdPerMillion: z.number().nonnegative(),
  latencyScore: z.number().min(0).max(1),
  healthy: z.boolean().default(true)
});
export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;
export interface CurrentModel { model: ModelDescriptor | null; error?: string }

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown())
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolCallOriginSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  toolName: z.string(),
  revision: z.number().int().positive(),
});
export type ToolCallOrigin = z.infer<typeof ToolCallOriginSchema>;

export const UsageSchema = z.object({
  reasoningTokens: z.number().int().nonnegative().optional(),
  costKnown: z.boolean().optional(),
  purpose: z.enum(["main", "compaction", "review", "sampling", "memory"]).optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedUsd: z.number().nonnegative()
});
export type Usage = z.infer<typeof UsageSchema>;

export const PlanStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  dependencies: z.array(z.string()).default([]),
  executor: z.enum(["main", "child"]).default("main"),
  mode: z.enum(["read", "write", "verify"]),
  allowedTools: z.array(z.string()).default([]),
  input: z.record(z.string(), z.unknown()).default({}),
  outputContract: z.string(),
  acceptanceCriteria: z.array(z.string()).default([]),
  status: z.enum(["pending", "ready", "running", "awaiting_approval", "completed", "failed", "cancelled"]).default("pending")
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanScopeSchema = z.object({
  pathGlobs: z.array(z.string()).default([]),
  commandPrefixes: z.array(z.string()).default([]),
  networkDomains: z.array(z.string()).default([]),
  maxRisk: RiskLevelSchema.default("write")
});
export type PlanScope = z.infer<typeof PlanScopeSchema>;

export const PlanSpecSchema = z.object({
  id: z.string(),
  runId: z.string(),
  goal: z.string(),
  version: z.number().int().positive(),
  status: z.enum(["draft", "awaiting_approval", "approved", "running", "revising", "completed", "failed", "rejected"]),
  steps: z.array(PlanStepSchema).min(1),
  scope: PlanScopeSchema,
  approvalId: z.string().optional(),
  approvedBy: z.string().optional(),
  approvedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type PlanSpec = z.infer<typeof PlanSpecSchema>;

export const VerificationItemSchema = z.object({
  dependencyPaths: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  stdin: z.string().max(1_000_000).optional(),
  stage: z.enum(["local", "broader"]).optional(),
  id: z.string(),
  command: z.string().min(1),
  cwd: z.string().default("."),
  timeoutMs: z.number().int().positive().max(3_600_000).default(120_000),
  required: z.boolean().default(true),
  expectedExitCodes: z.array(z.number().int()).min(1).default([0])
});
export type VerificationItem = z.infer<typeof VerificationItemSchema>;

export const VerificationMatrixSchema = z.object({
  broaderPolicy: z.enum(["required", "optional", "disabled"]).optional(),
  reviewPolicy: z.enum(["standard", "risk_based"]).optional(),
  items: z.array(VerificationItemSchema).default([]),
  maxRepairAttempts: z.number().int().min(0).max(5).nullable().default(null)
});
export type VerificationMatrix = z.infer<typeof VerificationMatrixSchema>;

export const VerificationResultSchema = z.object({
  dependencyPaths: z.array(z.string()).optional(), dependencyFingerprint: z.string().optional(), dependencyComplete: z.boolean().optional(),
  reusedFromRunId: z.string().optional(),
  fingerprint: z.string().optional(),
  reusedFromItemId: z.string().optional(),
  itemId: z.string(),
  command: z.string(),
  cwd: z.string(),
  exitCode: z.number().int().nullable(),
  passed: z.boolean(),
  required: z.boolean(),
  output: z.string(),
  durationMs: z.number().int().nonnegative(),
  timedOut: z.boolean().default(false)
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const VerificationRunSchema = z.object({
  codeFingerprint: z.string().optional(),
  outcome: z.enum(["passed", "failed", "skipped"]).optional(),
  skipReason: z.string().optional(),
  epoch: z.string().optional(),
  stage: z.enum(["local", "broader"]).optional(),
  revision: z.number().int().nonnegative().optional(),
  id: z.string(),
  runId: z.string(),
  attempt: z.number().int().nonnegative(),
  results: z.array(VerificationResultSchema),
  passed: z.boolean(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime()
});
export type VerificationRun = z.infer<typeof VerificationRunSchema>;

export const ContextSnapshotSchema = z.object({
  id: z.string(),
  runId: z.string(),
  messages: z.array(ModelMessageSchema),
  estimatedTokens: z.number().int().nonnegative(),
  modelContextTokens: z.number().int().positive(),
  retainedEventSequences: z.array(z.number().int().nonnegative()).default([]),
  createdAt: z.string().datetime()
});
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;

export const RunCheckpointSchema = z.object({
  conversationTaskQueue: ConversationTaskQueueReferenceSchema.optional(),
  // Version 1 working transcripts cover the preceding conversation, including accepted summaries.
  sessionContextVersion: z.literal(1).optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  verificationProgress: z.object({ stage: z.enum(["local", "broader"]), epoch: z.string(), revision: z.number().int().nonnegative(), codeFingerprint: z.string(), startedAt: z.string().datetime(), results: z.array(VerificationResultSchema), pendingItemIds: z.array(z.string()) }).optional(),
  workspaceFingerprint: z.string().optional(),
  workspaceBaseline: AttachmentRefSchema.optional(),
  repairAttemptsUsed: z.number().int().nonnegative().optional(),
  workflow: WorkflowStateSchema.optional(),
  id: z.string(),
  runId: z.string(),
  sequence: z.number().int().nonnegative(),
  reason: z.enum(["model_turn", "tool_batch", "plan_decision", "compaction", "verification", "manual"]),
  status: RunStatusSchema,
  transcript: z.array(ModelMessageSchema),
  planVersion: z.number().int().positive().optional(),
  currentStepId: z.string().optional(),
  usage: UsageSchema,
  turns: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  pendingNonIdempotentToolCalls: z.array(ToolCallSchema).default([]),
  // Optional for checkpoints written before steering became durable.
  pendingSteering: z.array(SteeringMessageSchema).max(8).optional(),
  createdAt: z.string().datetime()
});
export type RunCheckpoint = z.infer<typeof RunCheckpointSchema>;

export const CompactionRecordSchema = z.object({
  id: z.string(),
  runId: z.string(),
  sourceSequenceStart: z.number().int().nonnegative(),
  sourceSequenceEnd: z.number().int().nonnegative(),
  summary: z.string(),
  summaryHash: z.string(),
  modelId: z.string().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  deterministicFallback: z.boolean(),
  summaryOutcome: SummaryOutcomeSchema.optional(),
  trust: z.literal("untrusted_tool").default("untrusted_tool"),
  createdAt: z.string().datetime()
});
export type CompactionRecord = z.infer<typeof CompactionRecordSchema>;

export const PluginGrantSchema = z.object({
  pathGlobs: z.array(z.string()).default([]),
  networkDomains: z.array(z.string()).default([]),
  allowProcesses: z.boolean().default(false),
  mode: z.enum(["trusted_node", "untrusted_docker"])
});
export type PluginGrant = z.infer<typeof PluginGrantSchema>;

export const PluginManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  compatibility: z.string(),
  entrypoint: z.string(),
  tools: z.array(ToolContractSchema).default([]),
  requestedGrant: PluginGrantSchema,
  contentHash: z.string(),
  sourcePath: z.string(),
  fingerprint: z.string().optional()
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const PluginRecordSchema = z.object({
  manifest: PluginManifestSchema,
  trustedHash: z.string().optional(),
  grant: PluginGrantSchema.optional(),
  enabled: z.boolean().default(false),
  installedAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type PluginRecord = z.infer<typeof PluginRecordSchema>;

export const WebSearchResultSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  publishDate: z.string().nullable().optional(),
  excerpts: z.array(z.string()),
  trust: z.literal("untrusted_web").default("untrusted_web")
});
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;

export const SearchResponseSchema = z.object({
  searchId: z.string(),
  results: z.array(WebSearchResultSchema),
  warnings: z.array(z.string()).default([]),
  usage: z.record(z.string(), z.unknown()).default({})
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export interface SearchProvider {
  readonly id: string;
  search(input: { queries: string[]; objective?: string; maxCharsTotal?: number; signal?: AbortSignal }): Promise<SearchResponse>;
  health(): Promise<{ healthy: boolean; detail?: string }>;
}

export const EvalCaseSchema = z.object({
  id: z.string(),
  category: z.enum(["injection", "compaction", "planning", "recovery", "plugin", "verification"]),
  run: z.lazy(() => RunSpecSchema).optional(),
  fixture: z.record(z.string(), z.unknown()),
  assertions: z.array(z.string())
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const EvalResultSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  passed: z.boolean(),
  assertions: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string().optional() })),
  durationMs: z.number().int().nonnegative(),
  createdAt: z.string().datetime()
});
export type EvalResult = z.infer<typeof EvalResultSchema>;

export const ModelRequestSchema = z.object({
  reasoningEffort: ReasoningEffortSchema.optional(),
  disableThinking: z.boolean().optional(),
  cacheDiagnostics: z.boolean().optional(),
  purpose: z.enum(["main", "compaction", "review", "sampling", "memory"]).optional(),
  promptCacheKey: z.string().max(64).optional(),
  runId: z.string(),
  model: ModelDescriptorSchema,
  messages: z.array(ModelMessageSchema),
  tools: z.array(ToolContractSchema),
  maxOutputTokens: z.number().int().positive(),
  parallelToolCalls: z.boolean(),
  store: z.boolean().default(false)
});
export type ModelRequest = z.infer<typeof ModelRequestSchema>;

const eventBase = { id: z.string(), runId: z.string(), at: z.string().datetime(), sequence: z.number().int().nonnegative() };
const RunUsageCounterSchema = z.object({ used: z.number().nonnegative(), limit: z.number().nonnegative() });
export const RunStopInfoSchema = z.object({
  code: z.enum(["model_turn_limit", "tool_call_limit", "cost_limit", "duration_limit", "repeated_observation", "verification_config_missing", "review_incomplete", "provider_error"]),
  message: z.string(), phase: z.string(),
  usage: z.object({
    toolCalls: RunUsageCounterSchema, modelTurns: RunUsageCounterSchema,
    repairs: z.object({ used: z.number().int().nonnegative(), limit: z.null() }),
    usd: RunUsageCounterSchema.extend({ costKnown: z.boolean().optional() }), durationMs: RunUsageCounterSchema,
  }),
  pending: z.array(z.string()),
  lastFailure: z.object({ tool: z.string().optional(), message: z.string() }).optional(),
  summaryError: z.string().optional(),
});
export type RunStopInfo = z.infer<typeof RunStopInfoSchema>;

export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...eventBase,
    type: z.literal("capabilities_resolved"),
    mcp: z.array(McpToolSnapshotSchema),
    diagnostics: z.array(z.object({ serverId: z.string(), name: z.string(), error: z.string() })),
    skills: z.array(z.object({ key: z.string(), name: z.string() })),
  }),
  z.object({ ...eventBase, type: z.literal("workflow_updated"), workflow: WorkflowStateSchema, detail: z.string() }),
  z.object({ ...eventBase, type: z.literal("status"), status: RunStatusSchema }),
  z.object({ ...eventBase, type: z.literal("route"), providerId: z.string(), modelId: z.string(), reason: z.string(), estimatedUsd: z.number().nonnegative() }),
  z.object({ ...eventBase, type: z.literal("assistant_turn_started") }),
  z.object({ ...eventBase, type: z.literal("text_delta"), delta: z.string() }),
  z.object({ ...eventBase, type: z.literal("reasoning_summary"), summary: z.string() }),
  z.object({ ...eventBase, type: z.literal("tool_call"), call: ToolCallSchema }),
  z.object({ ...eventBase, type: z.literal("tool_started"), call: ToolCallSchema, origin: ToolCallOriginSchema.optional() }),
  z.object({ ...eventBase, type: z.literal("tool_finished"), callId: z.string(), output: z.unknown(), durationMs: z.number().nonnegative(), isError: z.boolean().optional() }),
  z.object({ ...eventBase, type: z.literal("approval_required"), approvalId: z.string(), summary: z.string(), risk: RiskLevelSchema }),
  z.object({ ...eventBase, type: z.literal("plan_created"), plan: PlanSpecSchema }),
  z.object({ ...eventBase, type: z.literal("plan_updated"), plan: PlanSpecSchema }),
  z.object({ ...eventBase, type: z.literal("plan_approval_required"), planId: z.string(), version: z.number().int().positive(), summary: z.string() }),
  // durationMs/messages make the cost of checkpointing visible: a run writes one of these per tool
  // result, so growth here against conversation size is what tells us the store needs a delta.
  z.object({ ...eventBase, type: z.literal("checkpoint_saved"), checkpointId: z.string(), reason: RunCheckpointSchema.shape.reason, durationMs: z.number().nonnegative().optional(), messages: z.number().int().nonnegative().optional() }),
  z.object({ ...eventBase, type: z.literal("context_compacted"), record: CompactionRecordSchema }),
  z.object({ ...eventBase, type: z.literal("context_adjusted"), adjustment: ContextAdjustmentSchema }),
  z.object({ ...eventBase, type: z.literal("context_usage"), context: ContextUsageSchema }),
  z.object({ ...eventBase, type: z.literal("cache_diagnostic"), diagnostic: CacheDiagnosticSchema }),
  z.object({ ...eventBase, type: z.literal("verification_started"), verificationRunId: z.string(), attempt: z.number().int().nonnegative() }),
  z.object({
    ...eventBase,
    type: z.literal("verification_cache_decision"),
    verificationRunId: z.string(), itemId: z.string(), command: z.string(), cwd: z.string(),
    cached: z.boolean(), source: z.enum(["saved_run", "checkpoint", "same_suite", "executed", "unavailable"]),
    force: z.boolean(), reason: z.string().max(300),
    reusedFromRunId: z.string().optional(), dependencyComplete: z.boolean().optional(),
  }),
  z.object({ ...eventBase, type: z.literal("verification_finished"), verification: VerificationRunSchema }),
  z.object({ ...eventBase, type: z.literal("repair_started"), attempt: z.number().int().positive(), maxAttempts: z.number().int().positive().nullable() }),
  z.object({
    ...eventBase,
    type: z.literal("provider_retry"),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    delayMs: z.number().int().nonnegative(),
    category: z.enum(["transient", "tool_history_protocol"]),
    recovery: z.enum(["retry_request", "flatten_tool_history"]),
    reason: z.string(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("self_correction_started"),
    trigger: z.enum(["tool_error", "verification_failure"]),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive().nullable(),
    summary: z.string(),
  }),
  z.object({ ...eventBase, type: z.literal("plugin_event"), pluginId: z.string(), action: z.string(), detail: z.string().optional() }),
  z.object({ ...eventBase, type: z.literal("search_usage"), providerId: z.string(), searchId: z.string(), resultCount: z.number().int().nonnegative(), usage: z.record(z.string(), z.unknown()).default({}) }),
  z.object({ ...eventBase, type: z.literal("recovery_event"), checkpointId: z.string().optional(), action: z.enum(["restored", "paused_non_idempotent", "failed"]), detail: z.string() }),
  z.object({ ...eventBase, type: z.literal("model_request_finished"), purpose: z.enum(["main", "compaction", "review", "sampling", "memory"]), durationMs: z.number().nonnegative(), succeeded: z.boolean(), maxOutputTokens: z.number().int().positive().optional(), configuredMaxOutputTokens: z.number().int().positive().optional(), attempt: z.number().int().positive().optional(), errorCode: z.string().optional() }),
  z.object({ ...eventBase, type: z.literal("usage"), usage: UsageSchema }),
  // Accepted user input appears in the conversation before model delivery. Its stable ID joins
  // submission and delivery without duplicating the human message after resume or reload.
  z.object({ ...eventBase, type: z.literal("steering_submitted"), messageId: z.string().min(1), text: z.string(), withdrawable: z.boolean().optional() }),
  z.object({ ...eventBase, type: z.literal("steering_delivered"), messageId: z.string().min(1).optional(), text: z.string() }),
  z.object({ ...eventBase, type: z.literal("error"), code: z.string(), message: z.string(), retryable: z.boolean() }),
  z.object({ ...eventBase, type: z.literal("result"), text: z.string(), status: RunStatusSchema, stop: RunStopInfoSchema.optional(), sourceAssistantTurnSequence: z.number().int().nonnegative().optional() })
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventInput = AgentEvent extends infer Event ? Event extends AgentEvent ? Omit<Event, "id" | "runId" | "at" | "sequence"> : never : never;

/**
 * Scoped allowance granted by a user approval or configured in a Profile/RunSpec.
 * Semantics: empty `toolNames` matches no tool; empty `pathGlobs`/`commandPrefixes`/
 * `networkDomains` mean "no constraint on that dimension"; `"**"` in pathGlobs matches
 * all paths. Expired grants (expiresAt in the past) never match.
 */
export const PermissionGrantSchema = z.object({
  toolNames: z.array(z.string()),
  pathGlobs: z.array(z.string()),
  commandPrefixes: z.array(z.string()),
  networkDomains: z.array(z.string()),
  maxRisk: RiskLevelSchema,
  expiresAt: z.string().datetime().optional()
});
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;

export const RunBudgetSchema = z.object({
  maxTurns: z.number().int().positive().max(100).default(64),
  maxToolCalls: z.number().int().nonnegative().max(200).default(128),
  maxDurationMs: z.number().int().positive().default(1_800_000),
  maxUsd: z.number().positive().default(5)
});
export type RunBudget = z.infer<typeof RunBudgetSchema>;

export const GenerationPolicySchema = z.object({
  maxOutputTokens: z.number().int().positive().optional(),
  reviewMaxOutputTokens: z.number().int().positive().optional(),
});
export type GenerationPolicy = z.infer<typeof GenerationPolicySchema>;

export const RunSpecSchema = z.object({
  reasoningEffort: ReasoningEffortSchema.nullable().optional(),
  continuation: z.object({ runId: z.string(), checkpointId: z.string(), note: z.string().max(4000).optional() }).optional(),
  mcpUncertainCalls: z.array(z.object({ name: z.string(), fingerprint: z.string() })).optional(),
  mcpSnapshot: z.array(McpToolSnapshotSchema).max(16384).optional(),
  mcpReadOnly: z.boolean().optional(),
  mcpInherited: z.array(McpToolSnapshotSchema).max(16384).optional(),
  skillSelection: z.array(z.string()).max(100).optional(),
  skills: z.array(SkillReferenceSchema).max(100).optional(),
  taskMode: z.enum(["auto", "analysis", "change"]).default("auto").optional(),
  workflowVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  id: z.string(),
  sessionId: z.string(),
  request: z.string().min(1),
  workspacePath: z.string(),
  profileId: z.string(),
  attachments: z.array(AttachmentRefSchema).default([]),
  budget: RunBudgetSchema,
  generationPolicy: GenerationPolicySchema.optional(),
  grants: z.array(PermissionGrantSchema).default([]),
  parentRunId: z.string().optional(),
  parentStepId: z.string().optional(),
  createdAt: z.string().datetime()
});
export type RunSpec = z.infer<typeof RunSpecSchema>;
export interface RunWithdrawal { run: RunSpec; withdrawnRunIds: string[]; messageId?: string; text?: string }

export type RunHistoryItem = Pick<RunSpec, "id" | "sessionId" | "request" | "workspacePath" | "profileId" | "createdAt"> & { status: RunStatus };
export interface RunHistoryPage { items: RunHistoryItem[]; hasMore: boolean }

export interface RunReviewFile { path: string; added: number; deleted: number; diff: string; canUndo: boolean; undone: boolean }
export interface RunReview { runId: string; status: "capturing" | "ready" | "unavailable"; files: RunReviewFile[]; reason?: string; scope?: "tracked-and-nonignored-untracked" }

export const SessionRecordSchema = z.object({
  reasoningEffort: ReasoningEffortSchema.nullable().optional(),
  skillSelection: z.array(z.string()).max(100).optional(),
  id: z.string().min(1), workspacePath: z.string().min(1), profileId: z.string().min(1),
  title: z.string().trim().min(1).max(300), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().optional(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
export type SessionSummary = SessionRecord & { runCount: number; latestRunId?: string; latestStatus?: RunStatus };
export interface SessionPage { items: SessionSummary[]; hasMore: boolean }
export interface SessionDetail { session: SessionRecord; runs: Array<{ spec: RunSpec; status: RunStatus; events: AgentEvent[]; view?: { lastSequence: number; eventsComplete: boolean } }>; withdrawnEvents?: AgentEvent[] }
export interface SessionCursor { createdAt: string; id: string }
export interface SessionView extends SessionDetail { hasMore: boolean; before?: SessionCursor }
export interface RunEventPage { events: AgentEvent[]; nextSequence: number; hasMore: boolean; status: RunStatus }
export const ProjectRecordSchema = z.object({
  id: z.string().min(1), workspacePath: z.string().min(1), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), deletedAt: z.string().datetime().optional(),
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;


export const ProfileSchema = z.object({
  budgetPolicyVersion: z.number().int().nonnegative().optional(),
  contextPolicyMigration: z.object({ version: z.literal(1), reason: z.enum(["legacy_defaults", "invalid_saved_config"]), previous: z.unknown() }).optional(),
  id: z.string(),
  name: z.string(),
  systemPrompt: z.string(),
  allowedProviders: z.array(z.string()).min(1),
  preferredModels: z.array(z.string()),
  routeWeights: z.object({ quality: z.number(), cost: z.number(), latency: z.number() }),
  toolNames: z.array(z.string()),
  memoryScopes: z.array(z.enum(["session", "project", "global"])),
  memoryPolicyVersion: z.number().int().nonnegative().optional(),
  skillIds: z.array(z.string()),
  sandbox: z.enum(["local", "docker", "auto"]),
  budget: RunBudgetSchema,
  generationPolicy: GenerationPolicySchema.optional(),
  responsesContinuation: z.boolean().optional(),
  contextPolicy: z.object({
    workingContextTokens: z.number().int().min(4096).max(2_000_000).optional(), compactAtRatio: z.number().min(0.5).max(0.9).default(0.8),
    maxAfterCompactionRatio: z.number().min(0.1).max(0.9).default(0.45),
    outputReserveRatio: z.number().min(0.1).max(0.4).default(0.2),
    retainRecentTurns: z.number().int().min(1).max(10).default(2),
    resendImagesOnVisualRecheckOnly: z.boolean().default(true)
  }).refine(value => value.maxAfterCompactionRatio < value.compactAtRatio, { message: "压缩后目标比例必须小于触发比例", path: ["maxAfterCompactionRatio"] }).default({ compactAtRatio: 0.8, maxAfterCompactionRatio: 0.45, outputReserveRatio: 0.2, retainRecentTurns: 2, resendImagesOnVisualRecheckOnly: true }),
  planningPolicy: z.object({
    requiredForWrites: z.boolean().default(true),
    requiredForCommands: z.boolean().default(true),
    requiredForExternalBrowserActions: z.boolean().default(true),
    requiredForDelegation: z.boolean().default(true),
    maxParallelAgents: z.number().int().min(1).max(8).default(4)
  }).default({ requiredForWrites: true, requiredForCommands: true, requiredForExternalBrowserActions: true, requiredForDelegation: true, maxParallelAgents: 4 }),
  verificationPolicy: VerificationMatrixSchema.default({ items: [], maxRepairAttempts: null }),
  resiliencePolicy: z.object({
    maxProviderAttempts: z.number().int().min(1).max(5).default(3),
    providerRetryBaseDelayMs: z.number().int().min(0).max(10_000).default(500),
    maxToolSelfCorrections: z.number().int().min(0).max(10).nullable().default(null),
  }).default({
    maxProviderAttempts: 3,
    providerRetryBaseDelayMs: 500,
    maxToolSelfCorrections: null,
  }),
  searchProviders: z.array(z.string()).default([]),
  pluginIds: z.array(z.string()).default([]),
  telemetryPolicy: z.object({
    localTraces: z.boolean().default(true),
    otlpEnabled: z.boolean().default(false),
    otlpEndpoint: z.string().url().optional()
  }).default({ localTraces: true, otlpEnabled: false }),
  detailedRemoteOutput: z.boolean().default(false)
});
export type Profile = z.infer<typeof ProfileSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  runId: z.string(),
  toolName: z.string(),
  normalizedInput: z.record(z.string(), z.unknown()),
  risk: RiskLevelSchema,
  reason: z.string(),
  requestedGrant: PermissionGrantSchema,
  status: z.enum(["pending", "approved", "denied", "expired"]),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  decidedBy: z.string().optional()
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const MemoryKindSchema = z.enum(["preference", "convention", "decision", "fact", "summary"]);
export const MemoryCreateSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  scope: z.enum(["project", "global"]),
  scopeId: z.string().min(1),
  kind: MemoryKindSchema.exclude(["summary"]),
  key: z.string().trim().min(1).max(120),
});
export type MemoryCreate = z.infer<typeof MemoryCreateSchema>;
export interface MemoryPublicationPreview {
  workspacePath: string;
  token: string;
  files: Array<{ path: string; before: string; after: string }>;
  memoryIds: string[];
}
export const MemoryRecordSchema = z.object({
  id: z.string(),
  content: z.string(),
  source: z.string(),
  scope: z.enum(["session", "project", "global"]),
  scopeId: z.string(),
  confidence: z.number().min(0).max(1),
  status: z.enum(["candidate", "approved", "rejected", "expired", "superseded"]),
  kind: MemoryKindSchema.optional(),
  key: z.string().max(120).optional(),
  evidence: z.array(z.object({ source: z.string(), quote: z.string().max(2000) })).max(8).optional(),
  sources: z.array(z.string()).max(16).optional(),
  conflictIds: z.array(z.string()).optional(),
  supersededBy: z.string().optional(),
  lastSeenAt: z.string().optional(),
  pinned: z.boolean(),
  approvedBy: z.string().optional(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
  editedBy: z.string().optional()
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const MemoryPatchSchema = z.object({
  content: z.string().trim().min(1).max(50_000).optional(),
  pinned: z.boolean().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  scope: z.enum(["project", "global"]).optional(),
  scopeId: z.string().min(1).optional(),
  kind: MemoryKindSchema.exclude(["summary"]).optional(),
  key: z.string().trim().min(1).max(120).optional()
}).strict().refine((value) => Object.keys(value).length > 0, "Empty memory update");
export type MemoryPatch = z.infer<typeof MemoryPatchSchema>;
export type MemoryScopeSelection = Pick<MemoryRecord, "scope" | "scopeId">;
export interface MemoryExport { schemaVersion: 1; exportedAt: string; records: MemoryRecord[] }

export const SkillManifestSchema = z.object({
  key: z.string().optional(),
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  triggers: z.array(z.string()),
  tools: z.array(z.string()),
  pathGlobs: z.array(z.string()),
  networkDomains: z.array(z.string()),
  compatibility: z.string(),
  sourcePath: z.string(),
  trustedHash: z.string().optional(),
  enabled: z.boolean()
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export const TaskSpecSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: KanbanStatusSchema,
  run: RunSpecSchema,
  dependencies: z.array(z.string()),
  cron: z.string().optional(),
  timezone: z.string().default("Asia/Shanghai"),
  misfireGraceMs: z.number().int().nonnegative().default(86_400_000),
  allowOverlap: z.boolean().default(false),
  approvedPlanTemplate: PlanSpecSchema.optional(),
  verificationMatrix: VerificationMatrixSchema.optional(),
  notify: z.array(z.enum(["desktop", "telegram", "feishu"]))
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const DaemonRequestSchema = z.discriminatedUnion("method", [
  ...McpRequestSchemas,
  z.object({ id: z.string(), method: z.literal("session.skills"), params: z.object({ sessionId: z.string().min(1), skillSelection: z.array(z.string().min(1)).max(100) }) }),
  z.object({ id: z.string(), method: z.literal("skills.recommend"), params: z.object({ profileId: z.string().min(1), query: z.string().trim().min(1).max(4000) }) }),
  z.object({ id: z.string(), method: z.literal("skills.preview"), params: z.object({ command: z.string().trim().min(1).max(4000) }) }),
  z.object({ id: z.string(), method: z.literal("skills.install"), params: z.object({ previewId: z.string(), skillPath: z.string(), replace: z.boolean().default(false) }) }),
  z.object({ id: z.string(), method: z.literal("skills.job"), params: z.object({ jobId: z.string() }) }),
  z.object({ id: z.string(), method: z.literal("skills.cancel"), params: z.object({ jobId: z.string() }) }),
  z.object({ id: z.string(), method: z.literal("skills.location") }),
  z.object({ id: z.string(), method: z.literal("health") }),
  z.object({ id: z.string(), method: z.literal("model.current"), params: z.object({ profileId: z.string().min(1), needsVision: z.boolean().optional() }) }),
  z.object({ id: z.string(), method: z.literal("session.reasoning"), params: z.object({ sessionId: z.string().min(1), profileId: z.string().min(1).optional(), needsVision: z.boolean().optional(), reasoningEffort: ReasoningEffortSchema.nullable() }) }),
  z.object({ id: z.string(), method: z.literal("sessions.create"), params: SessionRecordSchema.omit({ deletedAt: true }) }),
  z.object({ id: z.string(), method: z.literal("sessions.list"), params: z.object({ deleted: z.boolean().default(false), limit: z.number().int().positive().max(200).default(50), offset: z.number().int().nonnegative().default(0) }).default({ deleted: false, limit: 50, offset: 0 }) }),
  z.object({ id: z.string(), method: z.literal("session.get"), params: z.object({ sessionId: z.string().min(1) }) }),
  z.object({ id: z.string(), method: z.literal("session.view"), params: z.object({ sessionId: z.string().min(1), limit: z.number().int().min(1).max(20).default(20), before: z.object({ createdAt: z.string(), id: z.string() }).optional() }) }),
  z.object({ id: z.string(), method: z.literal("run.eventPage"), params: z.object({ runId: z.string(), afterSequence: z.number().int().default(-1), limit: z.number().int().min(1).max(200).default(100) }) }),
  z.object({ id: z.string(), method: z.literal("run.output"), params: z.object({ runId: z.string(), callId: z.string(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(64000).default(16000) }) }),
  z.object({ id: z.string(), method: z.literal("session.delete"), params: z.object({ sessionId: z.string().min(1) }) }),
  z.object({ id: z.string(), method: z.literal("session.restore"), params: z.object({ sessionId: z.string().min(1) }) }),
  z.object({ id: z.string(), method: z.literal("session.purge"), params: z.object({ sessionId: z.string().min(1) }) }),
  z.object({ id: z.string(), method: z.literal("projects.list"), params: z.object({ deleted: z.boolean().default(false) }).default({ deleted: false }) }),
  z.object({ id: z.string(), method: z.literal("project.delete"), params: z.object({ projectId: z.string().min(1) }) }),
  z.object({ id: z.string(), method: z.literal("project.restore"), params: z.object({ projectId: z.string().min(1) }) }),
  z.object({ id: z.string(), method: z.literal("run.start"), params: RunSpecSchema }),
  z.object({ id: z.string(), method: z.literal("runs.list"), params: z.object({ limit: z.number().int().positive().max(200).default(50), offset: z.number().int().nonnegative().default(0) }).optional() }),
  z.object({ id: z.string(), method: z.literal("run.get"), params: z.object({ runId: z.string().min(1) }) }),
  z.object({ id: z.string(), method: z.literal("run.review"), params: z.object({ runId: z.string().min(1) }) }),
  z.object({ id: z.string(), method: z.literal("review.undo"), params: z.object({ runId: z.string().min(1), path: z.string().min(1) }) }),
  z.object({ id: z.string(), method: z.literal("run.resume"), params: z.object({ runId: z.string() }) }),
  z.object({ id: z.string(), method: z.literal("run.continue"), params: z.object({ runId: z.string(), note: z.string().trim().max(4000).optional() }) }),
  z.object({ id: z.string(), method: z.literal("run.cancel"), params: z.object({ runId: z.string() }) }),
  z.object({ id: z.string(), method: z.literal("run.pause"), params: z.object({ runId: z.string() }) }),
  z.object({ id: z.string(), method: z.literal("run.withdraw"), params: z.object({ runId: z.string().min(1), messageId: z.string().min(1).optional() }) }),
  z.object({ id: z.string(), method: z.literal("run.steer"), params: z.object({ runId: z.string(), text: z.string().min(1).max(4_000), resumePaused: z.boolean().optional() }) }),
  z.object({ id: z.string(), method: z.literal("run.events"), params: z.object({ runId: z.string(), afterSequence: z.number().int().default(-1) }) }),
  z.object({ id: z.string(), method: z.literal("plan.get"), params: z.object({ runId: z.string() }) }),
  z.object({ id: z.string(), method: z.literal("plan.decide"), params: z.object({ planId: z.string(), version: z.number().int().positive(), approved: z.boolean(), actor: z.string(), feedback: z.string().optional() }) }),
  z.object({ id: z.string(), method: z.literal("checkpoints.get"), params: z.object({ runId: z.string(), limit: z.number().int().positive().max(100).default(20) }) }),
  z.object({ id: z.string(), method: z.literal("approval.decide"), params: z.object({ approvalId: z.string(), approved: z.boolean(), actor: z.string() }) }),
  z.object({ id: z.string(), method: z.literal("approvals.list") }),
  z.object({ id: z.string(), method: z.literal("tasks.list") }),
  z.object({ id: z.string(), method: z.literal("conversationTasks.list"), params: z.object({ sessionId: z.string().min(1), parentRunId: z.string().min(1).optional() }) }),
  z.object({ id: z.string(), method: z.literal("conversationTasks.cancel"), params: z.object({ sessionId: z.string().min(1), parentRunId: z.string().min(1), taskId: z.string().min(1) }) }),
  z.object({ id: z.string(), method: z.literal("conversationTasks.retry"), params: z.object({ sessionId: z.string().min(1), parentRunId: z.string().min(1), taskId: z.string().min(1), reason: z.string().trim().min(1).max(4000) }) }),
  z.object({ id: z.string(), method: z.literal("tasks.upsert"), params: TaskSpecSchema }),
  z.object({ id: z.string(), method: z.literal("profiles.list") }),
  z.object({ id: z.string(), method: z.literal("profiles.upsert"), params: ProfileSchema }),
  z.object({ id: z.string(), method: z.literal("memory.list"), params: z.object({ scopeId: z.string().optional() }).optional() }),
  z.object({ id: z.string(), method: z.literal("memory.decide"), params: z.object({ memoryId: z.string(), approved: z.boolean(), actor: z.string(), replaceConflicts: z.boolean().optional() }) }),
  z.object({ id: z.string(), method: z.literal("memory.create"), params: MemoryCreateSchema.extend({ actor: z.string() }) }),
  z.object({ id: z.string(), method: z.literal("memory.publishPreview"), params: z.object({ workspacePath: z.string(), memoryIds: z.array(z.string()).max(100) }) }),
  z.object({ id: z.string(), method: z.literal("memory.publish"), params: z.object({ workspacePath: z.string(), memoryIds: z.array(z.string()).max(100), token: z.string().regex(/^[a-f0-9]{64}$/) }) }),
  z.object({ id: z.string(), method: z.literal("memory.update"), params: z.object({ memoryId: z.string(), patch: MemoryPatchSchema, actor: z.string() }) }),
  z.object({ id: z.string(), method: z.literal("memory.delete"), params: z.object({ memoryId: z.string() }) }),
  z.object({ id: z.string(), method: z.literal("memory.export"), params: z.object({ memoryIds: z.array(z.string()).max(1000) }) }),
  z.object({ id: z.string(), method: z.literal("profiles.memoryScopes"), params: z.object({ profileId: z.string(), memoryScopes: z.array(z.enum(["session", "project", "global"])) }) }),
  z.object({ id: z.string(), method: z.literal("skills.list"), params: z.object({ workspacePath: z.string().optional() }).optional() }),
  z.object({ id: z.string(), method: z.literal("skills.trust"), params: z.object({ sourcePath: z.string(), expectedHash: z.string().optional() }) }),
  z.object({ id: z.string(), method: z.literal("skills.untrust"), params: z.object({ skillId: z.string() }) }),
  z.object({ id: z.string(), method: z.literal("plugins.list") }),
  z.object({ id: z.string(), method: z.literal("plugins.install"), params: z.object({ sourcePath: z.string() }) }),
  z.object({ id: z.string(), method: z.literal("plugins.trust"), params: z.object({ pluginId: z.string(), grant: PluginGrantSchema }) }),
  z.object({ id: z.string(), method: z.literal("plugins.enable"), params: z.object({ pluginId: z.string() }) }),
  z.object({ id: z.string(), method: z.literal("plugins.disable"), params: z.object({ pluginId: z.string() }) }),
  z.object({ id: z.string(), method: z.literal("search.status") }),
  z.object({ id: z.string(), method: z.literal("eval.run"), params: z.object({ caseIds: z.array(z.string()).optional(), live: z.boolean().default(false) }).optional() }),
  z.object({ id: z.string(), method: z.literal("eval.results") }),
  z.object({ id: z.string(), method: z.literal("trace.query"), params: z.object({ runId: z.string().optional(), type: z.string().optional(), limit: z.number().int().positive().max(1000).default(200) }).optional() }),
  z.object({ id: z.string(), method: z.literal("trace.export"), params: z.object({ runId: z.string(), destinationPath: z.string() }) }),
  z.object({ id: z.string(), method: z.literal("project.inspect"), params: z.object({ workspacePath: z.string() }) }),
  z.object({ id: z.string(), method: z.literal("project.trust"), params: z.object({ workspacePath: z.string(), files: z.array(z.object({ path: z.string(), sha256: z.string() })) }) }),
  z.object({ id: z.string(), method: z.literal("project.scaffold"), params: z.object({ workspacePath: z.string() }) }),
  z.object({ id: z.string(), method: z.literal("connectors.pairing"), params: z.object({ connector: z.enum(["telegram", "feishu"]) }) }),
  z.object({ id: z.string(), method: z.literal("attachment.put"), params: z.object({ base64: z.string(), mimeType: z.string(), fileName: z.string().min(1).max(255).optional(), source: z.enum(["file", "clipboard", "screenshot", "telegram", "feishu", "browser"]), allowedProviders: z.array(z.string()).default([]) }) })
]);
export type DaemonRequest = z.infer<typeof DaemonRequestSchema>;
export type DaemonRequestInput = DaemonRequest extends infer Request ? Request extends DaemonRequest ? Omit<Request, "id"> : never : never;

export const DaemonResponseSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional()
});
export type DaemonResponse = z.infer<typeof DaemonResponseSchema>;

export const DEFAULT_PROFILE: Profile = ProfileSchema.parse({
  id: "default",
  name: "Balanced Developer",
  systemPrompt: "You are a careful software development agent. Respect trust boundaries, inspect before editing, and verify changes.",
  allowedProviders: ["openai", "anthropic", "gemini", "openai-compatible", "gateway"],
  preferredModels: [],
  routeWeights: { quality: 0.5, cost: 0.25, latency: 0.25 },
  toolNames: ["read_file", "read_range", "list_files", "search_text", "apply_patch", "terminal", "git_diff", "browser", "web_search", "delegate"],
  memoryScopes: ["session", "project", "global"],
  skillIds: [],
  sandbox: "auto",
  budget: { maxTurns: 64, maxToolCalls: 128, maxDurationMs: 1_800_000, maxUsd: 5 },
  contextPolicy: { compactAtRatio: 0.8, maxAfterCompactionRatio: 0.45, outputReserveRatio: 0.2, retainRecentTurns: 2, resendImagesOnVisualRecheckOnly: true },
  planningPolicy: { requiredForWrites: true, requiredForCommands: true, requiredForExternalBrowserActions: true, requiredForDelegation: true, maxParallelAgents: 4 },
  verificationPolicy: { items: [], maxRepairAttempts: null },
  resiliencePolicy: { maxProviderAttempts: 3, providerRetryBaseDelayMs: 500, maxToolSelfCorrections: null },
  searchProviders: ["parallel"],
  pluginIds: [],
  telemetryPolicy: { localTraces: true, otlpEnabled: false },
  detailedRemoteOutput: false
});

// A desktop launch owns one daemon endpoint; CLI daemons keep the legacy default.
export function daemonEndpointName(instanceId?: string): string {
  if (instanceId === undefined) return "harness-agent-v2";
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(instanceId)) throw new Error("Invalid daemon instance ID");
  return `harness-agent-v2-${instanceId}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export * from "./prompt-cache.js";
export * from "./context-policy.js";
export * from "./cache-diagnostics.js";
export * from "./browser.js";
export * from "./skills.js";
export * from "./session-view.js";
export * from "./session-content.js";

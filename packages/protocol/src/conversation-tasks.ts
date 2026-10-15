import { z } from "zod";

export const ConversationTaskExecutionStateSchema = z.enum(["blocked", "queued", "running", "awaiting_integration", "completed", "failed", "interrupted", "cancelled"]);
export type ConversationTaskExecutionState = z.infer<typeof ConversationTaskExecutionStateSchema>;

export const ConversationTaskUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0), outputTokens: z.number().int().nonnegative().default(0),
  estimatedUsd: z.number().nonnegative().default(0), turns: z.number().int().nonnegative().default(0),
  toolCalls: z.number().int().nonnegative().default(0), durationMs: z.number().nonnegative().default(0),
  cachedInputTokens: z.number().int().nonnegative().default(0), costKnown: z.boolean().optional(),
});
export type ConversationTaskUsage = z.infer<typeof ConversationTaskUsageSchema>;
export const ConversationTaskBudgetSchema = z.object({
  maxTurns: z.number().int().nonnegative(), maxToolCalls: z.number().int().nonnegative(),
  maxDurationMs: z.number().nonnegative(), maxUsd: z.number().nonnegative(),
});
export type ConversationTaskBudget = z.infer<typeof ConversationTaskBudgetSchema>;

export const ConversationTaskAttemptSchema = z.object({
  attemptId: z.string().min(1), childRunId: z.string().min(1), claimedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(), finishedAt: z.string().datetime().optional(),
  retryReason: z.string().max(4000).optional(), error: z.string().max(6000).optional(),
  executionState: ConversationTaskExecutionStateSchema,
  reservation: ConversationTaskBudgetSchema.optional(), reservationState: z.enum(["held", "released", "settled"]).default("released"),
  accountedUsage: ConversationTaskUsageSchema.default(() => ConversationTaskUsageSchema.parse({})),
  summary: z.string().max(6000).optional(), patch: z.unknown().optional(), workspacePath: z.string().optional(), baselineTree: z.string().optional(),
});
export type ConversationTaskAttempt = z.infer<typeof ConversationTaskAttemptSchema>;

export const ConversationTaskSchema = z.object({
  taskId: z.string().min(1), sessionId: z.string().min(1), parentRunId: z.string().min(1), stepId: z.string().min(1),
  planGeneration: z.number().int().nonnegative(), queueVersion: z.number().int().nonnegative().default(0), enqueueOrder: z.number().int().nonnegative().optional(),
  source: z.object({ kind: z.enum(["run", "steering"]), messageId: z.string().min(1).optional(), checkpointId: z.string().optional(), queueVersion: z.number().int().nonnegative().optional() }),
  submissionKey: z.string().min(1).optional(), executionState: ConversationTaskExecutionStateSchema.default("queued"),
  priority: z.number().int().min(0).max(100).default(0), dependsOn: z.array(z.string().min(1)).default([]),
  blockedReason: z.string().max(4000).optional(), mode: z.enum(["read", "write"]), prompt: z.string().trim().min(1).max(10000),
  writePaths: z.array(z.string().min(1)).default([]), readPaths: z.array(z.string().min(1)).default([]), resourceKeys: z.array(z.string().min(1)).default([]),
  evidenceIds: z.array(z.string()).default([]), dependencyArtifacts: z.array(z.string()).default([]), workspaceVersion: z.string().optional(),
  attemptId: z.string().optional(), childRunId: z.string().optional(), attempts: z.array(ConversationTaskAttemptSchema).default([]),
  acceptanceState: z.enum(["pending", "verified", "rejected"]).default("pending"), verificationIds: z.array(z.string()).default([]),
  summary: z.string().max(6000).optional(), error: z.string().max(6000).optional(), patch: z.unknown().optional(),
  workspacePath: z.string().optional(), baselineTree: z.string().optional(), integrationReceipt: z.string().optional(),
  retryReason: z.string().max(4000).optional(), withdrawnAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), startedAt: z.string().datetime().optional(), finishedAt: z.string().datetime().optional(),
});
export type ConversationTask = z.infer<typeof ConversationTaskSchema>;
export type ConversationTaskRecord = ConversationTask;
export type ConversationTaskInput = z.input<typeof ConversationTaskSchema>;

export const ConversationTaskQueueReferenceSchema = z.object({ version: z.number().int().nonnegative(), taskIds: z.array(z.string()), planGeneration: z.number().int().nonnegative(), sourceMessageId: z.string().optional() });

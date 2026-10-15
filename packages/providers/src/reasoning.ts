import type { ModelDescriptor, ModelRequest, ReasoningEffort } from "@harness/protocol";

export type ReasoningApi = "responses" | "chat_completions" | "anthropic" | "gemini";

const balanced: ReasoningEffort[] = ["low", "medium", "high"];
const extended: ReasoningEffort[] = [...balanced, "xhigh"];
const maximum: ReasoningEffort[] = [...extended, "max"];

/** Only advertise documented levels; unknown model aliases retain provider defaults. */
export function inferredReasoningEfforts(modelId: string, api: ReasoningApi): ReasoningEffort[] | undefined {
  const id = modelId.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (api === "anthropic") {
    if (/^claude-opus-4-5(?:-\d{8})?$/.test(id)) return [...balanced];
    if (/^claude-(?:opus-(?:4-[678]|5(?:-5)?)|sonnet-(?:4-6|5(?:-5)?)|haiku-5-5|(?:fable|mythos)-5(?:-1)?|mythos-preview)(?:-\d{8})?$/.test(id)) return [...balanced, "max"];
    return undefined;
  }
  if (api === "gemini") {
    if (/^gemini-3-pro-preview$/.test(id)) return ["low", "high"];
    if (/^gemini-3\.1-flash-lite-image$/.test(id)) return ["minimal", "high"];
    if (/^gemini-3\.(?:7|8)-flash(?:-preview)?$/.test(id) || /^gemini-3\.1-pro(?:-preview)?$/.test(id)) return [...balanced];
    if (/^gemini-3(?:\.(?:5|6))?-flash(?:-lite)?(?:-preview)?$/.test(id) || /^gemini-3\.1-flash-lite(?:-preview)?$/.test(id)) return ["minimal", ...balanced];
    // GenerateContent's thinkingLevel does not work with Gemini 2.5 (thinkingBudget only).
    return undefined;
  }
  if (/^deepseek-(?:flash|v4(?:\.1)?-(?:flash|pro))$/.test(id)) return ["none", "low", "high", "max"];
  if (/^(?:gpt-6-(?:sol|astra|luna)|gpt-6\.1-sol)$/.test(id)) {
    if (api === "chat_completions" && /^gpt-6-(?:sol|luna)$/.test(id)) return ["none"];
    return /^gpt-6-(?:sol|luna)$/.test(id) ? ["none", ...maximum] : [...maximum];
  }
  if (/^gpt-5\.6(?:-(?:sol|terra|luna))?$/.test(id)) return ["none", ...maximum];
  if (/^gpt-5\.(?:2|5)$/.test(id) || /^gpt-5\.4(?:-(?:mini|nano))?$/.test(id)) return ["none", ...extended];
  if (id === "gpt-5.1") return ["none", ...balanced];
  if (/^gpt-5(?:-(?:mini|nano))?$/.test(id)) return ["minimal", ...balanced];
  if (/^(?:o3|o3-mini|o4-mini)$/.test(id)) return [...balanced];
  return undefined;
}

export function withReasoningCapabilities(model: ModelDescriptor, api: ReasoningApi): ModelDescriptor {
  const reasoningEfforts = model.capabilities.reasoningEfforts ?? inferredReasoningEfforts(model.modelId, api);
  // These models do not support function calls via Chat Completions at any effort.
  const unsupportedTools = api === "chat_completions" && /^gpt-6(?:\.1-sol|-astra)(?:-\d{4}-\d{2}-\d{2})?$/.test(model.modelId.toLowerCase());
  return { ...model, capabilities: { ...model.capabilities,
    ...(reasoningEfforts ? { reasoningEfforts } : {}),
    ...(unsupportedTools ? { tools: false, parallelTools: false } : {})
  } };
}

export function usesOpenAICompletionTokenLimit(modelId: string): boolean {
  // OpenAI's Chat limit includes reasoning tokens; legacy max_tokens is rejected
  // by o-series. Do not change the wire contract for unrelated compatible APIs.
  return /^(?:gpt-|o[34](?:-|$))/i.test(modelId) && inferredReasoningEfforts(modelId, "chat_completions") !== undefined;
}

export function validatedReasoningEffort(request: ModelRequest, model: ModelDescriptor): ReasoningEffort | undefined {
  // Compaction never inherits the main turn's thinking effort. The DeepSeek adapter
  // retains its explicit non-thinking override, independently of this setting.
  if (request.disableThinking) return undefined;
  const effort = request.reasoningEffort;
  if (effort !== undefined && !model.capabilities.reasoningEfforts?.includes(effort)) {
    throw new Error(`模型 ${model.modelId} 不支持推理等级 ${effort}`);
  }
  return effort;
}

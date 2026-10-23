import type { ModelDescriptor, ModelMessage, ModelRequest, PromptBackend, ToolContract } from "@harness/protocol";
import type { ModelProvider } from "@harness/providers";

export interface PromptSystem {
  readonly backend: PromptBackend;
  readonly version: string;
  assemble(messages: ModelMessage[], tools: ToolContract[], model: ModelDescriptor): Promise<{ messages: ModelMessage[]; tools: ToolContract[] }>;
  runtimeContext(value: string): string;
  dispose(): Promise<void>;
}

/** A configuration-bound backend; each task owns its own registry and lifecycle. */
export async function createPromptSystem(backend: PromptBackend = "harness"): Promise<PromptSystem> {
  if (backend === "dsh") {
    const { createDshPromptSystem } = await import("./dsh-prompt-system.js");
    const system = await createDshPromptSystem();
    return {
      backend,
      version: system.version,
      assemble: (messages, tools, model) => system.assemble(messages, tools, model),
      runtimeContext: value => system.runtimeContext(value),
      dispose: () => system.dispose(),
    };
  }
  return {
    backend,
    version: "harness:1",
    async assemble(messages, tools) { return { messages, tools }; },
    runtimeContext: value => value,
    async dispose() {},
  };
}

/** Specialized generations keep their own instructions while using the selected assembler. */
export async function preparePromptRequest(provider: ModelProvider, request: ModelRequest): Promise<ModelRequest> {
  if (provider.promptBackend !== "dsh") return request;
  const system = await createPromptSystem("dsh");
  try {
    const assembled = await system.assemble(request.messages, request.tools, request.model);
    return { ...request, ...assembled };
  } finally {
    await system.dispose();
  }
}

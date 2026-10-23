import { Context } from "@deepseek-ai/cordis";
import SystemPrompt, { renderContextSections, renderPrompt, type PromptAssembly } from "@deepseek-ai/dsh-system-prompt";
import type { ModelDescriptor, ModelMessage, ToolContract } from "@harness/protocol";

export interface DshPromptSystem {
  readonly version: string;
  assemble(messages: ModelMessage[], tools: ToolContract[], model: ModelDescriptor): Promise<{ messages: ModelMessage[]; tools: ToolContract[] }>;
  /** Keep the existing runtime delta protocol while rendering its source through dsh. */
  runtimeContext(value: string): string;
  dispose(): Promise<void>;
}

const RUNTIME_CONTEXT = "harness:runtime-state";

/**
 * One real dsh registry per run. Message provenance remains owned by Harness:
 * rendering a developer/profile contribution never promotes it to system policy.
 */
export async function createDshPromptSystem(): Promise<DshPromptSystem> {
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt);
    let model: ModelDescriptor | undefined;
    let runtimeValue = "";
    ctx.systemPrompt.variable("provider", () => model?.providerId);
    ctx.systemPrompt.variable("model", () => model?.modelId);
    ctx.systemPrompt.context({ name: RUNTIME_CONTEXT, order: ctx.systemPrompt.getContextOrder("APPROVAL_POLICY"), required: true,
      text: () => runtimeValue, interpolate: false });
    let accepted: PromptAssembly = await ctx.systemPrompt.assemble();
    const registrations: Array<() => void> = [];
    let pending: Promise<unknown> = Promise.resolve();
    let closing = false;
    let disposal: Promise<void> | undefined;
    const requireActive = () => { if (closing) throw new Error("The dsh prompt system has been disposed"); };

    return {
      version: "dsh-system-prompt@0.2.1-rc.2:harness-adapter-1",
      assemble(messages, tools, selectedModel) {
        if (closing) return Promise.reject(new Error("The dsh prompt system has been disposed"));
        // Snapshot before queueing: callers may continue changing workflow state.
        const input = structuredClone(messages);
        const contracts = structuredClone(tools);
        const modelSnapshot = structuredClone(selectedModel);
        const operation = pending.then(async () => {
          for (const unregister of registrations.splice(0).reverse()) unregister();
          model = modelSnapshot;
          const sectionParts = new Map<string, { message: number; part: number }>();
          const contextParts = new Map<string, { message: number; part: number }>();
          for (const [messageIndex, message] of input.entries()) {
            for (const [partIndex, part] of message.content.entries()) {
              if (part.type !== "text") continue;
              const name = `harness:message:${messageIndex}:part:${partIndex}`;
              const order = messageIndex * 1_000 + partIndex;
              if (message.role === "system" || message.role === "developer") {
                sectionParts.set(name, { message: messageIndex, part: partIndex });
                registrations.push(ctx.systemPrompt.section({ name, order, text: part.text, interpolate: false }));
              } else if (message.role === "user" && part.trust !== "user_request") {
                contextParts.set(name, { message: messageIndex, part: partIndex });
                registrations.push(ctx.systemPrompt.context({ name, order, text: part.text, interpolate: false }));
              }
            }
          }
          registrations.push(ctx.systemPrompt.tools(() => ({ schemas: contracts.map(contract => ({
            name: contract.name, description: contract.description, parameters: contract.inputSchema,
          })) })));
          const assembly = await ctx.systemPrompt.assemble();
          accepted = assembly;
          const additions: ModelMessage[] = [];
          const updatePart = (target: { message: number; part: number }, text: string) => {
            const part = input[target.message]!.content[target.part]!;
            if (part.type === "text") part.text = text;
          };
          for (const section of assembly.sections) {
            const text = renderPrompt({ ...assembly, sections: [section] });
            const target = sectionParts.get(section.name);
            if (target) updatePart(target, text);
            else if (text) additions.push({ role: "system", content: [{ type: "text", text, trust: "app_policy" }] });
          }
          const renderedContexts = new Map(renderContextSections(assembly).map(context => [context.name, context.text]));
          for (const [name, target] of contextParts) updatePart(target, renderedContexts.get(name) ?? "");
          // Preserve execution-only metadata absent from dsh's model-facing ToolSchema.
          const contractsByName = new Map<string, ToolContract[]>();
          for (const contract of contracts) {
            const matches = contractsByName.get(contract.name) ?? [];
            matches.push(contract);
            contractsByName.set(contract.name, matches);
          }
          const assembledTools = assembly.tools.map(schema => {
            const contract = contractsByName.get(schema.name)?.shift();
            if (!contract) throw new Error(`dsh returned an unknown tool: ${schema.name}`);
            return { ...contract, description: schema.description, inputSchema: structuredClone(schema.parameters) };
          });
          return { messages: [...additions, ...input], tools: assembledTools };
        });
        pending = operation.catch(() => {});
        return operation;
      },
      runtimeContext(value) {
        requireActive();
        runtimeValue = value;
        const refreshed = ctx.systemPrompt.refreshContext(accepted);
        return renderContextSections(refreshed).find(context => context.name === RUNTIME_CONTEXT)?.text ?? "";
      },
      dispose() {
        if (disposal) return disposal;
        closing = true;
        disposal = pending.then(async () => { await ctx.fiber.dispose(); });
        return disposal;
      },
    };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

import { afterEach, describe, expect, it } from "vitest";
import type { AttachmentRef, ModelMessage, ToolContract } from "@harness/protocol";
import { descriptor } from "@harness/providers";
import { createDshPromptSystem, type DshPromptSystem } from "../packages/core/src/dsh-prompt-system.js";

const model = descriptor({ providerId: "fixture", modelId: "deepseek-v4-flash", displayName: "DeepSeek fixture" });
const identity = "You are an AI agent powered by DeepSeek Harness.";
const systems: DshPromptSystem[] = [];
async function create() { const system = await createDshPromptSystem(); systems.push(system); return system; }
afterEach(async () => { await Promise.all(systems.splice(0).map(system => system.dispose())); });
const tool = (name: string): ToolContract => ({ name, description: `Run ${name}`, inputSchema: { type: "object", properties: { value: { type: "string" } } },
  strict: false, risk: "write", idempotent: false, timeoutMs: 12_345 });
const text = (value: string): ModelMessage => ({ role: "system", content: [{ type: "text", trust: "app_policy", text: value }] });

describe("native dsh prompt system", () => {
  it("renders native identity, policy and context without changing roles, trust or literal braces", async () => {
    const system = await create();
    const messages: ModelMessage[] = [
      text("Safety {{unknown}} and {{ invalid template }}"),
      { role: "developer", content: [{ type: "text", trust: "user_profile", text: "User profile {{model}}" }] },
      { role: "user", content: [{ type: "text", trust: "trusted_project", text: "Project C:/{{project}}" }] },
      { role: "user", content: [{ type: "text", trust: "user_profile", text: "Approved memory {{memory}}" }] },
      { role: "user", content: [{ type: "text", trust: "untrusted_tool", text: "Runtime facts {{provider}}" }] },
      { role: "user", content: [{ type: "text", trust: "user_request", text: "Actual user instruction {{request}}" }] },
    ];
    const result = await system.assemble(messages, [], model);
    expect(result.messages[0]).toEqual(text(identity));
    expect(result.messages.slice(1)).toEqual(messages);
    expect(result.messages.find(message => message.role === "developer")?.content[0]).toMatchObject({ trust: "user_profile" });
    expect(JSON.stringify(result.messages.filter(message => message.role === "system"))).not.toContain("Approved memory");
  });

  it("keeps attachments and non-text conversation content in their original messages", async () => {
    const system = await create();
    const attachment: AttachmentRef = { id: "image", sha256: "a".repeat(64), mimeType: "image/png", byteLength: 12,
      width: 10, height: 10, encryptedPath: "blob/image", source: "file", trust: "untrusted_attachment", allowedProviders: [], createdAt: "2026-10-22T00:00:00Z" };
    const messages: ModelMessage[] = [
      { role: "user", steeringId: "steer-1", content: [{ type: "text", text: "Inspect", trust: "user_request" }, { type: "image", attachment, detail: "auto" }] },
      { role: "assistant", reasoningContent: "retained privately", content: [{ type: "tool_call", toolCallId: "call", name: "read_file", input: { path: "{{file}}" } }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "call", output: { text: "untrusted" }, trust: "untrusted_tool" }] },
    ];
    const result = await system.assemble(messages, [], model);
    expect(result.messages.slice(1)).toEqual(messages);
    const resultPart = result.messages[1]!.content[1]!;
    if (resultPart.type !== "image") throw new Error("Missing image");
    resultPart.attachment.fileName = "mutated.png";
    expect(attachment.fileName).toBeUndefined();
  });

  it("uses native deterministic tool ordering and preserves execution contracts", async () => {
    const system = await create();
    const tools = [tool("write_file"), tool("read_file"), tool("apply_patch")];
    const original = structuredClone(tools);
    const result = await system.assemble([], tools, model);
    expect(result.tools).toEqual([tools[2], tools[1], tools[0]]);
    expect(tools).toEqual(original);
    result.tools[0]!.inputSchema.type = "changed";
    expect(tools[2]!.inputSchema.type).toBe("object");
    expect(result.tools[1]).toMatchObject({ strict: false, risk: "write", idempotent: false, timeoutMs: 12_345 });
  });

  it("replaces conditional contributions without accumulating old policies or tools", async () => {
    const system = await create();
    await system.assemble([text("analysis guidance")], [tool("read_file")], model);
    const changed = await system.assemble([text("implementation guidance"), text("verification guidance")], [tool("apply_patch")], model);
    expect(changed.messages).toEqual([text(identity), text("implementation guidance"), text("verification guidance")]);
    expect(changed.tools.map(item => item.name)).toEqual(["apply_patch"]);
    const empty = await system.assemble([], [], model);
    expect(empty).toEqual({ messages: [text(identity)], tools: [] });
  });

  it("refreshes required runtime context as exact JSON without adding another history message", async () => {
    const system = await create();
    expect(system.runtimeContext("")).toBe("");
    await system.assemble([text("policy")], [], model);
    const first = JSON.stringify({ budget: 5, path: "C:/{{workspace}}", permissions: [] });
    const second = JSON.stringify({ budget: 4, permissions: ["read"] });
    expect(system.runtimeContext(first)).toBe(first);
    expect(system.runtimeContext(second)).toBe(second);
    const result = await system.assemble([text("policy")], [], model);
    expect(result.messages).toEqual([text(identity), text("policy")]);
    expect(system.runtimeContext(first)).toBe(first);
  });

  it("isolates concurrent runs and snapshots queued input", async () => {
    const left = await create();
    const right = await create();
    const leftMessages = [text("left policy")];
    const leftPromise = left.assemble(leftMessages, [tool("left_tool")], model);
    leftMessages[0] = text("changed after call");
    const [a, b] = await Promise.all([leftPromise, right.assemble([text("right policy")], [tool("right_tool")], model)]);
    expect(a.messages).toEqual([text(identity), text("left policy")]);
    expect(b.messages).toEqual([text(identity), text("right policy")]);
    expect(a.tools.map(item => item.name)).toEqual(["left_tool"]);
    expect(b.tools.map(item => item.name)).toEqual(["right_tool"]);
    expect(left.runtimeContext("left runtime")).toBe("left runtime");
    expect(right.runtimeContext("right runtime")).toBe("right runtime");
    const [before, after] = await Promise.all([left.assemble([text("before")], [], model), left.assemble([text("after")], [], model)]);
    expect(before.messages).toEqual([text(identity), text("before")]);
    expect(after.messages).toEqual([text(identity), text("after")]);
  });

  it("disposes idempotently and refuses subsequent assembly or context refresh", async () => {
    const system = await create();
    const pending = system.assemble([text("accepted before disposal")], [], model);
    const disposal = system.dispose();
    await pending;
    await Promise.all([disposal, system.dispose()]);
    expect(() => system.runtimeContext("late")).toThrow(/disposed/);
    await expect(system.assemble([], [], model)).rejects.toThrow(/disposed/);
  });
});

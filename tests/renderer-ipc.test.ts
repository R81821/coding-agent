import { describe, expect, it } from "vitest";
import { DaemonRequestSchema } from "@harness/protocol";
import { sanitizeRendererRequest } from "../apps/desktop/src/renderer-ipc.js";

describe("sanitizeRendererRequest", () => {
  it("allows whitelisted methods", () => {
    expect(sanitizeRendererRequest("run.start", { id: "r1" }).method).toBe("run.start");
    for (const method of ["sessions.create", "sessions.list", "session.get", "session.delete", "session.restore", "session.purge", "projects.list", "project.delete", "project.restore"]) {
      expect(sanitizeRendererRequest(method, {}).method).toBe(method);
    }
  });

  it("rejects non-whitelisted methods", () => {
    expect(() => sanitizeRendererRequest("trace.export", {})).toThrow("cannot invoke");
  });

  it.each([
    ["mcp.resources", {}], ["mcp.prompts", {}],
    ["mcp.resource.read", { uri: "fixture://first" }],
    ["mcp.resource.subscribe", { uri: "fixture://first" }],
    ["mcp.resource.unsubscribe", { uri: "fixture://first" }], ["mcp.resource.updates", {}],
    ["mcp.prompt.get", { name: "review", arguments: { topic: "MCP" } }],
    ["mcp.completion", { ref: { type: "ref/prompt", name: "review" }, argument: { name: "topic", value: "mc" }, context: { arguments: { locale: "zh" } } }],
    ["mcp.completion", { ref: { type: "ref/resource", uri: "fixture://topics/{topic}" }, argument: { name: "topic", value: "mc" } }],
  ])("allows %s and preserves its validated project-scoped parameters", (method, extra) => {
    const params = { serverId: "server-1", workspacePath: "D:\\fixture", ...extra };
    const sanitized = sanitizeRendererRequest(method as string, params);
    expect(sanitized).toEqual({ method, params });
    expect(DaemonRequestSchema.parse({ id: "mcp", ...sanitized })).toMatchObject(sanitized);
  });

  it("preserves interaction run filtering and accepts primitive user answers", () => {
    for (const [method, params] of [
      ["mcp.interactions.list", { workspacePath: "D:\\fixture", runId: "run-1" }],
      ["mcp.interactions.respond", { workspacePath: "D:\\fixture", requestId: "request-1", action: "accept", content: { topic: "MCP", count: 3, enabled: true, choices: ["one", "two"] } }],
    ] as const) {
      const sanitized = sanitizeRendererRequest(method, params);
      expect(sanitized).toEqual({ method, params });
      expect(DaemonRequestSchema.parse({ id: "mcp", ...sanitized })).toMatchObject(sanitized);
    }
  });

  it.each([
    ["mcp.resources", { serverId: "server-1" }],
    ["mcp.resource.read", { serverId: "server-1", workspacePath: "D:\\fixture", uri: "" }],
    ["mcp.prompt.get", { serverId: "server-1", workspacePath: "D:\\fixture", name: "review", arguments: { topic: 3 } }],
    ["mcp.completion", { serverId: "server-1", workspacePath: "D:\\fixture", ref: { type: "tools", name: "review" }, argument: { name: "topic", value: "mc" } }],
    ["mcp.completion", { serverId: "server-1", workspacePath: "D:\\fixture", ref: { type: "ref/prompt", name: "review" }, argument: { name: "topic", value: 3 } }],
    ["mcp.interactions.list", {}],
    ["mcp.interactions.respond", { workspacePath: "D:\\fixture", requestId: "request-1", action: "execute" }],
    ["mcp.interactions.respond", { workspacePath: "D:\\fixture", requestId: "request-1", action: "accept", content: { nested: { token: "secret" } } }],
    ["mcp.interactions.respond", { workspacePath: "D:\\fixture", requestId: "request-1", action: "accept", content: { count: Infinity } }],
  ])("rejects malformed parameters for allowed MCP method %s at the daemon schema", (method, params) => {
    const sanitized = sanitizeRendererRequest(method as string, params);
    expect(() => DaemonRequestSchema.parse({ id: "mcp", ...sanitized })).toThrow();
  });

  it("continues to reject renderer calls to arbitrary MCP tools", () => {
    expect(() => sanitizeRendererRequest("mcp.callTool", { serverId: "server-1", name: "write" })).toThrow(/cannot invoke/);
  });

  it.each([undefined, false, true])("allows current-model preview and preserves needsVision=%s", needsVision => {
    const params = { profileId: "profile-selected", ...(needsVision === undefined ? {} : { needsVision }) };
    const sanitized = sanitizeRendererRequest("model.current", params);
    expect(sanitized).toEqual({ method: "model.current", params });
    expect(DaemonRequestSchema.parse({ id: "preview", ...sanitized })).toMatchObject(sanitized);
  });

  it.each([null, "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const)("allows scalar reasoning effort %s and preserves session/profile/vision parameters", reasoningEffort => {
    const params = { sessionId: "session-selected", profileId: "profile-selected", needsVision: true, reasoningEffort };
    const sanitized = sanitizeRendererRequest("session.reasoning", params);
    expect(sanitized).toEqual({ method: "session.reasoning", params });
    expect(DaemonRequestSchema.parse({ id: "effort", ...sanitized })).toMatchObject(sanitized);
  });

  it("preserves explicit default effort without optional Profile or vision overrides", () => {
    const params = { sessionId: "session-selected", reasoningEffort: null };
    expect(sanitizeRendererRequest("session.reasoning", params)).toEqual({ method: "session.reasoning", params });
  });

  it.each(["profiles.upsert", "eval.run", "trace.export", "daemon.shutdown", "unknown.method"])("still rejects unauthorized or unknown method %s", method => {
    expect(() => sanitizeRendererRequest(method, {})).toThrow(`Renderer cannot invoke daemon method: ${method}`);
  });

  it.each(["approval.decide", "plan.decide", "memory.decide", "memory.update"])("preserves the desktop actor guard for %s", method => {
    const params = { actor: "admin", reason: "keep this user value" };
    expect(sanitizeRendererRequest(method, params).params).toEqual({ actor: "desktop:user", reason: params.reason });
    expect(params.actor).toBe("admin");
  });

  it("forces the actor to desktop:user on approval.decide", () => {
    const result = sanitizeRendererRequest("approval.decide", { approvalId: "a1", approved: true, actor: "attacker" });
    expect(result.params).toEqual({ approvalId: "a1", approved: true, actor: "desktop:user" });
  });

  it("forces the actor to desktop:user on plan.decide and keeps feedback", () => {
    const result = sanitizeRendererRequest("plan.decide", { planId: "p1", version: 1, approved: false, actor: "attacker", feedback: "revise" });
    expect(result.params).toMatchObject({ actor: "desktop:user", feedback: "revise" });
  });
});

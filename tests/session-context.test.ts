import { describe, expect, it } from "vitest";
import { buildSessionContext, validateSessionRunStart } from "@harness/core";
import {
  DaemonRequestSchema,
  DEFAULT_PROFILE,
  type AgentEvent,
  type RunSpec,
  type SessionDetail,
} from "@harness/protocol";

const at = "2026-09-08T00:00:00.000Z";

function run(id: string, request: string, status: SessionDetail["runs"][number]["status"], result?: string): SessionDetail["runs"][number] {
  const spec: RunSpec = {
    id,
    sessionId: "session-main",
    request,
    workspacePath: "D:/workspace",
    profileId: "default",
    attachments: [],
    budget: DEFAULT_PROFILE.budget,
    grants: [],
    createdAt: at,
  };
  const events: AgentEvent[] = result === undefined ? [] : [{
    id: `event-${id}`,
    runId: id,
    at,
    sequence: 0,
    type: "result",
    text: result,
    status,
  }];
  return { spec, status, events };
}

function detail(runs: SessionDetail["runs"]): SessionDetail {
  return {
    session: {
      id: "session-main",
      workspacePath: "D:/workspace",
      profileId: "default",
      title: "Persistent conversation",
      createdAt: at,
      updatedAt: at,
    },
    runs,
  };
}

function text(messages: ReturnType<typeof buildSessionContext>): string {
  return messages.flatMap((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : [])).join("\n");
}

describe("buildSessionContext", () => {
  it("replays completed turns in order, excludes the current run, and keeps history untrusted", () => {
    const messages = buildSessionContext(detail([
      run("run-1", "first request", "completed", "first answer"),
      run("run-2", "second request", "completed", "second answer"),
      run("run-current", "current request", "queued"),
    ]), "run-current", 10_000);

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(text(messages)).toMatch(/first request[\s\S]*first answer[\s\S]*second request[\s\S]*second answer/);
    expect(text(messages)).not.toContain("current request");
    expect(messages.flatMap((message) => message.content).filter((part) => part.type === "text").every((part) => part.trust === "untrusted_tool")).toBe(true);
  });

  it("marks unfinished prior turns instead of inventing an assistant result", () => {
    const messages = buildSessionContext(detail([
      run("run-paused", "continue the refactor", "paused"),
      run("run-current", "what remains?", "queued"),
    ]), "run-current", 10_000);

    expect(text(messages)).toContain("continue the refactor");
    expect(text(messages)).toContain("未完成");
    expect(text(messages)).toContain("paused");
  });

  it("keeps the most recent full turn and compacts older turns within the character budget", () => {
    const messages = buildSessionContext(detail([
      run("run-old", "old-request-".repeat(30), "completed", "old-answer-".repeat(30)),
      run("run-recent", "recent request", "completed", "recent answer"),
      run("run-current", "current request", "queued"),
    ]), "run-current", 240);
    const rendered = text(messages);

    expect(rendered).toContain("较早会话摘要");
    expect(rendered).toContain("recent request");
    expect(rendered).toContain("recent answer");
    expect(rendered.length).toBeLessThanOrEqual(240);
  });
});

describe("Session run lifecycle", () => {
  it("rejects missing, deleted, mismatched, and concurrently active Sessions", () => {
    const current = run("run-current", "continue", "queued").spec;
    const project = { id: "project-main", workspacePath: "D:/workspace", createdAt: at, updatedAt: at };
    expect(() => validateSessionRunStart(undefined, [project], current)).toThrow("Unknown Session");
    expect(() => validateSessionRunStart({ ...detail([]), session: { ...detail([]).session, deletedAt: at } }, [project], current)).toThrow("deleted Session");
    expect(() => validateSessionRunStart(detail([]), [{ ...project, deletedAt: at }], current)).toThrow("deleted project");
    expect(() => validateSessionRunStart(detail([]), [project], { ...current, workspacePath: "D:/other" })).toThrow("workspace");
    expect(() => validateSessionRunStart(detail([run("run-live", "working", "running")]), [project], current)).toThrow("active run");
    expect(() => validateSessionRunStart(detail([run("run-done", "done", "completed", "done")]), [project], current)).not.toThrow();
  });

  it("validates explicit Session and project lifecycle requests", () => {
    const session = detail([]).session;
    expect(DaemonRequestSchema.parse({ id: "1", method: "sessions.create", params: session })).toMatchObject({ method: "sessions.create" });
    expect(DaemonRequestSchema.parse({ id: "2", method: "sessions.list", params: { deleted: true } })).toMatchObject({ params: { deleted: true, limit: 50, offset: 0 } });
    expect(DaemonRequestSchema.parse({ id: "3", method: "session.get", params: { sessionId: session.id } })).toMatchObject({ method: "session.get" });
    expect(DaemonRequestSchema.parse({ id: "4", method: "session.purge", params: { sessionId: session.id } })).toMatchObject({ method: "session.purge" });
    expect(DaemonRequestSchema.parse({ id: "5", method: "projects.list", params: { deleted: false } })).toMatchObject({ method: "projects.list" });
    expect(DaemonRequestSchema.parse({ id: "6", method: "project.delete", params: { projectId: "project-main" } })).toMatchObject({ method: "project.delete" });
    expect(() => DaemonRequestSchema.parse({ id: "7", method: "session.delete", params: {} })).toThrow();
  });
});

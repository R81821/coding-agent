import { describe, expect, it } from "vitest";
import { DaemonRequestSchema, type DaemonRequest } from "@harness/protocol";
import { sanitizeRendererRequest } from "../apps/desktop/src/renderer-ipc.js";

/**
 * Run control spans three places that must agree: the daemon request schema, the renderer allowlist,
 * and the engine. A method missing from either of the first two is unreachable from the UI, which is
 * exactly the kind of gap that only shows up when a user presses the button.
 */
describe("run control RPC surface", () => {
  const parse = (request: unknown): DaemonRequest => DaemonRequestSchema.parse(request);

  it("accepts pause, steer and resume with their required parameters", () => {
    expect(parse({ id: "1", method: "run.pause", params: { runId: "run-1" } })).toMatchObject({ method: "run.pause" });
    expect(parse({ id: "2", method: "run.steer", params: { runId: "run-1", text: "also check b.ts" } })).toMatchObject({ method: "run.steer" });
    expect(parse({ id: "3", method: "run.resume", params: { runId: "run-1" } })).toMatchObject({ method: "run.resume" });
    expect(parse({ id: "4", method: "run.withdraw", params: { runId: "run-1" } })).toMatchObject({ method: "run.withdraw" });
    expect(parse({ id: "5", method: "run.steer", params: { runId: "run-1", text: "Think again", resumePaused: true } })).toMatchObject({ method: "run.steer", params: { resumePaused: true } });
    expect(parse({ id: "6", method: "run.steer", params: { runId: "run-1", text: "Queue only" } })).not.toHaveProperty("params.resumePaused");
    expect(parse({ id: "7", method: "run.withdraw", params: { runId: "run-1", messageId: "steering-2" } })).toMatchObject({ method: "run.withdraw", params: { messageId: "steering-2" } });
    expect(() => parse({ id: "8", method: "run.withdraw", params: { runId: "run-1", messageId: "" } })).toThrow();
  });

  it("rejects a steering message that is empty or too long for one turn boundary", () => {
    expect(() => parse({ id: "1", method: "run.steer", params: { runId: "run-1", text: "" } })).toThrow();
    expect(() => parse({ id: "2", method: "run.steer", params: { runId: "run-1", text: "x".repeat(4_001) } })).toThrow();
    expect(() => parse({ id: "3", method: "run.steer", params: { runId: "run-1", text: "valid", resumePaused: "yes" } })).toThrow();
  });

  it("lets the renderer reach every control it renders", () => {
    for (const method of ["run.pause", "run.steer", "run.resume", "run.withdraw"]) {
      expect(() => sanitizeRendererRequest(method, { runId: "run-1", text: "note" })).not.toThrow();
    }
  });
});

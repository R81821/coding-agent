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
  });

  it("rejects a steering message that is empty or too long for one turn boundary", () => {
    expect(() => parse({ id: "1", method: "run.steer", params: { runId: "run-1", text: "" } })).toThrow();
    expect(() => parse({ id: "2", method: "run.steer", params: { runId: "run-1", text: "x".repeat(4_001) } })).toThrow();
  });

  it("lets the renderer reach every control it renders", () => {
    for (const method of ["run.pause", "run.steer", "run.resume"]) {
      expect(() => sanitizeRendererRequest(method, { runId: "run-1", text: "note" })).not.toThrow();
    }
  });
});

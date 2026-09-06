import { daemonEndpointName } from "@harness/protocol";
import { describe, expect, it } from "vitest";
import { appendBounded, daemonStartupError } from "../apps/desktop/src/daemon-startup.js";

describe("desktop daemon startup diagnostics", () => {
  it("isolates desktop launches from each other and the legacy development daemon", () => {
    expect(daemonEndpointName()).toBe("harness-agent-v2");
    expect(daemonEndpointName("desktop_a")).not.toBe(daemonEndpointName());
    expect(daemonEndpointName("desktop_a")).not.toBe(daemonEndpointName("desktop_b"));
    for (const id of ["", "../file", "bad/name", "bad\\name"]) expect(() => daemonEndpointName(id)).toThrow("Invalid daemon instance ID");
  });

  it("turns a vault rejection into an actionable localized error", () => {
    const error = daemonStartupError("Error: Invalid application passphrase or corrupted key envelope\n", 1);
    expect(error.message).toContain("应用口令错误");
    expect(error.message).not.toContain("启动超时");
  });

  it("keeps only a bounded stderr tail", () => {
    expect(appendBounded("1234", "5678", 5)).toBe("45678");
  });
});

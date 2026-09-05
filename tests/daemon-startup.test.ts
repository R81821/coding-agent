import { describe, expect, it } from "vitest";
import { appendBounded, daemonStartupError } from "../apps/desktop/src/daemon-startup.js";

describe("desktop daemon startup diagnostics", () => {
  it("turns a vault rejection into an actionable localized error", () => {
    const error = daemonStartupError("Error: Invalid application passphrase or corrupted key envelope\n", 1);
    expect(error.message).toContain("应用口令错误");
    expect(error.message).not.toContain("启动超时");
  });

  it("keeps only a bounded stderr tail", () => {
    expect(appendBounded("1234", "5678", 5)).toBe("45678");
  });
});

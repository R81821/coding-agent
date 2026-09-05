import { describe, expect, it } from "vitest";
import { grantsAllow } from "@harness/tools";
import type { PermissionGrant } from "@harness/protocol";

function grant(partial: Partial<PermissionGrant>): PermissionGrant {
  return {
    toolNames: ["terminal"],
    pathGlobs: [],
    commandPrefixes: [],
    networkDomains: [],
    maxRisk: "high",
    ...partial,
  };
}

describe("grantsAllow (tools-layer grant enforcement)", () => {
  it("allows a command covered by an active grant prefix", () => {
    const reason = grantsAllow("terminal", [grant({ commandPrefixes: ["npm test"] })], { command: "npm test -- --coverage" }, "high");
    expect(reason).toBeUndefined();
  });

  it("rejects a command outside every grant prefix", () => {
    const reason = grantsAllow("terminal", [grant({ commandPrefixes: ["npm test"] })], { command: "git push" }, "high");
    expect(reason).toContain("No active grant covers");
  });

  it("allows a browser URL inside a granted domain", () => {
    const reason = grantsAllow("browser", [grant({ toolNames: ["browser"], networkDomains: ["example.com"] })], { url: "https://api.example.com/x" }, "high");
    expect(reason).toBeUndefined();
  });

  it("rejects a browser URL outside every granted domain", () => {
    const reason = grantsAllow("browser", [grant({ toolNames: ["browser"], networkDomains: ["example.com"] })], { url: "https://evil.example.com.attacker.io/" }, "high");
    expect(reason).toContain("No active grant covers");
  });

  it("ignores expired grants", () => {
    const reason = grantsAllow("terminal", [grant({ commandPrefixes: ["npm test"], expiresAt: new Date(Date.now() - 1_000).toISOString() })], { command: "npm test" }, "high");
    expect(reason).toBeUndefined();
  });

  it("does not constrain tools without matching grant entries", () => {
    const reason = grantsAllow("terminal", [], { command: "anything" }, "high");
    expect(reason).toBeUndefined();
  });

  it("never constrains read-risk calls", () => {
    const reason = grantsAllow("terminal", [grant({ commandPrefixes: ["other"] })], { command: "npm test" }, "read");
    expect(reason).toBeUndefined();
  });
});

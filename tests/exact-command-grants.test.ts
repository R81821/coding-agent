import { describe, expect, it } from "vitest";
import { PermissionEngine } from "@harness/core";
import { PermissionGrantSchema, type PermissionGrant } from "@harness/protocol";
import { grantsAllow } from "@harness/tools";

const permissions = new PermissionEngine();
const workspace = process.cwd();
const grant = (overrides: Partial<PermissionGrant> = {}): PermissionGrant => ({ toolNames: ["terminal"], pathGlobs: [], commandPrefixes: [], networkDomains: [], maxRisk: "high", ...overrides });
const engineAllows = (grants: PermissionGrant[], input: Record<string, unknown>) => permissions.decide("terminal", input, "high", grants, workspace).allowed;
const toolAllows = (grants: PermissionGrant[], input: Record<string, unknown>) => grantsAllow("terminal", grants, input, "high") === undefined;

describe.each([
  { layer: "engine", allowed: engineAllows },
  { layer: "tools", allowed: toolAllows },
])("exact command grants at the $layer boundary", ({ allowed }) => {
  it.each([
    { command: "node --version", expected: true },
    { command: "node --version --extra", expected: false },
    { command: "node --version; inspect secret", expected: false },
    { command: "node --version\ninspect secret", expected: false },
    { command: "node --version $(inspect secret)", expected: false },
    { command: " node --version", expected: false },
    { command: "node --version ", expected: false },
    { command: "NODE --version", expected: false },
  ])("requires the original complete command ($command)", ({ command, expected }) => {
    expect(allowed([grant({ exactCommands: ["node --version"] })], { command })).toBe(expected);
  });

  it("preserves explicitly configured prefix grants", () => {
    expect(allowed([grant({ commandPrefixes: ["node"] })], { command: "node --version --extra" })).toBe(true);
  });

  it("accepts a complete explicitly approved quoted shell program without extending it", () => {
    const command = "& 'C:\\Program Files\\node.exe' --version\ninspect first";
    const scoped = grant({ exactCommands: [command] });
    expect(allowed([scoped], { command })).toBe(true);
    expect(allowed([scoped], { command: command + "\ninspect secret" })).toBe(false);
  });

  it("treats exact commands as a restriction in addition to an explicit prefix", () => {
    const restricted = grant({ commandPrefixes: ["node"], exactCommands: ["node --version", "inspect first"] });
    expect(allowed([restricted], { command: "node --version" })).toBe(true);
    expect(allowed([restricted], { command: "node --version --extra" })).toBe(false);
    expect(allowed([restricted], { command: "inspect first" })).toBe(false);
  });

  it("accepts any explicitly listed exact command, without extending its arguments", () => {
    const scoped = grant({ exactCommands: ["inspect first", "inspect second"] });
    expect(allowed([scoped], { command: "inspect first" })).toBe(true);
    expect(allowed([scoped], { command: "inspect second" })).toBe(true);
    expect(allowed([scoped], { command: "inspect second --extra" })).toBe(false);
  });

  it("does not treat an empty exact list or a missing command as a broad grant", () => {
    expect(allowed([grant({ exactCommands: [] })], { command: "inspect first" })).toBe(false);
    expect(allowed([grant({ exactCommands: ["inspect first"] })], {})).toBe(false);
  });

  it("ignores an expired exact allowance when checking an active narrower grant", () => {
    const grants = [grant({ exactCommands: ["inspect secret"], expiresAt: new Date(Date.now() - 1_000).toISOString() }), grant({ exactCommands: ["inspect public"] })];
    expect(allowed(grants, { command: "inspect secret" })).toBe(false);
    expect(allowed(grants, { command: "inspect public" })).toBe(true);
  });

  it("requires one grant to cover command and domain without combining separate scopes", () => {
    const grants = [grant({ exactCommands: ["inspect first"], networkDomains: ["first.test"] }), grant({ exactCommands: ["inspect second"], networkDomains: ["second.test"] })];
    expect(allowed(grants, { command: "inspect first", url: "https://first.test/" })).toBe(true);
    expect(allowed(grants, { command: "inspect first", url: "https://second.test/" })).toBe(false);
    expect(allowed(grants, { command: "inspect first", url: "https://first.test.attacker.test/" })).toBe(false);
  });
});

it("round-trips exact command constraints through the grant protocol schema", () => {
  const input = grant({ exactCommands: ["node --version"] });
  expect(PermissionGrantSchema.parse(input)).toEqual(input);
  expect(PermissionGrantSchema.parse(grant())).not.toHaveProperty("exactCommands");
  expect(() => PermissionGrantSchema.parse(grant({ exactCommands: [""] }))).toThrow();
});

it("does not let expired grants authorize engine execution", () => {
  expect(engineAllows([grant({ exactCommands: ["inspect first"], expiresAt: new Date(Date.now() - 1_000).toISOString() })], { command: "inspect first" })).toBe(false);
});

it("keeps exact command permission inside its path and risk scope", () => {
  const scoped = grant({ exactCommands: ["inspect first"], pathGlobs: ["public/**"] });
  expect(engineAllows([scoped], { command: "inspect first", path: "private/source.ts" })).toBe(false);
  expect(permissions.decide("terminal", { command: "git reset --hard" }, "destructive", [grant({ exactCommands: ["git reset --hard"], maxRisk: "destructive" })], workspace).allowed).toBe(false);
});

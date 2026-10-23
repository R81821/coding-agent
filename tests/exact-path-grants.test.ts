import { describe, expect, it } from "vitest";
import { PermissionEngine } from "@harness/core";
import { PermissionGrantSchema, type PermissionGrant } from "@harness/protocol";
import { captureExactPathInputs, grantsAllow } from "@harness/tools";
import { projectPermissionGrants } from "../packages/core/src/authorization-context.js";

const permissions = new PermissionEngine();
const grant = (input: Record<string, unknown>): PermissionGrant => ({ toolNames: ["write_fixture"], pathGlobs: ["**"], commandPrefixes: [], networkDomains: [], maxRisk: "write", exactPathInputs: captureExactPathInputs(input) });
const check = (scoped: PermissionGrant, input: Record<string, unknown>) => {
  const runtime = permissions.decide("write_fixture", input, "write", [scoped], process.cwd()).allowed;
  const tools = grantsAllow("write_fixture", [scoped], input, "write") === undefined;
  expect(tools).toBe(runtime);
  return runtime;
};

describe("literal path input approval scopes", () => {
  it.each(["path", "filePath", "cwd"])("binds %s to its exact original value and requires approval after changes or omission", field => {
    const scoped = grant({ [field]: "a/source.ts" });
    expect(check(scoped, { [field]: "a/source.ts" })).toBe(true);
    expect(check(scoped, { [field]: "b/source.ts" })).toBe(false);
    expect(check(scoped, {})).toBe(false);
    expect(check(scoped, { [field]: undefined })).toBe(false);
    expect(check(scoped, { [field]: null })).toBe(false);
    expect(check(scoped, { [field]: ["a/source.ts"] })).toBe(false);
  });

  it("does not promote literal wildcard characters to glob permissions", () => {
    const scoped = grant({ path: "literal*/source?.ts" });
    expect(check(scoped, { path: "literal*/source?.ts" })).toBe(true);
    expect(check(scoped, { path: "literal-other/source1.ts" })).toBe(false);
  });

  it("does not add a new path input through a grant approved without that field", () => {
    const scoped = grant({});
    expect(check(scoped, {})).toBe(true);
    for (const field of ["path", "filePath", "cwd"]) expect(check(scoped, { [field]: "elsewhere" })).toBe(false);
  });

  it("requires every path dimension to match without mixing separate grants", () => {
    const first = grant({ path: "a.ts", cwd: "a" });
    const second = grant({ path: "b.ts", cwd: "b" });
    const input = { path: "a.ts", cwd: "b" };
    expect(permissions.decide("write_fixture", input, "write", [first, second], process.cwd()).allowed).toBe(false);
    expect(grantsAllow("write_fixture", [first, second], input, "write")).toBeDefined();
  });

  it.each([null, undefined, 42, {}, []])("keeps a supplied non-string path %j one-time instead of matching a later missing field", value => {
    const scoped = grant({ path: value });
    expect(scoped.exactPathInputs).toBeNull();
    expect(check(scoped, { path: value })).toBe(false);
    expect(check(scoped, {})).toBe(false);
  });

  it("preserves existing explicitly configured broad grants", () => {
    const { exactPathInputs: _ignored, ...configured } = grant({ path: "a.ts" });
    expect(check(configured, { path: "a/source.ts", filePath: "b.ts", cwd: "c" })).toBe(true);
    expect(check(configured, { path: "b/nested/source.ts" })).toBe(true);
    expect(check(configured, {})).toBe(true);
  });

  it("persists literal scopes and their absent fields without allowing partial objects", () => {
    const scoped = grant({ path: "literal*.ts", cwd: "." });
    expect(PermissionGrantSchema.parse(scoped)).toEqual(scoped);
    expect(PermissionGrantSchema.parse({ ...scoped, exactPathInputs: null }).exactPathInputs).toBeNull();
    expect(() => PermissionGrantSchema.parse({ ...scoped, exactPathInputs: { path: "a.ts" } })).toThrow();
  });

  it("bounds path display summaries without changing or reusing their authority", () => {
    const path = "literal*".repeat(200);
    const scoped = grant({ path });
    const before = JSON.stringify(scoped);
    const projected = projectPermissionGrants([scoped]);
    expect(JSON.stringify(projected)).not.toContain(path);
    expect(projected.grants[0]).toMatchObject({ exactPathInputs: { path: { truncated: true, characters: path.length }, filePath: { absent: true }, cwd: { absent: true } } });
    expect(JSON.stringify(scoped)).toBe(before);
    expect(check(scoped, { path })).toBe(true);
    expect(check(scoped, { path: path.slice(0, 300) + "…" })).toBe(false);
  });
});

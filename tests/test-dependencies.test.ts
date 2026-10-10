import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { VerificationItemSchema } from "@harness/protocol";
import { analyzeVerificationDependencies, canReuseVerificationDependencies, type VerificationDependencies } from "../packages/core/src/test-dependencies.js";
import type { WorkspaceSnapshot } from "../packages/core/src/workspace-impact.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-test-dependencies-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

async function snapshot(root: string): Promise<WorkspaceSnapshot> {
  const files: Record<string, string> = {};
  const walk = async (directory: string, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), path + "/");
      else files[path] = createHash("sha256").update(await readFile(join(root, path))).digest("hex");
    }
  };
  await walk(root);
  return { files, complete: true, truncated: false, skipped: 0, scanned: Object.keys(files).length };
}

async function analyze(root: string, command = "node --test tests/a.test.mjs", dependencyPaths?: string[]): Promise<VerificationDependencies> {
  const item = { ...VerificationItemSchema.parse({ id: "a", command }), ...(dependencyPaths ? { dependencyPaths } : {}) };
  return (await analyzeVerificationDependencies(root, [item], await snapshot(root))).a!;
}

const isolated = {
  "src/a.mjs": "export const a = 1;",
  "src/b.mjs": "export const b = 2;",
  "tests/a.test.mjs": "import test from 'node:test'; import assert from 'node:assert/strict'; import { a } from '../src/a.mjs'; test('a', () => assert.equal(a, 1));",
  "tests/b.test.mjs": "import test from 'node:test'; import assert from 'node:assert/strict'; import { b } from '../src/b.mjs'; test('b', () => assert.equal(b, 2));",
};

describe("verification dependency analysis", () => {
  it("reuses an independent real test closure after a source outside its dependency graph changes", async () => {
    const root = await fixture(isolated);
    await promisify(execFile)(process.execPath, ["--test", "tests/a.test.mjs"], { cwd: root });
    const before = await analyze(root);
    await writeFile(join(root, "src/b.mjs"), "export const b = 3;");
    const after = await analyze(root);
    expect(before.complete).toBe(true);
    expect(before.paths).toEqual(["src/a.mjs", "tests/a.test.mjs"]);
    expect(canReuseVerificationDependencies(before, after, ["src/b.mjs"])).toBe(true);
    await writeFile(join(root, "src/a.mjs"), "export const a = 4;");
    expect(canReuseVerificationDependencies(before, await analyze(root), ["src/a.mjs"])).toBe(false);
    await expect(promisify(execFile)(process.execPath, ["--test", "tests/a.test.mjs"], { cwd: root })).rejects.toThrow();
  });

  it("recursively includes reexports, literal dynamic imports, and require calls", async () => {
    const root = await fixture({
      "tests/a.test.mjs": "import '../src/entry.mjs'; await import('../src/lazy.mjs');",
      "src/entry.mjs": "export { value } from './nested/value.mjs';",
      "src/nested/value.mjs": "const data = require('../data.json'); export const value = data.value;",
      "src/lazy.mjs": "export const ready = true;",
      "src/data.json": '{"value":1}',
    });
    const dependencies = await analyze(root);
    expect(dependencies.complete).toBe(true);
    expect(dependencies.paths).toEqual(["src/data.json", "src/entry.mjs", "src/lazy.mjs", "src/nested/value.mjs", "tests/a.test.mjs"]);
    await writeFile(join(root, "src/data.json"), '{"value":2}');
    expect(canReuseVerificationDependencies(dependencies, await analyze(root))).toBe(false);
  });

  it("supports TypeScript substitution and invalidates when a new competing resolution appears", async () => {
    const root = await fixture({ "tests/a.test.ts": "import { a } from '../src/a.js';", "src/a.ts": "export const a = 1;" });
    const before = await analyze(root, "tsx --test tests/a.test.ts");
    expect(before.complete).toBe(true);
    expect(before.paths).toContain("src/a.ts");
    await writeFile(join(root, "src/a.js"), "export const a = 2;");
    const after = await analyze(root, "tsx --test tests/a.test.ts");
    expect(after.paths).toContain("src/a.js");
    expect(canReuseVerificationDependencies(before, after)).toBe(false);
  });

  it("resolves local package scripts instead of trusting an opaque npm command", async () => {
    const root = await fixture({ ...isolated, "package.json": JSON.stringify({ scripts: { test: "node --test tests/a.test.mjs" } }) });
    const before = await analyze(root, "npm test");
    expect(before.complete).toBe(true);
    expect(before.paths).toContain("package.json");
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test tests/b.test.mjs" } }));
    const after = await analyze(root, "npm test");
    expect(after.paths).toContain("src/b.mjs");
    expect(canReuseVerificationDependencies(before, after)).toBe(false);
  });

  it("includes package lifecycle scripts and rejects opaque lifecycle side effects", async () => {
    const root = await fixture({ ...isolated, "package.json": JSON.stringify({ scripts: { pretest: "node tests/b.test.mjs", test: "node --test tests/a.test.mjs" } }) });
    const before = await analyze(root, "npm test");
    expect(before.complete).toBe(true);
    expect(before.paths).toContain("src/b.mjs");
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { pretest: "generate-fixtures", test: "node --test tests/a.test.mjs" } }));
    expect((await analyze(root, "npm test")).complete).toBe(false);
  });

  it("records every glob entry and detects new or deleted tests", async () => {
    const root = await fixture(isolated);
    const before = await analyze(root, 'node --test "tests/*.test.mjs"');
    expect(before.complete).toBe(true);
    expect(before.paths).toContain("tests/b.test.mjs");
    await writeFile(join(root, "tests/c.test.mjs"), "import 'node:test';");
    const after = await analyze(root, 'node --test "tests/*.test.mjs"');
    expect(canReuseVerificationDependencies(before, after)).toBe(false);
    await rm(join(root, "tests/a.test.mjs"));
    expect(canReuseVerificationDependencies(after, await analyze(root, 'node --test "tests/*.test.mjs"'))).toBe(false);
  });

  it("includes declared dependency globs without dropping automatically detected imports", async () => {
    const root = await fixture({ ...isolated, "data/weather.json": '{"rain":1}', "data/cloud.json": '{"cloud":1}' });
    const before = await analyze(root, undefined, ["data/*.json"]);
    expect(before.complete).toBe(true);
    expect(before.paths).toEqual(["data/cloud.json", "data/weather.json", "src/a.mjs", "tests/a.test.mjs"]);
    await writeFile(join(root, "data/weather.json"), '{"rain":2}');
    expect(canReuseVerificationDependencies(before, await analyze(root, undefined, ["data/*.json"]))).toBe(false);
  });

  it.each(["package.json", "pnpm-lock.yaml", "tsconfig.json", "vite.config.ts", "vitest.config.ts", ".env.test"])("detects creation and deletion of global configuration %s", async path => {
    const root = await fixture(isolated);
    const before = await analyze(root);
    await writeFile(join(root, path), path.endsWith(".ts") ? "export default {};" : "{}");
    const after = await analyze(root);
    expect(after.paths).toContain(path);
    expect(canReuseVerificationDependencies(before, after, [path])).toBe(false);
    await rm(join(root, path));
    expect(canReuseVerificationDependencies(after, await analyze(root), [path])).toBe(false);
  });

  it.each([
    ["await import(name);", /Dynamic import|Nonliteral/],
    ["require('../src/' + name);", /Dynamic require/],
    ["const load = require; load(name);", /Aliased runtime require/],
    ["import '../src/missing.mjs';", /Missing module/],
    ["import '../../../escape.mjs';", /escapes/],
    ["import '../src/component.py';", /Unsupported dependency language/],
    ["import 'unknown-package';", /External or aliased/],
    ["import { readFile } from 'node:fs/promises';", /Runtime I\/O/],
    ["import.meta.glob('../src/*.mjs');", /import.meta/],
  ])("fails closed for unsupported or unbounded dependencies: %s", async (source, reason) => {
    const root = await fixture({ ...isolated, "tests/a.test.mjs": source, "src/component.py": "pass" });
    const before = await analyze(root, undefined, ["src/**"]);
    expect(before.complete).toBe(false);
    expect(before.reason).toMatch(reason);
    await writeFile(join(root, "src/b.mjs"), "export const b = 3;");
    const after = await analyze(root, undefined, ["src/**"]);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(canReuseVerificationDependencies(before, after)).toBe(false);
  });

  it("rejects an incomplete snapshot and source changed after that snapshot", async () => {
    const root = await fixture(isolated);
    const item = VerificationItemSchema.parse({ id: "a", command: "node --test tests/a.test.mjs" });
    const original = await snapshot(root);
    const incomplete = (await analyzeVerificationDependencies(root, [item], { ...original, complete: false })).a!;
    expect(incomplete.complete).toBe(false);
    expect(incomplete.reason).toMatch(/snapshot is incomplete/);
    await writeFile(join(root, "src/a.mjs"), "export const a = 9;");
    const changed = (await analyzeVerificationDependencies(root, [item], original)).a!;
    expect(changed.complete).toBe(false);
    expect(changed.reason).toMatch(/changed during analysis/);
  });

  it.each([[false, true], [true, false], [false, false]])("never reuses equal dependency fingerprints when completeness is %s / %s", (previousComplete, currentComplete) => {
    const fingerprint = "unchanged-workspace-fingerprint";
    const previous = { paths: ["tests/a.test.mjs"], fingerprint, complete: previousComplete };
    const current = { paths: ["tests/a.test.mjs"], fingerprint, complete: currentComplete };
    expect(canReuseVerificationDependencies(previous, current)).toBe(false);
    expect(canReuseVerificationDependencies(undefined, { ...current, complete: true })).toBe(false);
  });

  it("does not reuse unchanged opaque dependencies even when both fallback fingerprints match", async () => {
    const root = await fixture({ ...isolated, "tests/a.test.mjs": "await import(process.env.TEST_MODULE);" });
    const before = await analyze(root);
    const after = await analyze(root);
    expect(before.complete).toBe(false);
    expect(after.complete).toBe(false);
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(canReuseVerificationDependencies(before, after)).toBe(false);
  });

  it("binds command, environment, and cwd to the reusable dependency fingerprint", async () => {
    const root = await fixture(isolated);
    const before = await analyze(root);
    expect((await analyze(root, "node --test --test-concurrency=1 tests/a.test.mjs")).fingerprint).not.toBe(before.fingerprint);
    const key = "HARNESS_DEPENDENCY_ANALYSIS_TEST";
    const old = process.env[key];
    try {
      process.env[key] = "changed";
      expect(canReuseVerificationDependencies(before, await analyze(root))).toBe(false);
    } finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
  });

  it("handles dependency cycles without recursion overflow", async () => {
    const root = await fixture({ "tests/a.test.mjs": "import '../src/a.mjs';", "src/a.mjs": "import './b.mjs';", "src/b.mjs": "import './a.mjs';" });
    expect((await analyze(root)).complete).toBe(true);
  });

  it.each(["npm run nonexistent", "cargo test", "node --test tests/a.test.mjs && node --test tests/b.test.mjs", "node --import unknown-loader --test tests/a.test.mjs"])("fails closed on an unknown verification entry: %s", async command => {
    const root = await fixture({ ...isolated, "package.json": '{}' });
    expect((await analyze(root, command)).complete).toBe(false);
  });

  it("honors cancellation rather than reporting a complete analysis", async () => {
    const root = await fixture(isolated);
    const controller = new AbortController();
    controller.abort();
    await expect(analyzeVerificationDependencies(root, [VerificationItemSchema.parse({ id: "a", command: "node --test tests/a.test.mjs" })], await snapshot(root), controller.signal)).rejects.toThrow();
  });
});

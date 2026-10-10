import { describe, expect, it } from "vitest";
import { matchesVerificationCheck, sameVerificationCwd, sameVerificationStdin, verificationPlanMismatch } from "../packages/core/src/verification-matching.js";

const local = { id: "unit", stage: "local", command: "pnpm test -- test/service.test.ts", cwd: "./src" };
const broader = { id: "integration", stage: "broader", command: "pnpm test -- test/integration.test.ts", cwd: "." };

describe("verification comparison and bounded repair feedback", () => {
  it.each([
    ["./src", "src"], ["src/", "src"], ["", "."], ["./", "."], ["src//", "src"],
  ])("recognizes equivalent cwd %j and %j without requiring execution", (a, b) => {
    expect(sameVerificationCwd(a, b, "linux")).toBe(true);
  });

  it("uses Windows path separators and case rules while preserving Linux case", () => {
    expect(sameVerificationCwd(".\\Src\\", "src", "win32")).toBe(true);
    expect(sameVerificationCwd("C:\\App\\Src\\", "c:/app/src", "win32")).toBe(true);
    expect(sameVerificationCwd("Src", "src", "linux")).toBe(false);
    expect(sameVerificationCwd("src", "src2", "win32")).toBe(false);
    expect(sameVerificationCwd("src", "src/test", "linux")).toBe(false);
    expect(sameVerificationCwd(" src", "src", "linux")).toBe(false);
    expect(sameVerificationCwd("src ", "src", "win32")).toBe(false);
    expect(sameVerificationCwd("src\\test", "src/test", "linux")).toBe(false);
    expect(sameVerificationCwd("link/../src", "src", "linux")).toBe(false);
    expect(sameVerificationCwd("link\\..\\src", "src", "win32")).toBe(false);
  });

  it.each([undefined, ""])("treats unused stdin %j as absent", stdin => {
    expect(sameVerificationStdin(stdin, undefined)).toBe(true);
    expect(sameVerificationStdin(undefined, stdin)).toBe(true);
  });

  it("compares nonempty stdin exactly including trailing whitespace", () => {
    expect(sameVerificationStdin("assert()", "assert()")).toBe(true);
    expect(sameVerificationStdin("assert()", "assert()\n")).toBe(false);
    expect(sameVerificationStdin(" assert()", "assert()")).toBe(false);
    expect(sameVerificationStdin("assert()", undefined)).toBe(false);
    expect(sameVerificationStdin(" \n\t ", undefined)).toBe(false);
    expect(sameVerificationStdin(" \n\t ", " \n\t ")).toBe(true);
  });

  it("normalizes only cwd and unused stdin, retaining exact command and stage admission", () => {
    expect(matchesVerificationCheck(local, { ...local, cwd: "src/", stdin: "" })).toBe(true);
    expect(matchesVerificationCheck(local, { ...local, command: local.command + " " })).toBe(false);
    expect(matchesVerificationCheck(local, { ...local, command: local.command.replace("pnpm", "npm") })).toBe(false);
    expect(matchesVerificationCheck(local, { ...local, stage: "broader" })).toBe(false);
    expect(matchesVerificationCheck(local, { ...local, stdin: "assert()" })).toBe(false);
  });

  it("returns the exact applicable stage command and identifies the mismatched field", () => {
    expect(verificationPlanMismatch([local, broader], { ...broader, command: "unknown-test" })).toEqual({
      expected: [{ id: "integration", stage: "broader", command: broader.command, cwd: ".", hasStdin: false }],
      mismatch: ["command"], expectedCount: 1, expectedTruncated: false,
    });
    expect(verificationPlanMismatch([local], { ...local, cwd: "different" }).mismatch).toEqual(["cwd"]);
    expect(verificationPlanMismatch([local], { ...local, stdin: "assert()" }).mismatch).toEqual(["stdin"]);
  });

  it("identifies an absent planned stage without disclosing commands from other stages", () => {
    const mismatch = verificationPlanMismatch([local], broader);
    expect(mismatch).toMatchObject({ expected: [], expectedCount: 0, expectedTruncated: false });
    expect(mismatch.mismatch).toContain("stage");
  });

  it("does not report a mismatch for accepted cwd or empty stdin aliases", () => {
    const mismatch = verificationPlanMismatch([local], { ...local, cwd: "src/", stdin: "" });
    expect(mismatch.mismatch).toEqual([]);
  });

  it("bounds count and text while making truncation and stdin semantics explicit", () => {
    const planned = Array.from({ length: 10 }, (_, index) => ({ id: `check-${index}`, stage: "broader", command: `test-${index}-${"x".repeat(340)}`, cwd: `dir-${index}-${"y".repeat(340)}`, stdin: index ? " \n " : "actual input" }));
    const mismatch = verificationPlanMismatch([local, ...planned], { ...broader, command: "unknown-test" });
    expect(mismatch.expected).toHaveLength(8);
    expect(mismatch.expectedCount).toBe(10);
    expect(mismatch.expectedTruncated).toBe(true);
    expect(mismatch.expected[0]).toMatchObject({ id: "check-0", commandTruncated: true, cwdTruncated: true, hasStdin: true });
    expect(mismatch.expected[1]?.hasStdin).toBe(true);
    expect(mismatch.expected.every(item => item.command.length <= 300 && item.cwd.length <= 300)).toBe(true);
    expect(mismatch.expected.at(-1)?.id).toBe("check-7");
    expect(JSON.stringify(mismatch)).not.toContain("actual input");
  });
});

import { describe, expect, it } from "vitest";
import type { PermissionGrant, PlanSpec } from "@harness/protocol";
import { describeToolOperation, projectApprovedPlan, projectPermissionGrants } from "../packages/core/src/authorization-context.js";

describe("bounded authorization display summaries", () => {
  it("describes the operation and binds stdin without replaying a full source file in the title", () => {
    const command = "node writer.mjs --path src/PixelRoom.tsx";
    const stdin = "source code".repeat(10_000);
    const title = describeToolOperation({ id: "write", name: "terminal", input: { command, stdin } });
    expect(title).toContain(command);
    expect(title).toContain("stdin 110000 bytes, sha256:");
    expect(title).not.toContain("source code");
    expect(title).not.toBe(describeToolOperation({ id: "write2", name: "terminal", input: { command, stdin: stdin + " changed" } }));
    expect(title.length).toBeLessThan(250);
  });

  it("bounds accumulated plan and permission context while retaining exact audit records", () => {
    const longCommand = "node -e " + "COMMAND_BODY_MARKER".repeat(2000);
    const grants: PermissionGrant[] = Array.from({ length: 40 }, (_, i) => ({ toolNames: ["terminal"], commandPrefixes: [], exactCommands: [longCommand + i], pathGlobs: ["**"], networkDomains: [], maxRisk: "high" }));
    const plan: PlanSpec = { id: "plan", runId: "run", goal: "Implement a dashboard", version: 40, status: "approved",
      steps: grants.map((_, index) => ({ id: `step-${index}`, title: `terminal: write file ${index}`, description: "Execute reviewed input", dependencies: [], executor: "main", mode: "write", allowedTools: ["terminal"], input: { command: longCommand, stdin: "SOURCE_BODY_MARKER".repeat(3000) }, outputContract: "actual result", acceptanceCriteria: [], status: "pending" })),
      scope: { pathGlobs: ["**"], commandPrefixes: [longCommand], networkDomains: [], maxRisk: "high" }, createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z" };
    const original = JSON.stringify({ plan, grants });
    const projection = JSON.stringify({ plan: projectApprovedPlan(plan), grants: projectPermissionGrants(grants) });
    expect(projection.length).toBeLessThan(16_000);
    expect(projection).not.toContain("SOURCE_BODY_MARKER");
    expect(projection).not.toContain(longCommand);
    expect(projectApprovedPlan(plan)).toMatchObject({ totalSteps: 40, earlierStepsOmitted: 32 });
    expect(projectPermissionGrants(grants)).toMatchObject({ totalGrants: 40, omittedGrants: 16 });
    expect(JSON.stringify({ plan, grants })).toBe(original);
  });
});

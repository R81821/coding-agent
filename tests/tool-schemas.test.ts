import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry } from "@harness/tools";

/**
 * Providers send a tool's `inputSchema` verbatim as the function `parameters` and OpenAI rejects the
 * entire request when it is not declared as a JSON object schema. A zod discriminated union converts
 * to a bare `oneOf`, which is exactly that failure — so the shape is asserted for every builtin tool
 * rather than only for the one that happened to break.
 */
describe("builtin tool input schemas", () => {
  const contracts = createDefaultToolRegistry().contracts();

  it("registers the browser tool and at least one other tool", () => {
    expect(contracts.map((contract) => contract.name)).toContain("browser");
    expect(contracts.length).toBeGreaterThan(5);
  });

  it.each(contracts.map((contract) => contract.name))("declares %s as a JSON object schema", (name) => {
    const contract = contracts.find((candidate) => candidate.name === name)!;
    const schema = contract.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
  });

  it("keeps per-action constraints for the browser tool inside the object schema", () => {
    const browser = contracts.find((contract) => contract.name === "browser")!;
    const schema = browser.inputSchema as { type?: unknown; anyOf?: unknown[]; oneOf?: unknown[] };
    // `anyOf` is the union keyword providers in this codebase are known to accept; a stray `oneOf`
    // alongside the object type is the shape that got rejected.
    expect(schema.oneOf).toBeUndefined();
    expect(Array.isArray(schema.anyOf)).toBe(true);
    const branches = schema.anyOf!;
    // Every branch must still be an object, or a provider validating the branch fails as well.
    for (const branch of branches) expect((branch as Record<string, unknown>).type).toBe("object");
    expect(JSON.stringify(schema)).toContain("snapshot");
    expect(JSON.stringify(schema)).toContain("cancel_download");
  });
});

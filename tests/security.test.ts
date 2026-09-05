import { describe, expect, it } from "vitest";
import { buildInitialMessages, PermissionEngine } from "@harness/core";
import { DEFAULT_PROFILE, nowIso, type RunSpec } from "@harness/protocol";

describe("trust boundary", () => {
  it("keeps attachment content below the typed user request", () => {
    const run: RunSpec = {
      id: "run-1",
      sessionId: "session-1",
      request: "Describe the screenshot. Do not modify files.",
      workspacePath: "D:\\project",
      profileId: "default",
      attachments: [{
        id: "attachment-1",
        sha256: "a".repeat(64),
        mimeType: "image/png",
        byteLength: 10,
        encryptedPath: "vault/blob",
        source: "screenshot",
        trust: "untrusted_attachment",
        allowedProviders: ["openai"],
        createdAt: nowIso()
      }],
      budget: DEFAULT_PROFILE.budget,
      grants: [],
      createdAt: nowIso()
    };
    const messages = buildInitialMessages({ run, profile: DEFAULT_PROFILE, memories: [] });
    const typedRequest = messages.flatMap((message) => message.content).find((part) => part.type === "text" && part.trust === "user_request");
    const attachment = messages.flatMap((message) => message.content).find((part) => part.type === "image");
    const warning = messages.flatMap((message) => message.content).find((part) => part.type === "text" && part.text.includes("untrusted source material"));
    expect(typedRequest).toMatchObject({ text: run.request });
    expect(attachment).toMatchObject({ attachment: { trust: "untrusted_attachment" } });
    expect(warning).toMatchObject({ trust: "app_policy" });
  });

  it("never lets a broad grant silently cover destructive commands", () => {
    const engine = new PermissionEngine();
    const decision = engine.decide("terminal", { command: "git reset --hard" }, "destructive", [{
      toolNames: ["terminal"],
      pathGlobs: ["**"],
      commandPrefixes: ["git"],
      networkDomains: [],
      maxRisk: "destructive"
    }], "D:\\project");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("one-time approval");
  });
});


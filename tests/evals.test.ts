import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HarnessEvalRunner } from "@harness/evals";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { descriptor, type ModelProvider } from "@harness/providers";

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("offline harness evals", () => {
  it("replays the six security and recovery fixture categories without an API key", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-evals-")); temporary.push(root);
    const vault = await VaultCrypto.open(join(root, "envelope.json"), "correct-password");
    const database = await HarnessDatabase.open(join(root, "harness.sqlite"), vault);
    const results = await new HarnessEvalRunner(database).run();
    expect(results).toHaveLength(6);
    expect(results.every((result) => result.passed)).toBe(true);
    expect(database.listEvalResults()).toHaveLength(6);
    database.close(); vault.dispose();
  });

  it("requires an explicit switch before a configured provider can incur live eval usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-live-evals-")); temporary.push(root);
    const vault = await VaultCrypto.open(join(root, "envelope.json"), "correct-password");
    const database = await HarnessDatabase.open(join(root, "harness.sqlite"), vault);
    const model = descriptor({ providerId: "mock-live", modelId: "test-model", displayName: "Test model" });
    const provider: ModelProvider = {
      id: "mock-live",
      listModels: async () => [model],
      async *stream() { yield { type: "text_delta", delta: "OK" }; },
      health: async () => true,
      estimateCost: () => 0,
    };

    await expect(new HarnessEvalRunner(database, [provider], {}).run(["live-provider-mock-live"], true))
      .rejects.toThrow("HARNESS_ENABLE_LIVE_EVALS=1");
    const results = await new HarnessEvalRunner(database, [provider], { HARNESS_ENABLE_LIVE_EVALS: "1" })
      .run(["live-provider-mock-live"], true);
    expect(results).toHaveLength(1);
    expect(results[0]?.passed).toBe(true);
    database.close(); vault.dispose();
  });
});

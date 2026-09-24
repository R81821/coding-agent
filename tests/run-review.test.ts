import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { RunReviewService } from "../packages/core/src/run-review.js";
import { HarnessEngine, ProjectTrustService } from "@harness/core";
import { MemoryService, SkillService } from "@harness/extensions";
import { descriptor, type ModelProvider } from "@harness/providers";
import { ToolRegistry } from "@harness/tools";
import {
  DaemonRequestSchema,
  DEFAULT_PROFILE,
  nowIso,
  type AgentEvent,
  type RunSpec,
} from "@harness/protocol";
import { sanitizeRendererRequest } from "../apps/desktop/src/renderer-ipc.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });

async function fixture(gitRepo = true) {
  const root = await mkdtemp(join(tmpdir(), "run-review-test-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await import("node:fs/promises").then((fs) => fs.mkdir(workspace));
  if (gitRepo) {
    git(workspace, "init", "-q");
    git(workspace, "config", "core.autocrlf", "false");
    await writeFile(join(workspace, "original.txt"), "committed\n");
    git(workspace, "add", "original.txt");
    git(workspace, "commit", "-qm", "initial");
  }
  const crypto = await VaultCrypto.open(
    join(root, "key.json"),
    "fixture-password",
  );
  return {
    root,
    workspace,
    crypto,
    reviews: new RunReviewService(join(root, "reviews"), crypto),
  };
}

describe("run review", () => {
  it("captures only the run delta across a dirty baseline, including terminal edits and new files", async () => {
    const { workspace, reviews, crypto } = await fixture();
    await writeFile(join(workspace, "original.txt"), "dirty before\n");
    await writeFile(join(workspace, "prior.txt"), "already here\n");
    const indexBefore = git(workspace, "ls-files", "--stage");
    await reviews.begin({
      id: "r1",
      sessionId: "s1",
      workspacePath: workspace,
    });
    await writeFile(join(workspace, "original.txt"), "dirty after\n");
    await writeFile(join(workspace, "created.txt"), "from terminal\n");
    await reviews.finish("r1", false);
    const result = await reviews.get("r1");
    expect(result.status).toBe("ready");
    expect(result.files.map((file) => file.path)).toEqual([
      "created.txt",
      "original.txt",
    ]);
    expect(result.files[0]).toMatchObject({
      added: 1,
      deleted: 0,
      canUndo: true,
      undone: false,
    });
    expect(result.files[1]!.diff).toContain("-dirty before");
    expect(result.files[1]!.diff).toContain("+dirty after");
    expect(git(workspace, "status", "--porcelain")).toContain("?? prior.txt");
    expect(git(workspace, "ls-files", "--stage")).toBe(indexBefore);
    crypto.dispose();
  });

  it("returns a ready empty review for no changes and preserves baseline through pause", async () => {
    const { workspace, reviews, crypto, root } = await fixture();
    await reviews.begin({
      id: "r1",
      sessionId: "s1",
      workspacePath: workspace,
    });
    await reviews.finish("r1", true);
    expect((await reviews.get("r1")).status).toBe("capturing");
    const reopened = new RunReviewService(join(root, "reviews"), crypto);
    expect((await reopened.get("r1")).status).toBe("capturing");
    await reopened.begin({
      id: "r1",
      sessionId: "s1",
      workspacePath: workspace,
    });
    await reopened.finish("r1", false);
    expect(await reopened.get("r1")).toMatchObject({
      status: "ready",
      files: [],
    });
    crypto.dispose();
  });

  it("continues a review-status run from its original baseline", async () => {
    const { workspace, reviews, crypto, root } = await fixture();
    const run = { id: "r1", sessionId: "s1", workspacePath: workspace };
    await reviews.begin(run);
    await writeFile(join(workspace, "original.txt"), "first pass\n");
    await reviews.finish(run.id, false);
    expect((await reviews.get(run.id)).status).toBe("ready");
    const reopened = new RunReviewService(join(root, "reviews"), crypto);
    await reopened.begin(run, true);
    expect((await reopened.get(run.id)).status).toBe("capturing");
    await writeFile(join(workspace, "original.txt"), "second pass\n");
    await reopened.finish(run.id, false);
    const diff = (await reopened.get(run.id)).files[0]!.diff;
    expect(diff).toContain("-committed");
    expect(diff).toContain("+second pass");
    crypto.dispose();
  });

  it("undoes one file, retains its encrypted record, and rejects repeated undo", async () => {
    const { workspace, reviews, crypto, root } = await fixture();
    await reviews.begin({
      id: "r1",
      sessionId: "s1",
      workspacePath: workspace,
    });
    await writeFile(join(workspace, "original.txt"), "changed\n");
    await writeFile(join(workspace, "new.txt"), "new\n");
    await reviews.finish("r1", false);
    await reviews.undo("r1", "original.txt");
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe(
      "committed\n",
    );
    expect(await readFile(join(workspace, "new.txt"), "utf8")).toBe("new\n");
    expect(
      (await reviews.get("r1")).files.find(
        (file) => file.path === "original.txt",
      ),
    ).toMatchObject({ undone: true, canUndo: false });
    await expect(reviews.undo("r1", "original.txt")).rejects.toThrow();
    const [name] = await readdir(join(root, "reviews"));
    expect(await readFile(join(root, "reviews", name!), "utf8")).not.toContain(
      "changed",
    );
    crypto.dispose();
  });

  it("keeps both undone flags when two files are undone concurrently", async () => {
    const { workspace, reviews, crypto } = await fixture();
    await reviews.begin({
      id: "r1",
      sessionId: "s1",
      workspacePath: workspace,
    });
    await writeFile(join(workspace, "original.txt"), "changed\n");
    await writeFile(join(workspace, "created.txt"), "new\n");
    await reviews.finish("r1", false);
    await Promise.all([
      reviews.undo("r1", "original.txt"),
      reviews.undo("r1", "created.txt"),
    ]);
    expect(
      (await reviews.get("r1")).files.map((file) => [file.path, file.undone]),
    ).toEqual([
      ["created.txt", true],
      ["original.txt", true],
    ]);
    crypto.dispose();
  });

  it("does not attribute an undo to a run started just after the active-run check", async () => {
    const { workspace, root, crypto } = await fixture();
    const next = { id: "r2", sessionId: "s2", workspacePath: workspace };
    let starting: Promise<void> | undefined;
    const reviews = new RunReviewService(join(root, "reviews"), crypto, {
      activeWorkspaces: () => {
        starting ??= reviews.begin(next);
        return [];
      },
    });
    await reviews.begin({
      id: "r1",
      sessionId: "s1",
      workspacePath: workspace,
    });
    await writeFile(join(workspace, "original.txt"), "changed\n");
    await reviews.finish("r1", false);
    await reviews.undo("r1", "original.txt");
    await starting;
    await reviews.finish("r2", false);
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe(
      "committed\n",
    );
    expect(await reviews.get("r2")).toMatchObject({
      status: "ready",
      files: [],
    });
    crypto.dispose();
  });

  it("rejects external worktree and staged changes without overwriting them", async () => {
    const { workspace, reviews, crypto } = await fixture();
    await reviews.begin({
      id: "r1",
      sessionId: "s1",
      workspacePath: workspace,
    });
    await writeFile(join(workspace, "original.txt"), "changed\n");
    await reviews.finish("r1", false);
    await writeFile(join(workspace, "original.txt"), "external\n");
    await expect(reviews.undo("r1", "original.txt")).rejects.toThrow();
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe(
      "external\n",
    );
    await writeFile(join(workspace, "original.txt"), "changed\n");
    git(workspace, "add", "original.txt");
    await expect(reviews.undo("r1", "original.txt")).rejects.toThrow();
    expect(await readFile(join(workspace, "original.txt"), "utf8")).toBe(
      "changed\n",
    );
    crypto.dispose();
  });

  it("marks non-Git and overlapping repository runs unavailable", async () => {
    const plain = await fixture(false);
    await plain.reviews.begin({
      id: "plain",
      sessionId: "s1",
      workspacePath: plain.workspace,
    });
    await plain.reviews.finish("plain", false);
    expect(await plain.reviews.get("plain")).toMatchObject({
      status: "unavailable",
      files: [],
    });
    plain.crypto.dispose();
    const { workspace, reviews, crypto } = await fixture();
    await reviews.begin({ id: "a", sessionId: "s1", workspacePath: workspace });
    await reviews.begin({ id: "b", sessionId: "s2", workspacePath: workspace });
    await writeFile(join(workspace, "original.txt"), "shared\n");
    await reviews.finish("a", false);
    await reviews.finish("b", false);
    expect((await reviews.get("a")).status).toBe("unavailable");
    expect((await reviews.get("b")).status).toBe("unavailable");
    crypto.dispose();
  });

  it("captures an ignored tracked file", async () => {
    const { workspace, reviews, crypto } = await fixture();
    await writeFile(join(workspace, ".gitignore"), "tracked.log\n");
    await writeFile(join(workspace, "tracked.log"), "old\n");
    git(workspace, "add", ".gitignore");
    git(workspace, "add", "-f", "tracked.log");
    git(workspace, "commit", "-qm", "tracked ignored");
    await reviews.begin({ id: "a", sessionId: "s1", workspacePath: workspace });
    await writeFile(join(workspace, "tracked.log"), "new\n");
    await reviews.finish("a", false);
    expect((await reviews.get("a")).files.map((file) => file.path)).toEqual([
      "tracked.log",
    ]);
    crypto.dispose();
  });

  it("reports that newly ignored files are outside the review scope", async () => {
    const { workspace, reviews, crypto } = await fixture();
    await writeFile(
      join(workspace, ".gitignore"),
      "private.env\nnode_modules/\n",
    );
    await reviews.begin({
      id: "r1",
      sessionId: "s1",
      workspacePath: workspace,
    });
    await writeFile(join(workspace, "private.env"), "SECRET=value\n");
    await mkdir(join(workspace, "node_modules"));
    await writeFile(
      join(workspace, "node_modules", "package.js"),
      "module.exports = 1\n",
    );
    await writeFile(join(workspace, "visible.txt"), "visible\n");
    await reviews.finish("r1", false);
    const review = await reviews.get("r1");
    expect(review.scope).toBe("tracked-and-nonignored-untracked");
    expect(review.files.map((file) => file.path)).toEqual(["visible.txt"]);
    crypto.dispose();
  });

  it("uses unstaged worktree bytes as baseline while preserving staged index entries", async () => {
    const { workspace, reviews, crypto } = await fixture();
    await writeFile(join(workspace, "original.txt"), "staged\n");
    git(workspace, "add", "original.txt");
    const staged = git(workspace, "ls-files", "--stage");
    await writeFile(join(workspace, "original.txt"), "unstaged before\n");
    await reviews.begin({
      id: "r1",
      sessionId: "s1",
      workspacePath: workspace,
    });
    await writeFile(join(workspace, "original.txt"), "run wrote\n");
    await reviews.finish("r1", false);
    expect((await reviews.get("r1")).files[0]!.diff).toContain(
      "-unstaged before",
    );
    expect(git(workspace, "ls-files", "--stage")).toBe(staged);
    crypto.dispose();
  });

  it("accepts the same Windows workspace with different path casing on resume", async () => {
    if (process.platform !== "win32") return;
    const { workspace, reviews, crypto } = await fixture();
    await reviews.begin({
      id: "r1",
      sessionId: "s1",
      workspacePath: workspace,
    });
    await reviews.finish("r1", true);
    await expect(
      reviews.begin({
        id: "r1",
        sessionId: "s1",
        workspacePath: workspace.toUpperCase(),
      }),
    ).resolves.toBeUndefined();
    crypto.dispose();
  });

  it("rejects another run started while its owner is paused", async () => {
    const { workspace, reviews, crypto } = await fixture();
    await reviews.begin({ id: "a", sessionId: "s1", workspacePath: workspace });
    await reviews.finish("a", true);
    await reviews.begin({ id: "b", sessionId: "s2", workspacePath: workspace });
    await reviews.finish("b", false);
    await reviews.finish("a", false);
    expect((await reviews.get("a")).status).toBe("unavailable");
    expect((await reviews.get("b")).status).toBe("unavailable");
    crypto.dispose();
  });

  it("keeps new runs unavailable while an unavailable prior run is executing", async () => {
    const { workspace, crypto, root } = await fixture();
    const activeRuns: Array<{
      id: string;
      sessionId: string;
      workspacePath: string;
    }> = [];
    const reviews = new RunReviewService(join(root, "reviews"), crypto, {
      activeRuns: () => activeRuns,
    });
    await reviews.begin({ id: "a", sessionId: "s1", workspacePath: workspace });
    await reviews.begin({ id: "b", sessionId: "s2", workspacePath: workspace });
    await reviews.finish("a", false);
    await reviews.finish("b", false);
    await reviews.begin({ id: "a", sessionId: "s1", workspacePath: workspace });
    activeRuns.push(
      { id: "a", sessionId: "s1", workspacePath: workspace },
      { id: "c", sessionId: "s3", workspacePath: workspace },
    );
    await reviews.begin({ id: "c", sessionId: "s3", workspacePath: workspace });
    await reviews.finish("c", false);
    expect((await reviews.get("c")).status).toBe("unavailable");
    crypto.dispose();
  });

  it("removes encrypted review records when its session is deleted", async () => {
    const { workspace, reviews, crypto, root } = await fixture();
    await reviews.begin({
      id: "r1",
      sessionId: "s1",
      workspacePath: workspace,
    });
    await reviews.finish("r1", false);
    expect((await readdir(join(root, "reviews"))).length).toBe(1);
    await reviews.deleteSession("s1");
    expect(await readdir(join(root, "reviews"))).toEqual([]);
    crypto.dispose();
  });

  it("does not recreate a review when deletion races with final capture", async () => {
    const { workspace, reviews, crypto, root } = await fixture();
    await reviews.begin({
      id: "r1",
      sessionId: "s1",
      workspacePath: workspace,
    });
    await writeFile(join(workspace, "original.txt"), "changed\n");
    const finishing = reviews.finish("r1", false);
    await reviews.deleteSession("s1");
    await finishing;
    expect(await readdir(join(root, "reviews"))).toEqual([]);
    crypto.dispose();
  });

  it("captures new runs after a deleted session is restored", async () => {
    const { workspace, reviews, crypto } = await fixture();
    await reviews.deleteSession("s1");
    reviews.restoreSession("s1");
    await reviews.begin({
      id: "r2",
      sessionId: "s1",
      workspacePath: workspace,
    });
    await reviews.finish("r2", false);
    expect((await reviews.get("r2")).status).toBe("ready");
    crypto.dispose();
  });

  it("does not revive an old review when a session is restored during final capture", async () => {
    const { workspace, reviews, crypto, root } = await fixture();
    await reviews.begin({
      id: "r1",
      sessionId: "s1",
      workspacePath: workspace,
    });
    await writeFile(join(workspace, "original.txt"), "changed\n");
    const finishing = reviews.finish("r1", false);
    await reviews.deleteSession("s1");
    reviews.restoreSession("s1");
    await finishing;
    expect(await readdir(join(root, "reviews"))).toEqual([]);
    crypto.dispose();
  });

  it("captures the Git baseline before an engine model turn and finalizes after its result", async () => {
    const { workspace, reviews, crypto, root } = await fixture();
    const database = await HarnessDatabase.open(
      join(root, "app.sqlite"),
      crypto,
    );
    const model = descriptor({
      providerId: "fake",
      modelId: "fake-model",
      displayName: "Fake",
      capabilities: {
        vision: false,
        tools: true,
        parallelTools: true,
        structuredOutput: true,
        maxContextTokens: 32_000,
        dataPolicy: "local",
      },
    });
    let statusAtModel = "";
    const provider: ModelProvider = {
      id: "fake",
      async listModels() {
        return [model];
      },
      async health() {
        return true;
      },
      estimateCost() {
        return 0;
      },
      async *stream() {
        statusAtModel = (await reviews.get("r1")).status;
        await writeFile(
          join(workspace, "original.txt"),
          "edited by model turn\n",
        );
        yield { type: "text_delta" as const, delta: "Done." };
        yield {
          type: "usage" as const,
          usage: { inputTokens: 1, outputTokens: 1, estimatedUsd: 0 },
        };
      },
    };
    const engine = new HarnessEngine({
      database,
      providers: [provider],
      tools: new ToolRegistry(),
      memory: new MemoryService(database),
      skills: new SkillService(join(root, "skills")),
      projectTrust: new ProjectTrustService(database),
      review: reviews,
    });
    const profile = {
      ...DEFAULT_PROFILE,
      allowedProviders: ["fake"],
      toolNames: [],
    };
    const run: RunSpec = {
      id: "r1",
      sessionId: "s1",
      workspacePath: workspace,
      request: "Edit original.txt",
      profileId: profile.id,
      attachments: [],
      grants: [],
      budget: profile.budget,
      createdAt: nowIso(),
      workflowVersion: 1,
    };
    const result = new Promise<AgentEvent>((resolveResult) =>
      engine.on("event", (event: AgentEvent) => {
        if (event.runId === run.id && event.type === "result")
          resolveResult(event);
      }),
    );
    engine.start(run, profile);
    expect(await result).toMatchObject({ type: "result", status: "completed" });
    for (let attempt = 0; attempt < 100 && engine.isActive(run.id); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(statusAtModel).toBe("capturing");
    expect((await reviews.get(run.id)).files[0]!.diff).toContain(
      "+edited by model turn",
    );
    database.close();
    crypto.dispose();
  });

  it("exposes review and undo RPCs through protocol and renderer", () => {
    for (const [method, params] of [
      ["run.review", { runId: "r1" }],
      ["review.undo", { runId: "r1", path: "original.txt" }],
    ] as const) {
      expect(
        DaemonRequestSchema.parse({ id: "q", method, params }).method,
      ).toBe(method);
      expect(sanitizeRendererRequest(method, params).method).toBe(method);
    }
  });
});

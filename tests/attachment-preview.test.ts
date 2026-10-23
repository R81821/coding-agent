import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EncryptedBlobStore, HarnessDatabase, VaultCrypto } from "@harness/persistence";
import { AttachmentPreviewSchema, DaemonRequestSchema, DEFAULT_PROFILE, MAX_ATTACHMENT_BYTES, type AttachmentRef, type RunSpec, type SessionRecord } from "@harness/protocol";
import { readAttachmentPreview, type AttachmentPreviewTarget } from "../apps/daemon/src/attachment-preview.js";
import { sanitizeRendererRequest } from "../apps/desktop/src/renderer-ipc.js";

const at = "2026-10-20T00:00:00.000Z";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yXfoAAAAASUVORK5CYII=", "base64");
const params = { runId: "run", attachmentId: "picture" };
const session: SessionRecord = { id: "session", workspacePath: "D:/attachment-preview", profileId: "default", title: "session", createdAt: at, updatedAt: at };
function reference(bytes = png, mimeType = "image/png"): AttachmentRef {
  return { id: "picture", sha256: createHash("sha256").update(bytes).digest("hex"), mimeType, byteLength: bytes.byteLength,
    encryptedPath: "trusted-vault-path.hab", source: "screenshot", trust: "untrusted_attachment", allowedProviders: [], createdAt: at };
}
function run(attachments = [reference()]): RunSpec {
  return { id: "run", sessionId: session.id, request: "请分析截图", workspacePath: session.workspacePath, profileId: "default", budget: DEFAULT_PROFILE.budget, grants: [], attachments, createdAt: at };
}
function fakeTarget(attachment = reference(), bytes = png) {
  return {
    database: { getRun: vi.fn(() => ({ spec: run([attachment]) })), getVisibleSession: vi.fn<AttachmentPreviewTarget["database"]["getVisibleSession"]>(() => session), getAttachment: vi.fn<AttachmentPreviewTarget["database"]["getAttachment"]>(() => attachment) },
    blobs: { read: vi.fn(async () => bytes) },
  };
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close(); });

describe("attachment preview authority", () => {
  it("allows the renderer RPC with only a run and attachment identity", () => {
    const request = sanitizeRendererRequest("attachment.preview", params);
    expect(DaemonRequestSchema.parse({ id: "preview", ...request })).toMatchObject({ method: "attachment.preview", params });
    for (const invalid of [{}, { runId: "", attachmentId: "picture" }, { ...params, encryptedPath: "D:/private.txt" }, { ...params, attachment: reference() }]) {
      expect(DaemonRequestSchema.safeParse({ id: "preview", method: "attachment.preview", params: invalid }).success).toBe(false);
    }
  });

  it("uses only the separately persisted reference for the blob path", async () => {
    const target = fakeTarget();
    target.database.getRun.mockReturnValue({ spec: run([{ ...reference(), encryptedPath: "D:/forged-run-path" }]) });
    const preview = await readAttachmentPreview(params, target);
    expect(AttachmentPreviewSchema.parse(preview)).toEqual({ mimeType: "image/png", base64: png.toString("base64") });
    expect(target.blobs.read).toHaveBeenCalledWith(reference());
    expect(JSON.stringify(preview)).not.toContain("encryptedPath");
  });

  it("rejects attachment identities belonging to a different message before reading blobs", async () => {
    const target = fakeTarget();
    target.database.getRun.mockReturnValue({ spec: run([]) });
    await expect(readAttachmentPreview(params, target)).rejects.toThrow(/不属于/);
    expect(target.database.getAttachment).not.toHaveBeenCalled();
    expect(target.blobs.read).not.toHaveBeenCalled();
  });

  it("rejects missing trusted records instead of falling back to a run path", async () => {
    const target = fakeTarget(); target.database.getAttachment.mockReturnValue(undefined);
    await expect(readAttachmentPreview(params, target)).rejects.toThrow(/不存在/);
    expect(target.blobs.read).not.toHaveBeenCalled();
  });

  it.each(["image/svg+xml", "text/html", "application/pdf"])("does not serve active or non-raster content: %s", async mimeType => {
    const target = fakeTarget(reference(png, mimeType));
    await expect(readAttachmentPreview(params, target)).rejects.toThrow(/支持预览/);
    expect(target.blobs.read).not.toHaveBeenCalled();
  });

  it("rejects trusted metadata inconsistent with the run's attachment", async () => {
    const target = fakeTarget(); target.database.getAttachment.mockReturnValue({ ...reference(), sha256: "a".repeat(64) });
    await expect(readAttachmentPreview(params, target)).rejects.toThrow(/引用不一致/);
    expect(target.blobs.read).not.toHaveBeenCalled();
  });

  it.each([0, MAX_ATTACHMENT_BYTES + 1])("rejects an out-of-range byte count %s before blob I/O", async byteLength => {
    const target = fakeTarget({ ...reference(), byteLength });
    await expect(readAttachmentPreview(params, target)).rejects.toThrow(/大小/);
    expect(target.blobs.read).not.toHaveBeenCalled();
  });

  it("checks content length and hash, including renamed non-images", async () => {
    const corrupt = fakeTarget(); corrupt.blobs.read.mockResolvedValue(Buffer.from("corrupt"));
    await expect(readAttachmentPreview(params, corrupt)).rejects.toThrow(/校验失败/);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>run()</script></svg>');
    await expect(readAttachmentPreview(params, fakeTarget(reference(svg), svg))).rejects.toThrow(/类型不一致/);
  });

  it("rechecks visibility after asynchronous blob I/O", async () => {
    const target = fakeTarget(); target.database.getVisibleSession.mockReturnValueOnce(session).mockReturnValue(undefined);
    await expect(readAttachmentPreview(params, target)).rejects.toThrow(/删除/);
    expect(target.blobs.read).toHaveBeenCalledTimes(1);
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-attachment-preview-"));
  const crypto = await VaultCrypto.open(join(root, "vault.json"), "attachment-preview-passphrase");
  let database = await HarnessDatabase.open(join(root, "data.sqlite"), crypto);
  cleanup.push(async () => { database.close(); crypto.dispose(); await rm(root, { recursive: true, force: true }); });
  const blobs = new EncryptedBlobStore(join(root, "blobs"), crypto);
  database.createSession(session);
  const attachment = await blobs.put({ bytes: png, mimeType: "image/png", source: "screenshot" });
  database.saveAttachment(attachment);
  database.saveRun(run([attachment]), "paused");
  return { get database() { return database; }, blobs, attachment,
    async reopen() { database.close(); database = await HarnessDatabase.open(join(root, "data.sqlite"), crypto); } };
}

describe("persisted screenshot previews", () => {
  it("loads encrypted bytes after reopening, checks message membership, and preserves storage references", async () => {
    const state = await fixture(); await state.reopen();
    const input = { runId: "run", attachmentId: state.attachment.id };
    expect(await readAttachmentPreview(input, state)).toEqual({ mimeType: "image/png", base64: png.toString("base64") });
    expect(state.database.getAttachment(state.attachment.id)).toEqual(state.attachment);
    state.database.saveRun({ ...run([]), id: "other-message" }, "completed");
    await expect(readAttachmentPreview({ ...input, runId: "other-message" }, state)).rejects.toThrow(/不属于/);
    await expect(readAttachmentPreview({ ...input, runId: "unknown" }, state)).rejects.toThrow(/不存在/);
  });

  it.each(["session", "project", "purge", "withdraw"])("blocks previews when the %s is removed while keeping orphaned blob records inaccessible", async action => {
    const state = await fixture();
    if (action === "session" || action === "purge") state.database.deleteSession(session.id);
    if (action === "purge") state.database.purgeSession(session.id);
    if (action === "project") state.database.deleteProject(state.database.listProjects()[0]!.id);
    if (action === "withdraw") state.database.withdrawLatestRun("run");
    await state.reopen();
    expect(state.database.getAttachment(state.attachment.id)).toBeDefined();
    const read = vi.spyOn(state.blobs, "read");
    await expect(readAttachmentPreview({ runId: "run", attachmentId: state.attachment.id }, state)).rejects.toThrow(/不存在|删除/);
    expect(read).not.toHaveBeenCalled();
  });
});

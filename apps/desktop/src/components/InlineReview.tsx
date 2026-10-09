import React, { lazy, Suspense, useMemo } from "react";
import { useRowState } from "@harness/conversation-ui";
import type { RunReview } from "@harness/protocol";
import { parseDiff, type DiffFile } from "../code-changes.js";

const CodeChanges = lazy(() => import("./CodeChanges.js").then(module => ({ default: module.CodeChanges })));

export type { RunReview };

export type InlineReviewFile = {
  path: string;
  added: number;
  deleted: number;
  diffFile: DiffFile;
  canUndo: boolean;
  undone: boolean;
};

export function selectInlineReviewFiles(
  review: RunReview | undefined,
): InlineReviewFile[] {
  if (review?.status === "ready")
    return review.files.map((file) => ({
      path: file.path,
      added: file.added,
      deleted: file.deleted,
      diffFile: parseDiff(file.diff).find(
        (item) => item.path === file.path,
      ) ?? {
        path: file.path,
        added: file.added,
        deleted: file.deleted,
        lines: [{ kind: "meta", text: "此文件的差异无法预览。" }],
      },
      canUndo: file.canUndo,
      undone: file.undone,
    }));
  return [];
}

export function InlineReview({
  runId,
  review,
  onUndo,
}: {
  runId: string;
  review: RunReview | undefined;
  onUndo: (path: string) => Promise<void>;
}) {
  const [selectedPath, setSelectedPath] = useRowState<string | null>("reviewPath", null);
  const [undoing, setUndoing] = useRowState<string | null>("reviewUndoing", null);
  const [error, setError] = useRowState("reviewError", "");
  const files = useMemo(() => selectInlineReviewFiles(review), [review]);
  if (!files.length) return null;
  const selected = files.find((file) => file.path === selectedPath);
  async function undo(path: string) {
    if (undoing !== null) return;
    if (!window.confirm(`撤销 ${path} 在本轮中的修改？`)) return;
    setUndoing(path);
    setError("");
    try {
      await onUndo(path);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setUndoing(null);
    }
  }
  return (
    <section
      className="conversation-inline-review"
      aria-label="代码审核"
      data-run-id={runId}
    >
      <h2>代码审核</h2>
      <p className="inline-review-scope">
        仅展示本轮 Git 可记录文件的净变更；忽略文件不在审核范围内。
      </p>
      <div className="inline-review-files">
        {files.map((file) => (
          <div className="inline-review-file" key={file.path}>
            <span className="inline-review-path" title={file.path}>
              {file.path}
            </span>
            <span className="inline-review-counts">
              <b className="diff-plus">+{file.added}</b>
              <b className="diff-minus">−{file.deleted}</b>
            </span>
            {file.undone ? (
              <span className="inline-review-undone">已撤销</span>
            ) : file.canUndo ? (
              <button
                type="button"
                disabled={undoing !== null}
                onClick={() => void undo(file.path)}
              >
                {undoing === file.path ? "撤销中…" : "撤销"}
              </button>
            ) : null}
            <button
              type="button"
              aria-expanded={selectedPath === file.path}
              onClick={() =>
                setSelectedPath(selectedPath === file.path ? null : file.path)
              }
            >
              审核
            </button>
          </div>
        ))}
      </div>
      {error && (
        <p className="inline-review-error" role="alert">
          {error}
        </p>
      )}
      {selected && <Suspense fallback={<p role="status">正在加载差异…</p>}>
        <CodeChanges
          compact
          events={[]}
          snapshots={[
            {
              id: `${runId}:${selected.path}`,
              label: "本轮变更",
              files: [selected.diffFile],
            },
          ]}
        />
      </Suspense>}
    </section>
  );
}

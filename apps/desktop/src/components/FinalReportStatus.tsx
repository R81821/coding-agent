import React from "react";
import type { AgentEvent } from "@harness/protocol";
import { runStatusLabel } from "../run-history.js";

/** The structured result takes precedence over completion claims inside model prose. */
export function FinalReportStatus({ result }: { result?: Extract<AgentEvent, { type: "result" }> }) {
  if (!result) return null;
  const reason = result.stop?.message;
  const visibleReason = reason && !/^运行已暂停[。．]?/.test(reason) ? reason : undefined;
  return <div role="status" className="mb-3 text-sm text-text-muted">
    <p>运行状态：{runStatusLabel[result.status]}</p>
    {visibleReason && <p className="break-words text-warning">{visibleReason}</p>}
  </div>;
}

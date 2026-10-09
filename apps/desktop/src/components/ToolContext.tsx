import React, { memo, useMemo } from "react";

export const ToolContext = memo(function ToolContext({ value }: { value: unknown }) {
  const text = useMemo(() => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value), [value]);
  return <pre className="tool-context-pre">{text}</pre>;
});

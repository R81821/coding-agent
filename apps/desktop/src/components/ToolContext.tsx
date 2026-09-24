import React, { useState } from "react";

const PREVIEW_LENGTH = 20_000;

export function ToolContext({ value }: { value: unknown }) {
  const [showAll, setShowAll] = useState(false);
  const text = JSON.stringify(value, null, 2) ?? String(value);
  const long = text.length > PREVIEW_LENGTH;
  return (
    <>
      <pre className="tool-context-pre">
        {long && !showAll
          ? `${text.slice(0, PREVIEW_LENGTH)}\n… 预览已截断`
          : text}
      </pre>
      {long && (
        <button
          className="tool-context-toggle"
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? "收起长内容" : "查看完整内容"}
        </button>
      )}
    </>
  );
}

/**
 * Adapted from shadcn/ui Base UI Code Block.
 * https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/bases/base/ui/code-block.tsx
 * Copyright (c) 2023 shadcn. MIT License; see SHADCN-LICENSE.txt.
 */
import React from "react";
import { Check, Copy } from "lucide-react";

const classes = (...values: Array<string | undefined>) => values.filter(Boolean).join(" ");

function CodeBlock({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<"div"> & { variant?: "default" | "destructive"; size?: "default" | "sm" }) {
  return <div data-slot="code-block" data-variant={variant} data-size={size} className={classes("ui-code-block", className)} {...props} />;
}

function CodeBlockHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="code-block-header" className={classes("ui-code-block-header", className)} {...props} />;
}

function CodeBlockTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="code-block-title" className={classes("ui-code-block-title", className)} {...props} />;
}

function CodeBlockActions({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="code-block-actions" className={classes("ui-code-block-actions", className)} {...props} />;
}

function CodeBlockCopyButton({ value, className, onClick, ...props }: React.ComponentProps<"button"> & { value: string }) {
  const [copied, setCopied] = React.useState(false);
  const [copyError, setCopyError] = React.useState(false);

  React.useEffect(() => {
    if (!copied && !copyError) return;
    const timeout = setTimeout(() => { setCopied(false); setCopyError(false); }, 2000);
    return () => clearTimeout(timeout);
  }, [copied, copyError]);

  return (
    <>
      <button
        type="button"
        data-slot="code-block-copy-button"
        data-copied={copied || undefined}
        aria-label={copied ? "已复制" : "复制代码"}
        title={copied ? "已复制" : "复制代码"}
        className={classes("ui-code-block-copy-button", className)}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented) return;
          navigator.clipboard.writeText(value).then(() => { setCopied(true); setCopyError(false); }).catch(() => setCopyError(true));
        }}
        {...props}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
      <span aria-live="polite" className="ui-trace-sr-only">{copyError ? "无法复制，请选择代码后复制" : copied ? "已复制" : ""}</span>
    </>
  );
}

function CodeBlockContent({
  className,
  children,
  style,
  wrap = false,
  lineNumbers = false,
  startLine = 1,
  ...props
}: React.ComponentProps<"pre"> & { wrap?: boolean; lineNumbers?: boolean; startLine?: number }) {
  return (
    <pre
      data-slot="code-block-content"
      data-wrap={wrap || undefined}
      data-numbered={lineNumbers || undefined}
      dir="ltr"
      tabIndex={0}
      style={{ counterReset: `line ${startLine - 1}`, ...style }}
      className={classes("ui-code-block-content", className)}
      {...props}
    >
      <code data-slot="code-block-code" className="ui-code-block-code">
        {lineNumbers && typeof children === "string"
          ? children.replace(/\n$/, "").split("\n").map((line, index) => <CodeBlockLine key={index}>{line}</CodeBlockLine>)
          : children}
      </code>
    </pre>
  );
}

function CodeBlockLine({
  className,
  children,
  variant = "default",
  ...props
}: React.ComponentProps<"span"> & { variant?: "default" | "added" | "removed" | "highlighted" }) {
  const empty = children === undefined || children === null || children === "" || (Array.isArray(children) && children.length === 0);
  return (
    <span data-slot="code-block-line" data-variant={variant} className={classes("ui-code-block-line", className)} {...props}>
      <span data-slot="code-block-line-content">{empty ? "\n" : children}</span>
    </span>
  );
}

function CodeBlockFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="code-block-footer" className={classes("ui-code-block-footer", className)} {...props} />;
}

export { CodeBlock, CodeBlockHeader, CodeBlockTitle, CodeBlockActions, CodeBlockCopyButton, CodeBlockContent, CodeBlockLine, CodeBlockFooter };

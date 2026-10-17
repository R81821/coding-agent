import React, { Children, isValidElement, memo, useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { Streamdown, defaultRehypePlugins, parseMarkdownIntoBlocks, useIsCodeFenceIncomplete, type Components, type StreamdownProps } from "streamdown";
import { createCodePlugin, type HighlightOptions, type HighlightResult } from "@streamdown/code";
import { cjk } from "@streamdown/cjk";
import { Check, Copy, FileText } from "lucide-react";
import { messageHttpUrl } from "./message-links.js";
import "./markdown-message.css";

const highlighter = createCodePlugin({ themes: ["github-light", "github-dark"] });
const plugins = { code: highlighter, cjk };
// Keep raw HTML as raw nodes so skipHtml can discard it before rendering.
// Streamdown's default rehype-raw would otherwise turn it into live elements.
// URL handling stays at the desktop boundary; avoid rewriting reply text with
// the default hardener's "[blocked]" annotations.
const rehypePlugins: NonNullable<StreamdownProps["rehypePlugins"]> = [defaultRehypePlugins.sanitize!];
const remend: StreamdownProps["remend"] = { linkMode: "text-only" };
const messageUrl: NonNullable<StreamdownProps["urlTransform"]> = (url) => url.startsWith("#") ? url : messageHttpUrl(url);
// Reference definitions must share a parse tree with their earlier links/footnotes.
const parseMessageBlocks = (text: string): string[] => /^ {0,3}\[[^\]\n]+\]:/m.test(text) ? [text] : parseMarkdownIntoBlocks(text);

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<string>();
  const [failed, setFailed] = useState(false);
  const done = copied === text;
  useEffect(() => {
    if (!copied && !failed) return;
    const timeout = setTimeout(() => { setCopied(undefined); setFailed(false); }, 2000);
    return () => clearTimeout(timeout);
  }, [copied, failed]);
  return <button type="button" className="md-action" aria-label={label} onClick={async () => {
    try { await navigator.clipboard.writeText(text); setCopied(text); setFailed(false); }
    catch { setFailed(true); }
  }}>{done ? <Check size={13} /> : <Copy size={13} />}<span role="status">{failed ? "复制失败，请重试" : done ? "已复制" : label}</span></button>;
}

const CodeBlock = memo(function CodeBlock({ code, language }: { code: string; language: string }) {
  const isIncomplete = useIsCodeFenceIncomplete();
  const [highlighted, setHighlighted] = useState<{ code: string; language: string; result: HighlightResult }>();
  useEffect(() => {
    if (!language || code.length > 50000) return;
    const supportedLanguage = language.toLowerCase() as HighlightOptions["language"];
    if (!highlighter.supportsLanguage(supportedLanguage)) return;
    let cancelled = false;
    const update = (result: HighlightResult) => {
      if (!cancelled) setHighlighted({ code, language, result });
    };
    const cached = highlighter.highlight({ code, language: supportedLanguage, themes: highlighter.getThemes(), isIncomplete }, update);
    if (cached) update(cached);
    return () => { cancelled = true; };
  }, [code, language, isIncomplete]);
  const result = highlighted?.code === code && highlighted.language === language ? highlighted.result : undefined;
  return <div className="md-code-block">
    <div className="md-code-toolbar"><span>{language || "text"}</span><CopyButton text={code} label="复制代码" /></div>
    <pre tabIndex={0} aria-label={`${language || "文本"}代码块`}><code>{result ? result.tokens.map((line, index) => <React.Fragment key={index}>
      {index > 0 && "\n"}{line.map((token, tokenIndex) => <span key={tokenIndex} className="md-code-token" style={{
        "--md-token-light": token.htmlStyle?.color ?? token.color ?? "inherit",
        "--md-token-dark": token.htmlStyle?.["--shiki-dark"] ?? token.color ?? "inherit",
      } as CSSProperties}>{token.content}</span>)}
    </React.Fragment>) : code}</code></pre>
  </div>;
});

type MessageLinkProps = Pick<React.ComponentProps<"a">, "href" | "id" | "aria-label" | "aria-describedby"> & { children: ReactNode };
function MessageLink({ href, children, ...attributes }: MessageLinkProps) {
  const [failed, setFailed] = useState(false);
  if (href?.startsWith("#")) return <a {...attributes} href={href}>{children}</a>;
  const url = messageHttpUrl(href);
  if (!url) return <span>{children}</span>;
  return <><a {...attributes} href={url} title={url} onClick={async (event) => {
    event.preventDefault();
    try { await window.harness.openExternal(url); setFailed(false); }
    catch { setFailed(true); }
  }}>{children}</a>{failed && <small role="status" className="md-link-error">链接打开失败</small>}</>;
}

const components: Components = {
  strong: ({ children }) => <strong>{children}</strong>,
  li: ({ children, className, id, value }) => <li className={className} id={id} value={value}>{children}</li>,
  code: ({ children, className }) => <code className={className}>{children}</code>,
  inlineCode: ({ children }) => <code>{children}</code>,
  pre({ children }) {
    const child = Children.toArray(children)[0];
    if (!isValidElement<{ children?: ReactNode; className?: string }>(child)) return <pre>{children}</pre>;
    const code = String(child.props.children ?? "").replace(/\n$/, "");
    const language = /(?:^|\s)language-([^\s]+)/.exec(child.props.className ?? "")?.[1] ?? "";
    return <CodeBlock code={code} language={language} />;
  },
  table: ({ children }) => <div className="md-table-scroll" tabIndex={0} role="region" aria-label="表格"><table>{children}</table></div>,
  a: ({ href, children, id, "aria-label": label, "aria-describedby": describedBy }) => <MessageLink href={href} id={id} aria-label={label} aria-describedby={describedBy}>{children}</MessageLink>,
  img: ({ src, alt }) => <span className="md-image-link"><MessageLink href={typeof src === "string" ? src : undefined}>图片：{alt || "打开图片"}</MessageLink></span>,
};
export const MarkdownMessage = memo(function MarkdownMessage({ text, compact = false, isStreaming = false }: { text: string; compact?: boolean; isStreaming?: boolean }) {
  const [source, setSource] = useState(false);
  const anchorPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return <div className={`markdown-message${compact ? " md-compact" : ""}`} data-streaming={isStreaming || undefined}>
    {source ? <pre className="md-source">{text}</pre> : <Streamdown
      className="md-content"
      mode={isStreaming ? "streaming" : "static"}
      parseMarkdownIntoBlocksFn={parseMessageBlocks}
      parseIncompleteMarkdown={isStreaming}
      normalizeHtmlIndentation={false}
      isAnimating={isStreaming}
      animated={false}
      plugins={plugins}
      components={components}
      rehypePlugins={rehypePlugins}
      remarkRehypeOptions={{ clobberPrefix: `${anchorPrefix}-` }}
      urlTransform={messageUrl}
      remend={remend}
      controls={false}
      skipHtml
    >{text}</Streamdown>}
    {!compact && <div className="md-message-actions">
      <CopyButton text={text} label="复制 Markdown" />
      <button type="button" className="md-action" aria-pressed={source} onClick={() => setSource((value) => !value)}><FileText size={13} />{source ? "查看渲染" : "查看原文"}</button>
    </div>}
  </div>;
});

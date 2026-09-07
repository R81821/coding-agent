import React, { Children, isValidElement, memo, useId, useMemo, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { common, createLowlight } from "lowlight";
import { Check, Code2, Copy, FileText } from "lucide-react";
import { messageHttpUrl } from "./message-links.js";
import "./markdown-message.css";

const highlighter = createLowlight(common);
type HighlightNode = ReturnType<typeof highlighter.highlight>["children"][number];
function renderHighlight(node: HighlightNode, key: number): ReactNode {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return null;
  const classes = node.properties.className;
  return <span key={key} className={Array.isArray(classes) ? classes.join(" ") : ""}>{node.children.map(renderHighlight)}</span>;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<string>();
  const [failed, setFailed] = useState(false);
  const done = copied === text;
  return <button type="button" className="md-action" aria-label={label} onClick={async () => {
    try { await navigator.clipboard.writeText(text); setCopied(text); setFailed(false); }
    catch { setFailed(true); }
  }}>{done ? <Check size={13} /> : <Copy size={13} />}<span role="status">{failed ? "复制失败，请重试" : done ? "已复制" : label}</span></button>;
}

const CodeBlock = memo(function CodeBlock({ code, language }: { code: string; language: string }) {
  const highlighted = useMemo(() => {
    if (!language || code.length > 50000 || !highlighter.registered(language)) return code;
    try { return highlighter.highlight(language, code).children.map(renderHighlight); }
    catch { return code; }
  }, [code, language]);
  return <div className="md-code-block">
    <div className="md-code-toolbar"><span><Code2 size={14} />{language || "text"}</span><CopyButton text={code} label="复制代码" /></div>
    <pre tabIndex={0} aria-label={`${language || "文本"}代码块`}><code>{highlighted}</code></pre>
  </div>;
});

function MessageLink({ href, children }: { href?: string | undefined; children: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (href?.startsWith("#")) return <a href={href}>{children}</a>;
  const url = messageHttpUrl(href);
  if (!url) return <span>{children}</span>;
  return <><a href={url} title={url} onClick={async (event) => {
    event.preventDefault();
    try { await window.harness.openExternal(url); setFailed(false); }
    catch { setFailed(true); }
  }}>{children}</a>{failed && <small role="status" className="md-link-error">链接打开失败</small>}</>;
}

const components: Components = {
  pre({ children }) {
    const child = Children.toArray(children)[0];
    if (!isValidElement<{ children?: ReactNode; className?: string }>(child)) return <pre>{children}</pre>;
    const code = String(child.props.children ?? "").replace(/\n$/, "");
    const language = /(?:^|\s)language-([^\s]+)/.exec(child.props.className ?? "")?.[1] ?? "";
    return <CodeBlock code={code} language={language} />;
  },
  table: ({ children }) => <div className="md-table-scroll" tabIndex={0} role="region" aria-label="表格"><table>{children}</table></div>,
  a: ({ href, children }) => <MessageLink href={href}>{children}</MessageLink>,
  img: ({ src, alt }) => <span className="md-image-link"><MessageLink href={typeof src === "string" ? src : undefined}>图片：{alt || "打开图片"}</MessageLink></span>,
};
export const MarkdownMessage = memo(function MarkdownMessage({ text, compact = false }: { text: string; compact?: boolean }) {
  const [source, setSource] = useState(false);
  const anchorPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return <div className={`markdown-message${compact ? " md-compact" : ""}`}>
    {source ? <pre className="md-source">{text}</pre> : <div className="md-content"><Markdown remarkPlugins={[remarkGfm]} remarkRehypeOptions={{ clobberPrefix: `${anchorPrefix}-` }} components={components} skipHtml>{text}</Markdown></div>}
    {!compact && <div className="md-message-actions">
      <CopyButton text={text} label="复制 Markdown" />
      <button type="button" className="md-action" aria-pressed={source} onClick={() => setSource((value) => !value)}><FileText size={13} />{source ? "查看渲染" : "查看原文"}</button>
    </div>}
  </div>;
});
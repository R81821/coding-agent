import React, { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, FileText, RefreshCw, X } from "lucide-react";
import type { DaemonRequestInput } from "@harness/protocol";
import { BuiButton } from "../ui/button.js";
import { mcpContentText, mcpPromptDraft, mcpResourceDraft, mcpTemplateUri, mcpTemplateVariables, type McpPromptResult, type McpResourceResult } from "./mcp-content.js";

export type McpUiRequest = <T>(request: DaemonRequestInput) => Promise<T>;
interface Resource { uri: string; name: string; title?: string; description?: string; mimeType?: string }
interface ResourceTemplate { uriTemplate: string; name: string; title?: string; description?: string }
interface Prompt { name: string; title?: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }
interface Completion { completion: { values: string[]; total?: number; hasMore?: boolean } }
export interface McpCatalogProps { serverId: string; serverName: string; workspacePath: string; request: McpUiRequest; initialTab?: "resources" | "prompts"; onClose: () => void; onApplyPrompt?: ((text: string) => void) | undefined; onAttachResource?: ((text: string) => void) | undefined }

export function McpCatalog({ serverId, serverName, workspacePath, request, initialTab = "resources", onClose, onApplyPrompt, onAttachResource }: McpCatalogProps) {
  const [tab, setTab] = useState(initialTab);
  const [resources, setResources] = useState<Resource[]>([]);
  const [templates, setTemplates] = useState<ResourceTemplate[]>([]);
  const [template, setTemplate] = useState<ResourceTemplate>();
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({});
  const [templateSuggestions, setTemplateSuggestions] = useState<Record<string, string[]>>({});
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [query, setQuery] = useState("");
  const [uri, setUri] = useState("");
  const [resourceResult, setResourceResult] = useState<McpResourceResult>();
  const [prompt, setPrompt] = useState<Prompt>();
  const [argumentsValue, setArgumentsValue] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({});
  const [promptResult, setPromptResult] = useState<McpPromptResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [subscribed, setSubscribed] = useState<string>();
  const generation = useRef(0);
  const subscription = useRef<string | undefined>(undefined);
  const params = { serverId, workspacePath };
  const perform = useCallback(async (work: () => Promise<void>) => {
    const current = generation.current;
    setBusy(true); setError(""); setNotice("");
    try { await work(); }
    catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (current === generation.current) setBusy(false); }
  }, []);
  const refresh = useCallback(async () => {
    const current = generation.current;
    if (tab === "resources") {
      const result = await request<{ resources: Resource[]; resourceTemplates: ResourceTemplate[] }>({ method: "mcp.resources", params: { serverId, workspacePath } });
      if (current === generation.current) { setResources(result.resources); setTemplates(result.resourceTemplates); }
    } else {
      const result = await request<{ prompts: Prompt[] }>({ method: "mcp.prompts", params: { serverId, workspacePath } });
      if (current === generation.current) setPrompts(result.prompts);
    }
  }, [request, serverId, workspacePath, tab]);
  useEffect(() => {
    generation.current++; setError(""); setNotice(""); setQuery("");
    void perform(refresh);
    return () => { generation.current++; };
  }, [refresh, perform]);
  useEffect(() => {
    setResources([]); setTemplates([]); setPrompts([]); setUri(""); setResourceResult(undefined);
    setTemplate(undefined); setTemplateValues({}); setTemplateSuggestions({});
    setPrompt(undefined); setArgumentsValue({}); setSuggestions({}); setPromptResult(undefined); setSubscribed(undefined);
  }, [serverId, workspacePath]);
  useEffect(() => () => {
    if (subscription.current) void request({ method: "mcp.resource.unsubscribe", params: { serverId, workspacePath, uri: subscription.current } }).catch(() => {});
    subscription.current = undefined;
  }, [request, serverId, workspacePath]);
  async function readResource(target: string, current = generation.current) {
    if (current !== generation.current) return;
    const result = await request<McpResourceResult>({ method: "mcp.resource.read", params: { ...params, uri: target } });
    if (current === generation.current) { setUri(target); setResourceResult(result); }
  }
  useEffect(() => {
    if (!subscribed || uri !== subscribed) return;
    let disposed = false; let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void request<{ uris: string[]; catalogRevision: number }>({ method: "mcp.resource.updates", params: { serverId, workspacePath } }).then(async result => {
        if (disposed || !result.uris.includes(subscribed)) return;
        const content = await request<McpResourceResult>({ method: "mcp.resource.read", params: { serverId, workspacePath, uri: subscribed } });
        if (!disposed) { setResourceResult(content); setNotice("订阅资源已更新"); }
      }).catch(error => { if (!disposed) setError(error instanceof Error ? error.message : String(error)); }).finally(() => { polling = false; });
    }, 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [subscribed, uri, request, serverId, workspacePath]);
  async function changeSubscription() {
    const current = generation.current;
    if (subscription.current) {
      const previous = subscription.current;
      await request({ method: "mcp.resource.unsubscribe", params: { ...params, uri: previous } });
      if (current !== generation.current) return;
      subscription.current = undefined; setSubscribed(undefined);
    }
    else if (uri) {
      const target = uri;
      await request({ method: "mcp.resource.subscribe", params: { ...params, uri: target } });
      if (current !== generation.current) { await request({ method: "mcp.resource.unsubscribe", params: { ...params, uri: target } }); return; }
      subscription.current = target; setSubscribed(target); setNotice("等待服务推送资源更新");
    }
  }
  async function selectResource(target: string, clearTemplate = false) {
    const current = generation.current;
    if (subscription.current && subscription.current !== target) {
      const previous = subscription.current;
      await request({ method: "mcp.resource.unsubscribe", params: { ...params, uri: previous } });
      if (current !== generation.current) return;
      subscription.current = undefined; setSubscribed(undefined);
    }
    if (current !== generation.current) return;
    if (clearTemplate) setTemplate(undefined);
    setResourceResult(undefined); await readResource(target, current);
  }
  function setTemplateValue(name: string, value: string) {
    const next = { ...templateValues, [name]: value };
    setTemplateValues(next); setResourceResult(undefined);
    if (template) setUri(mcpTemplateUri(template.uriTemplate, next));
  }
  const matches = (value: string) => value.toLowerCase().includes(query.toLowerCase());
  return <section className="mcp-catalog mcp-content-catalog" aria-label="MCP 资源与提示词目录">
    <div className="mcp-card-title"><h3>{serverName} · {tab === "resources" ? "资源目录" : "提示词目录"}</h3><div className="mcp-actions"><BuiButton size="sm" disabled={busy} aria-label="刷新目录" onClick={() => void perform(refresh)}><RefreshCw size={15} /></BuiButton><BuiButton size="sm" aria-label="关闭目录" onClick={onClose}><X size={15} /></BuiButton></div></div>
    <div className="mcp-catalog-tabs" role="tablist" aria-label="MCP 内容类型"><button role="tab" disabled={busy} aria-selected={tab === "resources"} onClick={() => setTab("resources")}><FileText size={15} />资源与模板</button><button role="tab" disabled={busy} aria-selected={tab === "prompts"} onClick={() => setTab("prompts")}><BookOpen size={15} />提示词</button></div>
    <div aria-live="polite">{error && <p className="mcp-error" role="alert">{error}</p>}{notice && <p className="mcp-notice">{notice}</p>}{busy && <p className="mcp-muted">正在读取…</p>}</div>
    <input aria-label={tab === "resources" ? "搜索资源" : "搜索提示词"} placeholder="搜索名称或说明" value={query} onChange={event => setQuery(event.target.value)} />
    {tab === "resources" ? <>
      <div className="mcp-content-list">{resources.filter(resource => matches(`${resource.name} ${resource.uri} ${resource.description ?? ""}`)).map(resource => <button className="mcp-content-item" key={resource.uri} disabled={busy} onClick={() => void perform(() => selectResource(resource.uri, true))}><strong>{resource.title ?? resource.name}</strong><span>{resource.description ?? resource.uri}</span><small>{resource.mimeType ?? "资源"}</small></button>)}</div>
      {resources.length === 0 && !busy && <p className="mcp-muted">服务未提供静态资源。</p>}
      {templates.length > 0 && <div className="mcp-template-list"><h4>资源模板</h4>{templates.filter(item => matches(`${item.name} ${item.uriTemplate} ${item.description ?? ""}`)).map(item => <button className="mcp-content-item" key={item.uriTemplate} disabled={busy} onClick={() => void perform(async () => {
        const current = generation.current;
        if (subscription.current) {
          const previous = subscription.current;
          await request({ method: "mcp.resource.unsubscribe", params: { ...params, uri: previous } });
          if (current !== generation.current) return;
          subscription.current = undefined; setSubscribed(undefined);
        }
        if (current !== generation.current) return;
        setTemplate(item); setTemplateValues({}); setTemplateSuggestions({}); setUri(item.uriTemplate); setResourceResult(undefined);
      })}><strong>{item.title ?? item.name}</strong><span>{item.description ?? item.uriTemplate}</span><code>{item.uriTemplate}</code></button>)}</div>}
      {template && <div className="mcp-template-form"><h4>{template.title ?? template.name}</h4>{mcpTemplateVariables(template.uriTemplate).map(name => <div className="mcp-prompt-argument" key={name}><label>{name}<input aria-label={`资源模板参数 ${name}`} disabled={busy} value={templateValues[name] ?? ""} onChange={event => setTemplateValue(name, event.target.value)} /></label><BuiButton size="sm" disabled={busy} onClick={() => {
        const current = generation.current;
        void perform(async () => { const result = await request<Completion>({ method: "mcp.completion", params: { ...params, ref: { type: "ref/resource", uri: template.uriTemplate }, argument: { name, value: templateValues[name] ?? "" }, context: { arguments: templateValues } } }); if (current === generation.current) { setTemplateSuggestions(values => ({ ...values, [name]: result.completion.values })); if (!result.completion.values.length) setNotice("没有可用的补全建议"); } });
      }}>补全</BuiButton>{templateSuggestions[name]?.length ? <div className="mcp-completion-options">{templateSuggestions[name]?.map(value => <button type="button" key={value} disabled={busy} onClick={() => setTemplateValue(name, value)}>{value}</button>)}</div> : null}</div>)}</div>}
      <form className="mcp-resource-uri" onSubmit={event => { event.preventDefault(); void perform(() => selectResource(uri)); }}><label>资源 URI<input aria-label="资源 URI" disabled={busy} placeholder="填写完整 URI；模板中的变量请替换为实际值" value={uri} onChange={event => { setUri(event.target.value); setTemplate(undefined); setResourceResult(undefined); }} /></label><BuiButton type="submit" disabled={busy || !uri.trim() || /\{[^}]*\}/.test(uri)}>读取</BuiButton></form>
      {resourceResult && <div className="mcp-content-preview"><div className="mcp-actions"><BuiButton size="sm" disabled={busy} onClick={() => void perform(() => readResource(uri))}>刷新正文</BuiButton><BuiButton size="sm" disabled={busy} onClick={() => void perform(changeSubscription)}>{subscribed ? "取消订阅" : "订阅更新"}</BuiButton>{onAttachResource && <BuiButton size="sm" variant="primary" disabled={!mcpResourceDraft(resourceResult, serverName)} onClick={() => { onAttachResource(mcpResourceDraft(resourceResult, serverName)); setNotice("资源正文已加入会话草稿"); }}>加入会话草稿</BuiButton>}</div>{resourceResult.contents.map((content, index) => <div key={`${content.uri}-${index}`}><p className="mcp-content-source">{content.uri} {content.mimeType && `· ${content.mimeType}`}</p>{typeof content.text === "string" ? <pre>{content.text}</pre> : <p className="mcp-muted">二进制资源已读取（{content.mimeType ?? "未知类型"}），当前预览不显示二进制内容。</p>}</div>)}</div>}
    </> : <>
      <div className="mcp-content-list">{prompts.filter(item => matches(`${item.name} ${item.description ?? ""}`)).map(item => <button className="mcp-content-item" key={item.name} disabled={busy} onClick={() => { setPrompt(item); setArgumentsValue({}); setSuggestions({}); setPromptResult(undefined); setNotice(""); }}><strong>{item.title ?? item.name}</strong><span>{item.description ?? "暂无说明"}</span><small>{item.arguments?.length ?? 0} 个参数</small></button>)}</div>
      {prompts.length === 0 && !busy && <p className="mcp-muted">服务未提供提示词。</p>}
      {prompt && <form className="mcp-prompt-form" onSubmit={event => { event.preventDefault(); const selected = prompt; const current = generation.current; void perform(async () => { const result = await request<McpPromptResult>({ method: "mcp.prompt.get", params: { ...params, name: selected.name, arguments: Object.fromEntries(Object.entries(argumentsValue).filter(([, value]) => value.length > 0)) } }); if (current === generation.current) setPromptResult(result); }); }}><h4>{prompt.title ?? prompt.name}</h4>{prompt.arguments?.map(argument => <div className="mcp-prompt-argument" key={argument.name}><label>{argument.name}{argument.required ? " *" : "（可选）"}<input disabled={busy} required={argument.required} aria-label={`提示词参数 ${argument.name}`} list={`mcp-argument-${serverId}-${argument.name}`} value={argumentsValue[argument.name] ?? ""} onChange={event => { setArgumentsValue(values => ({ ...values, [argument.name]: event.target.value })); setPromptResult(undefined); }} />{argument.description && <small>{argument.description}</small>}</label><BuiButton type="button" size="sm" disabled={busy} onClick={() => { const current = generation.current; void perform(async () => { const result = await request<Completion>({ method: "mcp.completion", params: { ...params, ref: { type: "ref/prompt", name: prompt.name }, argument: { name: argument.name, value: argumentsValue[argument.name] ?? "" }, context: { arguments: argumentsValue } } }); if (current === generation.current) { setSuggestions(values => ({ ...values, [argument.name]: result.completion.values })); if (!result.completion.values.length) setNotice("没有可用的补全建议"); } }); }}>补全</BuiButton><datalist id={`mcp-argument-${serverId}-${argument.name}`}>{suggestions[argument.name]?.map(value => <option key={value} value={value} />)}</datalist>{suggestions[argument.name]?.length ? <div className="mcp-completion-options">{suggestions[argument.name]?.map(value => <button type="button" key={value} disabled={busy} onClick={() => { setArgumentsValue(values => ({ ...values, [argument.name]: value })); setPromptResult(undefined); }}>{value}</button>)}</div> : null}</div>)}<BuiButton type="submit" disabled={busy || prompt.arguments?.some(argument => argument.required && !argumentsValue[argument.name]?.trim())}>获取提示词预览</BuiButton></form>}
      {promptResult && prompt && <div className="mcp-content-preview">{promptResult.description && <p>{promptResult.description}</p>}{promptResult.messages.map((message, index) => <div key={index}><span className="mcp-message-role">{message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : message.role}</span><pre>{mcpContentText(message.content)}</pre></div>)}{onApplyPrompt && <BuiButton variant="primary" disabled={!promptResult.messages.length} onClick={() => { onApplyPrompt(mcpPromptDraft(promptResult, serverName, prompt.name)); setNotice("提示词已加入会话草稿"); }}>放入会话草稿</BuiButton>}<p className="mcp-muted">预览内容由服务提供，加入草稿后可编辑并手动发送。</p></div>}
    </>}
  </section>;
}

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, MessageSquare, Sparkles, X } from "lucide-react";
import type { DaemonRequestInput, McpInteractionView } from "@harness/protocol";
import { BuiButton } from "../ui/button.js";
import { mcpContentText, type McpContent } from "./mcp-content.js";
import { elicitationContent, elicitationDateTimeInput, elicitationDefaults, elicitationFields, type ElicitationField, type ElicitationValues } from "./mcp-elicitation.js";
import "./mcp.css";

type Request = <T>(request: DaemonRequestInput) => Promise<T>;
export type { McpInteractionView } from "@harness/protocol";
const requestDefault: Request = request => window.harness.request(request);

export function McpInteractions({ workspacePath, runId, request = requestDefault, initialRequests = [] }: { workspacePath: string; runId?: string | undefined; request?: Request; initialRequests?: McpInteractionView[] }) {
  const [requests, setRequests] = useState(initialRequests);
  const [pollError, setPollError] = useState("");
  const generation = useRef(0);
  const responseGeneration = generation.current;
  const refresh = useCallback(async () => {
    const current = generation.current;
    const result = await request<{ requests: McpInteractionView[] }>({ method: "mcp.interactions.list", params: { workspacePath, ...(runId ? { runId } : {}) } });
    if (current === generation.current) { setRequests(result.requests); setPollError(""); }
  }, [request, workspacePath, runId]);
  useEffect(() => {
    generation.current++; setRequests([]); setPollError("");
    if (!workspacePath) return;
    let polling = false;
    const poll = () => { if (polling) return; polling = true; const current = generation.current; void refresh().catch(error => { if (current === generation.current) setPollError(error instanceof Error ? error.message : String(error)); }).finally(() => { polling = false; }); };
    poll(); const timer = setInterval(poll, 1000);
    return () => { generation.current++; clearInterval(timer); };
  }, [workspacePath, refresh]);
  // The RPC already scopes requests to the canonical project, including junctions.
  const current = requests.find(item => !runId || !item.runId || item.runId === runId);
  if (!current) return null;
  return <div className="mcp-interactions"><McpInteractionCard key={current.id} interaction={current} request={request} onResponded={async () => { if (responseGeneration !== generation.current) return; setRequests(list => list.filter(item => item.id !== current.id)); await refresh(); }} pendingCount={requests.length} />{pollError && <p role="status" className="mcp-error">待确认请求刷新失败：{pollError}</p>}</div>;
}

export function McpInteractionCard({ interaction, request, onResponded, pendingCount = 1 }: { interaction: McpInteractionView; request: Request; onResponded: () => Promise<void> | void; pendingCount?: number }) {
  const { params } = interaction;
  const fields = elicitationFields(params.requestedSchema);
  const [values, setValues] = useState<ElicitationValues>(() => elicitationDefaults(fields ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [urlCompleted, setUrlCompleted] = useState(false);
  const isUrl = interaction.kind === "elicitation" && params.mode === "url";
  const validUrl = typeof params.url === "string" && /^https?:\/\//i.test(params.url);
  const setValue = (name: string, value: ElicitationValues[string]) => setValues(values => ({ ...values, [name]: value }));
  async function respond(action: "accept" | "decline" | "cancel") {
    setBusy(true); setError("");
    try {
      const content = action === "accept" && interaction.kind === "elicitation" && !isUrl ? elicitationContent(fields ?? [], values) : undefined;
      await request({ method: "mcp.interactions.respond", params: { requestId: interaction.id, workspacePath: interaction.workspacePath, action, ...(content ? { content } : {}) } });
      await onResponded();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const messages = Array.isArray(params.messages) ? params.messages as Array<{ role?: string; content?: McpContent | McpContent[] }> : [];
  return <section className="mcp-interaction-card" role="dialog" aria-label={interaction.kind === "sampling" ? "MCP 模型采样请求" : "MCP 信息收集请求"}>
    <header className="mcp-card-title"><h3>{interaction.kind === "sampling" ? <Sparkles size={18} /> : <MessageSquare size={18} />}{interaction.kind === "sampling" ? "模型采样请求" : "服务请求信息"}</h3><BuiButton aria-label="取消 MCP 请求" size="sm" disabled={busy} onClick={() => void respond("cancel")}><X size={16} /></BuiButton></header>
    <p className="mcp-interaction-source">{interaction.serverName}{pendingCount > 1 ? ` · ${pendingCount} 个请求待处理` : ""}</p>
    <div className="mcp-interaction-body">
      {interaction.kind === "sampling" ? <><p>服务希望调用当前模型生成内容。批准后才会发起调用。</p><p className="mcp-muted">仅使用服务提供的消息，不包含其他会话历史。</p><div className="mcp-sampling-meta"><span>使用模型：{interaction.modelName ?? "当前项目配置的模型"}</span>{typeof params.maxTokens === "number" && <span>最多输出 {params.maxTokens.toLocaleString()} tokens</span>}</div>{typeof params.systemPrompt === "string" && <details open><summary>服务提供的提示词（作为外部内容处理）</summary><pre>{params.systemPrompt}</pre></details>}{messages.map((message, index) => <div className="mcp-sampling-message" key={index}><span className="mcp-message-role">{message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : message.role ?? "消息"}</span><pre>{(Array.isArray(message.content) ? message.content : message.content ? [message.content] : []).map(mcpContentText).join("\n\n")}</pre></div>)}</> : <>
        {typeof params.message === "string" && <p className="mcp-elicitation-message">{params.message}</p>}
        {isUrl ? <><p className="mcp-muted">此请求需要在服务的网页完成操作。</p><p className="mcp-external-url">{typeof params.url === "string" ? params.url : "服务未提供有效地址"}</p><BuiButton disabled={busy || !validUrl} onClick={() => { setError(""); void window.harness.openExternal(params.url as string).catch(error => setError(error instanceof Error ? error.message : String(error))); }}><ExternalLink size={15} />打开服务网页</BuiButton><label className="mcp-check"><input type="checkbox" checked={urlCompleted} onChange={event => setUrlCompleted(event.target.checked)} />我已在网页完成操作</label></> : fields ? <form id={`mcp-interaction-${interaction.id}`} className="mcp-elicitation-form" onSubmit={event => { event.preventDefault(); void respond("accept"); }}>{fields.map(field => <ElicitationInput key={field.name} field={field} value={values[field.name]} disabled={busy} onChange={value => setValue(field.name, value)} />)}</form> : <p role="alert" className="mcp-error">服务请求的表单类型暂不支持，请拒绝或取消此请求。</p>}
      </>}
    </div>
    {error && <p className="mcp-error" role="alert">{error}</p>}
    <footer className="mcp-actions"><BuiButton disabled={busy} onClick={() => void respond("cancel")}>取消</BuiButton><BuiButton disabled={busy} onClick={() => void respond("decline")}>拒绝</BuiButton>{interaction.kind === "sampling" || isUrl ? <BuiButton variant="primary" disabled={busy || isUrl && (!validUrl || !urlCompleted)} onClick={() => void respond("accept")}>{busy ? "处理中…" : interaction.kind === "sampling" ? "批准采样" : "确认完成"}</BuiButton> : <BuiButton variant="primary" type="submit" form={`mcp-interaction-${interaction.id}`} disabled={busy || !fields}>{busy ? "处理中…" : "提交信息"}</BuiButton>}</footer>
  </section>;
}

function ElicitationInput({ field, value, disabled, onChange }: { field: ElicitationField; value: ElicitationValues[string] | undefined; disabled: boolean; onChange: (value: ElicitationValues[string]) => void }) {
  const label = `${field.title ?? field.name}${field.required ? " *" : "（可选）"}`;
  const description = field.description ? <small>{field.description}</small> : null;
  if (field.type === "array") return <fieldset disabled={disabled} className="mcp-multiselect"><legend>{label}</legend>{description}{field.enum?.map((option, index) => <label className="mcp-check" key={option}><input type="checkbox" checked={Array.isArray(value) && value.includes(option)} onChange={event => { const selected = Array.isArray(value) ? value : []; onChange(event.target.checked ? [...selected, option] : selected.filter(item => item !== option)); }} />{field.enumNames?.[index] ?? option}</label>)}</fieldset>;
  if (field.type === "boolean") return <label>{label}<select disabled={disabled} required={field.required} aria-label={label} value={typeof value === "boolean" ? String(value) : ""} onChange={event => onChange(event.target.value === "" ? "" : event.target.value === "true")}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>{description}</label>;
  if (field.enum) return <label>{label}<select disabled={disabled} required={field.required} aria-label={label} value={typeof value === "string" ? value : ""} onChange={event => onChange(event.target.value)}><option value="">请选择</option>{field.enum.map((option, index) => <option key={option} value={option}>{field.enumNames?.[index] ?? option}</option>)}</select>{description}</label>;
  const numeric = field.type === "number" || field.type === "integer";
  const type = numeric ? "number" : field.format === "email" ? "email" : field.format === "date" ? "date" : field.format === "date-time" ? "datetime-local" : field.format === "uri" ? "url" : "text";
  return <label>{label}<input disabled={disabled} required={field.required} aria-label={label} type={type} step={numeric ? field.type === "integer" ? 1 : "any" : type === "datetime-local" ? "any" : undefined} min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength} value={type === "datetime-local" ? elicitationDateTimeInput(value) : typeof value === "string" || typeof value === "number" ? value : ""} onChange={event => onChange(event.target.value)} />{description}</label>;
}

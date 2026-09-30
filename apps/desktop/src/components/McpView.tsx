import React, { useCallback, useEffect, useRef, useState } from "react";
import { Plug, Plus, RefreshCw, Upload, Search, X } from "lucide-react";
import { McpServerInputSchema, type DaemonRequestInput, type McpManagementSnapshot, type McpServerInput, type McpServerView } from "@harness/protocol";
import { BuiButton } from "../ui/button.js";
import { buildMcpDraft, mcpForm, type McpForm, type SecretEdit } from "./mcp-form.js";
import "./mcp.css";

type Request = <T>(request: DaemonRequestInput) => Promise<T>;
interface CatalogTool { name: string; description?: string; inputSchema: Record<string, unknown> }
const empty: McpManagementSnapshot = { servers: [], statuses: [], auth: {} };
const stateLabels = { disabled: "已停用", disconnected: "未连接", connecting: "连接中", connected: "已连接", auth_required: "需要登录", error: "连接失败" };
const requestDefault: Request = request => window.harness.request(request);

export function McpView({ workspacePath, request = requestDefault, initialSnapshot = empty }: { workspacePath: string; request?: Request; initialSnapshot?: McpManagementSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [form, setForm] = useState<McpForm>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<{ id: string; tools: CatalogTool[] }>();
  const [toolQuery, setToolQuery] = useState("");
  const [importText, setImportText] = useState<string>();
  const [preview, setPreview] = useState<McpServerInput[]>([]);
  const [removeId, setRemoveId] = useState<string>();
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = generation.current;
    const result = await request<McpManagementSnapshot>({ method: "mcp.list", params: workspacePath ? { workspacePath } : {} });
    if (current === generation.current) setSnapshot(result);
  }, [request, workspacePath]);
  useEffect(() => {
    generation.current++; setCatalog(undefined); setForm(undefined); setError(""); setNotice(""); setBusy(false);
    const current = generation.current;
    void refresh().catch(error => { if (generation.current === current) setError(String(error)); });
    return () => { generation.current++; };
  }, [refresh]);
  const pendingAuth = Object.values(snapshot.auth).some(auth => auth.state === "pending");
  useEffect(() => {
    if (!pendingAuth) return;
    const timer = setInterval(() => { void refresh().catch(() => {}); }, 2000);
    return () => clearInterval(timer);
  }, [pendingAuth, refresh]);
  async function act(work: () => Promise<void | string>, message: string) {
    const current = generation.current;
    setBusy(true); setError(""); setNotice("");
    try { const result = await work(); if (current === generation.current) { setNotice(result ?? message); await refresh(); } }
    catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  const update = <K extends keyof McpForm>(key: K, value: McpForm[K]) => setForm(form => form ? { ...form, [key]: value } : form);
  async function saveServer(server: McpServerView, changes: Partial<McpServerInput>) {
    await request({ method: "mcp.save", params: McpServerInputSchema.parse({ ...server, ...changes, expectedRevision: server.revision }) });
    setCatalog(undefined);
  }
  const servers = snapshot.servers.filter(server => `${server.name} ${server.transport.type}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="mcp-view" aria-label="MCP 服务管理">
    <header className="mcp-heading"><div><h2><Plug size={20} /> MCP 服务</h2><p>连接外部工具，为项目配置可用的服务。</p></div><div className="mcp-actions">
      <BuiButton disabled={busy} aria-label="刷新 MCP 状态" onClick={() => void act(refresh, "状态已刷新")}><RefreshCw size={15} /></BuiButton>
      <BuiButton disabled={busy || !workspacePath} onClick={() => { setImportText(""); setPreview([]); }}><Upload size={15} />导入 JSON</BuiButton>
      <BuiButton variant="primary" disabled={busy} onClick={() => setForm(mcpForm(undefined, workspacePath))}><Plus size={15} />新增服务</BuiButton>
    </div></header>
    <div className="mcp-project">{workspacePath ? <>当前项目 <strong title={workspacePath}>{workspacePath}</strong></> : "选择项目后，可以绑定服务、测试连接和查看工具。"}</div>
    <div aria-live="polite">{error && <p role="alert" className="mcp-error">{error}</p>}{notice && <p className="mcp-notice">{notice}</p>}{busy && <p className="mcp-muted">正在处理…</p>}</div>
    <label className="mcp-search"><Search size={15} /><input aria-label="搜索 MCP 服务" placeholder="搜索服务" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {servers.length === 0 && <div className="mcp-empty"><Plug size={30} /><h3>{query ? "没有匹配的服务" : "添加第一个 MCP 服务"}</h3><p>支持本地 stdio、远程 Streamable HTTP 和 SSE。</p></div>}
    <div className="mcp-grid">{servers.map(server => {
      const status = snapshot.statuses.find(status => status.serverId === server.id);
      const state = status?.state ?? (server.enabled ? "disconnected" : "disabled");
      const bound = !!status;
      const auth = snapshot.auth[server.id];
      return <article className="mcp-card" key={server.id}>
        <div className="mcp-card-title"><h3>{server.name}</h3><span className={`mcp-state mcp-state-${state}`}>{stateLabels[state]}</span></div>
        <p className="mcp-endpoint" title={server.transport.type === "stdio" ? server.transport.command : server.transport.url}>{server.transport.type === "stdio" ? server.transport.command : server.transport.url}</p>
        <div className="mcp-meta"><span>{server.transport.type === "stdio" ? "本地 · stdio" : server.transport.type === "sse" ? "远程 · SSE" : "远程 · HTTP"}</span><span>{bound ? "已绑定当前项目" : `绑定 ${server.projectPaths.length} 个项目`}</span><span>{status?.toolCount ?? 0} 个工具</span></div>
        {status?.error && <p className="mcp-error">{status.error}</p>}{auth?.error && <p className="mcp-error">{auth.error}</p>}
        {server.transport.type !== "stdio" && <p className="mcp-muted">{auth?.state === "authorized" ? "OAuth 已登录" : auth?.state === "pending" ? "等待浏览器完成登录" : state === "connected" ? "当前连接无需 OAuth 登录" : server.headerKeys.length ? `已保存请求头：${server.headerKeys.join("、")}` : "未配置 OAuth 登录"}</p>}
        <div className="mcp-actions">
          <BuiButton size="sm" disabled={busy || !workspacePath || !bound || !server.enabled} onClick={() => void act(async () => { await request({ method: state === "connected" ? "mcp.disconnect" : "mcp.connect", params: { serverId: server.id, workspacePath } }); }, state === "connected" ? "连接已断开，在途调用已取消" : "连接成功")}>{state === "connected" ? "断开连接" : "测试连接"}</BuiButton>
          <BuiButton size="sm" disabled={busy || !workspacePath || !bound || !server.enabled} onClick={() => void act(async () => { const result = await request<{ tools: CatalogTool[] }>({ method: "mcp.tools", params: { serverId: server.id, workspacePath } }); setCatalog({ id: server.id, tools: result.tools }); setToolQuery(""); }, "工具目录已刷新")}>工具目录</BuiButton>
          <BuiButton size="sm" disabled={busy} onClick={() => setForm(mcpForm(server, workspacePath))}>编辑</BuiButton>
          <BuiButton size="sm" disabled={busy} onClick={() => void act(() => saveServer(server, { enabled: !server.enabled }), server.enabled ? "服务已停用，在途调用已取消" : "服务已启用")}>{server.enabled ? "停用" : "启用"}</BuiButton>
          {!bound && workspacePath && <BuiButton size="sm" disabled={busy} onClick={() => void act(() => saveServer(server, { projectPaths: [...server.projectPaths, workspacePath] }), "已绑定当前项目")}>绑定当前项目</BuiButton>}
          {server.transport.type !== "stdio" && <BuiButton size="sm" disabled={busy || !workspacePath || !bound || !server.enabled} onClick={() => void act(async () => {
            if (auth?.state === "authorized" || auth?.state === "pending") { await request({ method: "mcp.auth.logout", params: { serverId: server.id } }); return; }
            const result = await request<{ state: "not_required" | "pending" | "authorized"; authorizationUrl?: string }>({ method: "mcp.auth.start", params: { serverId: server.id } });
            if (result.state === "not_required") return "此服务无需 OAuth 登录，已连接";
            if (result.state === "authorized") return "OAuth 已登录";
            if (!result.authorizationUrl) throw new Error("服务未返回 OAuth 授权地址");
            await window.harness.openExternal(result.authorizationUrl);
          }, auth?.state === "authorized" || auth?.state === "pending" ? "已退出登录" : "请在浏览器完成登录")}>{auth?.state === "authorized" ? "退出登录" : auth?.state === "pending" ? "取消登录" : "OAuth 登录"}</BuiButton>}
          <BuiButton size="sm" variant="ghost" disabled={busy} onClick={() => setRemoveId(server.id)}>删除</BuiButton>
        </div>
        {removeId === server.id && <div className="mcp-confirm"><p>删除「{server.name}」并取消所有项目的在途调用？</p><BuiButton variant="danger" size="sm" disabled={busy} onClick={() => void act(async () => { await request({ method: "mcp.remove", params: { serverId: server.id, expectedRevision: server.revision } }); setRemoveId(undefined); setCatalog(undefined); }, "服务已删除")}>确认删除</BuiButton><BuiButton size="sm" onClick={() => setRemoveId(undefined)}>取消</BuiButton></div>}
      </article>;
    })}</div>
    {catalog && <section className="mcp-catalog"><div className="mcp-card-title"><h3>{snapshot.servers.find(server => server.id === catalog.id)?.name} · 工具目录</h3><BuiButton size="sm" aria-label="关闭工具目录" onClick={() => setCatalog(undefined)}><X size={15} /></BuiButton></div><input aria-label="搜索工具" placeholder="搜索工具名称或说明" value={toolQuery} onChange={event => setToolQuery(event.target.value)} />
      {catalog.tools.length === 0 && <p>服务未提供工具。</p>}
      {catalog.tools.filter(tool => `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(toolQuery.toLowerCase())).map(tool => <details key={tool.name}><summary>{tool.name}</summary><p>{tool.description || "暂无说明"}</p><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>)}
    </section>}
    {form && <McpModal busy={busy} onClose={() => setForm(undefined)}><form className="mcp-dialog" aria-label={form.id ? "编辑 MCP 服务" : "新增 MCP 服务"} onSubmit={event => { event.preventDefault(); void act(async () => { await request({ method: "mcp.save", params: buildMcpDraft(form) }); setForm(undefined); setCatalog(undefined); }, "服务配置已保存"); }}>
      <div className="mcp-card-title"><h3>{form.id ? "编辑 MCP 服务" : "新增 MCP 服务"}</h3><BuiButton type="button" disabled={busy} aria-label="关闭服务编辑" onClick={() => setForm(undefined)}><X size={17} /></BuiButton></div>
      {error && <p role="alert" className="mcp-error">{error}</p>}
      <div className="mcp-form-grid"><label>服务名称<input autoFocus required value={form.name} onChange={event => update("name", event.target.value)} /></label><label>传输方式<select value={form.type} onChange={event => update("type", event.target.value as McpForm["type"])}><option value="stdio">本地 stdio</option><option value="streamable_http">Streamable HTTP</option><option value="sse">SSE（兼容）</option></select></label></div>
      {form.type === "stdio" ? <><label>启动命令<input required placeholder="node / uvx / npx" value={form.command} onChange={event => update("command", event.target.value)} /></label><label>参数（JSON 字符串数组）<textarea rows={3} value={form.args} onChange={event => update("args", event.target.value)} spellCheck={false} /></label><label>工作目录（留空使用项目目录）<input value={form.cwd} onChange={event => update("cwd", event.target.value)} /></label><SecretFields label="环境变量" rows={form.env} onChange={value => update("env", value)} /></> : <><label>服务地址<input required type="url" placeholder="https://example.com/mcp" value={form.url} onChange={event => update("url", event.target.value)} /></label><SecretFields label="请求头" rows={form.headers} onChange={value => update("headers", value)} /><p className="mcp-muted">Bearer token 可填写 Authorization 请求头，值为 Bearer 加空格和 token。OAuth 可在保存后登录。</p></>}
      <label>绑定项目（每行一个绝对路径）<textarea rows={2} value={form.projects} onChange={event => update("projects", event.target.value)} /></label>
      {workspacePath && <BuiButton type="button" size="sm" onClick={() => update("projects", [...new Set([...form.projects.split(/\r?\n/).filter(Boolean), workspacePath])].join("\n"))}>加入当前项目</BuiButton>}
      <details><summary>工具策略与超时</summary><label>只读工具名称（每行一个，需自行确认）<textarea rows={3} value={form.readOnlyTools} onChange={event => update("readOnlyTools", event.target.value)} /></label><p className="mcp-muted">此项用于风险分类，具体调用仍受项目和任务审批约束。</p><div className="mcp-form-grid"><label>连接超时（秒）<input type="number" min={0.1} max={120} step={0.1} value={form.connectSeconds} onChange={event => update("connectSeconds", Number(event.target.value))} /></label><label>调用超时（秒）<input type="number" min={0.1} max={3600} step={0.1} value={form.callSeconds} onChange={event => update("callSeconds", Number(event.target.value))} /></label></div></details>
      <label className="mcp-check"><input type="checkbox" checked={form.enabled} onChange={event => update("enabled", event.target.checked)} />启用此服务</label>
      <footer className="mcp-actions"><BuiButton type="button" disabled={busy} onClick={() => setForm(undefined)}>取消</BuiButton><BuiButton type="submit" variant="primary" disabled={busy}>保存配置</BuiButton></footer>
    </form></McpModal>}
    {importText !== undefined && <McpModal busy={busy} onClose={() => setImportText(undefined)}><section className="mcp-dialog" aria-label="导入 MCP 配置"><div className="mcp-card-title"><h3>导入 MCP 配置</h3><BuiButton disabled={busy} aria-label="关闭导入" onClick={() => setImportText(undefined)}><X size={17} /></BuiButton></div><p>粘贴包含 mcpServers 的 JSON。预览后保存，服务保持停用。</p>{error && <p role="alert" className="mcp-error">{error}</p>}<textarea aria-label="MCP JSON 配置" rows={10} spellCheck={false} value={importText} onChange={event => { setImportText(event.target.value); setPreview([]); }} />
      <BuiButton disabled={busy || !importText.trim()} onClick={() => void act(async () => { const result = await request<{ servers: McpServerInput[] }>({ method: "mcp.import", params: { source: importText, workspacePath } }); setPreview(result.servers); }, "已校验，尚未保存或执行")}>校验并预览</BuiButton>
      {preview.length > 0 && <><ul>{preview.map(server => <li key={server.name}><strong>{server.name}</strong> · {server.transport.type} · 停用<p className="mcp-import-target">{server.transport.type === "stdio" ? `${server.transport.command} ${JSON.stringify(server.transport.args ?? [])}` : server.transport.url}</p></li>)}</ul><BuiButton variant="primary" disabled={busy} onClick={() => void act(async () => { for (const server of preview) { await request({ method: "mcp.save", params: McpServerInputSchema.parse(server) }); setPreview(remaining => remaining.filter(item => item.name !== server.name)); } setImportText(undefined); }, "配置已导入，服务保持停用")}>保存 {preview.length} 个服务</BuiButton></>}
    </section></McpModal>}
  </section>;
}

function McpModal({ children, busy, onClose }: { children: React.ReactNode; busy: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="mcp-overlay" aria-label="MCP 配置" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>{children}</dialog>;
}
function SecretFields({ label, rows, onChange }: { label: string; rows: SecretEdit[]; onChange: (rows: SecretEdit[]) => void }) {
  const update = (index: number, change: Partial<SecretEdit>) => onChange(rows.map((row, i) => i === index ? { ...row, ...change } : row));
  return <fieldset className="mcp-secrets"><legend>{label}</legend>{rows.map((row, index) => <div className="mcp-secret-row" key={index}><input aria-label={`${label}名称 ${index + 1}`} value={row.key} disabled={row.persisted} onChange={event => update(index, { key: event.target.value })} placeholder="名称" /><select aria-label={`${label}操作 ${index + 1}`} value={row.mode} onChange={event => update(index, { mode: event.target.value as SecretEdit["mode"], value: "" })}>{row.persisted && <option value="keep">保留</option>}<option value="replace">替换</option>{row.persisted && <option value="clear">清除</option>}</select><input aria-label={`${label}值 ${index + 1}`} type="password" autoComplete="new-password" disabled={row.mode !== "replace"} placeholder={row.mode === "keep" ? "已保存，不回显" : row.mode === "clear" ? "保存时移除" : "输入新值"} value={row.value} onChange={event => update(index, { value: event.target.value })} />{!row.persisted && <button type="button" aria-label={`移除${label} ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}><X size={14} /></button>}</div>)}<BuiButton type="button" size="sm" onClick={() => onChange([...rows, { key: "", mode: "replace", value: "" }])}><Plus size={13} />添加{label}</BuiButton></fieldset>;
}

import { useEffect, useState } from "react";
import type { MemoryRecord, MemoryPatch, Profile, MemoryCreate, MemoryPublicationPreview } from "@harness/protocol";
import { BuiButton } from "./ui/button.js";
import { BuiBadge } from "./ui/badge.js";

const scopeLabels = { session: "会话", project: "项目", global: "全局" };
const statusLabels = { candidate: "待确认", approved: "已批准", rejected: "已忽略", expired: "已过期", superseded: "已被替换" };
const kindLabels = { preference: "个人偏好", convention: "项目规范", decision: "重要决策", fact: "项目事实", summary: "会话摘要" };
const fieldClass = "rounded-xl border border-line px-3 py-2 text-sm";

function localDateTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function MemoryManager({ memories, decide, refresh, workspace, profile }: {
  memories: MemoryRecord[];
  decide: (id: string, approved: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  workspace: string;
  profile?: Profile;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [status, setStatus] = useState("all");
  const [editing, setEditing] = useState<string>();
  const [content, setContent] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [draftScope, setDraftScope] = useState<"global" | "project">("global");
  const [draftScopeId, setDraftScopeId] = useState("");
  const [draftKind, setDraftKind] = useState<MemoryCreate["kind"]>("preference");
  const [draftKey, setDraftKey] = useState("");
  const [preview, setPreview] = useState<MemoryPublicationPreview>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  useEffect(() => { void refresh().catch(failure => setError(String(failure))); }, [refresh]);
  useEffect(() => { setPreview(undefined); setEditing(undefined); }, [workspace]);

  const effectiveStatus = (memory: MemoryRecord) => memory.expiresAt && Date.parse(memory.expiresAt) <= now ? "expired" : memory.status;
  const visible = memories.filter((memory) =>
    (scope === "all" || (scope === "current" ? memory.scope === "project" && memory.scopeId === workspace : memory.scope === scope)) &&
    (status === "all" || effectiveStatus(memory) === status) &&
    `${memory.content} ${memory.source} ${memory.scopeId}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  ).sort((a, b) => Number(b.pinned) - Number(a.pinned));

  async function perform(action: () => Promise<unknown>, message: string): Promise<boolean> {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await refresh(); setNow(Date.now()); setNotice(message); return true; }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return false; }
    finally { setBusy(false); }
  }
  const update = (memoryId: string, patch: MemoryPatch) => window.harness.request({ method: "memory.update", params: { memoryId, patch, actor: "desktop:user" } });
  const publishable = memories.filter(item => item.scope === "project" && item.scopeId === workspace && effectiveStatus(item) === "approved" && ["convention", "decision", "fact"].includes(item.kind ?? ""));
  function edit(memory?: MemoryRecord) {
    setEditing(memory?.id ?? "new"); setContent(memory?.content ?? ""); setExpiresAt(localDateTime(memory?.expiresAt));
    setDraftScope(memory?.scope === "project" ? "project" : "global"); setDraftScopeId(memory?.scopeId ?? workspace);
    setDraftKind(memory?.kind && memory.kind !== "summary" ? memory.kind : "preference"); setDraftKey(memory?.key ?? "");
  }
  function editor(memory?: MemoryRecord) {
    return <form className="glass p-4 flex flex-col gap-3" onSubmit={event => {
      event.preventDefault();
      const value: MemoryCreate = { content, key: draftKey, kind: draftKind, scope: draftScope, scopeId: draftScope === "global" ? "global" : draftScopeId };
      void perform(async () => {
        if (memory) await update(memory.id, { ...(memory.scope === "session" ? { content } : value), expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null });
        else await window.harness.request({ method: "memory.create", params: { ...value, actor: "desktop:user" } });
      }, memory ? "修改已保存，请确认更新后的内容" : "记忆已保存；如存在冲突，请选择保留哪条内容").then(ok => { if (ok) setEditing(undefined); });
    }}>
      {memory?.scope !== "session" && <>
      <label>适用范围<select aria-label="编辑记忆范围" className={fieldClass} value={draftScope} disabled={busy} onChange={event => { setDraftScope(event.target.value as "global" | "project"); if (event.target.value === "project" && draftScopeId === "global") setDraftScopeId(workspace); }}><option value="global">所有项目</option><option value="project">指定项目</option></select></label>
      {draftScope === "project" && <label>项目路径<input aria-label="记忆项目路径" required className={fieldClass} value={draftScopeId} disabled={busy} onChange={event => setDraftScopeId(event.target.value)} /></label>}
      <label>分类<select aria-label="记忆分类" className={fieldClass} value={draftKind} disabled={busy} onChange={event => setDraftKind(event.target.value as MemoryCreate["kind"])}>{Object.entries(kindLabels).filter(([key]) => key !== "summary").map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>主题<input aria-label="记忆主题" required maxLength={120} className={fieldClass} placeholder="例如：回复语言、组件库、构建命令" value={draftKey} disabled={busy} onChange={event => setDraftKey(event.target.value)} /></label>
      </>}
      <label>记忆正文<textarea aria-label="记忆正文" required maxLength={memory ? 50000 : 4000} className={`${fieldClass} mt-2 w-full`} rows={4} value={content} disabled={busy} onChange={event => setContent(event.target.value)} /></label>
      {memory && <label>过期时间（留空为永不过期）<input aria-label="过期时间" type="datetime-local" className={fieldClass} value={expiresAt} disabled={busy} onChange={event => setExpiresAt(event.target.value)} /></label>}
      <div className="flex gap-2"><BuiButton type="submit" variant="primary" disabled={busy || !content.trim() || (memory?.scope !== "session" && !draftKey.trim())}>{memory ? "保存修改" : "保存并记住"}</BuiButton><BuiButton type="button" disabled={busy} onClick={() => setEditing(undefined)}>取消编辑</BuiButton></div>
    </form>;
  }

  return <div className="memory-manager flex flex-col gap-4">
    <header>
      <h2 className="text-base font-semibold text-text">本地长期记忆</h2>
      <p className="text-sm text-text-muted">任务完成后提炼有依据的长期记忆。确认后的偏好与规范优先读取，决策和事实按任务匹配；过期、忽略或被替换的记录不会使用。</p>
    </header>
    {profile && <section className="glass p-4" aria-label="Profile 记忆范围">
      <h3 className="text-sm text-text">{profile.name} · 下次运行允许读取的记忆</h3>
      <div className="mt-3 flex flex-wrap gap-5">
        {(["session", "project", "global"] as const).map((item) => <label key={item} className="flex items-center gap-2 text-sm text-text-muted">
          <input type="checkbox" checked={profile.memoryScopes.includes(item)} disabled={busy}
            onChange={(event) => {
              const scopes = event.target.checked ? [...profile.memoryScopes, item] : profile.memoryScopes.filter((value) => value !== item);
              void perform(() => window.harness.request({ method: "profiles.memoryScopes", params: { profileId: profile.id, memoryScopes: scopes } }), "读取范围已保存，下次运行生效");
            }} />{scopeLabels[item]}记忆
        </label>)}
      </div>
      <p className="mt-2 text-xs text-text-muted">全部取消即停用记忆召回；已保存的记忆不会删除。</p>
    </section>}
    <div className="flex flex-wrap gap-2">
      <BuiButton disabled={busy} onClick={() => edit()}>新增记忆</BuiButton>
      <BuiButton disabled={busy || !workspace || publishable.length > 100} onClick={() => void perform(async () => {
        setPreview(await window.harness.request<MemoryPublicationPreview>({ method: "memory.publishPreview", params: { workspacePath: workspace, memoryIds: publishable.map(item => item.id) } }));
      }, "已生成项目文件变更预览")}>同步项目规范与知识（{publishable.length}）</BuiButton>
    </div>
    {editing === "new" && editor()}
    {preview && <section className="glass p-4" aria-label="项目知识变更预览">
      <h3>项目知识变更预览</h3><p className="text-sm text-text-muted">规范写入 AGENTS.md，决策与事实写入 docs/agent-knowledge.md。原有手写内容保留；应用后将信任本次预览中的项目规范。</p>
      {preview.files.map(file => <details key={file.path} open><summary>{file.path}</summary><div className="grid gap-3"><div>修改前<pre className="whitespace-pre-wrap break-words text-xs max-h-64 overflow-auto">{file.before || "（新文件）"}</pre></div><div>修改后<pre className="whitespace-pre-wrap break-words text-xs max-h-64 overflow-auto">{file.after}</pre></div></div></details>)}
      <div className="mt-3 flex gap-2"><BuiButton variant="primary" disabled={busy} onClick={() => void perform(() => window.harness.request({ method: "memory.publish", params: { workspacePath: preview.workspacePath, memoryIds: preview.memoryIds, token: preview.token } }), "项目知识已同步，规范将在下次运行读取").then(ok => { if (ok) setPreview(undefined); })}>应用并信任项目规范</BuiButton><BuiButton disabled={busy} onClick={() => setPreview(undefined)}>取消</BuiButton></div>
    </section>}
    <div className="flex flex-wrap items-center gap-2">
      <input aria-label="搜索记忆" className={fieldClass} placeholder="搜索内容、来源或项目…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <select aria-label="记忆作用域" className={fieldClass} value={scope} onChange={(e) => setScope(e.target.value)}>
        <option value="all">全部作用域</option><option value="current" disabled={!workspace}>当前项目</option>
        {Object.entries(scopeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <select aria-label="记忆状态" className={fieldClass} value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="all">全部状态</option>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <BuiButton disabled={busy || !visible.length || visible.length > 1000} onClick={() => {
        setBusy(true); setError(""); setNotice("");
        void window.harness.exportMemories(visible.map((m) => m.id)).then((result) => {
          setNotice(result.canceled ? "已取消导出" : `已导出：${result.path}`);
        }).catch((failure: unknown) => setError(String(failure))).finally(() => setBusy(false));
      }}>导出当前结果（{visible.length}）</BuiButton>
    </div>
    <p className="text-xs text-text-muted">导出为明文 JSON，包含内容与来源。单次最多 1,000 条，可筛选后导出。</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {notice && <p role="status" className="text-sm text-text-muted break-words">{notice}</p>}
    {!visible.length && <div className="glass p-6 text-sm text-text-muted">没有符合条件的记忆</div>}
    {visible.map((memory) => <article className="glass p-4" key={memory.id} data-memory-id={memory.id}>
      <header className="flex flex-wrap items-center gap-2">
        <BuiBadge>{scopeLabels[memory.scope]}</BuiBadge>
        {memory.kind && <BuiBadge>{kindLabels[memory.kind]}</BuiBadge>}
        <span className="text-xs text-text-muted">{statusLabels[effectiveStatus(memory)]}{memory.pinned ? " · 已固定" : ""}</span>
      </header>
      <p className="mt-2 text-xs text-text-muted break-all">作用域：{memory.scopeId} · 来源：{memory.source}</p>
      {memory.key && <p className="mt-1 text-xs text-text-muted">主题：{memory.key}{memory.sources && memory.sources.length > 1 ? ` · ${memory.sources.length} 个来源` : ""}</p>}
      {!!memory.evidence?.length && <details className="mt-2 text-sm text-text-muted"><summary>查看原文依据</summary>{memory.evidence.map((item, index) => <blockquote key={index}><p className="whitespace-pre-wrap">{item.quote}</p><small>{item.source}</small></blockquote>)}</details>}
      {memory.status === "candidate" && !!memory.conflictIds?.length && <div className="mt-2 text-sm text-text-muted" role="note"><p>同一主题存在不同内容，记住新内容时将替换以下记录：</p>{memory.conflictIds.map(id => <blockquote key={id}>{memories.find(item => item.id === id)?.content ?? id}</blockquote>)}</div>}
      <p className="mt-1 text-xs text-text-muted">创建：{new Date(memory.createdAt).toLocaleString()} · 到期：{memory.expiresAt ? new Date(memory.expiresAt).toLocaleString() : "永不过期"}</p>
      <p className="mt-1 text-xs text-text-muted">批准者：{memory.approvedBy || "待确认"}{memory.editedBy ? ` · 编辑者：${memory.editedBy}` : ""}</p>
      {editing === memory.id ? editor(memory) : <>
        <p className="mt-3 whitespace-pre-wrap break-words text-sm text-text">{memory.content}</p>
        <footer className="mt-4 flex flex-wrap gap-2">
          <BuiButton size="sm" disabled={busy} onClick={() => edit(memory)}>编辑</BuiButton>
          <BuiButton size="sm" disabled={busy} onClick={() => void perform(() => update(memory.id, { pinned: !memory.pinned }), memory.pinned ? "已取消固定" : "已固定，批准后在有效期内优先召回")}>{memory.pinned ? "取消固定" : "固定"}</BuiButton>
          {memory.status === "candidate" && <>
            <BuiButton size="sm" variant="primary" disabled={busy || effectiveStatus(memory) === "expired"} onClick={() => void perform(() => memory.conflictIds?.length
              ? window.harness.request({ method: "memory.decide", params: { memoryId: memory.id, approved: true, replaceConflicts: true, actor: "desktop:user" } })
              : decide(memory.id, true), "记忆已批准，旧的冲突内容已停用")}>{memory.conflictIds?.length ? "替换旧记忆并记住" : "记住"}</BuiButton>
            <BuiButton size="sm" disabled={busy} onClick={() => void perform(() => decide(memory.id, false), "已忽略候选")}>忽略</BuiButton>
          </>}
          <BuiButton size="sm" variant="danger" disabled={busy} onClick={() => {
            if (window.confirm(`删除这条记忆及其搜索索引？此操作不能撤销。\n\n${memory.content.slice(0, 200)}`))
              void perform(() => window.harness.request({ method: "memory.delete", params: { memoryId: memory.id } }), "记忆及搜索索引已删除");
          }}>删除</BuiButton>
        </footer>
      </>}
    </article>)}
  </div>;
}

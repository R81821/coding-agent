import { useEffect, useState } from "react";
import type { MemoryRecord, MemoryPatch, Profile } from "@harness/protocol";
import { BuiButton } from "./ui/button.js";
import { BuiBadge } from "./ui/badge.js";

const scopeLabels = { session: "会话", project: "项目", global: "全局" };
const statusLabels = { candidate: "待确认", approved: "已批准", rejected: "已忽略", expired: "已过期" };
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
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);

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

  return <div className="memory-manager flex flex-col gap-4">
    <header>
      <h2 className="text-base font-semibold text-text">本地长期记忆</h2>
      <p className="text-sm text-text-muted">修改正文后需重新确认。固定记忆优先召回，过期或未批准的记忆不会使用。</p>
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
        <span className="text-xs text-text-muted">{statusLabels[effectiveStatus(memory)]}{memory.pinned ? " · 已固定" : ""}</span>
      </header>
      <p className="mt-2 text-xs text-text-muted break-all">作用域：{memory.scopeId} · 来源：{memory.source}</p>
      <p className="mt-1 text-xs text-text-muted">创建：{new Date(memory.createdAt).toLocaleString()} · 到期：{memory.expiresAt ? new Date(memory.expiresAt).toLocaleString() : "永不过期"}</p>
      <p className="mt-1 text-xs text-text-muted">批准者：{memory.approvedBy || "待确认"}{memory.editedBy ? ` · 编辑者：${memory.editedBy}` : ""}</p>
      {editing === memory.id ? <form className="mt-3 flex flex-col gap-3" onSubmit={(event) => {
        event.preventDefault();
        const expiry = expiresAt ? new Date(expiresAt).toISOString() : null;
        void perform(() => update(memory.id, { content, expiresAt: expiry }), "记忆已保存；正文变更需要重新确认").then((ok) => { if (ok) setEditing(undefined); });
      }}>
        <label className="text-sm text-text-muted">记忆正文<textarea aria-label="记忆正文" required maxLength={50000} className={`${fieldClass} mt-2 w-full`} rows={5} value={content} disabled={busy} onChange={(e) => setContent(e.target.value)} /></label>
        <label className="text-sm text-text-muted">过期时间（本地时间，留空为永不过期）<input aria-label="过期时间" type="datetime-local" className={`${fieldClass} mt-2 block`} value={expiresAt} disabled={busy} onChange={(e) => setExpiresAt(e.target.value)} /></label>
        <div className="flex gap-2"><BuiButton type="submit" variant="primary" disabled={busy || !content.trim()}>保存修改</BuiButton><BuiButton type="button" disabled={busy} onClick={() => setEditing(undefined)}>取消编辑</BuiButton></div>
      </form> : <>
        <p className="mt-3 whitespace-pre-wrap break-words text-sm text-text">{memory.content}</p>
        <footer className="mt-4 flex flex-wrap gap-2">
          <BuiButton size="sm" disabled={busy} onClick={() => { setEditing(memory.id); setContent(memory.content); setExpiresAt(localDateTime(memory.expiresAt)); }}>编辑</BuiButton>
          <BuiButton size="sm" disabled={busy} onClick={() => void perform(() => update(memory.id, { pinned: !memory.pinned }), memory.pinned ? "已取消固定" : "已固定，批准后在有效期内优先召回")}>{memory.pinned ? "取消固定" : "固定"}</BuiButton>
          {memory.status === "candidate" && <>
            <BuiButton size="sm" variant="primary" disabled={busy || effectiveStatus(memory) === "expired"} onClick={() => void perform(() => decide(memory.id, true), "记忆已批准")}>记住</BuiButton>
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

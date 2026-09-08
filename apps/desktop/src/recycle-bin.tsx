import React, { useCallback, useEffect, useState } from "react";
import type { ProjectRecord, SessionPage } from "@harness/protocol";
import { RotateCcw, Trash2 } from "lucide-react";
import { BuiButton } from "./ui/button.js";

export function RecycleBin({ onChanged }: { onChanged: () => Promise<void> }) {
  const [sessions, setSessions] = useState<SessionPage>({ items: [], hasMore: false });
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setError("");
    try {
      const [nextSessions, nextProjects] = await Promise.all([
        window.harness.request<SessionPage>({ method: "sessions.list", params: { deleted: true, limit: 200, offset: 0 } }),
        window.harness.request<ProjectRecord[]>({ method: "projects.list", params: { deleted: true } }),
      ]);
      setSessions(nextSessions);
      setProjects(nextProjects);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function act(id: string, action: () => Promise<unknown>) {
    setBusyId(id);
    setError("");
    try {
      await action();
      await Promise.all([refresh(), onChanged()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <article className="glass recycle-bin col-span-2 flex flex-col gap-4 p-4">
      <div>
        <small className="text-[10px] font-semibold tracking-widest text-accent-text">RECYCLE BIN</small>
        <h3 className="text-sm font-semibold text-text">已删除的会话与项目</h3>
        <p className="text-xs text-text-muted">删除不会影响长期记忆。项目删除只会从 Harness 隐藏代码仓库，不会修改磁盘文件。</p>
      </div>
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      <section>
        <h4 className="mb-2 text-xs font-semibold text-text">已删除会话</h4>
        {sessions.items.length === 0 && <p className="text-xs text-text-muted">暂无已删除会话</p>}
        <div className="recycle-list">
          {sessions.items.map((session) => (
            <div className="recycle-row deleted-session" data-session-id={session.id} key={session.id}>
              <div><strong>{session.title}</strong><small>{session.workspacePath} · {session.runCount} 轮</small></div>
              <BuiButton className="restore-session" variant="ghost" size="sm" disabled={Boolean(busyId)} onClick={() => void act(session.id, () => window.harness.request({ method: "session.restore", params: { sessionId: session.id } }))}><RotateCcw size={14} />恢复</BuiButton>
              <BuiButton className="purge-session" variant="ghost" size="sm" disabled={Boolean(busyId)} onClick={() => {
                if (window.confirm("永久删除后，该会话及运行记录无法恢复；长期记忆仍会保留。确定永久删除吗？")) void act(session.id, () => window.harness.request({ method: "session.purge", params: { sessionId: session.id } }));
              }}><Trash2 size={14} />永久删除</BuiButton>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h4 className="mb-2 text-xs font-semibold text-text">已删除项目</h4>
        {projects.length === 0 && <p className="text-xs text-text-muted">暂无已删除项目</p>}
        <div className="recycle-list">
          {projects.map((project) => (
            <div className="recycle-row deleted-project" data-project-id={project.id} key={project.id}>
              <div><strong>{project.workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? project.workspacePath}</strong><small>{project.workspacePath}</small></div>
              <BuiButton className="restore-project" variant="ghost" size="sm" disabled={Boolean(busyId)} onClick={() => void act(project.id, () => window.harness.request({ method: "project.restore", params: { projectId: project.id } }))}><RotateCcw size={14} />恢复</BuiButton>
            </div>
          ))}
        </div>
      </section>
    </article>
  );
}

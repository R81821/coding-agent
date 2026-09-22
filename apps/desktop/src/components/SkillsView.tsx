import React, { useEffect, useRef, useState } from "react";
import { BookOpen, Check, Copy, Download, Search, X } from "lucide-react";
import type { SkillJob, SkillManifest, SkillPreview } from "@harness/protocol";
import { BuiButton } from "../ui/button.js";
import { MarkdownMessage } from "../markdown-message.js";
import { DecisionDialog } from "./DecisionDialog.js";
import "./skills.css";

export interface DesktopSkill {
  manifest: SkillManifest; key: string; scope: "global" | "project";
  hash: string; changedSinceTrust: boolean; content: string; files: string[];
}

export function SkillsView({ skills, profileId, refresh, decide }: {
  skills: DesktopSkill[]; profileId: string; refresh: () => Promise<void>;
  decide: (skill: DesktopSkill, trusted: boolean) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [command, setCommand] = useState("");
  const [globalPath, setGlobalPath] = useState("");
  const [jobs, setJobs] = useState<Partial<Record<SkillJob["kind"], SkillJob>>>({});
  const [preview, setPreview] = useState<SkillPreview>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [viewing, setViewing] = useState<DesktopSkill>();
  const [starting, setStarting] = useState(false);
  const downloadRef = useRef<HTMLElement>(null);
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  const jobRef = useRef(jobs); jobRef.current = jobs;
  useEffect(() => { void window.harness.request<{ globalPath: string }>({ method: "skills.location" }).then(value => setGlobalPath(value.globalPath)).catch(e => setError(String(e))); }, []);
  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      for (const previous of Object.values(jobRef.current)) {
        if (previous?.status !== "running") continue;
        try {
          const job = await window.harness.request<SkillJob>({ method: "skills.job", params: { jobId: previous.id } });
          if (disposed) return;
          setJobs(current => current[job.kind]?.id === job.id ? { ...current, [job.kind]: job } : current);
          if (job.status === "completed" && job.preview) { setPreview(job.preview); setSelectedPath(job.preview.skills.length === 1 ? job.preview.skills[0]!.path : undefined); }
          if (job.status === "completed" && job.kind === "install") {
            await refreshRef.current();
            setPreview(current => current ? { ...current, skills: current.skills.map(item => item.path === installedPath.current ? { ...item, installedRevision: current.revision } : item) } : current);
          }
        } catch (e) { if (!disposed) setError(`进度查询失败：${String(e)}`); }
      }
      if (!disposed) timer = setTimeout(() => void poll(), 600);
    };
    let timer = setTimeout(() => void poll(), 300);
    return () => { disposed = true; clearTimeout(timer); };
  }, []);
  const installedPath = useRef<string | undefined>(undefined);
  async function start(kind: SkillJob["kind"]) {
    setError(""); setStarting(true);
    try {
      if (kind === "preview") { setPreview(undefined); setSelectedPath(undefined); }
      if (kind === "install") installedPath.current = selectedPath;
      const job = await window.harness.request<SkillJob>(kind === "recommend" ? { method: "skills.recommend", params: { query, profileId } } : kind === "preview" ? { method: "skills.preview", params: { command } } : { method: "skills.install", params: { previewId: preview!.id, skillPath: selectedPath!, replace: Boolean(selected?.installedRevision) } });
      setJobs(current => ({ ...current, [kind]: job }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setStarting(false); }
  }
  async function cancel(job: SkillJob) {
    try { const updated = await window.harness.request<SkillJob>({ method: "skills.cancel", params: { jobId: job.id } }); setJobs(current => ({ ...current, [job.kind]: updated })); }
    catch (e) { setError(String(e)); }
  }
  function fill(value: string) { setCommand(value); setPreview(undefined); setSelectedPath(undefined); downloadRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }
  const selected = preview?.skills.find(item => item.path === selectedPath);
  const downloading = jobs.preview?.status === "running" || jobs.install?.status === "running";
  const alreadyInstalled = selected?.installedRevision === preview?.revision && Boolean(selected);
  function status(job?: SkillJob) {
    if (!job) return null;
    return <div className={`skill-progress ${job.status}`} role="status"><span>{job.error && job.status === "failed" ? job.error : job.progress}</span>{job.status === "running" && <BuiButton variant="ghost" size="sm" onClick={() => void cancel(job)}>取消</BuiButton>}</div>;
  }
  return <div className="skills-page">
    <section className="skills-section">
      <header><div><h2><Search size={19} /> 搜索推荐</h2><p>描述你的需求，让 Agent 查找并验证公开 GitHub 技能。</p></div><span className="skill-badge">独立任务</span></header>
      <label className="sr-only" htmlFor="skill-query">技能需求</label>
      <textarea id="skill-query" rows={3} value={query} onChange={e => setQuery(e.target.value)} placeholder="例如：查找适合审查 React 代码、生成测试的技能" />
      <div className="skill-actions"><BuiButton variant="primary" disabled={starting || !query.trim() || jobs.recommend?.status === "running"} onClick={() => void start("recommend")}><Search size={16} />{jobs.recommend?.status === "failed" ? "重试搜索" : "搜索推荐"}</BuiButton><small>使用当前 Profile · 最多 5 个结果</small></div>
      {status(jobs.recommend)}
      {jobs.recommend?.text && <details className="skill-transcript"><summary>查看 Agent 搜索过程</summary><MarkdownMessage text={jobs.recommend.text} /></details>}
      {Boolean(jobs.recommend?.recommendations?.length) && <p className="skill-summary">
        共 {jobs.recommend!.recommendations!.length} 项 · 已验证 {jobs.recommend!.recommendations!.filter(item => item.verified).length} 项
        {jobs.recommend!.recommendations!.some(item => !item.verified) && <span className="skill-muted"> · 未验证项仅作候选，安装前请自行核对</span>}
      </p>}
      <div className="skill-recommendations">{jobs.recommend?.recommendations?.map((item, index) => <article className={`skill-card skill-recommendation ${item.verified ? "is-verified" : "is-unverified"}`} key={`${item.source}-${index}`}>
        <div className="skill-card-head">
          <h3>{item.name}</h3>
          <span className={`skill-verify ${item.verified ? "is-ok" : "is-unknown"}`}>{item.verified ? "已验证" : "未验证"}</span>
        </div>
        <p>{item.purpose}</p>
        <p className="skill-muted">{item.reason}</p>
        <code className="skill-source">{item.source}</code>
        {item.command
          ? <><pre>{item.command}</pre><div className="skill-actions"><BuiButton variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(item.command!).then(() => setCopied(item.command!)).catch(e => setError(String(e)))}>{copied === item.command ? <Check size={15} /> : <Copy size={15} />}复制命令</BuiButton><BuiButton variant="ghost" size="sm" disabled={downloading} onClick={() => fill(item.command!)}><Download size={15} />填入下载面板</BuiButton></div></>
          : <p className="skill-muted">没有可解析的下载命令{item.diagnostic ? `：${item.diagnostic}` : ""}</p>}
      </article>)}</div>
      {jobs.recommend?.status === "completed" && !jobs.recommend.recommendations?.length && <p className="skill-empty">
        没有获得任何候选。{jobs.recommend.text.includes("不可达") || jobs.recommend.text.includes("失败") ? "检索来源可能不可达，可在设置中配置搜索服务后重试。" : "请调整需求后重试。"}
      </p>}
    </section>
    <section className="skills-section" ref={downloadRef}>
      <header><div><h2><Download size={19} /> 下载面板</h2><p>先预览技能内容，再安装到 Global 并启用。</p></div></header>
      <label htmlFor="skill-command">下载命令</label>
      <div className="skill-command-row"><input id="skill-command" value={command} disabled={downloading} onChange={e => { setCommand(e.target.value); setPreview(undefined); setSelectedPath(undefined); }} placeholder="npx skills add owner/repo --skill skill-name -g" /><BuiButton disabled={starting || downloading || !command.trim()} onClick={() => void start("preview")}>预览</BuiButton></div>
      <small className="skill-source">Global 位置：{globalPath || "加载中…"}</small>
      {status(jobs.preview)}{status(jobs.install)}
      {preview && <div className="skill-preview">
        <dl><dt>来源</dt><dd>{preview.source}</dd><dt>版本</dt><dd><code>{preview.revision}</code></dd></dl>
        <label htmlFor="skill-choice">选择技能</label><select id="skill-choice" value={selectedPath ?? "__none__"} disabled={downloading} onChange={e => setSelectedPath(e.target.value === "__none__" ? undefined : e.target.value)}><option value="__none__" disabled>请选择要安装的技能（{preview.skills.length} 个）</option>{preview.skills.map(item => <option value={item.path} key={item.path}>{item.name} · {item.path || "仓库根目录"}</option>)}</select>
        {selected && <><p>{selected.description}</p><small className="skill-source">安装位置：{selected.installationPath}</small><details open><summary>技能正文</summary><div className="skill-body"><MarkdownMessage text={selected.content} /></div></details><details><summary>随附文件 · {selected.files.length}</summary><ul>{selected.files.map(file => <li key={file}><code>{file}</code></li>)}</ul></details>
          {selected.installedRevision && !alreadyInstalled && <p className="skill-replace">已安装版本 {selected.installedRevision.slice(0, 12)}。替换后，使用旧版本的暂停任务需要重新开始。</p>}
          <BuiButton variant="primary" disabled={starting || downloading || alreadyInstalled} onClick={() => void start("install")}>{alreadyInstalled ? "已安装" : selected.installedRevision ? "替换为此版本并启用" : "安装并启用"}</BuiButton>
          {jobs.install?.status === "completed" && <p role="status">{jobs.install.text}</p>}
        </>}
      </div>}
    </section>
    <section className="skills-section"><header><div><h2><BookOpen size={19} /> 已安装技能</h2><p>选择已启用的技能可在对话中使用。正文或资源变化后需要重新确认。</p></div><BuiButton variant="ghost" size="sm" onClick={() => void refresh().catch(e => setError(String(e)))}>刷新</BuiButton></header>
      {!skills.length && <p className="skill-empty">尚未安装技能。搜索推荐或粘贴下载命令开始。</p>}
      {skills.map(skill => <article className="skill-card skill-installed" key={skill.key}><div><h3>{skill.manifest.name} <span className="skill-badge">{skill.scope === "global" ? "Global" : "项目"}</span></h3><p>{skill.manifest.description}</p><small className="skill-source">{skill.manifest.sourcePath}</small></div><div className="skill-installed-actions"><span className="skill-badge">{skill.changedSinceTrust ? "内容变化 · 需重新确认" : skill.manifest.enabled ? "已启用" : "未启用"}</span><BuiButton variant="ghost" size="sm" onClick={() => setViewing(skill)}>查看内容</BuiButton>{skill.manifest.enabled && <BuiButton variant="ghost" size="sm" onClick={() => void decide(skill, false).catch(e => setError(String(e)))}>撤销信任</BuiButton>}</div></article>)}
    </section>
    {error && <p className="skill-error" role="alert">{error}</p>}
    {viewing && <DecisionDialog title={viewing.manifest.name} status={viewing.manifest.enabled ? "已启用" : "请核对技能正文与资源"} confirmLabel={viewing.manifest.enabled ? "关闭" : "确认信任并启用"} onDismiss={() => setViewing(undefined)} onCancel={() => setViewing(undefined)} onConfirm={async () => { if (!viewing.manifest.enabled) await decide(viewing, true); setViewing(undefined); }}><div className="skill-body"><MarkdownMessage text={viewing.content} /></div><details><summary>随附资源 · {viewing.files.length}</summary><ul>{viewing.files.map(file => <li key={file}>{file}</li>)}</ul></details><small className="skill-source">SHA-256：{viewing.hash}</small></DecisionDialog>}
  </div>;
}

export function SkillPicker({ skills, selected, onChange, onClose, disabled }: { skills: DesktopSkill[]; selected: string[]; onChange: (keys: string[]) => void; onClose: () => void; disabled: boolean }) {
  const [query, setQuery] = useState("");
  const available = skills.filter(skill => skill.manifest.enabled && `${skill.manifest.name} ${skill.manifest.description}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="skill-picker" role="dialog" aria-label="选择技能" onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}><header><strong>选择技能</strong><button type="button" aria-label="关闭技能选择" onClick={onClose}><X size={17} /></button></header><input autoFocus aria-label="搜索已启用技能" placeholder="搜索已启用技能…" value={query} onChange={e => setQuery(e.target.value)} /><div className="skill-picker-list">{available.map(skill => <label key={skill.key}><input type="checkbox" disabled={disabled} checked={selected.includes(skill.key)} onChange={e => onChange(e.target.checked ? [...selected, skill.key] : selected.filter(key => key !== skill.key))} /><span><strong>{skill.manifest.name}</strong><small>{skill.manifest.description}</small></span><span className="skill-badge">{skill.scope === "global" ? "Global" : "项目"}</span></label>)}</div>{!available.length && <p className="skill-empty">没有匹配的已启用技能，请先在技能页面安装并启用。</p>}<footer><small>更改将在下一次新运行生效</small><BuiButton variant="ghost" size="sm" disabled={disabled || !selected.length} onClick={() => onChange([])}>清空选择</BuiButton></footer></div>;
}

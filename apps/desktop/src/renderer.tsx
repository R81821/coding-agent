import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentEvent,
  ApprovalRequest,
  MemoryRecord,
  PlanSpec,
  PluginRecord,
  Profile,
  ProjectRecord,
  RunCheckpoint,
  RunSpec,
  RunStatus,
  SessionDetail,
  SessionPage,
  SessionRecord,
  SessionSummary,
  SkillManifest,
  TaskSpec,
} from "@harness/protocol";
import { newId, nowIso, WORKFLOW_LABELS } from "@harness/protocol";
import type { DesktopAttachment } from "./preload.js";
import type { ProviderSettings } from "./provider-settings.js";
import { BuiBadge } from "./ui/badge.js";
import { BuiButton } from "./ui/button.js";
import { BuiGlassPanel } from "./ui/card.js";
import { BuiLoadingState } from "./ui/loading-state.js";
import { BuiPromptBar } from "./ui/prompt-bar.js";
import { BuiSidebarNav } from "./ui/sidebar-nav.js";
import { BuiToolChip } from "./ui/tool-chip.js";
import { MemoryManager } from "./memory-manager.js";
import { assistantMessages } from "./assistant-messages.js";
import { MarkdownMessage } from "./markdown-message.js";
import { PromptCacheStats } from "./components/PromptCacheStats.js";
import { RunStopCard } from "./components/RunStopCard.js";
import { RecycleBin } from "./recycle-bin.js";
import { groupSessionsByProject, isLiveRun, mergeRunEvents, mergeSessionPages, runStatusLabel, sessionTurns, workspaceKey, type SessionTurn } from "./run-history.js";
import {
  Activity,
  Bug,
  Brain,
  Camera,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FolderOpen,
  Hammer,
  Image as ImageIcon,
  MessageSquare,
  Monitor,
  PanelLeft,
  Plus,
  Puzzle,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareKanban,
  SquarePen,
  Terminal,
  Telescope,
  Trash2,
  UserCog,
  X,
} from "lucide-react";
import "./styles.css";
import "./tailwind.css";
import "./workbench.css";

type Tab =
  | "chat"
  | "tasks"
  | "approvals"
  | "plan"
  | "memory"
  | "skills"
  | "plugins"
  | "profiles"
  | "trace"
  | "settings";

type ApprovalPrompt =
  | { kind: "tool"; approval: ApprovalRequest }
  | { kind: "plan"; plan: PlanSpec };

function App() {
  const [unlocked, setUnlocked] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [rememberDevice, setRememberDevice] = useState(false);
  const [unlockError, setUnlockError] = useState("");
  const [tab, setTab] = useState<Tab>("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [workspace, setWorkspace] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("default");
  const [tasks, setTasks] = useState<TaskSpec[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [skills, setSkills] = useState<
    Array<{ manifest: SkillManifest; hash: string; changedSinceTrust: boolean }>
  >([]);
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<DesktopAttachment[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [activeRun, setActiveRun] = useState<string>();
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [sessionDetail, setSessionDetail] = useState<SessionDetail>();
  const [sessionPage, setSessionPage] = useState<SessionPage>({ items: [], hasMore: false });
  const sessionPageRef = useRef<SessionPage>({ items: [], hasMore: false });
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const historyRequest = useRef(0);
  const viewVersion = useRef(0);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const seededExpansion = useRef(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [recycleVersion, setRecycleVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [approvalPrompt, setApprovalPrompt] = useState<ApprovalPrompt>();
  const [capture, setCapture] = useState<{
    dataUrl: string;
    width: number;
    height: number;
  }>();

  const profile = profiles.find((item) => item.id === profileId);
  const conversationTurns = useMemo(() => sessionTurns(sessionDetail).map((turn) => turn.runId === activeRun ? { ...turn, events } : turn), [sessionDetail, activeRun, events]);
  const historyGroups = useMemo(() => groupSessionsByProject(sessionPage.items, projects, workspace), [sessionPage.items, projects, workspace]);
  const currentProjectKey = workspace ? workspaceKey(workspace) : "";

  const refreshHistory = useCallback(async (append = false) => {
    const requestVersion = ++historyRequest.current;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const [page, nextProjects] = await Promise.all([
        window.harness.request<SessionPage>({ method: "sessions.list", params: { deleted: false, limit: 50, offset: append ? sessionPageRef.current.items.length : 0 } }),
        window.harness.request<ProjectRecord[]>({ method: "projects.list", params: { deleted: false } }),
      ]);
      if (requestVersion !== historyRequest.current) return;
      const next = mergeSessionPages(sessionPageRef.current, page, append);
      sessionPageRef.current = next;
      setSessionPage(next);
      setProjects(nextProjects);
    } catch (error) {
      if (requestVersion === historyRequest.current) setHistoryError(`无法加载历史记录：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (requestVersion === historyRequest.current) setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (unlocked) void refreshHistory();
  }, [unlocked, refreshHistory]);

  useEffect(() => {
    if (!workspace) return;
    const key = workspaceKey(workspace);
    setExpandedProjects((current) => (current.has(key) ? current : new Set(current).add(key)));
  }, [workspace]);

  useEffect(() => {
    if (seededExpansion.current || sessionPage.items.length === 0) return;
    seededExpansion.current = true;
    const first = sessionPage.items[0];
    if (first) {
      const key = workspaceKey(first.workspacePath);
      setExpandedProjects((current) => (current.has(key) ? current : new Set(current).add(key)));
    }
  }, [sessionPage.items, workspace]);

  useEffect(() => {
    if (!unlocked || busy || activeSessionId || sessionPage.items.length === 0) return;
    const remembered = localStorage.getItem("harness.activeSessionId");
    const target = sessionPage.items.find((item) => item.id === remembered) ?? sessionPage.items[0];
    if (target) void openSession(target);
  }, [unlocked, busy, activeSessionId, sessionPage.items]);

  useEffect(() => {
    void window.harness.restoreUnlock().then((result) => {
      if (result.ok) setUnlocked(true);
    });
  }, []);

  const refresh = useCallback(async () => {
    const [nextProfiles, nextTasks, nextApprovals, nextMemories, nextSkills, nextPlugins] =
      await Promise.all([
        window.harness.request<Profile[]>({ method: "profiles.list" }),
        window.harness.request<TaskSpec[]>({ method: "tasks.list" }),
        window.harness.request<ApprovalRequest[]>({ method: "approvals.list" }),
        window.harness.request<MemoryRecord[]>({ method: "memory.list" }),
        window.harness.request<
          Array<{
            manifest: SkillManifest;
            hash: string;
            changedSinceTrust: boolean;
          }>
        >({
          method: "skills.list",
          ...(workspace ? { params: { workspacePath: workspace } } : {}),
        }),
        window.harness.request<PluginRecord[]>({ method: "plugins.list" }),
      ]);
    setProfiles(nextProfiles);
    setTasks(nextTasks);
    setApprovals(nextApprovals);
    setMemories(nextMemories);
    setSkills(nextSkills);
    setPlugins(nextPlugins);
  }, [workspace]);

  useEffect(() => {
    if (unlocked) void refresh();
  }, [unlocked, refresh]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (!unlocked) return;
      const image = [...(event.clipboardData?.files ?? [])].find((file) =>
        file.type.startsWith("image/"),
      );
      if (image) {
        event.preventDefault();
        void addBrowserFile(image, "clipboard");
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  async function unlock() {
    setUnlockError("");
    const result = await window.harness.unlock(passphrase, rememberDevice);
    if (result.ok) {
      setPassphrase("");
      setUnlocked(true);
    } else setUnlockError(result.error ?? "无法解锁");
  }

  async function chooseWorkspace() {
    const selected = await window.harness.chooseWorkspace();
    if (!selected) return;
    const inspection = await window.harness.request<{
      files: Array<{ path: string; sha256: string; content: string }>;
      trusted: boolean;
      changed: boolean;
    }>({ method: "project.inspect", params: { workspacePath: selected } });
    if (
      inspection.files.length > 0 &&
      (!inspection.trusted || inspection.changed)
    ) {
      const preview = inspection.files
        .map(
          (file) =>
            `${file.path} (${file.sha256.slice(0, 12)}…)\n${file.content.slice(0, 600)}`,
        )
        .join("\n\n");
      if (
        window.confirm(
          `该仓库包含项目指令。只有信任后它们才会获得指令权限；内容变化时会再次确认。\n\n${preview}\n\n信任这些文件吗？`,
        )
      ) {
        await window.harness.request({
          method: "project.trust",
          params: {
            workspacePath: selected,
            files: inspection.files.map(({ path, sha256 }) => ({
              path,
              sha256,
            })),
          },
        });
      }
    }
    setWorkspace(selected);
    await createSessionForWorkspace(selected);
  }

  async function createSessionForWorkspace(workspacePath: string) {
    if (!profile) return;
    const deletedProjects = await window.harness.request<ProjectRecord[]>({ method: "projects.list", params: { deleted: true } });
    const archivedProject = deletedProjects.find((project) => workspaceKey(project.workspacePath) === workspaceKey(workspacePath));
    if (archivedProject) await window.harness.request({ method: "project.restore", params: { projectId: archivedProject.id } });
    const createdAt = nowIso();
    const session = await window.harness.request<SessionRecord>({
      method: "sessions.create",
      params: {
        id: newId("session"),
        workspacePath,
        profileId: profile.id,
        title: "新会话",
        createdAt,
        updatedAt: createdAt,
      },
    });
    viewVersion.current += 1;
    setTab("chat");
    setWorkspace(session.workspacePath);
    setProfileId(session.profileId);
    setActiveSessionId(session.id);
    setSessionDetail({ session, runs: [] });
    setActiveRun(undefined);
    setEvents([]);
    setPrompt("");
    setAttachments([]);
    setApprovalPrompt(undefined);
    localStorage.setItem("harness.activeSessionId", session.id);
    await refreshHistory();
  }

  async function chooseImages() {
    if (!profile) return;
    const selected = await window.harness.chooseImages(
      profile.allowedProviders,
    );
    setAttachments((current) => [...current, ...selected]);
  }

  async function addBrowserFile(
    file: File,
    source: "clipboard" | "screenshot",
  ) {
    if (
      !profile ||
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        file.type,
      )
    )
      return;
    const base64 = await fileBase64(file);
    const result = await window.harness.putImage(
      base64,
      file.type,
      source,
      profile.allowedProviders,
    );
    setAttachments((current) => [...current, result]);
  }

  async function send() {
    if (!profile || !workspace || !activeSessionId || !sessionDetail || !prompt.trim() || busy) return;
    const viewToken = ++viewVersion.current;
    const request = prompt.trim();
    const runId = newId("run");
    const runSpec: RunSpec = {
      id: runId,
      sessionId: activeSessionId,
      request,
      workspacePath: workspace,
      profileId: profile.id,
      attachments: attachments.map((item) => item.attachment),
      budget: profile.budget,
      grants: [],
      createdAt: nowIso(),
    };
    setBusy(true);
    setEvents([]);
    setActiveRun(runId);
    setSessionDetail((current) => current ? { ...current, runs: [...current.runs, { spec: runSpec, status: "queued", events: [] }] } : current);
    try {
      await window.harness.request({
        method: "run.start",
        params: runSpec,
      });
      void refreshHistory();
      if (viewToken !== viewVersion.current) return;
      setPrompt("");
      setAttachments([]);
      await pollRun(runId, -1, viewToken);
    } catch (error) {
      if (viewToken !== viewVersion.current) return;
      setEvents((current) => [
        ...current,
        {
          type: "error",
          id: newId("event"),
          runId,
          at: nowIso(),
          sequence: Number.MAX_SAFE_INTEGER,
          code: "RUN_FAILED",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
      ]);
    } finally {
      if (viewToken === viewVersion.current) setBusy(false);
      await refresh().catch(() => {});
      await refreshHistory();
    }
  }

  async function newTask() {
    if (busy || !profile) return;
    setHistoryError("");
    if (!workspace) {
      await chooseWorkspace();
      return;
    }
    await createSessionForWorkspace(workspace);
  }

  async function deleteSession(item: SessionSummary) {
    if (busy || !window.confirm(`将会话“${item.title}”移到设置中的已删除会话？长期记忆会保留。`)) return;
    setHistoryError("");
    try {
      await window.harness.request({ method: "session.delete", params: { sessionId: item.id } });
      setRecycleVersion((current) => current + 1);
      const nextPage = { ...sessionPageRef.current, items: sessionPageRef.current.items.filter((session) => session.id !== item.id) };
      sessionPageRef.current = nextPage;
      setSessionPage(nextPage);
      if (activeSessionId === item.id) {
        viewVersion.current += 1;
        setActiveSessionId(undefined);
        setSessionDetail(undefined);
        setActiveRun(undefined);
        setEvents([]);
        localStorage.removeItem("harness.activeSessionId");
      }
      await refreshHistory();
    } catch (error) {
      setHistoryError(`无法删除会话：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function deleteProject(project: ProjectRecord) {
    if (busy || !window.confirm(`从 Harness 隐藏项目“${basename(project.workspacePath)}”？磁盘中的代码与文件不会被删除，会话和记忆也会保留。`)) return;
    setHistoryError("");
    try {
      await window.harness.request({ method: "project.delete", params: { projectId: project.id } });
      setRecycleVersion((current) => current + 1);
      setProjects((current) => current.filter((item) => item.id !== project.id));
      const nextPage = { ...sessionPageRef.current, items: sessionPageRef.current.items.filter((session) => workspaceKey(session.workspacePath) !== workspaceKey(project.workspacePath)) };
      sessionPageRef.current = nextPage;
      setSessionPage(nextPage);
      if (workspaceKey(workspace) === workspaceKey(project.workspacePath)) {
        viewVersion.current += 1;
        setWorkspace("");
        setActiveSessionId(undefined);
        setSessionDetail(undefined);
        setActiveRun(undefined);
        setEvents([]);
        localStorage.removeItem("harness.activeSessionId");
      }
      await refreshHistory();
    } catch (error) {
      setHistoryError(`无法删除项目：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function openSession(item: SessionSummary) {
    if (busy) return;
    const viewToken = ++viewVersion.current;
    setBusy(true);
    setHistoryError("");
    try {
      const stored = await window.harness.request<SessionDetail | undefined>({ method: "session.get", params: { sessionId: item.id } });
      if (viewToken !== viewVersion.current) return;
      if (!stored) throw new Error("该历史任务已不存在");
      if (stored.session.deletedAt) throw new Error("该会话已在回收站中");
      const latest = stored.runs.at(-1);
      setTab("chat");
      setWorkspace(stored.session.workspacePath);
      setProfileId(stored.session.profileId);
      setActiveSessionId(stored.session.id);
      setSessionDetail(stored);
      setActiveRun(latest?.spec.id);
      setEvents(latest ? latest.events : []);
      setPrompt("");
      setAttachments([]);
      setApprovalPrompt(undefined);
      localStorage.setItem("harness.activeSessionId", stored.session.id);
      if (latest && isLiveRun(latest.status)) {
        await pollRun(latest.spec.id, latest.events.reduce((max, event) => Math.max(max, event.sequence), -1), viewToken);
      }
      await refreshHistory();
    } catch (error) {
      if (viewToken === viewVersion.current) setHistoryError(`无法打开历史记录：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (viewToken === viewVersion.current) setBusy(false);
    }
  }

  async function pollRun(runId: string, startSequence = -1, viewToken = viewVersion.current) {
    let sequence = startSequence;
    let finished = false;
    while (!finished && viewToken === viewVersion.current) {
      const batch = await window.harness.request<AgentEvent[]>({
        method: "run.events",
        params: { runId, afterSequence: sequence },
      });
      if (viewToken !== viewVersion.current) return;
      if (batch.length) {
        setEvents((current) => viewToken === viewVersion.current ? mergeRunEvents(current, batch, runId) : current);
        setSessionDetail((current) => current ? {
          ...current,
          runs: current.runs.map((run) => run.spec.id === runId
            ? { ...run, events: mergeRunEvents(run.events, batch, runId), status: batch.findLast((event) => event.type === "result")?.type === "result" ? batch.findLast((event) => event.type === "result")!.status : run.status }
            : run),
        } : current);
        sequence = Math.max(...batch.map((event) => event.sequence), sequence);
        finished = batch.some((event) => event.type === "result");
        const toolApproval = batch.find(
          (event): event is Extract<AgentEvent, { type: "approval_required" }> =>
            event.type === "approval_required",
        );
        const planApproval = batch.find(
          (event): event is Extract<AgentEvent, { type: "plan_approval_required" }> =>
            event.type === "plan_approval_required",
        );
        if (toolApproval) {
          const nextApprovals = await window.harness.request<ApprovalRequest[]>({
            method: "approvals.list",
          });
          if (viewToken !== viewVersion.current) return;
          setApprovals(nextApprovals);
          const pending = nextApprovals.find(
            (approval) =>
              approval.id === toolApproval.approvalId &&
              approval.status === "pending",
          );
          if (pending) setApprovalPrompt({ kind: "tool", approval: pending });
        } else if (planApproval) {
          const plan = await window.harness.request<PlanSpec | undefined>({
            method: "plan.get",
            params: { runId },
          });
          if (viewToken !== viewVersion.current) return;
          if (plan?.status === "awaiting_approval")
            setApprovalPrompt({ kind: "plan", plan });
        }
      }
      if (!batch.length) {
        const stored = await window.harness.request<{ spec: RunSpec; status: RunStatus } | undefined>({ method: "run.get", params: { runId } });
        if (viewToken !== viewVersion.current) return;
        finished = !stored || !isLiveRun(stored.status);
      }
      if (!finished) await delay(500);
    }
  }

  async function decideApproval(approvalId: string, approved: boolean) {
    await window.harness.request({
      method: "approval.decide",
      params: { approvalId, approved, actor: "desktop:user" },
    });
    setApprovalPrompt((current) =>
      current?.kind === "tool" && current.approval.id === approvalId
        ? undefined
        : current,
    );
    await refresh();
  }

  async function decidePlan(plan: PlanSpec, approved: boolean, feedback?: string) {
    await window.harness.request({ method: "plan.decide", params: { planId: plan.id, version: plan.version, approved, actor: "desktop:user", ...(feedback ? { feedback } : {}) } });
    setApprovalPrompt((current) =>
      current?.kind === "plan" && current.plan.id === plan.id
        ? undefined
        : current,
    );
  }

  async function pluginAction(method: "plugins.install" | "plugins.trust" | "plugins.enable" | "plugins.disable", params: Record<string, unknown>) {
    await window.harness.request({ method, params } as never);
    await refresh();
  }

  async function decideMemory(memoryId: string, approved: boolean) {
    await window.harness.request({
      method: "memory.decide",
      params: { memoryId, approved, actor: "desktop:user" },
    });
    await refresh();
  }

  async function decideSkill(
    skill: { manifest: SkillManifest },
    trusted: boolean,
  ) {
    if (trusted)
      await window.harness.request({
        method: "skills.trust",
        params: { sourcePath: skill.manifest.sourcePath },
      });
    else
      await window.harness.request({
        method: "skills.untrust",
        params: { skillId: skill.manifest.id },
      });
    await refresh();
  }

  async function startCapture() {
    setCapture(await window.harness.captureScreen());
  }

  async function createTask(input: {
    title: string;
    request: string;
    cron?: string;
    allowPatch: boolean;
    commandPrefixes: string[];
  }) {
    if (!profile || !workspace) throw new Error("请先选择工作区和 Profile");
    const grants =
      input.allowPatch || input.commandPrefixes.length > 0
        ? [
            {
              toolNames: [
                ...(input.allowPatch ? ["apply_patch"] : []),
                ...(input.commandPrefixes.length ? ["terminal"] : []),
              ],
              pathGlobs: ["**"],
              commandPrefixes: input.commandPrefixes,
              networkDomains: [],
              maxRisk: "high" as const,
            },
          ]
        : [];
    const task: TaskSpec = {
      id: newId("task"),
      title: input.title,
      status: input.cron ? "Ready" : "Backlog",
      run: {
        id: newId("scheduled_run"),
        sessionId: newId("scheduled_session"),
        request: input.request,
        workspacePath: workspace,
        profileId: profile.id,
        attachments: [],
        budget: profile.budget,
        grants,
        createdAt: nowIso(),
      },
      dependencies: [],
      ...(input.cron ? { cron: input.cron } : {}),
      timezone: "Asia/Shanghai",
      misfireGraceMs: 86_400_000,
      allowOverlap: false,
      ...((input.allowPatch || input.commandPrefixes.length > 0) ? { approvedPlanTemplate: {
        id: newId("plan_template"),
        runId: "schedule-template",
        goal: input.request,
        version: 1,
        status: "approved" as const,
        steps: [{ id: "scheduled-write", title: "Execute scheduled write plan", description: "Run only the explicitly preauthorized patch and command scope.", dependencies: [], executor: "main" as const, mode: "write" as const, allowedTools: [...(input.allowPatch ? ["apply_patch"] : []), ...(input.commandPrefixes.length ? ["terminal"] : [])], input: {}, outputContract: "Return uncommitted diff and verification results", acceptanceCriteria: ["Stay within the configured command and workspace scope"], status: "pending" as const }],
        scope: { pathGlobs: input.allowPatch ? ["**"] : [], commandPrefixes: input.commandPrefixes, networkDomains: [], maxRisk: "high" as const },
        approvedBy: "desktop:user",
        approvedAt: nowIso(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      } } : {}),
      notify: ["desktop"],
    };
    await window.harness.request({ method: "tasks.upsert", params: task });
    await refresh();
  }

  if (!unlocked)
    return (
      <Unlock
        passphrase={passphrase}
        setPassphrase={setPassphrase}
        rememberDevice={rememberDevice}
        setRememberDevice={setRememberDevice}
        error={unlockError}
        onUnlock={unlock}
      />
    );

  return (
    <div
      className={`app-shell workbench${sidebarCollapsed ? " sidebar-collapsed" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const file = [...event.dataTransfer.files].find((candidate) =>
          candidate.type.startsWith("image/"),
        );
        if (file) void addBrowserFile(file, "clipboard");
      }}
    >
      <aside className="sidebar" aria-label="工作区侧栏" id="workspace-sidebar">
        <div className="brand">
          <span className="brand-mark">H</span>
          <div>
            <strong>Harness</strong>
            <small>本地开发助手</small>
          </div>
        </div>
        <BuiButton className="new-task-button" variant="ghost" disabled={busy}
          onClick={() => void newTask()}>
          <SquarePen size={18} /> 新建任务
        </BuiButton>
        <div className="sidebar-scroll">
        <BuiSidebarNav
          active={tab}
          onSelect={setTab}
          items={(
            [
              "chat",
              "tasks",
              "approvals",
              "plugins",
            ] as Tab[]
          ).map((item) => ({
            id: item,
            label: tabLabel(item),
            icon: <Icon name={item} />,
            ...(item === "approvals"
              ? {
                  badge: approvals.filter(
                    (approval) => approval.status === "pending",
                  ).length,
                }
              : {}),
          }))}
        />
        <section className="sidebar-projects" aria-label="项目与会话">
          <div className="sidebar-section-label"><span>项目</span>
            <BuiButton variant="ghost" size="sm" onClick={chooseWorkspace} aria-label="打开代码仓库" title="打开代码仓库"><Plus size={15} /></BuiButton>
          </div>
          {!historyGroups.length && !historyLoading && !historyError && <p className="sidebar-hint">{workspace ? "当前项目还没有会话" : "打开项目后，会话会自动按项目归档在这里"}</p>}
          {historyGroups.map((group) => {
            const isCurrent = group.key === currentProjectKey;
            const expanded = expandedProjects.has(group.key);
            return (
              <div key={group.key} className="project-group">
                <div className="project-folder-row">
                  <button type="button" className={`project-folder${expanded ? " expanded" : ""}`} aria-expanded={expanded} title={group.project.workspacePath} onClick={() => setExpandedProjects((current) => {
                    const next = new Set(current);
                    if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
                    return next;
                  })}>
                    <ChevronRight size={14} className="folder-chevron" />
                    <FolderOpen size={15} className="folder-icon" />
                    <span className="project-folder-name">{group.project.workspacePath ? basename(group.project.workspacePath) : "未归组会话"}</span>
                    {isCurrent && <span className="project-folder-tag">当前</span>}
                    {group.items.length > 0 && <span className="project-folder-count">{group.items.length}</span>}
                  </button>
                  <button type="button" className="row-icon-action project-new-session" aria-label={`在 ${basename(group.project.workspacePath)} 中新建会话`} title="新建会话" disabled={busy} onClick={(event) => { event.stopPropagation(); void createSessionForWorkspace(group.project.workspacePath); }}><Plus size={13} /></button>
                  <button type="button" className="row-icon-action project-delete" aria-label={`删除项目 ${basename(group.project.workspacePath)}`} title="从 Harness 删除项目" disabled={busy} onClick={(event) => { event.stopPropagation(); void deleteProject(group.project); }}><Trash2 size={13} /></button>
                </div>
                {expanded && (
                  <div className="project-group-items">
                    {group.items.map((item) => (
                      <div className="project-session-row" key={item.id}>
                        <button className={`project-session history-session${activeSessionId === item.id ? " active" : ""}`} aria-current={activeSessionId === item.id ? "page" : undefined} disabled={busy} onClick={() => void openSession(item)} title={`${item.title}\n${item.workspacePath}`}>
                          <MessageSquare size={14} />
                          <span className="history-session-content"><span>{item.title}</span><small>{item.latestStatus ? runStatusLabel[item.latestStatus] : "新会话"} · {item.runCount} 轮</small></span>
                        </button>
                        <button type="button" className="row-icon-action session-delete" aria-label={`删除会话 ${item.title}`} title="移到已删除会话" disabled={busy} onClick={(event) => { event.stopPropagation(); void deleteSession(item); }}><Trash2 size={13} /></button>
                      </div>
                    ))}
                    {!group.items.length && <p className="sidebar-hint">点击项目旁的 + 新建会话</p>}
                  </div>
                )}
              </div>
            );
          })}
          {historyLoading && <p className="sidebar-hint">正在加载历史记录…</p>}
          {historyError && <p className="sidebar-hint history-error" role="alert">{historyError}</p>}
          {historyError && <BuiButton variant="ghost" size="sm" disabled={historyLoading} onClick={() => void refreshHistory()}>重试加载</BuiButton>}
          {sessionPage.hasMore && <BuiButton variant="ghost" size="sm" disabled={busy || historyLoading} onClick={() => void refreshHistory(true)}>加载更早的会话</BuiButton>}
        </section>
        <details className="sidebar-tools">
          <summary>工作台工具 <ChevronDown size={14} /></summary>
          <BuiSidebarNav active={tab} onSelect={setTab} items={(["plan", "memory", "skills", "profiles", "trace"] as Tab[]).map((item) => ({ id: item, label: tabLabel(item), icon: <Icon name={item} /> }))} />
        </details>
        </div>
        <div className="sidebar-foot">
          <BuiButton variant="ghost" onClick={() => setTab("settings")} className="sidebar-settings"><Settings size={17} /><span>设置</span><small>v1.3.2</small></BuiButton>
          <div className="sidebar-connection"><span className="status-dot" />本地运行时已解锁</div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="workbench-heading">
            <BuiButton variant="ghost" size="sm" aria-controls="workspace-sidebar" aria-expanded={!sidebarCollapsed} aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} onClick={() => setSidebarCollapsed((value) => !value)}><PanelLeft size={18} /></BuiButton>
            <h1>{tab === "chat" ? "开发会话" : tabLabel(tab)}</h1>
          </div>
          <div className="top-actions">
            <select
              aria-label="选择 Profile"
              value={profileId}
              onChange={(event) => setProfileId(event.target.value)}
            >
              {profiles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <span className="secure"><ShieldCheck size={14} /> 本地加密</span>
          </div>
        </header>
        <section className={`content${tab === "chat" ? " chat-content" : ""}`}>
          {tab === "chat" && (
            <ChatView
              workspace={workspace}
              {...(profile ? { profile } : {})}
              prompt={prompt}
              setPrompt={setPrompt}
              attachments={attachments}
              setAttachments={setAttachments}
              events={events}
              turns={conversationTurns}
              hasSession={Boolean(activeSessionId)}
              busy={busy}
              onSend={send}
              onChooseImages={chooseImages}
              onCapture={startCapture}
              onChooseWorkspace={chooseWorkspace}
            />
          )}
          {tab === "tasks" && (
            <TasksView
              tasks={tasks}
              canCreate={Boolean(workspace && profile)}
              createTask={createTask}
            />
          )}
          {tab === "approvals" && (
            <ApprovalsView approvals={approvals} decide={decideApproval} />
          )}
          {tab === "plan" && <PlanView {...(activeRun ? { runId: activeRun } : {})} events={events} decide={decidePlan} />}
          {tab === "memory" && (
            <MemoryManager memories={memories} decide={decideMemory} refresh={refresh} workspace={workspace} {...(profile ? { profile } : {})} />
          )}
          {tab === "skills" && (
            <SkillsView skills={skills} decide={decideSkill} />
          )}
          {tab === "plugins" && <PluginsView plugins={plugins} action={pluginAction} />}
          {tab === "profiles" && (
            <ProfilesView profiles={profiles} activeId={profileId} refresh={refresh} />
          )}
          {tab === "trace" && (
            <TraceView
              events={events}
              {...(activeRun ? { runId: activeRun } : {})}
            />
          )}
          {tab === "settings" && <SettingsView key={recycleVersion} refresh={refresh} refreshHistory={refreshHistory} />}
        </section>
      </main>
      {capture && (
        <CropOverlay
          capture={capture}
          onCancel={() => setCapture(undefined)}
          onConfirm={async (base64) => {
            if (!profile) return;
            const result = await window.harness.putImage(
              base64,
              "image/png",
              "screenshot",
              profile.allowedProviders,
            );
            setAttachments((current) => [...current, result]);
            setCapture(undefined);
          }}
        />
      )}
      {approvalPrompt && (
        <ApprovalPromptDialog
          prompt={approvalPrompt}
          onClose={() => setApprovalPrompt(undefined)}
          onDecideTool={decideApproval}
          onDecidePlan={decidePlan}
        />
      )}
    </div>
  );
}

function Unlock(props: {
  passphrase: string;
  setPassphrase: (value: string) => void;
  rememberDevice: boolean;
  setRememberDevice: (value: boolean) => void;
  error: string;
  onUnlock: () => void;
}) {
  return (
    <div className="unlock">
      <div className="glass-strong flex w-[400px] max-w-[92vw] flex-col items-center gap-3 p-8 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-lg font-semibold text-accent-text">
          H
        </div>
        <small className="text-[10px] font-semibold tracking-[0.3em] text-text-muted">
          HARNESS AGENT
        </small>
        <h1 className="text-lg font-semibold text-text">解锁本地运行时</h1>
        <p className="text-sm text-text-muted">
          口令用于解密会话、记忆、工具记录和图片。它不会发送给模型服务。
        </p>
        <input
          autoFocus
          type="password"
          className="w-full rounded-xl border border-line bg-black/30 px-3 py-2.5 text-sm text-text outline-none placeholder:text-text-muted"
          value={props.passphrase}
          onChange={(event) => props.setPassphrase(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void props.onUnlock();
          }}
          placeholder="应用口令（至少 10 个字符）"
        />
        <label className="flex w-full items-center gap-2 text-left text-xs text-text-muted">
          <input
            type="checkbox"
            checked={props.rememberDevice}
            onChange={(event) => props.setRememberDevice(event.target.checked)}
          />
          记住此设备（使用 Windows DPAPI）
        </label>
        {props.error && (
          <div className="w-full rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-left text-xs text-danger">
            {props.error}
          </div>
        )}
        <BuiButton
          variant="primary"
          className="w-full"
          onClick={() => void props.onUnlock()}
        >
          解锁并启动 agentd
        </BuiButton>
      </div>
    </div>
  );
}

function ChatView(props: {
  workspace: string;
  profile?: Profile;
  prompt: string;
  setPrompt: (value: string) => void;
  attachments: DesktopAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<DesktopAttachment[]>>;
  events: AgentEvent[];
  turns: SessionTurn[];
  hasSession: boolean;
  busy: boolean;
  onSend: () => void;
  onChooseImages: () => void;
  onCapture: () => void;
  onChooseWorkspace: () => void;
}) {
  const conversationRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const eventCount = props.turns.reduce((total, turn) => total + turn.events.length, 0);
  const currentFinalText = assistantMessages(props.events).text;
  const route = props.events.find((event) => event.type === "route") as
    Extract<AgentEvent, { type: "route" }> | undefined;
  const status = [...props.events]
    .reverse()
    .find((event) => event.type === "status") as
    Extract<AgentEvent, { type: "status" }> | undefined;

  useEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation) return;
    if (props.turns.length === 0) {
      followLatestRef.current = true;
      conversation.scrollTop = 0;
      return;
    }
    if (!followLatestRef.current) return;
    const frame = requestAnimationFrame(() => {
      conversation.scrollTop = conversation.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [eventCount, currentFinalText, props.turns.length]);

  return (
    <div className="chat-layout">
      <div
        className={`conversation${props.turns.length === 0 ? " conversation-empty" : ""}`}
        ref={conversationRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          const remaining =
            element.scrollHeight - element.scrollTop - element.clientHeight;
          followLatestRef.current = remaining <= 96;
        }}
      >
        {props.turns.length === 0 && (
          <section className="workspace-welcome">
            <Terminal className="welcome-symbol" size={54} strokeWidth={1.25} aria-hidden="true" />
            <h2>{props.workspace ? <>我们应该在 <span title={props.workspace}>{basename(props.workspace)}</span> 中构建什么？</> : "今天，我们一起构建什么？"}</h2>
            <p>{props.workspace ? "从理解代码到完成交付，交给 Harness。" : "打开一个代码仓库，开始你的下一个想法。"}</p>
            <div className="task-starters">
              {[
                { title: "探索并理解代码", icon: Telescope, tone: "blue", prompt: "分析这个仓库，解释代码结构、关键流程和可以改进的地方；先不要修改代码" },
                { title: "构建新功能、应用或工具", icon: Hammer, tone: "purple", prompt: "帮我在这个项目中构建一个新功能，先询问需求并制定实现计划" },
                { title: "审查代码并提出修改建议", icon: Activity, tone: "green", prompt: "审查这个仓库的代码，按严重程度列出问题、位置和修改建议；先不要修改代码" },
                { title: "修复问题和失败", icon: Bug, tone: "orange", prompt: "诊断测试失败或附加截图中的错误，定位原因并修复，完成后运行验证" },
              ].map((starter) => <button key={starter.tone} className={`task-starter starter-${starter.tone}`} onClick={() => props.setPrompt(starter.prompt)}>
                <starter.icon size={21} strokeWidth={1.6} /><span>{starter.title}</span>
              </button>)}
            </div>
          </section>
        )}
        {props.turns.map((turn, index) => (
          <ConversationTurnView key={turn.runId} turn={turn} busy={props.busy && index === props.turns.length - 1} />
        ))}
      </div>
      <div className="composer-wrap">
        <div className="composer-project-bar">
          <button onClick={props.onChooseWorkspace} title={props.workspace || "打开代码仓库"}><FolderOpen size={16} /><span>{props.workspace ? basename(props.workspace) : "选择项目"}</span></button>
          <span><Monitor size={15} />本地</span>
          <span className="composer-profile" title={props.profile?.name}><UserCog size={15} />{props.profile?.name || "未选择 Profile"}</span>
        </div>
        <BuiPromptBar
          value={props.prompt}
          onChange={props.setPrompt}
          onSubmit={props.onSend}
          placeholder={
            !props.workspace ? "先选择项目，再开始对话…" : props.hasSession ? "描述你的想法，或粘贴错误截图…" : "点击新建任务创建会话…"
          }
          disabled={!props.workspace || !props.hasSession || props.busy}
          busy={props.busy}
          {...(props.profile
            ? {
                providerLabel: route ? `${route.providerId} / ${route.modelId}` : `自动路由 · ${props.profile.allowedProviders.join(" / ")}`,
              }
            : {})}
          {...(props.attachments.length > 0
            ? {
                attachments: (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {props.attachments.map((item, index) => (
                      <div
                        className="glass-strong flex items-center gap-2 p-2"
                        key={item.attachment.id}
                      >
                        <img
                          src={item.previewDataUrl}
                          className="h-10 w-14 rounded-lg object-cover"
                        />
                        <span className="text-xs text-text-muted">
                          {item.attachment.mimeType}
                          <small className="block text-[10px]">
                            不可信附件 · 发送前可见
                          </small>
                        </span>
                        <BuiButton
                          variant="ghost"
                          size="sm"
                          aria-label="移除附件"
                          onClick={() =>
                            props.setAttachments((all) =>
                              all.filter((_, itemIndex) => itemIndex !== index),
                            )
                          }
                        >
                          <X size={12} />
                        </BuiButton>
                      </div>
                    ))}
                  </div>
                ),
              }
            : {})}
          actions={
            <>
              <BuiButton
                variant="ghost"
                size="sm"
                title="添加图片"
                disabled={!props.profile || props.busy}
                onClick={props.onChooseImages}
              >
                <ImageIcon size={17} /> 图片
              </BuiButton>
              <BuiButton
                variant="ghost"
                size="sm"
                title="区域截图"
                disabled={!props.profile || props.busy}
                onClick={props.onCapture}
              >
                <Camera size={17} /> 截图
              </BuiButton>
            </>
          }
        />
        {status && (
          <div className="mt-2 flex items-center justify-center gap-2 text-xs text-text-muted">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
            {status.status}
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationTurnView({ turn, busy }: { turn: SessionTurn; busy: boolean }) {
  const { text: finalText, progress: progressMessages } = assistantMessages(turn.events);
  const result = turn.events.findLast((event) => event.type === "result");
  const route = turn.events.find((event) => event.type === "route") as Extract<AgentEvent, { type: "route" }> | undefined;
  return (
    <section className="conversation-turn" data-run-id={turn.runId}>
      <article className="user-message" aria-label="你的任务">{turn.request}</article>
      {route && (
        <BuiGlassPanel className="mb-3 flex items-center gap-3 px-4 py-3">
          <span className="text-[10px] font-semibold tracking-widest text-accent-text">AUTO ROUTE</span>
          <strong className="text-sm text-text">{route.providerId} / {route.modelId}</strong>
          <small className="ml-auto text-xs text-text-muted">{route.reason}</small>
        </BuiGlassPanel>
      )}
      <PromptCacheStats usages={turn.events.flatMap(event => event.type === "usage" ? [event.usage] : [])} />
      <WorkflowProgress events={turn.events} />
      {result?.stop && <RunStopCard stop={result.stop} />}
      {busy && !finalText && <div className="mb-3"><BuiLoadingState label="Agent 正在思考与执行…" /></div>}
      {finalText && (
        <article className="assistant-message mb-3 flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-text">H</div>
          <MarkdownMessage text={finalText} />
        </article>
      )}
      {progressMessages.length > 0 && (
        <details className="glass mb-3 px-4 py-3">
          <summary className="cursor-pointer text-xs text-text-muted">查看过程记录（{progressMessages.length} 轮）</summary>
          {progressMessages.map((text, index) => <div key={index} className="mt-3 border-t border-line pt-3"><MarkdownMessage text={text} compact /></div>)}
        </details>
      )}
      <div className="flex flex-col gap-2">
        {buildTimeline(turn.events).map((item) => item.kind === "tool_group"
          ? <ToolEventGroup key={item.id} tools={item.tools} />
          : <EventRow key={item.event.id} event={item.event} />)}
      </div>
    </section>
  );
}

function WorkflowProgress({ events }: { events: AgentEvent[] }) {
  const stages = events.filter((event): event is Extract<AgentEvent, { type: "workflow_updated" }> => event.type === "workflow_updated");
  const latest = stages.at(-1);
  if (!latest) return null;
  const state = latest.workflow;
  const chain = state.failureChains?.find(item => item.id === state.activeChainId && item.status === "open");
  const checkLabels = { pending: "待验证", passed: "通过", failed: "失败", skipped: "已跳过" };
  return <details className="glass mb-3 px-4 py-3 workflow-progress">
    <summary className="cursor-pointer text-sm text-text"><strong>{WORKFLOW_LABELS[state.phase]}</strong><span className="ml-3 text-xs text-text-muted">修改版本 {state.revision} · 累计失败 {state.failures} · 当前故障重复 {chain?.count ?? 0} 次</span></summary>
    <p className="mt-2 text-xs text-text-muted">{latest.detail}</p>
    {state.activity && <p className="mt-2 break-words text-xs text-text-muted">工具活动：{state.activity}</p>}
    <div className="mt-3 space-y-1 text-xs text-text workflow-checks">{(["localCheck", "broaderCheck"] as const).map((key, index) => <p key={key}>{index === 0 ? "局部验证" : "扩大验证"}：{state[key] ? checkLabels[state[key].status] : "历史记录，未区分验证与跳过"}{state[key]?.reason && <span className="ml-2 text-text-muted">{state[key].reason}</span>}</p>)}
    <p>独立只读评审：{state.reviewPolicy !== "risk_based" ? "未启用" : !state.riskFlags?.length ? "未触发" : checkLabels[state.independentReview?.status ?? "pending"]}</p></div>
    <ol className="mt-3 space-y-1 text-xs text-text-muted">{stages.slice(-16).map(event => <li key={event.id}>{WORKFLOW_LABELS[event.workflow.phase]}：{event.detail}</li>)}</ol>
    {state.hypotheses.length > 0 && <p className="mt-3 text-xs text-text">当前假设：{state.hypotheses.at(-1)?.cause}</p>}
    {state.requirementReceipts?.length > 0 && <p className="mt-2 text-xs text-text-muted">证据引用已核对；业务语义结论由模型评审。</p>}
    {state.requirements.length > 0 && <ul className="mt-2 space-y-1 text-xs text-text">{state.requirements.map((item, index) => <li key={index}>{state.requirementsRevision === state.revision && state.requirementReceipts?.some(receipt => receipt.requirementId === state.requirementIds?.[index]) ? "✓" : "○"} {item}</li>)}</ul>}
  </details>;
}

function EventRow({ event }: { event: AgentEvent }) {
  if (event.type === "provider_retry")
    return (
      <div className="glass flex items-center gap-3 border-warning/30 px-4 py-2.5">
        <span className="text-[10px] font-semibold tracking-widest text-warning">
          RETRY
        </span>
        <strong className="text-sm text-text">
          Provider 重试 {event.attempt}/{event.maxAttempts}
        </strong>
        <small className="ml-auto text-xs text-text-muted">
          {event.category === "tool_history_protocol"
            ? "已修复工具历史协议并重试"
            : `${event.delayMs} ms 后重试`}
        </small>
      </div>
    );
  if (event.type === "self_correction_started")
    return (
      <div className="glass flex items-center gap-3 border-warning/30 px-4 py-2.5">
        <span className="text-[10px] font-semibold tracking-widest text-warning">
          REFLECT
        </span>
        <strong className="text-sm text-text">
          {event.maxAttempts == null ? `第 ${event.attempt} 次自我修正` : `自我修正 ${event.attempt}/${event.maxAttempts}`}
        </strong>
        <small className="ml-auto max-w-[45%] truncate text-xs text-text-muted">
          {event.summary}
        </small>
      </div>
    );
  if (event.type === "repair_started")
    return (
      <div className="glass flex items-center gap-3 border-warning/30 px-4 py-2.5">
        <span className="text-[10px] font-semibold tracking-widest text-warning">REPAIR</span>
        <strong className="text-sm text-text">第 {event.attempt} 次修复</strong>
      </div>
    );
  if (event.type === "approval_required")
    return (
      <div className="glass flex items-center gap-3 border-warning/30 px-4 py-2.5">
        <span className="text-[10px] font-semibold tracking-widest text-warning">
          APPROVAL
        </span>
        <strong className="truncate text-sm text-text">{event.summary}</strong>
      </div>
    );
  if (event.type === "error")
    return (
      <div className="glass flex items-center gap-3 border-danger/30 px-4 py-2.5">
        <span className="text-[10px] font-semibold tracking-widest text-danger">
          {event.code}
        </span>
        <strong className="min-w-0 flex-1 break-words text-sm text-danger">
          {event.message}
        </strong>
      </div>
    );
  return null;
}

type ToolStartedEvent = Extract<AgentEvent, { type: "tool_started" }>;
type ToolFinishedEvent = Extract<AgentEvent, { type: "tool_finished" }>;
type ToolTimelineItem = {
  kind: "tool";
  started: ToolStartedEvent;
  finished?: ToolFinishedEvent;
};
type TimelineItem =
  | { kind: "tool_group"; id: string; tools: ToolTimelineItem[] }
  | { kind: "event"; event: AgentEvent };

function buildTimeline(events: AgentEvent[]): TimelineItem[] {
  const timeline: TimelineItem[] = [];
  const tools = new Map<string, ToolTimelineItem>();
  let activeGroup: Extract<TimelineItem, { kind: "tool_group" }> | undefined;
  for (const event of events) {
    if (event.type === "tool_started") {
      const item: ToolTimelineItem = {
        kind: "tool",
        started: event,
      };
      tools.set(event.call.id, item);
      if (!activeGroup) {
        activeGroup = {
          kind: "tool_group",
          id: `tool-group-${event.id}`,
          tools: [],
        };
        timeline.push(activeGroup);
      }
      activeGroup.tools.push(item);
    } else if (event.type === "tool_finished") {
      const item = tools.get(event.callId);
      if (item) item.finished = event;
    } else if (
      event.type === "approval_required" ||
      event.type === "error" ||
      event.type === "provider_retry" ||
      event.type === "self_correction_started" ||
      event.type === "repair_started"
    ) {
      timeline.push({ kind: "event", event });
    }
  }
  return timeline;
}

function ToolEventGroup({ tools }: { tools: ToolTimelineItem[] }) {
  const completed = tools.filter((tool) => tool.finished).length;
  const totalDuration = tools.reduce(
    (total, tool) => total + (tool.finished?.durationMs ?? 0),
    0,
  );
  const allCompleted = completed === tools.length;
  const failures = tools.filter((tool) => tool.finished?.isError === true || (tool.finished?.output && typeof tool.finished.output === "object" && "error" in tool.finished.output)).length;
  return (
    <details className="glass px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center gap-3">
        <span
          className={`text-[10px] font-semibold tracking-widest ${
            failures ? "text-danger" : allCompleted ? "text-success" : "text-accent-text"
          }`}
        >
          {failures ? "ERRORS" : allCompleted ? "DONE" : "TOOLS"}
        </span>
        <strong className="text-sm text-text">工具调用（{tools.length}）</strong>
        <small className="ml-auto text-xs text-text-muted">
          {allCompleted
            ? `${formatDuration(totalDuration)}${failures ? ` · ${failures} 项失败` : ""} · 点击展开全部结果`
            : `${completed}/${tools.length} 已完成 · 点击展开`}
        </small>
      </summary>
      <div className="mt-3 flex flex-col gap-2">
        {tools.map((tool) => (
          <ToolEventRow
            key={tool.started.id}
            started={tool.started}
            {...(tool.finished ? { finished: tool.finished } : {})}
          />
        ))}
      </div>
    </details>
  );
}

function ToolEventRow({
  started,
  finished,
}: {
  started: ToolStartedEvent;
  finished?: ToolFinishedEvent;
}) {
  const failed = finished?.isError === true || (
    finished !== undefined &&
    typeof finished.output === "object" &&
    finished.output !== null &&
    "error" in (finished.output as Record<string, unknown>));
  return (
    <details className="rounded-xl border border-line bg-white/5 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2.5">
        <BuiToolChip
          name={started.call.name}
          status={failed ? "failed" : finished ? "finished" : "running"}
        />
        <small className="ml-auto font-mono text-[11px] text-text-muted">
          {finished ? `${finished.durationMs} ms` : "运行中"} · 展开上下文
        </small>
      </summary>
      <div className="mt-2 flex flex-col gap-1.5">
        <label className="text-[10px] tracking-widest text-text-muted">INPUT</label>
        <pre className="overflow-auto rounded-lg bg-black/30 p-2 font-mono text-xs text-text-muted">
          {formatToolContext(started.call.input)}
        </pre>
        {finished && (
          <>
            <label className="text-[10px] tracking-widest text-text-muted">
              OUTPUT · 不可信工具数据
            </label>
            <pre className="overflow-auto rounded-lg bg-black/30 p-2 font-mono text-xs text-text-muted">
              {formatToolContext(finished.output)}
            </pre>
          </>
        )}
      </div>
    </details>
  );
}

function formatToolContext(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return text.length <= 20_000
    ? text
    : `${text.slice(0, 20_000)}\n… UI 预览已截断`;
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000
    ? `${durationMs} ms`
    : `${(durationMs / 1_000).toFixed(1)} s`;
}

function ApprovalPromptDialog({
  prompt,
  onClose,
  onDecideTool,
  onDecidePlan,
}: {
  prompt: ApprovalPrompt;
  onClose: () => void;
  onDecideTool: (id: string, approved: boolean) => Promise<void>;
  onDecidePlan: (
    plan: PlanSpec,
    approved: boolean,
    feedback?: string,
  ) => Promise<void>;
}) {
  const isTool = prompt.kind === "tool";
  const risk = isTool ? prompt.approval.risk : prompt.plan.scope.maxRisk;
  const riskBorder =
    risk === "destructive"
      ? "border-danger/40"
      : risk === "high"
        ? "border-warning/40"
        : "border-warning/30";
  return (
    <div className="approval-overlay" role="dialog" aria-modal="true">
      <BuiGlassPanel
        strong
        className={`w-[560px] max-w-[92vw] border ${riskBorder} p-5`}
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <small className="text-[10px] font-semibold tracking-widest text-text-muted">
              WAITING APPROVAL
            </small>
            <h2 className="mt-1 text-base font-semibold text-text">
              {isTool ? "工具请求审批" : "执行计划请求审批"}
            </h2>
          </div>
          <BuiButton variant="ghost" size="sm" aria-label="稍后处理" onClick={onClose}>
            <X size={14} />
          </BuiButton>
        </header>
        {isTool ? (
          <div className="mt-4 flex flex-col gap-3">
            <p className="flex items-center gap-2 text-sm">
              <BuiBadge tone={riskTone(risk)}>{risk}</BuiBadge>
              <strong className="font-mono text-text">{prompt.approval.toolName}</strong>
            </p>
            <p className="text-sm text-text-muted">{prompt.approval.reason}</p>
            <pre className="overflow-auto rounded-xl bg-black/30 p-3 font-mono text-xs text-text-muted">
              {formatToolContext(prompt.approval.normalizedInput)}
            </pre>
            <footer className="mt-1 flex justify-end gap-2">
              <BuiButton
                variant="ghost"
                onClick={() => void onDecideTool(prompt.approval.id, false)}
              >
                拒绝
              </BuiButton>
              <BuiButton
                variant="primary"
                onClick={() => void onDecideTool(prompt.approval.id, true)}
              >
                批准一次
              </BuiButton>
            </footer>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-sm text-text">{prompt.plan.goal}</p>
            <ol className="flex flex-col gap-2">
              {prompt.plan.steps.map((step, index) => (
                <li
                  key={step.id}
                  className="flex items-start gap-3 rounded-xl border border-line bg-white/5 px-3 py-2.5"
                >
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft font-mono text-[10px] text-accent-text">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <strong className="block truncate text-sm text-text">
                      {step.title}
                    </strong>
                    <small className="block truncate text-xs text-text-muted">
                      {step.acceptanceCriteria.join("；")}
                    </small>
                  </div>
                </li>
              ))}
            </ol>
            <footer className="mt-1 flex justify-end gap-2">
              <BuiButton
                variant="ghost"
                onClick={() => void onDecidePlan(prompt.plan, false)}
              >
                拒绝
              </BuiButton>
              <BuiButton
                variant="primary"
                onClick={() => void onDecidePlan(prompt.plan, true)}
              >
                批准计划
              </BuiButton>
            </footer>
          </div>
        )}
      </BuiGlassPanel>
    </div>
  );
}

function riskTone(risk: string): "danger" | "warning" | "info" {
  if (risk === "destructive") return "danger";
  if (risk === "high") return "warning";
  return "info";
}

function TasksView({
  tasks,
  canCreate,
  createTask,
}: {
  tasks: TaskSpec[];
  canCreate: boolean;
  createTask: (input: {
    title: string;
    request: string;
    cron?: string;
    allowPatch: boolean;
    commandPrefixes: string[];
  }) => Promise<void>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [request, setRequest] = useState("");
  const [cron, setCron] = useState("");
  const [allowPatch, setAllowPatch] = useState(false);
  const [commands, setCommands] = useState("");
  const columns: TaskSpec["status"][] = [
    "Backlog",
    "Ready",
    "Running",
    "Awaiting Approval",
    "Blocked",
    "Review",
    "Done",
    "Failed",
  ];
  return (
    <div className="tasks-shell">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-text">Cron + Kanban</h2>
          <p className="text-sm text-text-muted">
            无人值守权限在任务创建时固定，越界操作会暂停等待审批。
          </p>
        </div>
        <BuiButton
          variant="primary"
          size="sm"
          disabled={!canCreate}
          onClick={() => setShowForm((value) => !value)}
        >
          ＋ 新任务
        </BuiButton>
      </div>
      {showForm && (
        <div className="glass mt-3 flex flex-col gap-2 p-4">
          <input
            className="rounded-xl border border-line bg-black/30 px-3 py-2 text-sm text-text outline-none placeholder:text-text-muted"
            placeholder="任务标题"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <textarea
            className="min-h-[64px] rounded-xl border border-line bg-black/30 px-3 py-2 text-sm text-text outline-none placeholder:text-text-muted"
            placeholder="任务请求"
            value={request}
            onChange={(event) => setRequest(event.target.value)}
          />
          <input
            className="rounded-xl border border-line bg-black/30 px-3 py-2 text-sm text-text outline-none placeholder:text-text-muted"
            placeholder="Cron（可选，如 0 9 * * 1-5）"
            value={cron}
            onChange={(event) => setCron(event.target.value)}
          />
          <input
            className="rounded-xl border border-line bg-black/30 px-3 py-2 text-sm text-text outline-none placeholder:text-text-muted"
            placeholder="允许的命令前缀，逗号分隔（可选）"
            value={commands}
            onChange={(event) => setCommands(event.target.value)}
          />
          <label className="flex items-center gap-2 text-sm text-text-muted">
            <input
              type="checkbox"
              checked={allowPatch}
              onChange={(event) => setAllowPatch(event.target.checked)}
            />
            预授权工作区补丁写入
          </label>
          <div className="flex justify-end">
            <BuiButton
              variant="primary"
              size="sm"
              disabled={!title.trim() || !request.trim()}
              onClick={() =>
                void createTask({
                  title: title.trim(),
                  request: request.trim(),
                  ...(cron.trim() ? { cron: cron.trim() } : {}),
                  allowPatch,
                  commandPrefixes: commands
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                }).then(() => {
                  setTitle("");
                  setRequest("");
                  setCron("");
                  setCommands("");
                  setAllowPatch(false);
                  setShowForm(false);
                })
              }
            >
              保存任务
            </BuiButton>
          </div>
        </div>
      )}
      <div className="board mt-3">
        {columns.map((status) => (
          <div className="glass flex w-56 shrink-0 flex-col gap-2 p-3" key={status}>
            <header className="flex items-center justify-between px-1">
              <span className="text-xs font-semibold text-text">{status}</span>
              <em className="not-italic rounded-full bg-white/8 px-1.5 text-[11px] text-text-muted">
                {tasks.filter((task) => task.status === status).length}
              </em>
            </header>
            {tasks
              .filter((task) => task.status === status)
              .map((task) => (
                <article
                  className="rounded-xl border border-line bg-white/5 p-3"
                  key={task.id}
                >
                  <strong className="block truncate text-sm text-text">
                    {task.title}
                  </strong>
                  <small className="mt-0.5 block truncate text-[11px] text-text-muted">
                    {task.run.workspacePath}
                  </small>
                  {task.cron && (
                    <code className="mt-1 block truncate font-mono text-[10px] text-accent-text">
                      {task.cron} · {task.timezone}
                    </code>
                  )}
                  <div className="mt-2 flex items-center justify-between text-[11px] text-text-muted">
                    <span>{task.run.profileId}</span>
                    <span>${task.run.budget.maxUsd}</span>
                  </div>
                </article>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function ApprovalsView({
  approvals,
  decide,
}: {
  approvals: ApprovalRequest[];
  decide: (id: string, approved: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold text-text">确定性权限中心</h2>
        <p className="text-sm text-text-muted">
          模型不能自行越权。破坏性操作始终需要一次性批准。
        </p>
      </div>
      {approvals.length === 0 && <Empty label="暂无审批请求" />}
      {approvals.map((approval) => (
        <article
          className={`glass p-4 ${
            approval.risk === "destructive"
              ? "border-danger/40"
              : approval.risk === "high"
                ? "border-warning/40"
                : "border-line"
          }`}
          key={approval.id}
        >
          <div className="flex items-center gap-2">
            <BuiBadge tone={riskTone(approval.risk)}>{approval.risk}</BuiBadge>
            <strong className="font-mono text-sm text-text">
              {approval.toolName}
            </strong>
            <small className="ml-auto text-xs text-text-muted">
              {approval.status} · {new Date(approval.expiresAt).toLocaleString()}
            </small>
          </div>
          <p className="mt-2 text-sm text-text-muted">{approval.reason}</p>
          <pre className="mt-2 overflow-auto rounded-xl bg-black/30 p-3 font-mono text-xs text-text-muted">
            {JSON.stringify(approval.normalizedInput, null, 2)}
          </pre>
          {approval.status === "pending" && (
            <footer className="mt-3 flex justify-end gap-2">
              <BuiButton
                variant="ghost"
                size="sm"
                onClick={() => void decide(approval.id, false)}
              >
                拒绝
              </BuiButton>
              <BuiButton
                variant="primary"
                size="sm"
                onClick={() => void decide(approval.id, true)}
              >
                批准一次
              </BuiButton>
            </footer>
          )}
        </article>
      ))}
    </div>
  );
}

function SkillsView({
  skills,
  decide,
}: {
  skills: Array<{
    manifest: SkillManifest;
    hash: string;
    changedSinceTrust: boolean;
  }>;
  decide: (skill: { manifest: SkillManifest }, trusted: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold text-text">SKILL.md</h2>
        <p className="text-sm text-text-muted">
          技能只有在核对权限与内容哈希后才会启用；变更会撤销信任。
        </p>
      </div>
      {skills.length === 0 && (
        <Empty label="用户目录或项目中没有发现技能" />
      )}
      {skills.map((skill) => (
        <article
          className="glass flex items-start gap-3 p-4"
          key={`${skill.manifest.id}:${skill.manifest.sourcePath}`}
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-sm font-semibold text-accent-text">
            S
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-text">
              {skill.manifest.name}
              <small className="ml-2 text-xs text-text-muted">
                v{skill.manifest.version}
              </small>
            </h3>
            <p className="mt-0.5 text-sm text-text-muted">
              {skill.manifest.description}
            </p>
            <code className="mt-1 block truncate font-mono text-[11px] text-text-muted">
              {skill.manifest.sourcePath}
            </code>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {skill.manifest.tools.map((tool) => (
                <BuiToolChip key={tool} name={tool} />
              ))}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <BuiBadge
              tone={
                skill.changedSinceTrust
                  ? "warning"
                  : skill.manifest.enabled
                    ? "success"
                    : "neutral"
              }
            >
              {skill.changedSinceTrust
                ? "内容已变化"
                : skill.manifest.enabled
                  ? "已信任"
                  : "待确认"}
            </BuiBadge>
            <BuiButton
              variant="ghost"
              size="sm"
              onClick={() => void decide(skill, !skill.manifest.enabled)}
            >
              {skill.manifest.enabled ? "撤销信任" : "查看并信任"}
            </BuiButton>
          </div>
        </article>
      ))}
    </div>
  );
}

function ProfilesView({
  profiles,
  activeId,
  refresh,
}: {
  profiles: Profile[];
  activeId: string;
  refresh: () => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-3">
      <VerificationEditor
        {...(profiles.find((profile) => profile.id === activeId)
          ? { profile: profiles.find((profile) => profile.id === activeId)! }
          : {})}
        refresh={refresh}
      />
      <div className="grid grid-cols-2 gap-3">
        {profiles.map((profile) => (
          <article
            className={`glass p-4 ${
              profile.id === activeId ? "border-accent/40" : ""
            }`}
            key={profile.id}
          >
            <header className="flex items-center gap-2">
              <div className="min-w-0">
                <small className="text-[10px] font-semibold tracking-widest text-accent-text">
                  PROFILE
                </small>
                <h3 className="truncate text-sm font-semibold text-text">
                  {profile.name}
                </h3>
              </div>
              <BuiBadge tone={profile.sandbox === "docker" ? "info" : "neutral"}>
                {profile.sandbox}
              </BuiBadge>
            </header>
            <p className="mt-2 line-clamp-2 text-xs text-text-muted">
              {profile.systemPrompt}
            </p>
            <dl className="mt-3 flex flex-col gap-1.5 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="shrink-0 text-text-muted">Providers</dt>
                <dd className="truncate text-text">{profile.allowedProviders.join(", ")}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="shrink-0 text-text-muted">Route weights</dt>
                <dd className="truncate text-text">
                  质量 {profile.routeWeights.quality} · 成本 {profile.routeWeights.cost} · 延迟 {profile.routeWeights.latency}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="shrink-0 text-text-muted">Budget</dt>
                <dd className="truncate text-text">
                  ${profile.budget.maxUsd} · {profile.budget.maxTurns} turns
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="shrink-0 text-text-muted">Tools</dt>
                <dd className="truncate text-text">{profile.toolNames.join(", ")}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="shrink-0 text-text-muted">Context</dt>
                <dd className="truncate text-text">
                  {Math.round(profile.contextPolicy.compactAtRatio * 100)}% 压缩 ·{" "}
                  {Math.round(profile.contextPolicy.outputReserveRatio * 100)}% 输出余量
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="shrink-0 text-text-muted">Verification</dt>
                <dd className="truncate text-text">
                  {profile.verificationPolicy.items.length} 项 · 修复次数不限
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="shrink-0 text-text-muted">Plugins</dt>
                <dd className="truncate text-text">
                  {profile.pluginIds.join(", ") || "无"}
                </dd>
              </div>
            </dl>
            <label className="mt-3 flex items-start gap-2 text-xs text-text-muted">
              <input type="checkbox" checked={profile.responsesContinuation !== false} onChange={event => { void window.harness.request({ method: "profiles.upsert", params: { ...profile, responsesContinuation: event.target.checked } }).then(refresh).catch(error => window.alert(String(error))); }} />
              <span>Responses 连续响应（服务端保存响应上下文）。关闭后使用本地完整历史发送。</span>
            </label>
          </article>
        ))}
      </div>
    </div>
  );
}

function VerificationEditor({ profile, refresh }: { profile?: Profile; refresh: () => Promise<void> }) {
  const [commands, setCommands] = useState("");
  const [broaderCommands, setBroaderCommands] = useState("");
  const [broaderPolicy, setBroaderPolicy] = useState<"required" | "optional" | "disabled">("optional");
  const [reviewPolicy, setReviewPolicy] = useState<"standard" | "risk_based">("standard");
  useEffect(() => {
    setBroaderPolicy(profile?.verificationPolicy.broaderPolicy ?? "optional");
    setReviewPolicy(profile?.verificationPolicy.reviewPolicy ?? "standard");
    setCommands(profile?.verificationPolicy.items.filter(item => (item.stage ?? "local") === "local").map(item => item.command).join("\n") ?? "");
    setBroaderCommands(profile?.verificationPolicy.items.filter(item => item.stage === "broader").map(item => item.command).join("\n") ?? "");
  }, [profile]);
  if (!profile) return null;
  return (
    <BuiGlassPanel className="mt-6 p-4">
      <div className="flex items-center gap-3">
        <span className="text-[10px] font-semibold tracking-widest text-accent-text">
          VERIFICATION MATRIX
        </span>
        <strong className="text-sm text-text">分层验证 · 每行一条必需命令</strong>
        <small className="ml-auto text-xs text-text-muted">
          写任务没有矩阵时进入 Review
        </small>
      </div>
      <textarea
        className="mt-3 min-h-[90px] w-full resize-y rounded-xl border border-line bg-black/30 p-3 font-mono text-xs text-text outline-none placeholder:text-text-muted"
        value={commands}
        onChange={(event) => setCommands(event.target.value)}
        aria-label="局部验证命令"
        placeholder={"局部验证：先语法、再相关测试\npnpm typecheck"}
      />
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-text">
        <span>修复次数不限，受运行总预算约束</span>
        <label>扩大验证策略 <select aria-label="扩大验证策略" value={broaderPolicy} onChange={event => setBroaderPolicy(event.target.value as typeof broaderPolicy)}><option value="optional">可选（无配置时明确跳过）</option><option value="required">必需（无配置时不能完成）</option><option value="disabled">禁用（记录策略原因）</option></select></label>
        <label>独立只读评审 <select aria-label="独立只读评审" value={reviewPolicy} onChange={event => setReviewPolicy(event.target.value as typeof reviewPolicy)}><option value="standard">不额外启用</option><option value="risk_based">敏感路径、大补丁、多文件或修改范围不明时启用</option></select></label>
      </div>
      <p className="mt-2 text-xs text-text-muted">独立评审使用额外模型轮次并计入任务预算。</p>
      <textarea className="mt-3 min-h-[90px] w-full rounded-xl border border-line bg-black/30 p-3 font-mono text-xs text-text" aria-label="扩大验证命令" value={broaderCommands} onChange={event => setBroaderCommands(event.target.value)} placeholder={"扩大验证：局部通过后执行，可留空\npnpm test\npnpm build"} />
      <div className="mt-2 flex justify-end">
        <BuiButton
          variant="primary"
          size="sm"
          onClick={async () => {
            const items = ([{ stage: "local" as const, text: commands }, { stage: "broader" as const, text: broaderCommands }]).flatMap(group => group.text.split(/\r?\n/).map(command => command.trim()).filter(Boolean).map(command => ({ command, stage: group.stage })))
              .map(({ command, stage }, index) => ({
                stage,
                id: `verify-${index + 1}`,
                command,
                cwd: ".",
                timeoutMs: 120_000,
                required: true,
                expectedExitCodes: [0],
              }));
            await window.harness.request({
              method: "profiles.upsert",
              params: {
                ...profile,
                verificationPolicy: { ...profile.verificationPolicy, items, broaderPolicy, reviewPolicy, maxRepairAttempts: null },
                resiliencePolicy: { ...profile.resiliencePolicy, maxToolSelfCorrections: null },
              },
            });
            await refresh();
          }}
        >
          保存验证矩阵
        </BuiButton>
      </div>
    </BuiGlassPanel>
  );
}

function PlanView({ runId, events, decide }: { runId?: string; events: AgentEvent[]; decide: (plan: PlanSpec, approved: boolean, feedback?: string) => Promise<void> }) {
  const [plan, setPlan] = useState<PlanSpec>();
  const [checkpoints, setCheckpoints] = useState<RunCheckpoint[]>([]);
  useEffect(() => {
    if (!runId) return;
    void Promise.all([
      window.harness.request<PlanSpec | undefined>({ method: "plan.get", params: { runId } }),
      window.harness.request<RunCheckpoint[]>({ method: "checkpoints.get", params: { runId, limit: 30 } }),
    ]).then(([nextPlan, nextCheckpoints]) => { setPlan(nextPlan); setCheckpoints(nextCheckpoints); });
  }, [runId, events.length]);
  const verification = [...events].reverse().find((event) => event.type === "verification_finished") as Extract<AgentEvent, { type: "verification_finished" }> | undefined;
  const compactions = events.filter((event) => event.type === "context_compacted") as Array<Extract<AgentEvent, { type: "context_compacted" }>>;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold text-text">计划与上下文</h2>
        <p className="text-sm text-text-muted">副作用前审批计划；工具权限仍单独裁决。</p>
      </div>
      {!plan ? (
        <Empty label="当前运行尚未请求副作用计划" />
      ) : (
        <article className="glass p-4">
          <div className="flex items-center gap-2">
            <BuiBadge tone={plan.status === "approved" ? "success" : plan.status === "rejected" ? "danger" : "warning"}>
              PLAN v{plan.version}
            </BuiBadge>
            <strong className="min-w-0 flex-1 truncate text-sm text-text">{plan.goal}</strong>
            <small className="text-xs text-text-muted">{plan.status}</small>
          </div>
          <ol className="mt-3 flex flex-col gap-2">
            {plan.steps.map((step, index) => (
              <li
                key={step.id}
                className="flex items-start gap-3 rounded-xl border border-line bg-white/5 px-3 py-2.5"
              >
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft font-mono text-[10px] text-accent-text">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <strong className="block truncate text-sm text-text">{step.title}</strong>
                  <p className="mt-0.5 text-xs text-text-muted">{step.description}</p>
                  <small className="text-[11px] text-text-muted">
                    {step.mode} · {step.allowedTools.join(", ")}
                  </small>
                </div>
              </li>
            ))}
          </ol>
          <pre className="mt-3 overflow-auto rounded-xl bg-black/30 p-3 font-mono text-xs text-text-muted">
            {JSON.stringify(plan.scope, null, 2)}
          </pre>
          {plan.status === "awaiting_approval" && (
            <footer className="mt-3 flex justify-end gap-2">
              <BuiButton variant="primary" onClick={() => void decide(plan, true)}>
                批准计划
              </BuiButton>
              <BuiButton variant="ghost" onClick={() => void decide(plan, false)}>
                拒绝
              </BuiButton>
              <BuiButton
                variant="secondary"
                onClick={() => {
                  const feedback = window.prompt("填写修订意见");
                  if (feedback) void decide(plan, false, feedback);
                }}
              >
                要求修订
              </BuiButton>
            </footer>
          )}
        </article>
      )}
      <article className="glass p-4">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-semibold tracking-widest text-accent-text">
            CONTEXT
          </span>
          <strong className="text-sm text-text">
            {checkpoints[0]?.transcript.length ?? 0} 条原生消息
          </strong>
          <small className="ml-auto text-xs text-text-muted">
            {checkpoints.length} 个加密检查点 · {compactions.length} 次压缩
          </small>
        </div>
        {compactions.map((event) => (
          <pre
            key={event.id}
            className="mt-2 rounded-lg bg-black/30 p-2 font-mono text-xs text-text-muted"
          >
            压缩 {event.record.inputTokens} → {event.record.outputTokens} tokens ·{" "}
            {event.record.deterministicFallback ? "确定性回退" : event.record.modelId}
          </pre>
        ))}
      </article>
      <article className="glass p-4">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-semibold tracking-widest text-accent-text">
            VERIFY
          </span>
          <strong className="text-sm text-text">
            {verification ? (verification.verification.passed ? "通过" : "需要 Review") : "尚未验证"}
          </strong>
          <small className="ml-auto text-xs text-text-muted">
            {verification
              ? `attempt ${verification.verification.attempt}`
              : "写任务无矩阵时不会进入 Done"}
          </small>
        </div>
        {verification && (
          <pre className="mt-2 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-xs text-text-muted">
            {JSON.stringify(verification.verification.results, null, 2)}
          </pre>
        )}
      </article>
    </div>
  );
}

function PluginsView({ plugins, action }: { plugins: PluginRecord[]; action: (method: "plugins.install" | "plugins.trust" | "plugins.enable" | "plugins.disable", params: Record<string, unknown>) => Promise<void> }) {
  const [sourcePath, setSourcePath] = useState("");
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold text-text">插件中心</h2>
        <p className="text-sm text-text-muted">
          可信 Node 模式仅隔离崩溃和误操作；恶意代码隔离必须使用 Docker。
        </p>
      </div>
      <div className="glass flex gap-2 p-4">
        <input
          className="min-w-0 flex-1 rounded-xl border border-line bg-black/30 px-3 py-2 text-sm text-text outline-none placeholder:text-text-muted"
          value={sourcePath}
          onChange={(event) => setSourcePath(event.target.value)}
          placeholder="插件目录（含 harness-plugin.json）"
        />
        <BuiButton
          variant="primary"
          size="sm"
          disabled={!sourcePath.trim()}
          onClick={() => void action("plugins.install", { sourcePath })}
        >
          检查并安装
        </BuiButton>
      </div>
      {plugins.length === 0 ? (
        <Empty label="尚未安装插件" />
      ) : (
        plugins.map((plugin) => (
          <article
            className="glass flex items-start gap-3 p-4"
            key={plugin.manifest.id}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-sm font-semibold text-accent-text">
              P
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold text-text">
                {plugin.manifest.name}
                <small className="ml-2 text-xs text-text-muted">
                  v{plugin.manifest.version}
                </small>
              </h3>
              <p className="mt-0.5 text-sm text-text-muted">
                {plugin.manifest.tools.map((tool) => tool.name).join(", ") ||
                  "无工具"}
              </p>
              <code className="mt-1 block truncate font-mono text-[11px] text-text-muted">
                {plugin.manifest.contentHash.slice(0, 16)}…
              </code>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <BuiBadge tone={plugin.enabled ? "success" : plugin.trustedHash ? "info" : "neutral"}>
                {plugin.enabled ? "已启用" : plugin.trustedHash ? "已信任" : "待信任"}
              </BuiBadge>
              {!plugin.trustedHash && (
                <BuiButton
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void action("plugins.trust", {
                      pluginId: plugin.manifest.id,
                      grant: {
                        pathGlobs: [],
                        networkDomains: [],
                        allowProcesses: false,
                        mode: plugin.manifest.requestedGrant.mode,
                      },
                    })
                  }
                >
                  信任{" "}
                  {plugin.manifest.requestedGrant.mode === "untrusted_docker"
                    ? "Docker 隔离"
                    : "本地模式"}
                </BuiButton>
              )}
              {plugin.trustedHash && (
                <BuiButton
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void action(
                      plugin.enabled ? "plugins.disable" : "plugins.enable",
                      { pluginId: plugin.manifest.id },
                    )
                  }
                >
                  {plugin.enabled ? "禁用" : "启用"}
                </BuiButton>
              )}
            </div>
          </article>
        ))
      )}
    </div>
  );
}

function TraceView({
  events,
  runId,
}: {
  events: AgentEvent[];
  runId?: string;
}) {
  const [typeFilter, setTypeFilter] = useState("");
  const [records, setRecords] = useState<Array<{ id: string; runId?: string; type: string; at: string; attributes: Record<string, unknown> }>>([]);
  useEffect(() => {
    void window.harness.request<typeof records>({ method: "trace.query", params: { ...(runId ? { runId } : {}), ...(typeFilter ? { type: typeFilter } : {}), limit: 500 } }).then(setRecords).catch(() => setRecords([]));
  }, [runId, typeFilter, events.length]);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold text-text">运行追踪</h2>
        <p className="text-sm text-text-muted">
          {runId ?? "尚未开始运行"} · 不记录私有思维链或密钥。
        </p>
        <input
          className="mt-2 w-full max-w-sm rounded-xl border border-line bg-black/30 px-3 py-2 text-sm text-text outline-none placeholder:text-text-muted"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
          placeholder="按事件类型筛选，例如 verification_finished"
        />
      </div>
      <div className="glass overflow-hidden">
        <header className="grid grid-cols-[3rem_5rem_14rem_1fr] gap-2 border-b border-line bg-white/5 px-4 py-2 text-[10px] font-semibold tracking-widest text-text-muted">
          <span>SEQ</span>
          <span>TIME</span>
          <span>TYPE</span>
          <span>DETAIL</span>
        </header>
        {records.map((record, index) => (
          <div
            className="grid grid-cols-[3rem_5rem_14rem_1fr] gap-2 border-b border-line/60 px-4 py-2 last:border-b-0"
            key={record.id}
          >
            <span className="font-mono text-xs text-text-muted">{index}</span>
            <span className="text-xs text-text-muted">
              {new Date(record.at).toLocaleTimeString()}
            </span>
            <span className="truncate font-mono text-xs text-accent-text">
              {record.type}
            </span>
            <code className="truncate font-mono text-xs text-text-muted">
              {JSON.stringify(record.attributes).slice(0, 260)}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsView({ refresh, refreshHistory }: { refresh: () => Promise<void>; refreshHistory: () => Promise<void> }) {
  const [pairing, setPairing] = useState<string>();
  const [credentials, setCredentials] = useState<Record<string, boolean>>({});
  const [credentialValue, setCredentialValue] = useState("");
  const [credentialName, setCredentialName] = useState("OPENAI_API_KEY");
  const [credentialMessage, setCredentialMessage] = useState("");
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>({
    openaiCompatibleBaseUrl: "",
    openaiCompatibleModel: "",
  });
  const [providerMessage, setProviderMessage] = useState("");
  const [searchStatus, setSearchStatus] = useState<{ healthy: boolean; detail?: string }>();
  useEffect(() => {
    void window.harness
      .credentialStatus()
      .then(setCredentials)
      .catch(() => setCredentials({}));
    void window.harness
      .providerSettings()
      .then(setProviderSettings)
      .catch((error) =>
        setProviderMessage(
          error instanceof Error ? error.message : String(error),
        ),
      );
    void window.harness.request<{ healthy: boolean; detail?: string }>({ method: "search.status" }).then(setSearchStatus).catch(() => setSearchStatus({ healthy: false, detail: "agentd unavailable" }));
  }, []);
  async function createPairing(connector: "telegram" | "feishu") {
    try {
      const result = await window.harness.request<{ code: string }>({
        method: "connectors.pairing",
        params: { connector },
      });
      setPairing(`${connector}: ${result.code}`);
    } catch (error) {
      setPairing(error instanceof Error ? error.message : String(error));
    }
  }
  async function saveCredential() {
    try {
      const next = await window.harness.setCredential(
        credentialName,
        credentialValue,
      );
      setCredentials(next);
      setCredentialValue("");
      setCredentialMessage(
        "已写入 Windows Credential Locker，agentd 已重新加载",
      );
    } catch (error) {
      setCredentialMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  async function removeCredential() {
    try {
      setCredentials(await window.harness.deleteCredential(credentialName));
      setCredentialMessage("凭据已删除");
    } catch (error) {
      setCredentialMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  async function saveCompatibleProvider() {
    setProviderMessage("");
    try {
      const saved = await window.harness.setProviderSettings(providerSettings);
      setProviderSettings(saved);
      setProviderMessage(
        saved.openaiCompatibleBaseUrl
          ? "已保存并重新加载 agentd"
          : "OpenAI-compatible 已禁用",
      );
    } catch (error) {
      setProviderMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return (
    <div className="grid grid-cols-2 gap-3">
      <RecycleBin onChanged={refreshHistory} />
      <article className="glass flex flex-col gap-2 p-4">
        <small className="text-[10px] font-semibold tracking-widest text-accent-text">
          PARALLEL SEARCH
        </small>
        <h3 className="text-sm font-semibold text-text">网页搜索</h3>
        <p className="text-xs text-text-muted">
          密钥使用上方 PARALLEL_API_KEY 保存。搜索摘录标记为不可信；含仓库内容的查询会触发数据外发审批。
        </p>
        <code className="mt-auto rounded-lg bg-black/30 p-2 font-mono text-[11px] text-text-muted">
          {searchStatus?.healthy
            ? "Parallel Search 已就绪"
            : (searchStatus?.detail ?? "正在检查")}
        </code>
      </article>
      <article className="glass flex flex-col gap-2 p-4">
        <small className="text-[10px] font-semibold tracking-widest text-accent-text">
          MODEL KEYS
        </small>
        <h3 className="text-sm font-semibold text-text">Windows 凭据</h3>
        <p className="text-xs text-text-muted">
          BYOK 密钥只保存在当前 Windows 用户的 Credential Locker 中。
        </p>
        <select
          className="rounded-xl border border-line bg-black/30 px-3 py-2 text-sm text-text outline-none"
          value={credentialName}
          onChange={(event) => setCredentialName(event.target.value)}
        >
          {[
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "GEMINI_API_KEY",
            "OPENAI_COMPATIBLE_API_KEY",
            "PARALLEL_API_KEY",
            "HARNESS_GATEWAY_TOKEN",
          ].map((name) => (
            <option key={name} value={name}>
              {name} {credentials[name] ? "✓" : ""}
            </option>
          ))}
        </select>
        <input
          type="password"
          autoComplete="off"
          className="rounded-xl border border-line bg-black/30 px-3 py-2 text-sm text-text outline-none placeholder:text-text-muted"
          value={credentialValue}
          onChange={(event) => setCredentialValue(event.target.value)}
          placeholder="粘贴密钥（不会回显）"
        />
        <div className="flex gap-2">
          <BuiButton
            variant="primary"
            size="sm"
            disabled={!credentialValue.trim()}
            onClick={() => void saveCredential()}
          >
            安全保存
          </BuiButton>
          <BuiButton
            variant="danger"
            size="sm"
            onClick={() => void removeCredential()}
          >
            删除
          </BuiButton>
        </div>
        {credentialMessage && (
          <small className="text-[11px] text-text-muted">{credentialMessage}</small>
        )}
      </article>
      <article className="glass flex flex-col gap-2 p-4">
        <small className="text-[10px] font-semibold tracking-widest text-accent-text">
          OPENAI-COMPATIBLE
        </small>
        <h3 className="text-sm font-semibold text-text">兼容 API</h3>
        <p className="text-xs text-text-muted">
          填写服务的 API 根地址（通常以 /v1 结尾）和实际模型 ID。两项留空可禁用。
        </p>
        <input
          type="url"
          className="rounded-xl border border-line bg-black/30 px-3 py-2 text-sm text-text outline-none placeholder:text-text-muted"
          value={providerSettings.openaiCompatibleBaseUrl}
          onChange={(event) =>
            setProviderSettings((current) => ({
              ...current,
              openaiCompatibleBaseUrl: event.target.value,
            }))
          }
          placeholder="http://127.0.0.1:11434/v1"
        />
        <input
          className="rounded-xl border border-line bg-black/30 px-3 py-2 text-sm text-text outline-none placeholder:text-text-muted"
          value={providerSettings.openaiCompatibleModel}
          onChange={(event) =>
            setProviderSettings((current) => ({
              ...current,
              openaiCompatibleModel: event.target.value,
            }))
          }
          placeholder="模型 ID，例如 qwen3-coder"
        />
        <BuiButton
          variant="primary"
          size="sm"
          onClick={() => void saveCompatibleProvider()}
        >
          保存并重载
        </BuiButton>
        {providerMessage && (
          <small className="text-[11px] text-text-muted">{providerMessage}</small>
        )}
      </article>
      <article className="glass flex flex-col gap-2 p-4">
        <small className="text-[10px] font-semibold tracking-widest text-accent-text">
          MESSAGING
        </small>
        <h3 className="text-sm font-semibold text-text">远程入口</h3>
        <p className="text-xs text-text-muted">
          配对后的 Telegram/飞书用户可以创建任务、查看状态和处理审批。
        </p>
        <div className="flex gap-2">
          <BuiButton
            variant="secondary"
            size="sm"
            onClick={() => void createPairing("telegram")}
          >
            Telegram 配对码
          </BuiButton>
          <BuiButton
            variant="secondary"
            size="sm"
            onClick={() => void createPairing("feishu")}
          >
            飞书配对码
          </BuiButton>
        </div>
        {pairing && (
          <code className="mt-auto rounded-lg bg-black/30 p-2 font-mono text-[11px] text-text-muted">
            {pairing}
          </code>
        )}
      </article>
      <article className="glass flex flex-col gap-2 p-4">
        <small className="text-[10px] font-semibold tracking-widest text-accent-text">
          TEAM GATEWAY
        </small>
        <h3 className="text-sm font-semibold text-text">自托管模型网关</h3>
        <p className="text-xs text-text-muted">
          在 Profile 中配置 Gateway URL 与设备令牌。网关默认只保存用量审计。
        </p>
        <code className="mt-auto rounded-lg bg-black/30 p-2 font-mono text-[11px] text-text-muted">
          docker compose up --build
        </code>
      </article>
      <article className="glass flex flex-col gap-2 p-4">
        <small className="text-[10px] font-semibold tracking-widest text-accent-text">
          DIAGNOSTICS
        </small>
        <h3 className="text-sm font-semibold text-text">运行时状态</h3>
        <p className="text-xs text-text-muted">
          刷新 Profile、任务、记忆、技能和审批缓存。
        </p>
        <BuiButton variant="primary" size="sm" onClick={() => void refresh()}>
          刷新数据
        </BuiButton>
      </article>
    </div>
  );
}

function CropOverlay({
  capture,
  onCancel,
  onConfirm,
}: {
  capture: { dataUrl: string; width: number; height: number };
  onCancel: () => void;
  onConfirm: (base64: string) => void;
}) {
  const [start, setStart] = useState<{ x: number; y: number }>();
  const [end, setEnd] = useState<{ x: number; y: number }>();
  const selection =
    start && end
      ? {
          left: Math.min(start.x, end.x),
          top: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
        }
      : undefined;
  async function confirm(image: HTMLImageElement) {
    if (!selection || selection.width < 4 || selection.height < 4) return;
    const scaleX = capture.width / image.clientWidth;
    const scaleY = capture.height / image.clientHeight;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(selection.width * scaleX);
    canvas.height = Math.round(selection.height * scaleY);
    canvas
      .getContext("2d")!
      .drawImage(
        image,
        selection.left * scaleX,
        selection.top * scaleY,
        selection.width * scaleX,
        selection.height * scaleY,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    onConfirm(canvas.toDataURL("image/png").split(",")[1] ?? "");
  }
  return (
    <div className="crop-overlay">
      <div className="crop-toolbar">
        拖动选择截图区域 <BuiButton variant="ghost" size="sm" onClick={onCancel}>取消</BuiButton>
      </div>
      <div className="crop-stage">
        <img
          id="capture-image"
          src={capture.dataUrl}
          draggable={false}
          onPointerDown={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setStart({
              x: event.clientX - rect.left,
              y: event.clientY - rect.top,
            });
            setEnd(undefined);
          }}
          onPointerMove={(event) => {
            if (!start || event.buttons !== 1) return;
            const rect = event.currentTarget.getBoundingClientRect();
            setEnd({
              x: event.clientX - rect.left,
              y: event.clientY - rect.top,
            });
          }}
        />
        {selection && <div className="crop-selection" style={selection} />}
      </div>
      <BuiButton
        variant="primary"
        className="crop-confirm"
        disabled={!selection}
        onClick={() =>
          void confirm(
            document.querySelector<HTMLImageElement>("#capture-image")!,
          )
        }
      >
        使用所选区域
      </BuiButton>
    </div>
  );
}

function Icon({ name }: { name: Tab }) {
  const map: Record<Tab, React.ReactNode> = {
    chat: <MessageSquare size={16} />,
    tasks: <SquareKanban size={16} />,
    approvals: <ShieldCheck size={16} />,
    plan: <ClipboardList size={16} />,
    memory: <Brain size={16} />,
    skills: <Sparkles size={16} />,
    plugins: <Puzzle size={16} />,
    profiles: <UserCog size={16} />,
    trace: <Activity size={16} />,
    settings: <Settings size={16} />,
  };
  return <span className="nav-icon">{map[name]}</span>;
}
function Empty({ label }: { label: string }) {
  return <div className="glass px-4 py-6 text-center text-sm text-text-muted">{label}</div>;
}
function tabLabel(tab: Tab): string {
  return {
    chat: "会话",
    tasks: "任务板",
    approvals: "审批",
    plan: "计划与验证",
    memory: "记忆",
    skills: "技能",
    plugins: "插件",
    profiles: "Profile",
    trace: "追踪",
    settings: "设置",
  }[tab];
}
function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
function fileBase64(file: File): Promise<string> {
  return new Promise((resolveFile, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () =>
      resolveFile(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

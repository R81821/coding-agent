import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
} from "react";
import { VirtualConversation, ConversationPositions, useRowState, useSessionContent, type ConversationPosition } from "@harness/conversation-ui";
import { createRoot } from "react-dom/client";
import type {
  AgentEvent,
  DaemonRequestInput,
  ApprovalRequest,
  MemoryRecord,
  ModelDescriptor,
  ReasoningEffort,
  PlanSpec,
  PluginRecord,
  Profile,
  ProjectRecord,
  RunCheckpoint,
  RunSpec,
  RunWithdrawal,
  RunStatus,
  RunSteerResult,
  SessionView,
  SessionDetail,
  RunEventPage,
  SessionPage,
  SessionRecord,
  SessionSummary,
  TaskSpec,
} from "@harness/protocol";
import { SessionViewCache, isDeferredOutput, refreshSessionView, mergeViewEvents, newId, nowIso } from "@harness/protocol";
import type { DesktopAttachment } from "./preload.js";
import { restoreWithdrawnDraft, type ComposerDraft } from "./withdrawal-draft.js";
import { BuiBadge } from "./ui/badge.js";
import { BuiButton } from "./ui/button.js";
import { BuiLoadingState } from "./ui/loading-state.js";
import { BuiPromptBar } from "./ui/prompt-bar.js";
import { BuiSidebarNav } from "./ui/sidebar-nav.js";
import { MemoryManager } from "./memory-manager.js";
import { MarkdownMessage } from "./markdown-message.js";
import { ConversationProcessSummary, conversationDurationMs, terminalConversationStatus } from "./components/ConversationProcess.js";
import { shouldExpandToolGroup, shouldPreviewProcessText, shouldShowHistoryLoading, summarizeActivityMessage } from "./conversation-layout.js";
import { buildConversationStream, type ConversationStreamItem, type ToolTimelineItem } from "./conversation-stream.js";
import { WorkflowProgress } from "./components/WorkflowProgress.js";
import { SessionCacheStats } from "./components/SessionCacheStats.js";
import { RunStopCard } from "./components/RunStopCard.js";
import { FinalReportStatus } from "./components/FinalReportStatus.js";
import { McpView } from "./components/McpView.js";
import { McpInteractions } from "./components/McpInteractions.js";
import { groupSessionsByProject, isLiveRun, latestConversationRun, eligibleWithdrawalRun, mergeRunEvents, mergeSessionPages, runStatusLabel, createSessionTurnSelector, workspaceKey, type SessionTurn } from "./run-history.js";
import {
  Activity,
  Bug,
  Brain,
  BookOpen,
  Camera,
  ChevronDown,
  Circle,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  CirclePause,
  CircleX,
  ClipboardList,
  Clock3,
  FolderOpen,
  Hammer,
  Image as ImageIcon,
  LoaderCircle,
  type LucideIcon,
  MessageSquare,
  Monitor,
  PanelLeft,
  Pencil,
  FilePlus,
  Plus,
  Puzzle,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareKanban,
  SquarePen,
  Terminal,
  RotateCcw,
  TriangleAlert,
  Telescope,
  Trash2,
  Undo2,
  UserCog,
  X,
} from "lucide-react";
const SettingsView = lazy(() => import("./components/settings/SettingsView.js").then(module => ({ default: module.SettingsView })));
import { useAppearance } from "./use-appearance.js";
import { THEMES, applyTheme, isThemeId, readTheme, saveTheme, watchTheme, type ThemeId } from "./theme.js";
import { SIDEBAR_MAX, SIDEBAR_MIN, clampSidebarWidth, readSidebarWidth, saveSidebarWidth } from "./layout-preferences.js";
import "./styles.css";
import "./tailwind.css";
import "./workbench.css";
import "./themes.css";
import "./code-changes.css";
import "./components/settings/settings.css";
import "./appearance.css";
const CodeChanges = lazy(() => import("./components/CodeChanges.js").then(module => ({ default: module.CodeChanges })));
import { InlineReview, type RunReview } from "./components/InlineReview.js";
import { ToolContext } from "./components/ToolContext.js";
import { CapabilitiesRow } from "./components/CapabilitiesRow.js";
import { defaultConversationLayout } from "./conversation-layout.js";
import { toolActivity, toolSummary } from "./tool-summary.js";
import { useConfirmation } from "./components/DecisionDialog.js";
import { ApprovalDialog } from "./components/ApprovalDialog.js";
import { ApprovalContent } from "./components/ApprovalContent.js";
import { DesktopChrome } from "./components/DesktopChrome.js";
import { SkillsView, SkillPicker, type DesktopSkill } from "./components/SkillsView.js";
import { BrowserPanel } from "./components/BrowserPanel.js";
import { ProfileGenerationEditor } from "./components/ProfileGenerationEditor.js";
import { ProfileVerificationEditor } from "./components/ProfileVerificationEditor.js";
import { ModelReasoningPicker } from "./components/ModelReasoningPicker.js";
import { Unlock } from "./components/Unlock.js";

type Tab =
  | "chat"
  | "tasks"
  | "changes"
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

const sessionStatusIcons: Record<RunStatus | "new", LucideIcon> = {
  queued: Clock3,
  planning: LoaderCircle,
  running: LoaderCircle,
  waiting_approval: CircleHelp,
  paused: CirclePause,
  verifying: LoaderCircle,
  review: CircleHelp,
  completed: CircleCheck,
  failed: CircleX,
  cancelled: CircleMinus,
  new: Circle,
};

function SessionStatusMarker({ status }: { status: RunStatus | undefined }) {
  const key = status ?? "new";
  const Icon = sessionStatusIcons[key];
  const label = status ? runStatusLabel[status] : "新会话";
  return <span className={`session-status session-status-${key}`} title={label} aria-hidden="true"><Icon size={16} /></span>;
}

const initialTheme = readTheme();
applyTheme(initialTheme);

function App() {
  const { confirm, confirmationDialog } = useConfirmation();
  const [theme, setTheme] = useState<ThemeId>(initialTheme);
  const [themeSaved, setThemeSaved] = useState(true);
  useEffect(() => watchTheme(theme), [theme]);
  const appearance = useAppearance(theme);
  function changeTheme(next: ThemeId) {
    setTheme(next);
    setThemeSaved(saveTheme(next));
  }
  const [unlocked, setUnlocked] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [rememberDevice, setRememberDevice] = useState(false);
  const [unlockError, setUnlockError] = useState("");
  const [tab, setTab] = useState<Tab>("chat");
  const skillsVisited = useRef(false);
  if (tab === "skills") skillsVisited.current = true;
  const previousWorkbenchTab = useRef<Tab>("chat");
  useEffect(() => {
    if (tab !== "settings") previousWorkbenchTab.current = tab;
  }, [tab]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [workspace, setWorkspace] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("default");
  const [tasks, setTasks] = useState<TaskSpec[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [skills, setSkills] = useState<DesktopSkill[]>([]);
  const [skillSaving, setSkillSaving] = useState(false);
  const [skillError, setSkillError] = useState("");
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [prompt, setPrompt] = useState("");
  const [taskMode, setTaskMode] = useState<"auto" | "analysis" | "change">("auto");
  const [currentModel, setCurrentModel] = useState<ModelDescriptor>();
  const [modelLoading, setModelLoading] = useState(false);
  const [modelCatalogError, setModelCatalogError] = useState("");
  const [modelError, setModelError] = useState("");
  const [modelSaving, setModelSaving] = useState(false);
  const modelMutation = useRef(false);
  const [modelCatalogVersion, setModelCatalogVersion] = useState(0);
  const [attachments, setAttachments] = useState<DesktopAttachment[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [activeRun, setActiveRun] = useState<string>();
  const [pausedRun, setPausedRun] = useState<string>();
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [withdrawalSessionId, setWithdrawalSessionId] = useState<string>();
  const pendingWithdrawal = useRef<{ sessionId: string; runId: string } | undefined>(undefined);
  const pendingSteering = useRef(new Map<string, { runId: string; text: string }>());
  const [steeringSessions, setSteeringSessions] = useState<Set<string>>(() => new Set());
  const withdrawing = Boolean(activeSessionId && withdrawalSessionId === activeSessionId);
  const [sessionDetail, setSessionDetail] = useState<SessionView>();
  const sessionView = useRef(sessionDetail);
  sessionView.current = sessionDetail;
  const [sessionPage, setSessionPage] = useState<SessionPage>({ items: [], hasMore: false });
  const sessionPageRef = useRef<SessionPage>({ items: [], hasMore: false });
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const historyRequest = useRef(0);
  const viewVersion = useRef(0);
  const sessionCreation = useRef(0);
  const viewCache = useRef(new SessionViewCache());
  const drafts = useRef(new Map<string, ComposerDraft>());
  const submittedDrafts = useRef(new Map<string, ComposerDraft>());
  const composerDraft = useRef({ sessionId: activeSessionId, draft: { prompt, attachments, taskMode } });
  composerDraft.current = { sessionId: activeSessionId, draft: { prompt, attachments, taskMode } };
  const scrollPositions = useRef(new ConversationPositions());
  const [switching, setSwitching] = useState(false);
  const content = useSessionContent(activeSessionId, sessionDetail, setSessionDetail, requestSessionContent, unlocked && !switching && !withdrawing);
  useEffect(() => {
    if (!unlocked) { viewCache.current.clear(); drafts.current.clear(); submittedDrafts.current.clear(); scrollPositions.current.clear(); }
  }, [unlocked]);
  function saveDraft() {
    if (sessionDetail) viewCache.current.set(sessionDetail);
    if (activeSessionId) {
      // Bounded like the other two per-session stores: drafts hold attachment screenshots and are
      // memory-only, so visiting many sessions must not grow this without limit.
      drafts.current.delete(activeSessionId);
      drafts.current.set(activeSessionId, { prompt, attachments, taskMode });
      while (drafts.current.size > 6) drafts.current.delete(drafts.current.keys().next().value!);
    }
  }
  // Highest event sequence already consumed for the active run. Continuing must subscribe from here,
  // never from the start: the previous attempt's `result` event is still in the log, and replaying it
  // makes the follow loop exit immediately as if the run had just finished.
  const lastSequence = useRef(-1);
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
  const reasoningEffort = sessionDetail?.session.reasoningEffort ?? null;
  useEffect(() => { setModelError(""); }, [activeSessionId, profileId]);
  useEffect(() => {
    if (!unlocked || !profiles.some(item => item.id === profileId)) { setCurrentModel(undefined); return; }
    let current = true;
    setCurrentModel(undefined); setModelLoading(true); setModelCatalogError("");
    void window.harness.request<{ model: ModelDescriptor | null; error?: string }>({ method: "model.current", params: { profileId, needsVision: attachments.length > 0 } })
      .then(result => {
        if (!current) return;
        setCurrentModel(result.model ?? undefined);
        setModelCatalogError(result.error ?? "");
      })
      .catch(error => { if (current) setModelCatalogError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (current) setModelLoading(false); });
    return () => { current = false; };
  }, [unlocked, profileId, profiles, modelCatalogVersion, attachments.length]);
  const [selectTurns] = useState(createSessionTurnSelector);
  const conversationTurns = useMemo(() => {
    const localErrors = events.filter(event => event.sequence === Number.MAX_SAFE_INTEGER);
    return selectTurns(sessionDetail).map(turn => turn.runId === activeRun && localErrors.length ? { ...turn, events: [...turn.events, ...localErrors] } : turn);
  }, [selectTurns, sessionDetail, activeRun, events]);
  const continueRef = useRef(continueTask); continueRef.current = continueTask;
  const continueFromRow = useCallback((runId: string, note: string) => continueRef.current(runId, note), []);
  // The controls follow the run's recorded status rather than the polling flag: a run can be
  // parked on an approval, or still be in the engine's active set, without this component polling.
  const activeRunStatus = conversationTurns.find((turn) => turn.runId === activeRun)?.status;
  // Plan and trace read the selected run's whole record. `events` only carries the session view's short
  // preview plus whatever the live follow merged, so take the hydrated turn instead.
  const activeRunEvents = conversationTurns.find((turn) => turn.runId === activeRun)?.events ?? events;
  const runParked = activeRunStatus === "paused" || activeRunStatus === "waiting_approval";
  const composerEffort = (busy || runParked || pausedRun) && activeRun
    ? sessionDetail?.runs.find(run => run.spec.id === activeRun)?.spec.reasoningEffort ?? null
    : reasoningEffort;
  const canPauseRun = Boolean(activeRun) && Boolean(activeRunStatus) && isLiveRun(activeRunStatus!);
  const withdrawableRun = eligibleWithdrawalRun(sessionDetail);
  useEffect(() => {
    if (switching || withdrawing || busy || sessionDetail?.session.id !== activeSessionId) return;
    const selected = sessionDetail?.runs.find(run => run.spec.id === activeRun);
    // The first history page may consist entirely of delegated runs. Adopt its parent once
    // hydration reaches it, while retaining a newly submitted or already selected main run.
    if (activeRun && (!selected || selected.spec.parentRunId === undefined)) return;
    const latest = sessionDetail && latestConversationRun(sessionDetail.runs);
    if (!latest) return;
    setActiveRun(latest.spec.id);
    setEvents(latest.events);
    setPausedRun(latest.status === "paused" ? latest.spec.id : undefined);
    lastSequence.current = latest.view?.lastSequence ?? latest.events.at(-1)?.sequence ?? -1;
    if (isLiveRun(latest.status)) {
      const viewToken = viewVersion.current;
      setBusy(true);
      void pollRun(latest.spec.id, lastSequence.current, viewToken)
        .then(status => { if (viewToken === viewVersion.current && status === "paused") setPausedRun(latest.spec.id); })
        .catch(error => { if (viewToken === viewVersion.current) setHistoryError(`无法继续读取运行记录：${error instanceof Error ? error.message : String(error)}`); })
        .finally(() => { if (viewToken === viewVersion.current) { setBusy(false); void refreshHistory(); } });
    }
  }, [activeSessionId, sessionDetail, activeRun, switching, withdrawing, busy]);
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
  }, [sessionPage.items]);

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

  const workspaceRef = useRef(workspace); workspaceRef.current = workspace;
  const refresh = useCallback(async () => {
    viewCache.current.clear();
    const path = workspaceRef.current;
    const [nextProfiles, nextTasks, nextApprovals, nextMemories, nextPlugins] =
      await Promise.all([
        window.harness.request<Profile[]>({ method: "profiles.list" }),
        window.harness.request<TaskSpec[]>({ method: "tasks.list" }),
        window.harness.request<ApprovalRequest[]>({ method: "approvals.list" }),
        window.harness.request<MemoryRecord[]>({ method: "memory.list" }),
        window.harness.request<PluginRecord[]>({ method: "plugins.list" }),
      ]);
    setProfiles(nextProfiles);
    setTasks(nextTasks);
    setApprovals(nextApprovals);
    setMemories(nextMemories);
    setPlugins(nextPlugins);
    const nextSkills = await window.harness.request<DesktopSkill[]>({ method: "skills.list", ...(path ? { params: { workspacePath: path } } : {}) });
    if (workspaceRef.current === path) setSkills(nextSkills);
  }, []);

  useEffect(() => {
    if (!unlocked) return;
    let current = true;
    setSkills([]);
    void window.harness.request<DesktopSkill[]>({ method: "skills.list", ...(workspace ? { params: { workspacePath: workspace } } : {}) })
      .then(items => { if (current) setSkills(items); })
      .catch(error => { if (current) setSkillError(String(error)); });
    return () => { current = false; };
  }, [unlocked, workspace]);

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

  /**
   * Offer the built-in project conventions when the repository has none, then run the trust dialog.
   * Trust stays a separate, explicit confirmation: the file is written first and reviewed after.
   */
  async function reviewProjectInstructions(workspacePath: string, token: number) {
    type Inspection = { files: Array<{ path: string; sha256: string; content: string }>; trusted: boolean; changed: boolean };
    const inspect = () => window.harness.request<Inspection>({ method: "project.inspect", params: { workspacePath } });
    let inspection = await inspect();
    if (token !== viewVersion.current) return;
    if (inspection.files.length === 0) {
      if (!window.confirm("该仓库还没有项目约束文件 (AGENTS.md)。用 Harness 内置约束创建一份吗？\n\n创建后可以先看内容，再决定是否信任。")) return;
      try {
        await window.harness.request({ method: "project.scaffold", params: { workspacePath } });
      } catch (error) {
        setHistoryError(`无法创建 AGENTS.md：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (token !== viewVersion.current) return;
      inspection = await inspect();
    }
    if (!inspection.files.length || (inspection.trusted && !inspection.changed)) return;
    if (token !== viewVersion.current) return;
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
          workspacePath,
          files: inspection.files.map(({ path, sha256 }) => ({
            path,
            sha256,
          })),
        },
      });
    }
  }

  async function chooseWorkspace() {
    const token = viewVersion.current;
    const selected = await window.harness.chooseWorkspace();
    if (!selected || token !== viewVersion.current) return;
    await reviewProjectInstructions(selected, token);
    if (token !== viewVersion.current) return;
    await createSessionForWorkspace(selected);
  }

  async function createSessionForWorkspace(workspacePath: string, initialPrompt = "") {
    if (!profile) return;
    saveDraft();
    const token = viewVersion.current;
    const creation = ++sessionCreation.current;
    setSwitching(true);
    setHistoryError("");
    let session: SessionRecord;
    try {
      const deletedProjects = await window.harness.request<ProjectRecord[]>({ method: "projects.list", params: { deleted: true } });
      const archivedProject = deletedProjects.find((project) => workspaceKey(project.workspacePath) === workspaceKey(workspacePath));
      if (archivedProject) await window.harness.request({ method: "project.restore", params: { projectId: archivedProject.id } });
      const createdAt = nowIso();
      session = await window.harness.request<SessionRecord>({
        method: "sessions.create",
        params: { id: newId("session"), workspacePath, profileId: profile.id, title: "新会话", createdAt, updatedAt: createdAt },
      });
    } catch (error) {
      if (token === viewVersion.current && creation === sessionCreation.current) {
        setSwitching(false);
        setHistoryError(`无法新建会话：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (token !== viewVersion.current || creation !== sessionCreation.current) {
      // Another action took over the view, or a newer creation owns the flag. Release only what this call set.
      if (creation === sessionCreation.current) setSwitching(false);
      void refreshHistory(); return;
    }
    // Keep following the old run until creation succeeds; failure must not strand its UI.
    viewVersion.current++;
    setBusy(false);
    setSwitching(false);
    setTab("chat");
    setWorkspace(session.workspacePath);
    setProfileId(session.profileId);
    setActiveSessionId(session.id);
    setSessionDetail({ session, runs: [], hasMore: false });
    setTaskMode("auto");
    setActiveRun(undefined);
    lastSequence.current = -1;
    setEvents([]);
    setPrompt(initialPrompt);
    setAttachments([]);
    setApprovalPrompt(undefined);
    localStorage.setItem("harness.activeSessionId", session.id);
    await refreshHistory();
    return session;
  }

  async function applyMcpContent(text: string) {
    if (!text.trim() || switching || withdrawing) return;
    if (!activeSessionId) {
      if (!workspace || !profile) { setHistoryError("请先选择项目和 Profile"); return; }
      await createSessionForWorkspace(workspace, text);
      return;
    }
    setPrompt(current => current.trim() ? current + "\n\n" + text : text);
    setTab("chat");
  }

  async function chooseImages() {
    if (!profile || pendingWithdrawal.current?.sessionId === activeSessionId) return;
    const token = viewVersion.current;
    const selected = await window.harness.chooseImages(
      profile.allowedProviders,
    );
    if (token === viewVersion.current) setAttachments((current) => [...current, ...selected]);
  }

  async function addBrowserFile(
    file: File,
    source: "clipboard" | "screenshot",
  ) {
    const token = viewVersion.current;
    if (
      !profile || pendingWithdrawal.current?.sessionId === activeSessionId ||
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
    if (token === viewVersion.current) setAttachments((current) => [...current, result]);
  }

  async function send() {
    if (skillSaving || modelMutation.current || switching || pendingWithdrawal.current?.sessionId === activeSessionId) return;
    if (activeSessionId && pendingSteering.current.has(activeSessionId)) return;
    if (!prompt.trim()) return;
    // A paused task accepts the new user turn and resumes with it. Keep the same transcript,
    // workspace baseline and permissions throughout the conversation.
    if (activeRun && (isLiveRun(activeRunStatus ?? "queued") || activeRunStatus === "paused")) {
      await steerRun(prompt);
      return;
    }
    if (!profile || !workspace || !activeSessionId || !sessionDetail || busy) return;
    if (reasoningEffort && (modelLoading || !currentModel?.capabilities.reasoningEfforts?.includes(reasoningEffort))) {
      setModelError(modelLoading ? "正在读取模型设置，请稍后发送" : "设置中的模型不支持此推理强度，请选择可用档位或更改模型设置");
      return;
    }
    const viewToken = ++viewVersion.current;
    const request = prompt.trim();
    const submitted = { prompt, attachments, taskMode };
    const runId = newId("run");
    const runSpec: RunSpec = {
      id: runId,
      sessionId: activeSessionId,
      request,
      taskMode,
      reasoningEffort,
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
    setPausedRun(undefined);
    lastSequence.current = -1;
    setSessionDetail((current) => current ? { ...current, runs: [...current.runs, { spec: runSpec, status: "queued", events: [] }] } : current);
    try {
      await window.harness.request({
        method: "run.start",
        params: runSpec,
      });
      submittedDrafts.current.set(runId, submitted);
      while (submittedDrafts.current.size > 6) submittedDrafts.current.delete(submittedDrafts.current.keys().next().value!);
      void refreshHistory();
      const submittedDraft = drafts.current.get(activeSessionId);
      if (submittedDraft?.prompt.trim() === request) drafts.current.delete(activeSessionId);
      if (viewToken !== viewVersion.current) return;
      setPrompt("");
      setAttachments([]);
      const status = await pollRun(runId, -1, viewToken);
      if (viewToken === viewVersion.current && status === "paused") setPausedRun(runId);
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
    if (!profile) return;
    setHistoryError("");
    if (!workspace) {
      await chooseWorkspace();
      return;
    }
    await createSessionForWorkspace(workspace);
  }

  async function deleteSession(item: SessionSummary) {
    if (busy || !await confirm({title:"删除这个会话？",description:"会话将移到设置中的已删除会话，可随时恢复。长期记忆会保留。",subject:item.title,confirmLabel:"删除会话",status:"可恢复"})) return;
    setHistoryError("");
    const token = viewVersion.current;
    try {
      await window.harness.request({ method: "session.delete", params: { sessionId: item.id } });
      viewCache.current.delete(item.id); drafts.current.delete(item.id); scrollPositions.current.delete(item.id);
      setRecycleVersion((current) => current + 1);
      const nextPage = { ...sessionPageRef.current, items: sessionPageRef.current.items.filter((session) => session.id !== item.id) };
      sessionPageRef.current = nextPage;
      setSessionPage(nextPage);
      if (activeSessionId === item.id && token === viewVersion.current) {
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
    if (busy || !await confirm({title:"删除这个项目？",description:"项目将从 Harness 隐藏。磁盘中的代码与文件不会被删除，会话和记忆也会保留。",subject:project.workspacePath,confirmLabel:"删除项目",status:"仅从列表隐藏"})) return;
    setHistoryError("");
    const token = viewVersion.current;
    try {
      await window.harness.request({ method: "project.delete", params: { projectId: project.id } });
      viewCache.current.clear(); drafts.current.clear(); scrollPositions.current.clear();
      setRecycleVersion((current) => current + 1);
      setProjects((current) => current.filter((item) => item.id !== project.id));
      const nextPage = { ...sessionPageRef.current, items: sessionPageRef.current.items.filter((session) => workspaceKey(session.workspacePath) !== workspaceKey(project.workspacePath)) };
      sessionPageRef.current = nextPage;
      setSessionPage(nextPage);
      if (workspaceKey(workspace) === workspaceKey(project.workspacePath) && token === viewVersion.current) {
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
    if (activeSessionId === item.id && !historyError && !switching) { setTab("chat"); return; }
    saveDraft();
    const viewToken = ++viewVersion.current;
    setSwitching(true); setBusy(false); setHistoryError("");
    setTab("chat"); setWorkspace(item.workspacePath); setProfileId(item.profileId);
    setActiveSessionId(item.id); setApprovalPrompt(undefined); setPausedRun(undefined);
    const draft = drafts.current.get(item.id);
    setPrompt(draft?.prompt ?? ""); setAttachments(draft?.attachments ?? []); setTaskMode(draft?.taskMode ?? "auto");
    const cached = viewCache.current.get(item.id);
    setSessionDetail(cached);
    const cachedRun = cached && latestConversationRun(cached.runs);
    setActiveRun(cachedRun?.spec.id); setEvents(cachedRun?.events ?? []);
    localStorage.setItem("harness.activeSessionId", item.id);
    try {
      const stored = await window.harness.request<SessionView | undefined>({ method: "session.view", params: { limit: 20, sessionId: item.id } });
      if (viewToken !== viewVersion.current) return;
      if (!stored) throw new Error("该会话不存在或已被删除");
      const latest = latestConversationRun(stored.runs);
      setSessionDetail(refreshSessionView(cached, stored)); setActiveRun(latest?.spec.id); setEvents(latest?.events ?? []);
      setPausedRun(latest?.status === "paused" ? latest.spec.id : undefined);
      lastSequence.current = latest?.view?.lastSequence ?? latest?.events.at(-1)?.sequence ?? -1;
      if (!draft) setTaskMode(latest?.spec.taskMode ?? "auto");
      setSwitching(false);
      if (latest && isLiveRun(latest.status)) {
        setBusy(true);
        // Following a live run can outlast the open itself. A read failing here must not be mistaken
        // for a failed open: report it and keep the conversation, its draft and its scroll position.
        try {
          const status = await pollRun(latest.spec.id, lastSequence.current, viewToken);
          if (viewToken === viewVersion.current && status === "paused") setPausedRun(latest.spec.id);
        } catch (error) {
          if (viewToken === viewVersion.current) setHistoryError(`无法继续读取运行记录：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      if (viewToken === viewVersion.current) {
        viewCache.current.delete(item.id); drafts.current.delete(item.id); scrollPositions.current.delete(item.id); setSessionDetail(undefined); setEvents([]); setActiveRun(undefined);
        setHistoryError("无法打开历史记录：" + (error instanceof Error ? error.message : String(error)));
      }
    } finally {
      if (viewToken === viewVersion.current) { setSwitching(false); setBusy(false); }
    }
  }

  /** Ask the active run to stop at its next turn boundary. It stays resumable, unlike cancel. */
  async function pauseRun() {
    if (!activeRun || pendingWithdrawal.current?.sessionId === activeSessionId) return;
    try {
      const result = await window.harness.request<{ pausing: boolean }>({ method: "run.pause", params: { runId: activeRun } });
      if (!result.pausing) setPausedRun(undefined);
    } catch (error) { setHistoryError(`无法暂停：${error instanceof Error ? error.message : String(error)}`); }
  }

  async function continueTask(runId: string, note: string) {
    if (pendingWithdrawal.current?.sessionId === activeSessionId) return;
    const viewToken = ++viewVersion.current;
    setBusy(true);
    try {
      const result = await window.harness.request<{ runId: string }>({ method: "run.continue", params: { runId, ...(note.trim() ? { note: note.trim() } : {}) } });
      if (viewToken !== viewVersion.current) return;
      setActiveRun(result.runId); setPausedRun(undefined); setEvents([]); lastSequence.current = -1;
      if (activeSessionId) {
        const detail = await window.harness.request<SessionView>({ method: "session.view", params: { limit: 20, sessionId: activeSessionId } });
        if (viewToken !== viewVersion.current) return;
        setSessionDetail(detail);
      }
      const status = await pollRun(result.runId, -1, viewToken);
      if (viewToken === viewVersion.current && status === "paused") setPausedRun(result.runId);
      await refreshHistory();
    } catch (error) {
      if (viewToken === viewVersion.current) setHistoryError(`无法续办：${error instanceof Error ? error.message : String(error)}`);
    } finally { if (viewToken === viewVersion.current) setBusy(false); }
  }

  /** Continue a paused run from its checkpoint, then follow the events that follow. */
  async function resumeRun() {
    if (pendingWithdrawal.current?.sessionId === activeSessionId) return;
    if (activeSessionId && pendingSteering.current.has(activeSessionId)) return;
    const runId = pausedRun ?? activeRun;
    if (!runId) return;
    const viewToken = ++viewVersion.current;
    setBusy(true);
    setPausedRun(undefined);
    setActiveRun(runId);
    try {
      await window.harness.request({ method: "run.resume", params: { runId } });
      // The engine accepted the resume, so the run is working again. Reflect that immediately instead
      // of waiting for the next poll to refresh the stored status — the follow loop may already have
      // exited on the previous attempt's terminal event and would never refresh it.
      if (viewToken === viewVersion.current) {
        setSessionDetail((current) => current ? {
          ...current,
          runs: current.runs.map((run) => run.spec.id === runId ? { ...run, status: "running" as RunStatus } : run),
        } : current);
      }
      // Follow from the last event already shown. Replaying the log would re-read this run's previous
      // `result` and stop the loop before a single new event arrives.
      const status = await pollRun(runId, lastSequence.current, viewToken);
      if (viewToken === viewVersion.current && status === "paused") setPausedRun(runId);
    } catch (error) {
      if (viewToken === viewVersion.current) setHistoryError(`无法继续：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (viewToken === viewVersion.current) setBusy(false);
      await refreshHistory();
    }
  }

  async function withdrawRun(messageId?: string) {
    const eligible = eligibleWithdrawalRun(sessionDetail);
    if (!activeSessionId || !eligible || pendingWithdrawal.current || pendingSteering.current.has(activeSessionId) || switching || busy || modelMutation.current || skillSaving) return;
    const sessionId = activeSessionId;
    const operation = { sessionId, runId: eligible.spec.id };
    const initialDraft = composerDraft.current.draft;
    pendingWithdrawal.current = operation;
    setWithdrawalSessionId(sessionId);
    setHistoryError("");
    try {
      const result = await window.harness.request<RunWithdrawal>({ method: "run.withdraw", params: { runId: operation.runId, ...(messageId ? { messageId } : {}) } });
      const removed = new Set(result.withdrawnRunIds);
      const currentDraft = composerDraft.current.sessionId === sessionId ? composerDraft.current.draft : drafts.current.get(sessionId) ?? initialDraft;
      const restored = restoreWithdrawnDraft(result.messageId ? { ...result.run, request: result.text ?? "", attachments: [], taskMode: currentDraft.taskMode } : result.run,
        currentDraft, result.messageId ? undefined : submittedDrafts.current.get(operation.runId));
      drafts.current.set(sessionId, restored);
      while (drafts.current.size > 6) drafts.current.delete(drafts.current.keys().next().value!);
      for (const id of removed) submittedDrafts.current.delete(id);
      const cached = viewCache.current.get(sessionId);
      const applyWithdrawal = (view: SessionView) => removeWithdrawnMessage(removeWithdrawnRounds(view, removed), operation.runId, result.messageId);
      if (cached) viewCache.current.set(applyWithdrawal(cached));
      if (composerDraft.current.sessionId === sessionId) {
        // Ignore a follow/page response that was requested before the withdrawal committed.
        viewVersion.current++;
        setBusy(false);
        setSwitching(false);
        setPausedRun(undefined);
        setApprovalPrompt(undefined);
        setPrompt(restored.prompt);
        setAttachments(restored.attachments);
        setTaskMode(restored.taskMode);
        setSessionDetail(current => {
          if (current?.session.id !== sessionId) return current;
          return applyWithdrawal(current);
        });
        const source = sessionView.current?.session.id === sessionId ? sessionView.current : cached;
        const visible = source && applyWithdrawal(source);
        const previous = visible && latestConversationRun(visible.runs.filter(run => !removed.has(run.spec.id)));
        setActiveRun(previous?.spec.id);
        setPausedRun(previous?.status === "paused" ? previous.spec.id : undefined);
        setEvents(previous?.events ?? []);
        lastSequence.current = previous?.view?.lastSequence ?? previous?.events.at(-1)?.sequence ?? -1;
      }
      // Read canonical spending records as well: tokens already consumed remain in the totals.
      try {
        const stored = await window.harness.request<SessionView | undefined>({ method: "session.view", params: { sessionId, limit: 20 } });
        if (stored) {
          const cachedView = viewCache.current.get(sessionId);
          viewCache.current.set(refreshSessionView(cachedView, stored));
          setSessionDetail(current => current?.session.id === sessionId ? refreshSessionView(applyWithdrawal(current), stored) : current);
          if (composerDraft.current.sessionId === sessionId) {
            const latest = latestConversationRun(stored.runs);
            setEvents(latest?.events ?? []);
            lastSequence.current = latest?.view?.lastSequence ?? latest?.events.at(-1)?.sequence ?? -1;
          }
        }
      } catch (error) {
        if (composerDraft.current.sessionId === sessionId) setHistoryError(`对话已撤回，刷新历史失败：${error instanceof Error ? error.message : String(error)}`);
      }
      void refreshHistory();
    } catch (error) {
      if (composerDraft.current.sessionId === sessionId) setHistoryError(`无法撤回：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (pendingWithdrawal.current === operation) {
        pendingWithdrawal.current = undefined;
        setWithdrawalSessionId(undefined);
      }
    }
  }

  /**
   * Add a user turn to the current conversation, automatically resuming a paused task with it.
   */
  async function steerRun(text: string) {
    const value = text.trim();
    const runId = activeRun, sessionId = activeSessionId;
    let viewToken = viewVersion.current;
    const wasPaused = activeRunStatus === "paused" || pausedRun === runId;
    let accepted = false, following = false;
    if (!runId || !sessionId || !value || pendingWithdrawal.current?.sessionId === sessionId || pendingSteering.current.has(sessionId)) return;
    const operation = { runId, text };
    pendingSteering.current.set(sessionId, operation);
    setSteeringSessions(current => new Set(current).add(sessionId));
    const sameView = () => viewToken === viewVersion.current && composerDraft.current.sessionId === sessionId;
    const updateStatus = (status: RunStatus) => {
      setSessionDetail(current => current?.session.id === sessionId ? {
        ...current, runs: current.runs.map(run => run.spec.id === runId ? { ...run, status } : run),
      } : current);
      setSessionPage(current => {
        const next = { ...current, items: current.items.map(session => session.id === sessionId && session.latestRunId === runId ? { ...session, latestStatus: status } : session) };
        sessionPageRef.current = next;
        return next;
      });
      if (status !== "paused") setPausedRun(current => current === runId ? undefined : current);
    };
    try {
      const result = await window.harness.request<RunSteerResult>({ method: "run.steer", params: { runId, text: value, resumePaused: true } });
      if (result.accepted) {
        accepted = true;
        if (sameView()) setPrompt(current => current === text ? "" : current);
        else if (composerDraft.current.sessionId !== sessionId) {
          const draft = drafts.current.get(sessionId);
          if (draft?.prompt === text) drafts.current.set(sessionId, { ...draft, prompt: "" });
        }
        if (sameView()) {
          updateStatus(result.status);
          if (result.resumeError) setHistoryError(`消息已加入对话，自动继续失败：${result.resumeError}。可以点击继续重试。`);
          else if (result.resumed || wasPaused && isLiveRun(result.status)) {
            // Invalidate the old follow attempt, which ended at the previous pause receipt.
            viewToken = ++viewVersion.current;
            following = true;
            setHistoryError("");
            setBusy(true);
            setPausedRun(undefined);
            const status = await pollRun(runId, lastSequence.current, viewToken);
            if (sameView() && status === "paused") setPausedRun(runId);
          }
        }
      } else if (sameView()) {
        setHistoryError(`本轮${runStatusLabel[result.status]}，补充说明已保留在输入框。`);
        updateStatus(result.status);
      }
    } catch (error) {
      if (sameView()) setHistoryError(`${accepted ? "消息已保存，读取后续执行失败" : "无法发送消息，输入已保留"}：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (sameView()) {
        try {
          const stored = await window.harness.request<SessionView | undefined>({ method: "session.view", params: { sessionId, limit: 20 } });
          if (stored && sameView()) {
            setSessionDetail(current => current?.session.id === sessionId ? refreshSessionView(current, stored) : current);
            const status = stored.runs.find(run => run.spec.id === runId)?.status;
            if (status) updateStatus(status);
          }
        } catch { /* Keep the last displayed state and the draft when refreshing fails. */ }
      }
      if (pendingSteering.current.get(sessionId) === operation) {
        pendingSteering.current.delete(sessionId);
        setSteeringSessions(current => { const next = new Set(current); next.delete(sessionId); return next; });
      }
      if (following && sameView()) setBusy(false);
    }
  }

  async function pollRun(runId: string, startSequence = -1, viewToken = viewVersion.current): Promise<RunStatus | undefined> {
    let sequence = startSequence;
    let finished = false;
    let lastStatus: RunStatus | undefined;
    const clearRunApprovalPrompt = () => setApprovalPrompt(current => {
      const promptRunId = current?.kind === "tool" ? current.approval.runId : current?.plan.runId;
      return promptRunId === runId ? undefined : current;
    });
    while (!finished && viewToken === viewVersion.current) {
      const page = await window.harness.request<RunEventPage>({ method: "run.eventPage", params: { limit: 100, runId, afterSequence: sequence } });
      if (viewToken !== viewVersion.current) return;
      setEvents(current => mergeRunEvents(current, page.events, runId));
      setSessionDetail(current => current ? mergeViewEvents(current, runId, page) : current);
      sequence = page.nextSequence; lastSequence.current = sequence;
      lastStatus = page.status;
      finished = !page.hasMore && !isLiveRun(page.status);
      const stored = { status: page.status };
      if (stored?.status === "waiting_approval") {
        const pendingPlan = await window.harness.request<PlanSpec | undefined>({ method: "plan.get", params: { runId } });
        if (viewToken !== viewVersion.current) return;
        if (pendingPlan?.status === "awaiting_approval") setApprovalPrompt({ kind: "plan", plan: pendingPlan });
        else {
          const nextApprovals = await window.harness.request<ApprovalRequest[]>({ method: "approvals.list" });
          if (viewToken !== viewVersion.current) return;
          setApprovals(nextApprovals);
          const pending = nextApprovals.find((approval) => approval.runId === runId && approval.status === "pending");
          if (pending) setApprovalPrompt({ kind: "tool", approval: pending });
          else clearRunApprovalPrompt();
        }
      } else clearRunApprovalPrompt();
      if (!finished && !page.hasMore) await delay(500);
    }
    return lastStatus;
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
    skill: DesktopSkill,
    trusted: boolean,
  ) {
    if (trusted)
      await window.harness.request({
        method: "skills.trust",
        params: { sourcePath: skill.manifest.sourcePath, expectedHash: skill.hash },
      });
    else
      await window.harness.request({
        method: "skills.untrust",
        params: { skillId: skill.key },
      });
    await refresh();
  }

  const selectedSkills = sessionDetail?.session.skillSelection ?? (profile?.skillIds ?? []).map(id => {
    const matches = skills.filter(skill => skill.manifest.id === id || skill.key === id);
    return matches.length === 1 ? matches[0]!.key : id;
  });
  async function changeSkills(keys: string[]) {
    if (!activeSessionId || skillSaving || pendingWithdrawal.current?.sessionId === activeSessionId) return;
    const sessionId = activeSessionId;
    const token = viewVersion.current;
    setSkillSaving(true); setSkillError("");
    try {
      const session = await window.harness.request<SessionRecord>({ method: "session.skills", params: { sessionId, skillSelection: keys } });
      viewCache.current.delete(sessionId);
      setSessionDetail(current => current?.session.id === sessionId ? { ...current, session: { ...current.session, skillSelection: session.skillSelection ?? [] } } : current);
    } catch (error) { if (token === viewVersion.current) setSkillError(error instanceof Error ? error.message : String(error)); }
    finally { setSkillSaving(false); }
  }

  async function changeReasoning(effort: ReasoningEffort | null) {
    if (!activeSessionId || modelMutation.current || busy || switching || runParked || pausedRun || pendingWithdrawal.current?.sessionId === activeSessionId) return;
    const sessionId = activeSessionId;
    const token = viewVersion.current;
    modelMutation.current = true;
    setModelSaving(true); setModelError("");
    try {
      const session = await window.harness.request<SessionRecord>({ method: "session.reasoning", params: { sessionId, profileId, reasoningEffort: effort, needsVision: attachments.length > 0 } });
      viewCache.current.delete(sessionId);
      if (token === viewVersion.current) setSessionDetail(current => current?.session.id === sessionId ? { ...current, session } : current);
    } catch (error) {
      if (token === viewVersion.current) setModelError(error instanceof Error ? error.message : String(error));
    } finally {
      modelMutation.current = false; setModelSaving(false);
    }
  }

  async function startCapture() {
    if (pendingWithdrawal.current?.sessionId === activeSessionId) return;
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

  useEffect(() => {
    const onMenu = (event: Event) => {
      if (!unlocked) return;
      const command = (event as CustomEvent<unknown>).detail;
      if (command === "new-task") void newTask();
      else if (command === "open-project") void chooseWorkspace();
      else if (command === "settings") setTab("settings");
    };
    window.addEventListener("harness:workspace-menu", onMenu);
    return () => window.removeEventListener("harness:workspace-menu", onMenu);
  });

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
      className={`app-shell workbench${sidebarCollapsed ? " sidebar-collapsed" : ""}${browserOpen && tab !== "settings" ? " browser-open" : ""}${tab === "settings" ? " settings-open" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
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
          <strong>Harness</strong>
        </div>
        <BuiButton className="new-task-button" variant="ghost"
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
              "changes",
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
                  <button type="button" className="project-folder" aria-expanded={expanded} title={group.project.workspacePath} onClick={() => setExpandedProjects((current) => {
                    const next = new Set(current);
                    if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
                    return next;
                  })}>
                    <FolderOpen size={15} className="folder-icon" />
                    <span className="project-folder-name">{group.project.workspacePath ? basename(group.project.workspacePath) : "未归组会话"}</span>
                    {isCurrent && <span className="project-folder-tag">当前</span>}
                  </button>
                  <button type="button" className="row-icon-action project-new-session" aria-label={`在 ${basename(group.project.workspacePath)} 中新建会话`} title="新建会话" onClick={(event) => { event.stopPropagation(); void createSessionForWorkspace(group.project.workspacePath); }}><Plus size={13} /></button>
                  {/* The folder picker only runs when a project is added, so projects already in the list need their own entry to this. */}
                  <button type="button" className="row-icon-action project-instructions" aria-label={`为 ${basename(group.project.workspacePath)} 创建或查看项目约束`} title="项目约束 (AGENTS.md)" onClick={(event) => { event.stopPropagation(); void reviewProjectInstructions(group.project.workspacePath, viewVersion.current); }}><FilePlus size={13} /></button>
                  <button type="button" className="row-icon-action project-delete" aria-label={`删除项目 ${basename(group.project.workspacePath)}`} title="从 Harness 删除项目" disabled={busy} onClick={(event) => { event.stopPropagation(); void deleteProject(group.project); }}><Trash2 size={13} /></button>
                </div>
                {expanded && <div className="project-group-items">
                  {group.items.map((item) => (
                    <div className="project-session-row" key={item.id}>
                      <button className={`project-session history-session${activeSessionId === item.id ? " active" : ""}`} aria-current={activeSessionId === item.id ? "page" : undefined} aria-label={`${item.title}，${item.latestStatus ? runStatusLabel[item.latestStatus] : "新会话"}`} onClick={() => void openSession(item)} title={`${item.title}\n${item.workspacePath}`}>
                        <MessageSquare size={14} />
                        <span className="history-session-content">{item.title}</span>
                        <SessionStatusMarker status={item.latestStatus} />
                      </button>
                      <button type="button" className="row-icon-action session-delete" aria-label={`删除会话 ${item.title}`} title="移到已删除会话" disabled={busy} onClick={(event) => { event.stopPropagation(); void deleteSession(item); }}><Trash2 size={13} /></button>
                    </div>
                  ))}
                  {!group.items.length && <p className="sidebar-hint">点击项目旁的 + 新建会话</p>}
                </div>}
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
          <BuiButton variant="ghost" onClick={() => setTab("settings")} className="sidebar-settings"><Settings size={17} /><span>设置</span><small>v1.4.51</small></BuiButton>
          <div className="sidebar-connection"><span className="status-dot" />本地运行时已解锁</div>
        </div>
      </aside>
      <SidebarResizeHandle
        value={sidebarWidth}
        onResize={(value) => setSidebarWidth(clampSidebarWidth(value))}
        onCommit={(value) => setSidebarWidth(saveSidebarWidth(value))}
      />
      <main>
        <header className="topbar">
          <div className="workbench-heading">
            <BuiButton variant="ghost" size="sm" aria-controls="workspace-sidebar" aria-expanded={!sidebarCollapsed} aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} onClick={() => setSidebarCollapsed((value) => !value)}><PanelLeft size={18} /></BuiButton>
            <h1>{tab === "chat" ? "开发会话" : tabLabel(tab)}</h1>
          </div>
          <div className="top-actions">
            <BuiButton variant="ghost" size="sm" aria-label={browserOpen ? "收起浏览器" : "打开内置浏览器"} title="内置浏览器" onClick={() => setBrowserOpen(value => !value)}><Monitor size={16} /></BuiButton>
            <select className="theme-quick-switch" aria-label="界面主题" value={theme} onChange={event => { if (isThemeId(event.target.value)) changeTheme(event.target.value); }}>
              {THEMES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <select
              aria-label="选择 Profile"
              value={profileId}
              disabled={modelSaving || busy || runParked || Boolean(pausedRun) || withdrawing}
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
        <section className={`content${tab === "chat" ? " chat-content" : tab === "settings" ? " settings-content" : ""}`}><Suspense fallback={<BuiLoadingState label="正在加载页面…" />}>
          {tab === "chat" && (
            <ChatView
              key={activeSessionId ?? "no-session"}
              workspace={workspace}
              skills={skills}
              selectedSkills={selectedSkills}
              onSkillsChange={changeSkills}
              skillSaving={skillSaving}
              skillError={skillError}
              currentModel={currentModel}
              reasoningEffort={composerEffort}
              onReasoningChange={changeReasoning}
              modelLoading={modelLoading}
              modelSaving={modelSaving}
              modelError={modelError}
              modelCatalogError={modelCatalogError}
              onModelsRetry={() => setModelCatalogVersion(value => value + 1)}
              {...(profile ? { profile } : {})}
              prompt={prompt}
              setPrompt={setPrompt}
              taskMode={taskMode}
              setTaskMode={setTaskMode}
              attachments={attachments}
              setAttachments={setAttachments}
              events={events}
              turns={conversationTurns}
              hasSession={Boolean(activeSessionId)}
              busy={busy || switching || Boolean(activeSessionId && steeringSessions.has(activeSessionId))}
              steering={Boolean(activeSessionId && steeringSessions.has(activeSessionId))}
              switching={switching}
              hasOlder={Boolean(sessionDetail?.hasMore)}
              {...(sessionDetail?.withdrawnEvents ? { withdrawnEvents: sessionDetail.withdrawnEvents } : {})}
              contentError={content.error}
              onContentRetry={content.retry}
              onVisibleItems={content.prioritize}
              initialScroll={scrollPositions.current.get(activeSessionId ?? "")}
              onScrollPosition={position => { if (activeSessionId) scrollPositions.current.set(activeSessionId, position); }}
              {...(activeRun ? { runId: activeRun } : {})}
              paused={Boolean(pausedRun) || activeRunStatus === "paused"}
              canPause={canPauseRun}
              onPause={pauseRun}
              onResume={resumeRun}
              {...(withdrawableRun && (!withdrawalSessionId || withdrawing) ? { withdrawableRunId: withdrawableRun.spec.id } : {})}
              withdrawing={withdrawing}
              onWithdraw={withdrawRun}
              onContinue={continueFromRow}
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
          {tab === "changes" && <SessionChanges key={activeSessionId ?? "none"} sessionId={activeSessionId} />}
          {tab === "approvals" && (
            <ApprovalsView approvals={approvals} decide={decideApproval} />
          )}
          {tab === "plan" && <PlanView {...(activeRun ? { runId: activeRun } : {})} events={activeRunEvents} decide={decidePlan} />}
          {tab === "memory" && (
            <MemoryManager memories={memories} decide={decideMemory} refresh={refresh} workspace={workspace} {...(profile ? { profile } : {})} />
          )}
          {skillsVisited.current && <div hidden={tab !== "skills"}><SkillsView skills={skills} profileId={profileId} refresh={refresh} decide={decideSkill} /></div>}
          {tab === "plugins" && <PluginsView plugins={plugins} action={pluginAction} workspacePath={workspace} onApplyContent={text => { void applyMcpContent(text); }} />}
          {tab === "profiles" && (
            <ProfilesView profiles={profiles} activeId={profileId} refresh={refresh} />
          )}
          {tab === "trace" && (
            <TraceView
              events={activeRunEvents}
              {...(activeRun ? { runId: activeRun } : {})}
            />
          )}
          {tab === "settings" && <SettingsView key={recycleVersion} refresh={refresh} refreshHistory={async () => { viewCache.current.clear(); drafts.current.clear(); scrollPositions.current.clear(); await refreshHistory(); }} theme={theme} onThemeChange={changeTheme} themeSaved={themeSaved} appearance={appearance} onClose={() => setTab(previousWorkbenchTab.current)} />}
        </Suspense></section>
      </main>
      <BrowserPanel sessionId={activeSessionId} open={browserOpen && tab !== "settings"} onOpenChange={setBrowserOpen} />
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
      {confirmationDialog}
      <McpInteractions workspacePath={workspace} />
      {approvalPrompt && (
        <ApprovalPromptDialog
          prompt={approvalPrompt}
          onClose={() => setApprovalPrompt(undefined)}
          onDecideTool={decideApproval}
          onDecidePlan={decidePlan}
          {...((approvalPrompt.kind === "tool" ? approvalPrompt.approval.runId : approvalPrompt.plan.runId) === activeRun && canPauseRun ? { onPause: pauseRun } : {})}
        />
      )}
    </div>
  );
}

function SessionChanges({ sessionId }: { sessionId: string | undefined }) {
  const [detail, setDetail] = useState<SessionDetail>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!sessionId) return;
    let current = true;
    // The changes tab needs applied patch evidence. Hydrate it only after opening this tab.
    void window.harness.request<SessionDetail>({ method: "session.get", params: { sessionId } })
      .then(value => { if (current) setDetail(value); })
      .catch(reason => { if (current) setError(String(reason)); });
    return () => { current = false; };
  }, [sessionId]);
  if (error) return <p role="alert">{error}</p>;
  if (sessionId && !detail) return <BuiLoadingState label="正在加载差异记录…" />;
  return <CodeChanges events={detail?.runs.flatMap(run => run.events) ?? []} />;
}

const turnKey = (turn: SessionTurn) => turn.runId;

function ChatView(props: {
  skills: DesktopSkill[];
  selectedSkills: string[];
  onSkillsChange: (keys: string[]) => void;
  skillSaving: boolean;
  skillError: string;
  currentModel: ModelDescriptor | undefined;
  reasoningEffort: ReasoningEffort | null;
  onReasoningChange: (effort: ReasoningEffort | null) => void;
  modelLoading: boolean;
  modelSaving: boolean;
  modelError: string;
  modelCatalogError: string;
  onModelsRetry: () => void;
  workspace: string;
  profile?: Profile;
  prompt: string;
  setPrompt: (value: string) => void;
  taskMode: "auto" | "analysis" | "change";
  setTaskMode: (mode: "auto" | "analysis" | "change") => void;
  attachments: DesktopAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<DesktopAttachment[]>>;
  events: AgentEvent[];
  turns: SessionTurn[];
  hasSession: boolean;
  switching: boolean;
  hasOlder: boolean;
  withdrawnEvents?: readonly AgentEvent[];
  contentError: string;
  onContentRetry: () => void;
  onVisibleItems: (ids: string[]) => void;
  initialScroll: ConversationPosition | undefined;
  onScrollPosition: (position: ConversationPosition) => void;
  busy: boolean;
  steering: boolean;
  runId?: string;
  paused: boolean;
  canPause: boolean;
  onPause: () => void;
  onResume: () => void;
  withdrawableRunId?: string;
  withdrawing: boolean;
  onWithdraw: (messageId?: string) => void;
  onContinue: (runId: string, note: string) => Promise<void>;
  onSend: () => void;
  onChooseImages: () => void;
  onCapture: () => void;
  onChooseWorkspace: () => void;
}) {
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const showHistoryLoading = shouldShowHistoryLoading(props.hasSession, props.switching, props.turns.length);
  return (
    <div className="chat-layout">
      {props.contentError && <div role="alert">{props.contentError}<BuiButton onClick={props.onContentRetry}>重试</BuiButton></div>}
      <div className="conversation-stage">
      <VirtualConversation items={props.turns} itemKey={turnKey} className={props.turns.length ? "conversation" : "conversation conversation-empty"} contentClassName="conversation-content"
        onVisibleItems={props.onVisibleItems}
        initialPosition={props.initialScroll} onPosition={props.onScrollPosition}
        renderItem={(turn, index) => <MemoConversationTurn turn={turn} busy={props.busy && index === props.turns.length - 1} continuationDisabled={props.busy || props.paused || props.withdrawing} onContinue={props.onContinue}
          {...(turn.runId === props.withdrawableRunId ? { onWithdraw: props.onWithdraw } : {})}
          withdrawing={props.withdrawing && turn.runId === props.withdrawableRunId} withdrawDisabled={props.busy || props.steering || props.modelSaving || props.skillSaving} />}
        header={<>
        {showHistoryLoading && (
          <section className="conversation-history-loading" aria-live="polite">
            <BuiLoadingState label="正在加载历史记录…" />
          </section>
        )}
        {props.turns.length === 0 && !showHistoryLoading && (
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
        {props.hasOlder && <p role="status">正在同步历史消息…</p>}
        </>}
      />
      </div>
      <div className="composer-wrap">
        <div className="composer-project-bar">
          <button onClick={props.onChooseWorkspace} disabled={props.withdrawing} title={props.workspace || "打开代码仓库"}><FolderOpen size={16} /><span>{props.workspace ? basename(props.workspace) : "选择项目"}</span></button>
          <span><Monitor size={15} />本地</span>
          <span className="composer-profile" title={props.profile?.name}><UserCog size={15} />{props.profile?.name || "未选择 Profile"}</span>
        </div>
        <BuiPromptBar
          value={props.prompt}
          skillChips={<><div className="skill-chips">{props.selectedSkills.map(key => { const skill = props.skills.find(item => item.key === key); return <button key={key} type="button" disabled={props.skillSaving || props.withdrawing} title={skill?.manifest.enabled ? "移除此技能" : "技能不可用，请重新选择或确认信任"} aria-label={`移除技能 ${skill?.manifest.name ?? key}`} onClick={() => props.onSkillsChange(props.selectedSkills.filter(item => item !== key))}><BookOpen size={13} /><span>{skill?.manifest.name ?? "缺失的技能"}{skill && !skill.manifest.enabled ? " · 需确认" : ""}</span><X size={12} /></button>; })}</div>{props.skillError && <small role="alert">{props.skillError}</small>}{props.modelError && <small role="alert">{props.modelError}</small>}</>}
          skillPicker={skillPickerOpen ? <SkillPicker skills={props.skills} selected={props.selectedSkills} onChange={props.onSkillsChange} onClose={() => setSkillPickerOpen(false)} disabled={props.skillSaving || props.withdrawing} /> : null}
          taskMode={props.taskMode}
          modelPicker={<ModelReasoningPicker model={props.currentModel} effort={props.reasoningEffort} onChange={props.onReasoningChange}
            loading={props.modelLoading} error={props.modelError || props.modelCatalogError}
            disabled={!props.hasSession || props.busy || props.paused || props.modelSaving || props.withdrawing}
            disabledReason={props.paused ? "继续运行时沿用原推理强度" : props.busy ? "运行期间固定推理强度" : props.modelSaving ? "正在保存推理强度" : "请先创建会话"} />}
          onTaskModeChange={props.setTaskMode}
          onChange={props.setPrompt}
          onSubmit={props.onSend}
          placeholder={
            !props.workspace ? "先选择项目，再开始对话…" : props.hasSession ? "描述你的想法，或粘贴错误截图…" : "点击新建任务创建会话…"
          }
          disabled={!props.workspace || !props.hasSession || props.withdrawing}
          busy={props.busy || props.modelSaving}
          {...(props.runId && !props.paused && props.canPause ? { onHold: props.onPause } : {})}
          holding={props.paused}
          {...(props.runId ? { onRelease: props.onResume, canRelease: !props.steering } : {})}
          withdrawing={props.withdrawing}
          runDisabled={props.withdrawing}
          {...(props.attachments.length > 0
            ? {
                attachments: (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {props.attachments.map((item, index) => (
                      <div
                        className="glass-strong flex items-center gap-2 p-2"
                        key={item.attachment.id}
                      >
                        {item.previewDataUrl ? <img
                          src={item.previewDataUrl}
                          alt="待发送图片"
                          className="h-10 w-14 rounded-lg object-cover"
                        /> : <ImageIcon size={24} aria-label="已恢复的图片附件" />}
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
                          disabled={props.withdrawing}
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
              <BuiButton variant="ghost" size="sm" disabled={props.withdrawing} onClick={() => setSkillPickerOpen(true)}><BookOpen size={17} /> 技能</BuiButton>
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
        <SessionCacheStats turns={props.turns} hasOlder={props.hasOlder} {...(props.withdrawnEvents ? { withdrawnEvents: props.withdrawnEvents } : {})} />
        {props.modelCatalogError && <small role="alert">{props.modelCatalogError} <BuiButton variant="ghost" size="sm" disabled={props.modelLoading} onClick={props.onModelsRetry}>重新读取模型设置</BuiButton></small>}
      </div>
    </div>
  );
}

function SidebarResizeHandle({ value, onResize, onCommit }: {
  value: number;
  onResize: (value: number) => void;
  onCommit: (value: number) => void;
}) {
  const start = useRef({ x: 0, width: value });
  const latest = useRef(value);
  latest.current = value;
  function setFromKeyboard(next: number) {
    const clamped = clampSidebarWidth(next);
    onResize(clamped);
    onCommit(clamped);
  }
  return <div
    className="sidebar-resizer"
    role="separator"
    aria-label="调整侧栏宽度"
    aria-orientation="vertical"
    aria-valuemin={SIDEBAR_MIN}
    aria-valuemax={SIDEBAR_MAX}
    aria-valuenow={value}
    tabIndex={0}
    onDoubleClick={() => setFromKeyboard(258)}
    onKeyDown={(event) => {
      const next = event.key === "ArrowLeft" ? value - 12 : event.key === "ArrowRight" ? value + 12 : event.key === "Home" ? SIDEBAR_MIN : event.key === "End" ? SIDEBAR_MAX : undefined;
      if (next !== undefined) { event.preventDefault(); setFromKeyboard(next); }
    }}
    onPointerDown={(event) => {
      start.current = { x: event.clientX, width: value };
      latest.current = value;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.classList.add("is-dragging");
    }}
    onPointerMove={(event) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const next = clampSidebarWidth(start.current.width + event.clientX - start.current.x);
      latest.current = next;
      onResize(next);
    }}
    onPointerUp={(event) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      event.currentTarget.classList.remove("is-dragging");
      onCommit(latest.current);
    }}
  />;
}

const requestSessionContent = <T,>(input: DaemonRequestInput) => window.harness.request<T>(input);
function removeWithdrawnRounds(view: SessionView, removed: ReadonlySet<string>): SessionView {
  const spentEvents = new Map((view.withdrawnEvents ?? []).map(event => [event.id, event]));
  for (const run of view.runs) if (removed.has(run.spec.id)) {
    for (const event of run.events) if (event.type === "usage" || event.type === "context_compacted") spentEvents.set(event.id, event);
  }
  return { ...view, runs: view.runs.filter(run => !removed.has(run.spec.id)), withdrawnEvents: [...spentEvents.values()] };
}
const MemoConversationTurn = React.memo(ConversationTurnView);

function removeWithdrawnMessage(view: SessionView, runId: string, messageId?: string): SessionView {
  if (!messageId) return view;
  const target = view.runs.find(run => run.spec.id === runId);
  const submitted = target?.events.find(event => event.type === "steering_submitted" && event.messageId === messageId);
  if (!submitted) return view;
  const spent = new Map((view.withdrawnEvents ?? []).map(event => [event.id, event]));
  for (const event of target!.events) if (event.sequence >= submitted.sequence && (event.type === "usage" || event.type === "context_compacted")) spent.set(event.id, event);
  return { ...view, withdrawnEvents: [...spent.values()], runs: view.runs.map(run => run !== target ? run : {
    ...run, status: "paused", events: run.events.filter(event => event.sequence < submitted.sequence),
    ...(run.view ? { view: { ...run.view, lastSequence: submitted.sequence - 1 } } : {}),
  }) };
}

function ConversationTurnView({ turn, busy, continuationDisabled, onContinue, onWithdraw, withdrawing, withdrawDisabled }: {
  turn: SessionTurn; busy: boolean; continuationDisabled: boolean; onContinue: (runId: string, note: string) => Promise<void>;
  onWithdraw?: (messageId?: string) => void; withdrawing: boolean; withdrawDisabled: boolean;
}) {
  const [continuable, setContinuable] = useState(false);
  const [continuationNote, setContinuationNote] = useRowState("continuationNote", "");
  const pending = turn.events.findLast(event => event.type === "result")?.stop?.pending.length ?? 0;
  useEffect(() => {
    let cancelled = false;
    setContinuable(false);
    if (turn.status === "review" && pending) void window.harness.request<RunCheckpoint[]>({ method: "checkpoints.get", params: { runId: turn.runId, limit: 1 } }).then(items => { if (!cancelled) setContinuable(items.length > 0); }).catch(() => {});
    return () => { cancelled = true; };
  }, [turn.runId, turn.status, pending]);
  const terminalStatus = terminalConversationStatus(turn.events);
  const [runReview, setRunReview] = useRowState<RunReview | undefined>("review", undefined);
  useEffect(() => {
    if (busy || !terminalStatus || runReview?.status === "ready" || (turn.view && !turn.view.eventsComplete)) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delayMs = 800;
    const load = async () => {
      try {
        const record = await window.harness.request<RunReview | undefined>({ method: "run.review", params: { runId: turn.runId } });
        if (cancelled) return;
        setRunReview(record);
        if (record?.status === "capturing") {
          retry = setTimeout(() => void load(), delayMs);
          delayMs = Math.min(Math.round(delayMs * 1.5), 5_000);
        }
      } catch {
        // Older history and non-Git workspaces can still show applied patch evidence.
      }
    };
    void load();
    return () => { cancelled = true; if (retry) clearTimeout(retry); };
  }, [busy, terminalStatus, turn.runId, turn.view?.eventsComplete]);
  async function undoReviewFile(path: string) {
    const updated = await window.harness.request<RunReview>({ method: "review.undo", params: { runId: turn.runId, path } });
    setRunReview(updated);
  }
  const stream = useMemo(() => buildConversationStream(turn.events), [turn.events]);
  const segments = useMemo(() => {
    const groups: Array<{ id: string; user?: Extract<ConversationStreamItem, { kind: "user_message" }>; items: ConversationStreamItem[] }> = [{ id: "initial", items: [] }];
    for (const item of stream) {
      if (item.kind === "user_message") groups.push({ id: item.id, user: item, items: [] });
      else groups.at(-1)!.items.push(item);
    }
    return groups.map((group, index) => ({ ...group, events: turn.events.filter(event =>
      event.sequence >= (group.user?.sequence ?? -1) && event.sequence < (groups[index + 1]?.user?.sequence ?? Infinity)) }));
  }, [stream, turn.events]);
  const completed = !busy && terminalStatus !== undefined;
  const latestHuman = stream.findLast(item => item.kind === "user_message");
  const withdrawalButton = (messageId?: string) => <div className="conversation-user-actions">
    <button type="button" className="conversation-withdraw" disabled={withdrawDisabled || withdrawing} aria-label={messageId ? "撤回最新消息" : "撤回最新一轮"} aria-busy={withdrawing}
      title={messageId ? "撤回这条消息及其后产生的文件改动，将消息放回输入框" : "撤回本轮对话及本轮产生的文件改动，将原消息放回输入框"} onClick={() => onWithdraw?.(messageId)}>
      {withdrawing ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Undo2 size={16} aria-hidden="true" />}
    </button>
  </div>;
  const renderStreamItem = (item: ConversationStreamItem) => item.kind === "text"
    ? item.process
      ? <ProcessNarration key={item.id} text={item.text} live={busy && stream.at(-1) === item} />
      : <article className="assistant-message" key={item.id}><FinalReportStatus {...(item.result ? { result: item.result } : {})} /><MarkdownMessage text={item.text} /></article>
    : item.kind === "tool_group"
      ? <ToolEventGroup key={item.id} tools={item.tools} />
      : item.kind === "user_message"
        ? <div className="conversation-user-turn" key={item.id} data-message-id={item.id}><article className="user-message" aria-label="你的消息">{item.text}</article>
            {onWithdraw && item === latestHuman && (() => {
              const submitted = turn.events.find(event => event.type === "steering_submitted" && event.sequence === item.sequence);
              return submitted?.type === "steering_submitted" && submitted.withdrawable ? withdrawalButton(submitted.messageId) : null;
            })()}
          </div>
        : <EventRow key={item.event.id} event={item.event} />;
  return (
    <section className="conversation-turn" data-run-id={turn.runId}>
      {turn.view && !turn.view.eventsComplete && <p role="status">正在同步执行记录…</p>}
      <div className="conversation-user-turn">
        <article className="user-message" aria-label="你的任务">{turn.continuation ? `继续任务${turn.continuation.note ? "：" + turn.continuation.note : ""}` : turn.request}</article>
        {onWithdraw && !latestHuman && withdrawalButton()}
      </div>
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        const finalIndex = segment.items.findLastIndex(item => item.kind === "text" && !item.process);
        const processItems = finalIndex >= 0 ? segment.items.slice(0, finalIndex) : segment.items;
        const finalItems = finalIndex >= 0 ? segment.items.slice(finalIndex) : [];
        const result = segment.events.findLast(event => event.type === "result");
        const visibleStop = result?.stop && !/^运行已暂停[。．]?/.test(result.stop.message) ? result.stop : undefined;
        const route = segment.events.find(event => event.type === "route");
        const segmentCompleted = !last || completed;
        return <React.Fragment key={segment.id}>
          {segment.user && renderStreamItem(segment.user)}
          {(processItems.length > 0 || route || visibleStop) && <ConversationProcessSummary stateKey={segment.id === "initial" ? "process" : `process:${segment.id}`} completed={segmentCompleted}
            preview={Boolean(turn.view && !turn.view.eventsComplete)} durationMs={conversationDurationMs(segment.events)} activeLabel={result?.status === "paused" ? "已暂停" : "运行中"}>
            {() => <div className="conversation-stream">
              {route?.type === "route" && <div className="activity-row conversation-route"><Terminal size={14} aria-hidden="true" /><span>{route.providerId} / {route.modelId}</span><small>{route.reason}</small></div>}
              {processItems.map(renderStreamItem)}
              {visibleStop && <RunStopCard stop={visibleStop} />}
              {last && <WorkflowProgress events={turn.events} />}
            </div>}
          </ConversationProcessSummary>}
          {finalItems.length > 0 && <div className="conversation-stream conversation-final-stream">{finalItems.map(renderStreamItem)}</div>}
          {last && completed && finalItems.length === 0 && <div className="conversation-stream conversation-final-stream">
            <article className="assistant-message"><MarkdownMessage text={terminalStatus === "failed" ? "运行失败，未生成最终回答。" : terminalStatus === "cancelled" ? "运行已取消。" : terminalStatus === "review" ? "本轮已结束，仍有待复核事项。" : "运行已完成，未生成最终回答。"} /></article>
          </div>}
        </React.Fragment>;
      })}
      {turn.continuation && turn.chainUsage && <p className="text-xs text-text-muted">本轮：{turn.usage?.turns ?? 0} 轮 / {turn.usage?.tools ?? 0} 次工具调用 · 续办链累计：{turn.chainUsage.turns} 轮 / {turn.chainUsage.tools} 次工具调用 · 输入 {turn.chainUsage.inputTokens} / 输出 {turn.chainUsage.outputTokens} tokens · {turn.chainUsage.costKnown ? `$${turn.chainUsage.usd.toFixed(4)}` : "费用统计不完整"}</p>}
      {continuable && <div className="flex items-center gap-2 my-3">
        <input aria-label="续办补充说明" placeholder="补充说明（可选）" maxLength={4000} value={continuationNote} disabled={continuationDisabled} onChange={event => setContinuationNote(event.target.value)} className="rounded border border-line bg-transparent px-3 py-2 text-sm" />
        <BuiButton disabled={continuationDisabled} onClick={() => void onContinue(turn.runId, continuationNote)}>继续任务</BuiButton>
        <small>保留原计划，使用新一轮额度</small>
      </div>}
      {defaultConversationLayout.inlineReview && <InlineReview runId={turn.runId} review={runReview} onUndo={undoReviewFile} />}
      {busy && <BuiLoadingState label="Agent 正在思考与执行…" />}
    </section>
  );
}

function ProcessNarration({ text, live }: { text: string; live: boolean }) {
  const preview = shouldPreviewProcessText(text, live);
  const [expanded, setExpanded] = useState(false);
  return <article className="assistant-message assistant-process">
    <div className={`process-narration-body${preview && !expanded ? " is-preview" : ""}`}>
      <MarkdownMessage text={text} compact />
    </div>
    {preview && <button type="button" className="process-narration-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? "收起过程文字" : "展开完整过程文字"}
    </button>}
  </article>;
}

function EventRow({ event }: { event: AgentEvent }) {
  if (event.type === "capabilities_resolved") return <CapabilitiesRow event={event} />;
  if (event.type === "provider_retry")
    return (
      <div className="activity-row activity-row-warning">
        <RotateCcw size={15} aria-hidden="true" />
        <strong>Provider 重试 {event.attempt}/{event.maxAttempts}</strong>
        <small>
          {event.category === "tool_history_protocol"
            ? "已修复工具历史协议并重试"
            : `${event.delayMs} ms 后重试`}
        </small>
      </div>
    );
  if (event.type === "self_correction_started")
    return (
      <div className="activity-row activity-row-warning">
        <TriangleAlert size={15} aria-hidden="true" />
        <strong>
          {event.maxAttempts == null ? `第 ${event.attempt} 次自我修正` : `自我修正 ${event.attempt}/${event.maxAttempts}`}
        </strong>
        <small>
          {event.summary}
        </small>
      </div>
    );
  if (event.type === "repair_started")
    return (
      <div className="activity-row activity-row-warning">
        <Pencil size={15} aria-hidden="true" />
        <strong>第 {event.attempt} 次修复</strong>
      </div>
    );
  if (event.type === "approval_required")
    return (
      <div className="activity-row activity-row-warning">
        <TriangleAlert size={15} aria-hidden="true" />
        <ActivityMessage message={event.summary} />
      </div>
    );
  if (event.type === "error") {
    return (
      <div className="activity-row activity-row-error">
        <TriangleAlert size={15} aria-hidden="true" />
        <ActivityMessage message={event.message} />
        <small>{event.code}</small>
      </div>
    );
  }
  return null;
}

function ActivityMessage({ message }: { message: string }) {
  const summary = summarizeActivityMessage(message);
  return summary === message
    ? <strong className="activity-message-text">{message}</strong>
    : <details className="activity-detail">
        <summary><strong className="activity-message-text">{summary}</strong></summary>
        <pre>{message}</pre>
      </details>;
}

type ToolStartedEvent = Extract<AgentEvent, { type: "tool_started" }>;
type ToolFinishedEvent = Extract<AgentEvent, { type: "tool_finished" }>;

function ToolEventGroup({ tools }: { tools: ToolTimelineItem[] }) {
  const completed = tools.filter((tool) => tool.finished).length;
  const key = `toolGroup:${tools[0]?.started.id}`;
  const [groupOpen, setGroupOpen] = useRowState(`${key}:open`, () => shouldExpandToolGroup(completed, tools.length));
  const [progress, setProgress] = useRowState(`${key}:progress`, `${completed}/${tools.length}`);
  useEffect(() => {
    if (progress === `${completed}/${tools.length}`) return;
    setProgress(`${completed}/${tools.length}`);
    setGroupOpen(shouldExpandToolGroup(completed, tools.length));
  }, [completed, tools.length, progress, setProgress, setGroupOpen]);
  const totalDuration = tools.reduce(
    (total, tool) => total + (tool.finished?.durationMs ?? 0),
    0,
  );
  const allCompleted = completed === tools.length;
  const failures = tools.filter((tool) => tool.finished?.isError === true || (tool.finished?.output && typeof tool.finished.output === "object" && "error" in tool.finished.output)).length;
  return (
    <details className="tool-group-card" open={groupOpen} onToggle={event => setGroupOpen(event.currentTarget.open)}>
      <summary className="activity-row tool-group-summary">
        <Terminal size={15} aria-hidden="true" />
        <strong>{allCompleted ? "已运行" : "运行中"}（{tools.length} 个工具）</strong>
        <small>
          {allCompleted
            ? `${formatDuration(totalDuration)}${failures ? ` · ${failures} 项失败` : ""}`
            : `${completed}/${tools.length} 已完成`}
        </small>
      </summary>
      {groupOpen && <div className="tool-group-body">
        {tools.map((tool) => (
          <ToolEventRow
            key={tool.started.id}
            started={tool.started}
            {...(tool.finished ? { finished: tool.finished } : {})}
          />
        ))}
      </div>}
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
  const [open, setOpen] = useRowState(`tool:${started.id}:open`, false);
  const summary = toolSummary(started.call.name, started.call.input, started.origin);
  const activity = toolActivity(started.call.name, started.call.input);
  const displayDetail = started.call.name === "git_diff" && finished
    ? `${summary.detail} · ${countDiffFiles(finished.output)} 个文件`
    : summary.detail;
  const failed = finished?.isError === true || (
    finished !== undefined &&
    typeof finished.output === "object" &&
    finished.output !== null &&
    "error" in (finished.output as Record<string, unknown>));
  return (
    <details className="tool-call-card" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="tool-call-summary" title={`${started.call.name}: ${displayDetail || activity.detail}`}>
        {activity.verb === "编辑了文件" ? <Pencil size={14} aria-hidden="true" /> : <Terminal size={14} aria-hidden="true" />}
        <span className="tool-call-detail min-w-0 flex-1 truncate">
          <span>{activity.verb}</span>{displayDetail === "" ? null : <><span> </span><strong>{displayDetail}</strong></>}
        </span>
        <small className={failed ? "tool-call-failed" : ""}>
          {failed ? "失败 · " : ""}{finished ? `${finished.durationMs} ms` : "运行中"}
        </small>
      </summary>
      {open && <div className="tool-call-body mt-2 flex flex-col gap-1.5">
        <label className="text-[10px] tracking-widest text-text-muted">INPUT</label>
        <ToolContext value={started.call.input} />
        {finished && (
          <>
            <label className="text-[10px] tracking-widest text-text-muted">
              OUTPUT · 不可信工具数据
            </label>
            <DeferredToolOutput event={finished} />
          </>
        )}
      </div>}
    </details>
  );
}

function DeferredToolOutput({ event }: { event: ToolFinishedEvent }) {
  if (isDeferredOutput(event.output)) return <p role="status">正在同步工具输出…</p>;
  return <ToolContext value={event.output} />;
}

function countDiffFiles(output: unknown): number {
  if (!output || typeof output !== "object") return 0;
  const record = output as Record<string, unknown>;
  const names = new Set<string>();
  for (const key of ["diff", "stagedDiff"]) {
    const diff = typeof record[key] === "string" ? record[key] as string : "";
    for (const match of diff.matchAll(/^diff --git a\/(.+?) b\/.+$/gm)) names.add(match[1]!);
  }
  if (Array.isArray(record.newFiles)) for (const file of record.newFiles) {
    const path = file && typeof file === "object" ? (file as Record<string, unknown>).path : undefined;
    if (typeof path === "string") names.add(path);
  }
  return names.size;
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
  onPause,
}: {
  prompt: ApprovalPrompt;
  onClose: () => void;
  onDecideTool: (id: string, approved: boolean) => Promise<void>;
  onDecidePlan: (
    plan: PlanSpec,
    approved: boolean,
    feedback?: string,
  ) => Promise<void>;
  onPause?: () => Promise<void>;
}) {
  const isTool = prompt.kind === "tool";
  const risk = isTool ? prompt.approval.risk : prompt.plan.scope.maxRisk;
  const status = risk === "destructive"
    ? "破坏性操作 · 请谨慎确认"
    : isTool ? "未授予此工具的权限" : `计划含 ${prompt.plan.steps.length} 个步骤`;
  return (
    <ApprovalDialog
      title={isTool ? "允许执行这项操作？" : "批准这个执行计划？"}
      description={isTool ? prompt.approval.reason : prompt.plan.goal}
      {...(isTool ? { subject: prompt.approval.toolName } : {})}
      status={status}
      destructive={risk === "destructive" || risk === "high"}
      {...(isTool ? { alternativesLabel: "查看参数" } : { alternativesLabel: `查看步骤（${prompt.plan.steps.length}）` })}
      confirmLabel={isTool ? "批准一次" : "批准计划"}
      cancelLabel="拒绝"
      onDismiss={onClose}
      onCancel={() => isTool ? onDecideTool(prompt.approval.id, false) : onDecidePlan(prompt.plan, false)}
      onConfirm={() => isTool ? onDecideTool(prompt.approval.id, true) : onDecidePlan(prompt.plan, true)}
      {...(onPause ? { onPause } : {})}
    >
      {isTool
        ? <ApprovalContent input={prompt.approval.normalizedInput} />
        : <ol className="decision-plan">{prompt.plan.steps.map(step => <li key={step.id}><strong>{step.title}</strong><span>{step.acceptanceCriteria.join("；")}</span></li>)}</ol>}
    </ApprovalDialog>
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
          <ApprovalContent input={approval.normalizedInput} />
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
      <ProfileGenerationEditor
        {...(profiles.find((profile) => profile.id === activeId)
          ? { profile: profiles.find((profile) => profile.id === activeId)! }
          : {})}
        refresh={refresh}
      />
      <ProfileVerificationEditor
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

function PluginsView({ plugins, action, workspacePath, onApplyContent }: { plugins: PluginRecord[]; action: (method: "plugins.install" | "plugins.trust" | "plugins.enable" | "plugins.disable", params: Record<string, unknown>) => Promise<void>; workspacePath: string; onApplyContent: (text: string) => void }) {
  const [sourcePath, setSourcePath] = useState("");
  const [section, setSection] = useState<"mcp" | "local">("mcp");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2" role="tablist" aria-label="插件类型"><BuiButton role="tab" aria-selected={section === "mcp"} variant={section === "mcp" ? "primary" : "secondary"} onClick={() => setSection("mcp")}>MCP 服务</BuiButton><BuiButton role="tab" aria-selected={section === "local"} variant={section === "local" ? "primary" : "secondary"} onClick={() => setSection("local")}>本地插件</BuiButton></div>
      {section === "mcp" ? <McpView workspacePath={workspacePath} onApplyPrompt={onApplyContent} onAttachResource={onApplyContent} /> : <>
      <div>
        <h2 className="text-base font-semibold text-text">本地插件</h2>
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
      </>}
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
    changes: <ClipboardList size={16} />,
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
    changes: "代码变更",
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
    <DesktopChrome><App /></DesktopChrome>
  </React.StrictMode>,
);

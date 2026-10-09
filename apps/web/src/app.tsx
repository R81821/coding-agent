import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleHelp,
  FolderClosed,
  Globe2,
  LoaderCircle,
  Monitor,
  PanelLeft,
  Pause,
  Play,
  Plus,
  Search,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type { SessionRecord, RunSpec } from "@harness/protocol";
import { useWorkbench, errorMessage } from "./hooks/use-workbench";
import { isActive, projectName } from "./lib/model";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "./components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/ui/tooltip";
import { Sidebar, type Page } from "./components/sidebar";
import { Conversation, Welcome } from "./components/conversation";
const WorkspacePanels = lazy(() => import("./components/workspace-panels").then(module => ({ default: module.WorkspacePanels })));

type Inspection = {
  files: Array<{ path: string; sha256: string; content: string }>;
  trusted: boolean;
  changed: boolean;
};
function initialTheme(): "light" | "dark" | "system" {
  try {
    const value = localStorage.getItem("harness.web.theme");
    return value === "dark" || value === "system" ? value : "light";
  } catch {
    return "light";
  }
}

export default function App() {
  const work = useWorkbench();
  const [page, setPage] = useState<Page>("chat");
  const [sidebar, setSidebar] = useState(true);
  const [mobile, setMobile] = useState(false);
  const [theme, setTheme] = useState(initialTheme);
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [projectOpen, setProjectOpen] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [inspection, setInspection] = useState<Inspection>();
  const [workspace, setWorkspace] = useState("");
  const [profileId, setProfileId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [taskMode, setTaskMode] = useState<"auto" | "analysis" | "change">(
    "auto",
  );
  const drafts = useRef(new Map<string, { prompt: string; taskMode: "auto" | "analysis" | "change" }>());
  const navigation = useRef(0);
  const [pending, setPending] = useState(false);
  const [help, setHelp] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const actionLock = useRef(false);
  const currentPath = work.detail?.session.workspacePath ?? work.sessions.items.find(item => item.id === work.activeId)?.workspacePath ?? workspace;
  const profile =
    work.profiles.find(
      (p) => p.id === (work.detail?.session.profileId ?? profileId),
    ) ?? work.profiles[0];
  const lastRun = work.detail?.runs.at(-1);
  const busy = isActive(lastRun?.status);
  const paused = lastRun?.status === "paused";

  useEffect(() => {
    try {
      localStorage.setItem("harness.web.theme", theme);
    } catch {
      /* Theme still applies for this visit. */
    }
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle(
        "dark",
        theme === "dark" || (theme === "system" && media.matches),
      );
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    drafts.current.clear(); navigation.current++;
    setWorkspace("");
    setProfileId("");
    setPrompt("");
  }, [work.mode]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch((v) => !v);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  function selectSession(id: string) {
    if (work.activeId) drafts.current.set(work.activeId, { prompt, taskMode });
    navigation.current++;
    work.setActiveId(id);
    setTaskMode(drafts.current.get(id)?.taskMode ?? "auto");
    setPage("chat");
    setMobile(false);
    setSearch(false);
    setPrompt(drafts.current.get(id)?.prompt ?? "");
  }
  function newTask() {
    if (work.activeId) drafts.current.set(work.activeId, { prompt, taskMode });
    navigation.current++;
    work.setActiveId(undefined);
    setPage("chat");
    setPrompt("");
    setMobile(false);
    setTimeout(() => textarea.current?.focus(), 0);
  }
  function goPage(page: Page) {
    setPage(page);
    setMobile(false);
  }
  async function action(callback: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    const token = navigation.current;
    setPending(true);
    work.setError("");
    try {
      await callback();
    } catch (e) {
      if (token === navigation.current) work.setError(errorMessage(e));
    } finally {
      setPending(false);
      actionLock.current = false;
    }
  }
  async function send() {
    if (
      work.selectionLoading ||
      !prompt.trim() ||
      !profile ||
      busy ||
      paused ||
      (work.activeId && !work.detail)
    )
      return;
    const path = currentPath || (work.mode === "demo" ? "/demo/harness" : "");
    if (!path) {
      setProjectOpen(true);
      return;
    }
    const request = prompt.trim();
    const token = navigation.current;
    await action(async () => {
      let session = work.detail?.session;
      if (!session) {
        const now = new Date().toISOString();
        session = await work.request<SessionRecord>({
          method: "sessions.create",
          params: {
            id: `session_${crypto.randomUUID()}`,
            title: request.slice(0, 100),
            workspacePath: path,
            profileId: profile.id,
            createdAt: now,
            updatedAt: now,
          },
        });
        if (token === navigation.current) work.setActiveId(session.id);
      }
      const spec: RunSpec = {
        id: `run_${crypto.randomUUID()}`,
        sessionId: session.id,
        request,
        workspacePath: session.workspacePath,
        profileId: session.profileId,
        taskMode,
        attachments: [],
        grants: [],
        budget: profile.budget,
        createdAt: new Date().toISOString(),
      };
      await work.request({ method: "run.start", params: spec });
      drafts.current.delete(session.id);
      if (token === navigation.current) setPrompt("");
      await work.reloadDetail(session.id);
    });
  }
  async function inspectProject() {
    if (!pathInput.trim()) return;
    if (
      work.mode === "local" &&
      !/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(pathInput.trim())
    ) {
      work.setError("请输入项目的绝对路径，例如 D:\\projects\\my-app。");
      return;
    }
    await action(async () => {
      const checked = await work.request<Inspection>({
        method: "project.inspect",
        params: { workspacePath: pathInput.trim() },
      });
      if (checked.files.length && (!checked.trusted || checked.changed))
        setInspection(checked);
      else acceptProject();
    });
  }
  function acceptProject() {
    newTask();
    setWorkspace(pathInput.trim());
    setPage("chat");
    setProjectOpen(false);
    setInspection(undefined);
  }
  const sidebarProps = {
    work,
    page,
    onPage: goPage,
    onNew: newTask,
    onSearch: () => setSearch(true),
    onProject: () => setProjectOpen(true),
    onClose: () => {
      setSidebar(false);
      setMobile(false);
    },
    onSession: selectSession,
  };
  const paths = [
    ...new Set([
      ...work.projects.map((p) => p.workspacePath),
      ...(workspace ? [workspace] : []),
    ]),
  ];
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-dvh min-h-0 w-full overflow-hidden">
        <a
          href="#main"
          className="sr-only z-50 rounded bg-card p-3 focus:not-sr-only focus:absolute"
        >
          跳到内容
        </a>
        {sidebar && (
          <div className="hidden w-[258px] shrink-0 border-r md:block">
            <Sidebar {...sidebarProps} />
          </div>
        )}
        <Sheet open={mobile} onOpenChange={setMobile}>
          <SheetContent
            side="left"
            className="w-[280px] gap-0 p-0"
            showCloseButton={false}
          >
            <SheetTitle className="sr-only">工作台导航</SheetTitle>
            <SheetDescription className="sr-only">
              项目、会话和工作台工具
            </SheetDescription>
            <Sidebar {...sidebarProps} />
          </SheetContent>
        </Sheet>
        <main id="main" className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border/70 px-4 sm:px-7">
            <Button
              variant="ghost"
              size="icon-sm"
              className={sidebar ? "md:hidden" : ""}
              aria-label="展开侧栏"
              onClick={() => {
                if (matchMedia("(min-width: 768px)").matches) setSidebar(true);
                else setMobile(true);
              }}
            >
              <PanelLeft />
            </Button>
            <span className="hidden text-muted-foreground sm:inline">
              工作台
            </span>
            <span className="hidden text-border sm:inline">/</span>
            <span className="min-w-0 flex-1 truncate">
              {page === "chat"
                ? (work.detail?.session.title ?? "新任务")
                : {
                    tasks: "任务板",
                    approvals: "审批",
                    skills: "技能",
                    plugins: "插件",
                    settings: "设置",
                  }[page]}
            </span>
            <Badge
              variant="outline"
              className="hidden gap-1.5 rounded-full font-normal text-muted-foreground sm:flex"
            >
              <span
                className={`size-1.5 rounded-full ${work.mode === "demo" ? "bg-amber-500" : "bg-emerald-500"}`}
              />
              {work.mode === "demo" ? "演示模式" : "本地已连接"}
            </Badge>
            {work.mode === "demo" && (
              <Button
                variant="outline"
                size="sm"
                disabled={work.connecting || pending}
                onClick={() => void work.connect()}
              >
                {work.connecting ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Monitor />
                )}
                <span className="hidden sm:inline">连接本地服务</span>
                <span className="sm:hidden">连接</span>
              </Button>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="使用帮助"
                  onClick={() => setHelp(true)}
                >
                  <CircleHelp className="text-muted-foreground" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>使用帮助</TooltipContent>
            </Tooltip>
          </header>
          {work.mode === "demo" && (
            <div className="flex shrink-0 items-center justify-center gap-2 border-b border-primary/5 bg-primary/[0.035] px-4 py-2 text-xs text-muted-foreground">
              <Sparkles className="size-3" />
              <span>自在探索，当前为演示模式</span>
              <span className="hidden sm:inline">· 不会修改真实项目</span>
            </div>
          )}
          {work.error && (
            <div
              role="alert"
              className="mx-4 mt-3 flex shrink-0 items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-destructive"
            >
              <span className="flex-1">{work.error}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="关闭错误提示"
                onClick={() => work.setError("")}
              >
                <X />
              </Button>
            </div>
          )}
          {page === "chat" ? (
            <>
              {work.activeId ? (
                <Conversation work={work} />
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <Welcome
                    work={work}
                    onSession={selectSession}
                    onSuggest={(text) => {
                      setPrompt(text);
                      textarea.current?.focus();
                    }}
                  />
                </div>
              )}
              <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-3 pb-4 sm:px-6 sm:pb-5">
                <div className="rounded-2xl border bg-card p-3 shadow-[0_6px_25px_-12px_rgba(30,50,30,0.2)] transition focus-within:border-primary/40">
                  <Textarea
                    ref={textarea}
                    aria-label="任务描述"
                    placeholder={
                      paused
                        ? "任务已暂停，可继续或停止本次任务"
                        : busy
                          ? "Harness 正在处理，你可以暂停或停止任务…"
                          : "描述你的想法，让我们开始吧…"
                    }
                    value={prompt}
                    disabled={pending || busy || paused}
                    onChange={(e) => setPrompt(e.target.value)}
                    className="min-h-20 max-h-44 resize-none rounded-none border-0 bg-transparent px-2 py-2 text-sm shadow-none focus-visible:ring-0 md:text-sm"
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing &&
                        e.keyCode !== 229
                      ) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          className="max-w-44 min-w-0 gap-1.5 text-xs text-muted-foreground"
                        >
                          <FolderClosed />
                          <span className="truncate">
                            {currentPath
                              ? projectName(currentPath)
                              : work.mode === "demo"
                                ? "harness"
                                : "选择项目"}
                          </span>
                          <ChevronDown className="size-3" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        {paths.map((path) => (
                          <DropdownMenuItem
                            key={path}
                            onSelect={() => {
                              newTask();
                              setWorkspace(path);
                            }}
                          >
                            <FolderClosed />
                            {projectName(path)}
                            {path === currentPath && (
                              <Check className="ml-auto" />
                            )}
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuItem onSelect={() => setProjectOpen(true)}>
                          <Plus />
                          添加项目
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <span className="h-3 w-px bg-border" />
                    <Select
                      value={profile?.id ?? ""}
                      onValueChange={setProfileId}
                      disabled={pending || !!work.activeId}
                    >
                      <SelectTrigger
                        aria-label="选择 Profile"
                        className="h-8! max-w-36 gap-1 border-0 bg-transparent px-2 text-xs shadow-none"
                      >
                        <SelectValue placeholder="选择 Profile" />
                      </SelectTrigger>
                      <SelectContent>
                        {work.profiles.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="ml-auto flex items-center gap-1.5">
                      <Select
                        value={taskMode}
                        onValueChange={(v) => setTaskMode(v as typeof taskMode)}
                        disabled={pending || busy || paused}
                      >
                        <SelectTrigger
                          aria-label="任务模式"
                          className="h-8! w-20 border-0 px-2 text-xs shadow-none"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">自动</SelectItem>
                          <SelectItem value="analysis">分析</SelectItem>
                          <SelectItem value="change">修改</SelectItem>
                        </SelectContent>
                      </Select>
                      {(busy || paused) && lastRun ? (
                        <>
                          {busy && (
                            <Button
                              size="icon-sm"
                              variant="secondary"
                              aria-label="暂停任务"
                              disabled={pending}
                              onClick={() =>
                                void action(async () => {
                                  await work.request({
                                    method: "run.pause",
                                    params: { runId: lastRun.spec.id },
                                  });
                                  await work.reloadDetail(
                                    lastRun.spec.sessionId,
                                  );
                                })
                              }
                            >
                              <Pause />
                            </Button>
                          )}
                          {paused && (
                            <Button
                              size="icon-sm"
                              aria-label="继续任务"
                              disabled={pending}
                              onClick={() =>
                                void action(async () => {
                                  await work.request({
                                    method: "run.resume",
                                    params: { runId: lastRun.spec.id },
                                  });
                                  await work.reloadDetail(
                                    lastRun.spec.sessionId,
                                  );
                                })
                              }
                            >
                              <Play />
                            </Button>
                          )}
                          <Button
                            size="icon-sm"
                            variant="outline"
                            aria-label="停止任务"
                            disabled={pending}
                            onClick={() =>
                              void action(async () => {
                                await work.request({
                                  method: "run.cancel",
                                  params: { runId: lastRun.spec.id },
                                });
                                await work.reloadDetail(lastRun.spec.sessionId);
                              })
                            }
                          >
                            <Square />
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="icon"
                          className="rounded-xl"
                          aria-label="发送任务"
                          disabled={
                            pending ||
                            !prompt.trim() ||
                            !profile ||
                            (Boolean(work.activeId) && !work.detail)
                          }
                          onClick={() => void send()}
                        >
                          {pending ? (
                            <LoaderCircle className="animate-spin" />
                          ) : (
                            <ArrowUp />
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex justify-between px-1 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Globe2 className="size-3" />
                    {work.mode === "demo"
                      ? "浏览器演示 · 无模型调用"
                      : "本地工作区 · 由你掌控"}
                  </span>
                  <span>
                    Enter 发送
                    <span className="hidden sm:inline">
                      {" "}
                      · Shift + Enter 换行
                    </span>
                  </span>
                </div>
              </div>
            </>
          ) : (
            <Suspense fallback={<p role="status">正在加载页面…</p>}><WorkspacePanels
              page={page}
              work={work}
              onSession={selectSession}
              theme={theme}
              setTheme={setTheme}
            /></Suspense>
          )}
        </main>
        <Dialog open={search} onOpenChange={setSearch}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>搜索对话</DialogTitle>
              <DialogDescription>
                按任务标题查找当前工作区的历史会话。
              </DialogDescription>
            </DialogHeader>
            <div className="relative">
              <Search className="absolute top-3 left-3 size-4 text-muted-foreground" />
              <Input
                aria-label="搜索对话关键词"
                autoFocus
                placeholder="搜索任务标题…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-10 pl-10"
              />
            </div>
            <div className="max-h-80 overflow-auto">
              {work.sessions.items
                .filter((s) =>
                  s.title.toLowerCase().includes(query.toLowerCase()),
                )
                .map((s) => (
                  <Button
                    key={s.id}
                    variant="ghost"
                    className="h-auto w-full min-w-0 justify-start py-3"
                    onClick={() => selectSession(s.id)}
                  >
                    <FolderClosed className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{s.title}</span>
                  </Button>
                ))}
              {!work.sessions.items.some((s) =>
                s.title.toLowerCase().includes(query.toLowerCase()),
              ) && (
                <p className="py-8 text-center text-muted-foreground">
                  没有找到匹配的对话。
                </p>
              )}
            </div>
          </DialogContent>
        </Dialog>
        <Dialog
          open={projectOpen}
          onOpenChange={(open) => {
            if (!pending) {
              setProjectOpen(open);
              if (!open) setInspection(undefined);
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {inspection ? "项目指令确认" : "打开项目"}
              </DialogTitle>
              <DialogDescription>
                {inspection
                  ? "以下文件将影响 Agent 的行为。确认来源可信后，才授予指令权限。"
                  : work.mode === "demo"
                    ? "输入一个项目名称或路径，添加到浏览器演示中。"
                    : "输入本地 Harness 服务所在电脑上的项目绝对路径。"}
              </DialogDescription>
            </DialogHeader>
            {inspection ? (
              <>
                <pre className="max-h-64 overflow-auto rounded-xl bg-secondary p-4 text-xs whitespace-pre-wrap">
                  {inspection.files
                    .map((f) => `${f.path}\n${f.content}`)
                    .join("\n\n")}
                </pre>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={acceptProject}
                  >
                    不信任，仅打开
                  </Button>
                  <Button
                    disabled={pending}
                    onClick={() =>
                      void action(async () => {
                        await work.request({
                          method: "project.trust",
                          params: {
                            workspacePath: pathInput.trim(),
                            files: inspection.files.map(({ path, sha256 }) => ({
                              path,
                              sha256,
                            })),
                          },
                        });
                        acceptProject();
                      })
                    }
                  >
                    信任并打开
                  </Button>
                </div>
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void inspectProject();
                }}
                className="space-y-4"
              >
                <label className="space-y-2">
                  <span>项目路径</span>
                  <Input
                    autoFocus
                    className="mt-2"
                    value={pathInput}
                    onChange={(e) => setPathInput(e.target.value)}
                    placeholder={
                      work.mode === "demo"
                        ? "/demo/my-project"
                        : "D:\\projects\\my-app"
                    }
                    required
                  />
                </label>
                <Button
                  type="submit"
                  disabled={pending || !pathInput.trim()}
                  className="float-right"
                >
                  {pending ? "正在检查…" : "打开项目"}
                </Button>
              </form>
            )}
          </DialogContent>
        </Dialog>
        <Dialog open={help} onOpenChange={setHelp}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>你的 Harness 网页工作台</DialogTitle>
              <DialogDescription>
                从想法开始，专注把事情做好。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 leading-7">
              <p>
                <strong>先试一试</strong>
                <br />
                选择一个灵感卡片，发送任务，体验对话与状态变化。演示内容只保存在当前浏览器。
              </p>
              <p>
                <strong>连接真实项目</strong>
                <br />
                启动并解锁本地 Harness 服务，点击“连接本地服务”，再选择项目与
                Profile。
              </p>
              <p>
                <strong>保持顺手</strong>
                <br />
                点击项目名称折叠会话；Ctrl / ⌘ K 搜索；Enter 发送，Shift + Enter
                换行。
              </p>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

import {
  FolderClosed,
  MessageSquare,
  SquarePen,
  Search,
  PanelsTopLeft,
  Puzzle,
  ShieldCheck,
  Settings2,
  Sparkles,
  Plus,
  PanelLeftClose,
  Globe2,
} from "lucide-react";
import type { Workbench } from "../hooks/use-workbench";
import { Button } from "./ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { StatusMarker } from "./status-marker";
import { cn } from "../lib/utils";
import { projectName } from "../lib/model";

export type Page =
  "chat" | "tasks" | "skills" | "plugins" | "approvals" | "settings";
export const navigation = [
  { id: "chat", label: "会话", icon: MessageSquare },
  { id: "tasks", label: "任务板", icon: PanelsTopLeft },
  { id: "approvals", label: "审批", icon: ShieldCheck },
  { id: "plugins", label: "插件", icon: Puzzle },
] as const;
type Props = {
  work: Workbench;
  page: Page;
  onPage: (page: Page) => void;
  onNew: () => void;
  onSearch: () => void;
  onProject: () => void;
  onClose: () => void;
  onSession: (id: string) => void;
};
export function Sidebar({
  work,
  page,
  onPage,
  onNew,
  onSearch,
  onProject,
  onClose,
  onSession,
}: Props) {
  const paths = [
    ...new Set([
      ...work.projects.map((p) => p.workspacePath),
      ...work.sessions.items.map((s) => s.workspacePath),
    ]),
  ];
  const pending = work.approvals.filter((a) => a.status === "pending").length;
  return (
    <aside className="sidebar-type flex h-full w-full min-w-0 flex-col bg-sidebar">
      <div className="flex h-20 shrink-0 items-center justify-between px-6">
        <span className="text-[21px] font-bold tracking-[-1px]">
          Harness<span className="text-primary">.</span>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="收起侧栏"
          onClick={onClose}
        >
          <PanelLeftClose className="text-muted-foreground" />
        </Button>
      </div>
      <div className="px-3 pb-4">
        <Button
          variant="outline"
          className="mb-1 h-10 w-full justify-start rounded-xl border-border/70 bg-card shadow-xs"
          onClick={onNew}
        >
          <SquarePen className="mr-1" />
          新建任务<span className="ml-auto text-muted-foreground">＋</span>
        </Button>
        <Button
          variant="ghost"
          className="w-full justify-start text-muted-foreground"
          onClick={onSearch}
        >
          <Search className="mr-1" />
          搜索对话
          <span className="ml-auto rounded border px-1 text-xs">Ctrl K</span>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <nav aria-label="主导航" className="space-y-1 px-3">
          {navigation.map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => onPage(item.id)}
              className={cn(
                "h-10 w-full justify-start rounded-lg",
                page === item.id && "bg-accent text-primary",
              )}
            >
              <item.icon className="mr-1" />
              {item.label}
              {item.id === "approvals" && pending > 0 && (
                <span className="ml-auto rounded-full bg-primary px-1.5 text-xs text-primary-foreground">
                  {pending}
                </span>
              )}
            </Button>
          ))}
        </nav>
        <section className="mt-8 px-3">
          <div className="mb-2 flex h-8 items-center justify-between px-2 text-muted-foreground">
            <span>项目</span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="添加项目"
              onClick={onProject}
            >
              <Plus />
            </Button>
          </div>
          {paths.map((path) => (
            <Collapsible
              key={`${work.mode}:${path}`}
              defaultOpen
              className="mb-2"
            >
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-9 w-full min-w-0 justify-start px-2"
                  title={path}
                >
                  <FolderClosed className="mr-1 text-muted-foreground" />
                  <span className="truncate">{projectName(path)}</span>
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-1 pt-1">
                {work.sessions.items
                  .filter((s) => s.workspacePath === path)
                  .map((s) => (
                    <Button
                      key={s.id}
                      variant="ghost"
                      title={s.title}
                      onClick={() => onSession(s.id)}
                      aria-current={
                        page === "chat" && work.activeId === s.id
                          ? "page"
                          : undefined
                      }
                      className={cn(
                        "h-9 w-full min-w-0 justify-start gap-2 rounded-lg pl-8 pr-2",
                        page === "chat" &&
                          work.activeId === s.id &&
                          "bg-accent",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate text-left">
                        {s.title}
                      </span>
                      <StatusMarker status={s.latestStatus} />
                    </Button>
                  ))}
              </CollapsibleContent>
            </Collapsible>
          ))}
          {!paths.length && (
            <p className="px-2 py-3 text-muted-foreground">
              添加项目，开始你的第一个任务。
            </p>
          )}
          {work.sessions.hasMore && (
            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={() =>
                void work.loadMore().catch((e) => work.setError(String(e)))
              }
            >
              加载更多会话
            </Button>
          )}
        </section>
        <section className="mt-8 px-3 pb-6">
          <p className="mb-2 px-2 text-muted-foreground">工作台工具</p>
          <Button
            variant="ghost"
            onClick={() => onPage("skills")}
            className={cn(
              "h-10 w-full justify-start",
              page === "skills" && "bg-accent",
            )}
          >
            <Sparkles className="mr-1" />
            技能
          </Button>
        </section>
      </div>
      <div className="mx-3 shrink-0 border-t py-3">
        <Button
          variant="ghost"
          className={cn(
            "w-full justify-start",
            page === "settings" && "bg-accent",
          )}
          onClick={() => onPage("settings")}
        >
          <Settings2 className="mr-1" />
          设置<span className="ml-auto text-muted-foreground">网页版</span>
        </Button>
        <div className="mt-3 flex items-center gap-2 px-3 pb-1 text-muted-foreground">
          <Globe2 className="size-3.5" />
          <span>{work.mode === "demo" ? "演示工作区" : "已连接本地服务"}</span>
          <span
            className={cn(
              "ml-auto size-1.5 rounded-full",
              work.mode === "demo" ? "bg-amber-500" : "bg-emerald-500",
            )}
          />
        </div>
      </div>
    </aside>
  );
}

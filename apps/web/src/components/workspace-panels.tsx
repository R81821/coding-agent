import { useState } from "react";
import {
  ArrowUpRight,
  CheckCheck,
  FolderClosed,
  Search,
  ShieldCheck,
  Sparkles,
  Puzzle,
  Monitor,
  Moon,
  Sun,
  RefreshCw,
  Plug,
} from "lucide-react";
import type { Workbench } from "../hooks/use-workbench";
import { errorMessage } from "../hooks/use-workbench";
import { isActive, projectName, statusLabels } from "../lib/model";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { StatusMarker } from "./status-marker";
import type { Page } from "./sidebar";

function Empty({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof Search;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed px-6 text-center">
      <Icon className="mb-5 size-8 text-muted-foreground/60" />
      <p className="font-medium">{title}</p>
      <p className="mt-2 max-w-md leading-6 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}
export function WorkspacePanels({
  page,
  work,
  onSession,
  theme,
  setTheme,
}: {
  page: Page;
  work: Workbench;
  onSession: (id: string) => void;
  theme: string;
  setTheme: (theme: "light" | "dark" | "system") => void;
}) {
  const [filter, setFilter] = useState("");
  const [pending, setPending] = useState<string>();
  const [tab, setTab] = useState("all");
  const header: Record<string, [string, string]> = {
    tasks: ["任务板", "每一个想法，都有清晰的进展。"],
    skills: ["技能", "为不同的任务，找到合适的工作方式。"],
    plugins: ["插件", "连接工具，拓展你的工作台。"],
    approvals: ["审批", "重要操作，由你决定。"],
    settings: ["设置", "让工作台适合你的工作习惯。"],
  };
  const [title, subtitle] = header[page] ?? ["工作台", ""];
  const sessions = work.sessions.items.filter((s) =>
    s.title.toLowerCase().includes(filter.toLowerCase()),
  );
  const pendingApprovals = work.approvals.filter((a) => a.status === "pending");
  async function decide(id: string, approved: boolean) {
    setPending(id);
    try {
      await work.request({
        method: "approval.decide",
        params: { approvalId: id, approved, actor: "web-user" },
      });
      await work.refresh();
    } catch (e) {
      work.setError(errorMessage(e));
    } finally {
      setPending(undefined);
    }
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10 sm:px-10">
        <p className="mb-3 text-xs tracking-widest text-primary">WORKSPACE</p>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-3 mb-9 text-muted-foreground">{subtitle}</p>
        {page === "tasks" && (
          <>
            <div className="relative mb-6 max-w-sm">
              <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
              <Input
                aria-label="筛选任务"
                placeholder="搜索任务…"
                className="pl-9"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="mb-6">
                <TabsTrigger value="all">全部任务</TabsTrigger>
                <TabsTrigger value="active">进行中</TabsTrigger>
                <TabsTrigger value="completed">已完成</TabsTrigger>
              </TabsList>
              {["all", "active", "completed"].map((key) => {
                const filtered = sessions.filter(
                  (s) =>
                    key === "all" ||
                    (key === "active"
                      ? isActive(s.latestStatus) || s.latestStatus === "paused"
                      : s.latestStatus === "completed"),
                );
                return (
                  <TabsContent key={key} value={key}>
                    {!filtered.length ? (
                      <Empty
                        icon={CheckCheck}
                        title="这里还没有任务"
                        description="新建任务，或换一个筛选条件。"
                      />
                    ) : (
                      <div className="grid gap-3 md:grid-cols-2">
                        {filtered.map((s) => (
                          <button
                            key={s.id}
                            className="rounded-xl border bg-card p-5 text-left transition hover:border-primary/40 hover:shadow-sm"
                            onClick={() => onSession(s.id)}
                          >
                            <div className="mb-5 flex items-center gap-2 text-xs text-muted-foreground">
                              <FolderClosed className="size-3.5" />
                              {projectName(s.workspacePath)}
                              <ArrowUpRight className="ml-auto size-3.5" />
                            </div>
                            <p className="truncate font-medium">{s.title}</p>
                            <div className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
                              <StatusMarker status={s.latestStatus} />
                              {s.latestStatus
                                ? statusLabels[s.latestStatus]
                                : "新会话"}
                              <time className="ml-auto">
                                {new Date(s.updatedAt).toLocaleDateString(
                                  "zh-CN",
                                  { month: "short", day: "numeric" },
                                )}
                              </time>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </TabsContent>
                );
              })}
            </Tabs>
          </>
        )}
        {page === "skills" &&
          (!work.skills.length ? (
            <Empty
              icon={Sparkles}
              title="还没有可用技能"
              description="本地服务中的技能会显示在这里。你可以通过现有技能目录管理它们。"
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {work.skills.map((skill) => (
                <Card key={skill.key} className="shadow-none">
                  <CardContent>
                    <div className="mb-5 flex items-center justify-between">
                      <div className="rounded-lg bg-primary/8 p-2.5 text-primary">
                        <Sparkles className="size-5" />
                      </div>
                      <Badge variant="outline" className="font-normal">
                        {work.mode === "demo"
                          ? "示例"
                          : skill.scope === "project"
                            ? "项目技能"
                            : "全局技能"}
                      </Badge>
                    </div>
                    <h2 className="font-medium">{skill.manifest.name}</h2>
                    <p className="mt-3 leading-6 text-muted-foreground">
                      {skill.manifest.description}
                    </p>
                    {work.mode === "local" && (
                      <p className="mt-4 text-xs text-muted-foreground">
                        {skill.changedSinceTrust
                          ? "内容已变更，需重新信任"
                          : skill.manifest.trustedHash
                            ? "已信任"
                            : "尚未信任"}
                      </p>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          ))}
        {page === "plugins" &&
          (!work.plugins.length ? (
            <Empty
              icon={Puzzle}
              title="连接更多可能"
              description={
                work.mode === "demo"
                  ? "连接本地服务后，这里会展示已安装的插件。"
                  : "尚未安装插件。已安装插件将自动同步到网页工作台。"
              }
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {work.plugins.map((plugin) => (
                <Card key={plugin.manifest.id} className="shadow-none">
                  <CardContent>
                    <Puzzle className="mb-4 size-5 text-primary" />
                    <h2 className="font-medium">{plugin.manifest.name}</h2>
                    <p className="mt-2 text-muted-foreground">
                      v{plugin.manifest.version} ·{" "}
                      {plugin.manifest.tools.length} 个工具
                    </p>
                    <Badge variant="secondary" className="mt-4">
                      {plugin.enabled ? "已启用" : "未启用"}
                    </Badge>
                  </CardContent>
                </Card>
              ))}
            </div>
          ))}
        {page === "approvals" &&
          (!pendingApprovals.length ? (
            <Empty
              icon={ShieldCheck}
              title="一切就绪，无待处理审批"
              description="需要你确认的工具操作会出现在这里，执行计划也会在对应会话内展示。"
            />
          ) : (
            <div className="space-y-4">
              {pendingApprovals.map((a) => (
                <Card key={a.id} className="shadow-none">
                  <CardContent>
                    <div className="flex items-center justify-between">
                      <h2 className="font-medium">{a.toolName}</h2>
                      <Badge variant="outline">{a.risk}</Badge>
                    </div>
                    <p className="mt-3">{a.reason}</p>
                    <pre className="my-4 max-h-64 overflow-auto rounded-xl bg-secondary p-4 text-xs whitespace-pre-wrap">
                      {JSON.stringify(
                        {
                          input: a.normalizedInput,
                          permission: a.requestedGrant,
                        },
                        null,
                        2,
                      )}
                    </pre>
                    <p className="mb-4 text-xs text-muted-foreground">
                      有效期至 {new Date(a.expiresAt).toLocaleString("zh-CN")}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        disabled={!!pending}
                        onClick={() => void decide(a.id, true)}
                      >
                        批准
                      </Button>
                      <Button
                        disabled={!!pending}
                        variant="outline"
                        onClick={() => void decide(a.id, false)}
                      >
                        拒绝
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ))}
        {page === "settings" && (
          <div className="max-w-2xl space-y-6">
            <Card className="shadow-none">
              <CardContent>
                <h2 className="mb-2 font-medium">外观</h2>
                <p className="mb-5 text-muted-foreground">
                  在明亮与专注之间，找到你的节奏。
                </p>
                <div className="flex flex-wrap gap-3">
                  {[
                    { id: "light", name: "浅色", icon: Sun },
                    { id: "dark", name: "深色", icon: Moon },
                    { id: "system", name: "跟随系统", icon: Monitor },
                  ].map((t) => (
                    <Button
                      key={t.id}
                      variant={theme === t.id ? "default" : "outline"}
                      aria-pressed={theme === t.id}
                      onClick={() =>
                        setTheme(t.id as "light" | "dark" | "system")
                      }
                    >
                      <t.icon />
                      {t.name}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardContent>
                <h2 className="mb-2 font-medium">工作区连接</h2>
                <p className="mb-5 leading-6 text-muted-foreground">
                  {work.mode === "demo"
                    ? "当前为演示模式。示例会话保存在此浏览器中，不调用模型、不更改项目文件。连接服务后，可以访问本机项目并执行真实任务。"
                    : "已连接本机 Harness 运行服务，使用服务中已有的项目、模型和 Profile 配置。"}
                </p>
                <Button
                  variant="outline"
                  disabled={work.connecting}
                  onClick={() =>
                    work.mode === "demo"
                      ? void work.connect()
                      : work.disconnect()
                  }
                >
                  <Plug />
                  {work.connecting
                    ? "正在连接…"
                    : work.mode === "demo"
                      ? "连接本地服务"
                      : "返回演示模式"}
                </Button>
                <p className="mt-4 text-xs leading-6 text-muted-foreground">
                  本地服务需先启动并解锁。网页端只监听本机地址；项目路径指向服务所在电脑。
                </p>
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardContent>
                <h2 className="mb-4 font-medium">可用 Profile</h2>
                {work.profiles.map((profile) => (
                  <div
                    key={profile.id}
                    className="border-t py-3 first:border-0"
                  >
                    <p>{profile.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {profile.preferredModels.join(" · ") || "自动选择模型"} ·{" "}
                      {profile.sandbox === "auto"
                        ? "自动运行环境"
                        : profile.sandbox}
                    </p>
                  </div>
                ))}
              </CardContent>
            </Card>
            <p className="text-xs text-muted-foreground">
              Harness Web · React + Tailwind CSS + shadcn/ui
            </p>
          </div>
        )}
        {!["settings", "tasks"].includes(page) && work.mode === "local" && (
          <Button
            className="mt-6"
            variant="ghost"
            onClick={() =>
              void Promise.all([
                work.refresh(),
                work.refreshCatalog(work.detail?.session.workspacePath),
              ]).catch((e) => work.setError(errorMessage(e)))
            }
          >
            <RefreshCw />
            刷新工作区
          </Button>
        )}
      </div>
    </div>
  );
}

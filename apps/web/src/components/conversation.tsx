import { memo, useEffect, useMemo, useRef, useState } from "react";
import { VirtualConversation, useRowState } from "@harness/conversation-ui";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  FileCode2,
  GitBranch,
  LoaderCircle,
  Terminal,
  Telescope,
  Hammer,
  Bug,
  ShieldCheck,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isDeferredOutput } from "@harness/protocol";
import type { AgentEvent, PlanSpec, RunReview } from "@harness/protocol";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogHeader,
  DialogDescription,
} from "./ui/dialog";
import { StatusMarker } from "./status-marker";
import {
  activityText,
  answerText,
  isActive,
  statusLabels,
  type Turn,
} from "../lib/model";
import { errorMessage, type Workbench } from "../hooks/use-workbench";

export const suggestions = [
  {
    icon: Telescope,
    title: "探索代码",
    description: "找到项目的脉络",
    prompt: "帮我梳理这个项目的结构，说明主要模块与关键入口。",
    color: "text-sky-600 bg-sky-500/8",
  },
  {
    icon: Hammer,
    title: "构建功能",
    description: "让想法成为现实",
    prompt: "我想添加一个新功能，请先分析项目结构并与我确定实施方案。",
    color: "text-amber-600 bg-amber-500/8",
  },
  {
    icon: ShieldCheck,
    title: "审查变更",
    description: "让代码更可靠",
    prompt: "审查当前未提交的代码变更，重点检查正确性和潜在回归。",
    color: "text-primary bg-primary/8",
  },
  {
    icon: Bug,
    title: "修复问题",
    description: "从定位到解决",
    prompt: "帮我定位和修复一个问题，请先了解项目并询问复现步骤。",
    color: "text-rose-500 bg-rose-500/8",
  },
];

export function Welcome({
  onSuggest,
  onSession,
  work,
}: {
  onSuggest: (text: string) => void;
  onSession: (id: string) => void;
  work: Workbench;
}) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col px-6 py-10 sm:px-10 sm:py-12">
      <div className="mb-7 flex items-center gap-2 text-xs tracking-[0.16em] text-muted-foreground">
        <span className="h-px w-6 bg-primary/40" />
        YOUR IDEAS, IN MOTION
      </div>
      <h1 className="text-3xl leading-tight font-semibold tracking-tight sm:text-[42px]">
        今天，我们一起
        <br className="sm:hidden" />
        构建什么<span className="text-primary">？</span>
      </h1>
      <p className="mt-5 text-sm leading-7 text-muted-foreground">
        从一个想法，到一次实现。
        <br className="sm:hidden" />让 Harness 和你一起把事情做好。
      </p>
      <div className="mt-9 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {suggestions.map((s) => (
          <button
            key={s.title}
            onClick={() => onSuggest(s.prompt)}
            className="group flex min-h-36 flex-col items-start rounded-xl border bg-card p-4 text-left transition hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-sm focus-visible:outline-2 focus-visible:outline-primary"
          >
            <span className={`mb-5 rounded-lg p-2 ${s.color}`}>
              <s.icon className="size-4" />
            </span>
            <span className="flex w-full items-center justify-between font-medium">
              {s.title}
              <ArrowUpRight className="size-3.5 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
            </span>
            <span className="mt-1.5 text-xs text-muted-foreground">
              {s.description}
            </span>
          </button>
        ))}
      </div>
      {work.sessions.items.length > 0 && (
        <div className="mt-10">
          <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>继续上次的灵感</span>
            <span>最近会话</span>
          </div>
          {work.sessions.items.slice(0, 2).map((s) => (
            <button
              key={s.id}
              onClick={() => onSession(s.id)}
              className="group flex w-full items-center gap-3 border-b py-3 text-left hover:text-primary"
            >
              <GitBranch className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <StatusMarker status={s.latestStatus} />
              <ArrowUpRight className="size-3.5 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type TurnActions = Pick<Workbench, "mode" | "request" | "setError" | "reloadDetail">;
const Answer = memo(function Answer({ text }: { text: string }) {
  return <div className="prose-harness"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: props => <a {...props} target="_blank" rel="noopener noreferrer" />,
  }}>{text}</ReactMarkdown></div>;
});
const TurnView = memo(function TurnView({ turn, work }: { turn: Turn; work: TurnActions }) {
  const [copied, setCopied] = useState(false);
  const [review, setReview] = useRowState<RunReview | undefined>("review", undefined);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [pending, setPending] = useRowState("planPending", false);
  const [plan, setPlan] = useState<PlanSpec>();
  const answer = useMemo(() => answerText(turn.events), [turn.events]);
  const result = turn.events.findLast(event => event.type === "result");
  const latestStatus = turn.events.findLast(event => event.type === "status");
  const terminalResult = result && (!latestStatus || result.sequence >= latestStatus.sequence) ? result : undefined;
  const displayStatus = terminalResult?.status ?? turn.status;
  const [processOpen, setProcessOpen] = useRowState("processOpen", false);
  const hasActivity = useMemo(() => turn.events.some(event => Boolean(activityText(event))), [turn.events]);
  const activity = useMemo(() => processOpen ? turn.events
    .map((e) => ({
      id: e.id,
      text: activityText(e),
      error: e.type === "error",
    }))
    .filter((e) => e.text) : [], [processOpen, turn.events]);
  const busy = isActive(turn.status) && !terminalResult;
  useEffect(() => {
    let current = true;
    if (work.mode === "local" && turn.status === "waiting_approval")
      void work
        .request<PlanSpec | undefined>({
          method: "plan.get",
          params: { runId: turn.spec.id },
        })
        .then((p) => {
          if (current) setPlan(p);
        })
        .catch((e) => {
          if (current) work.setError(errorMessage(e));
        });
    else setPlan(undefined);
    return () => {
      current = false;
    };
  }, [turn.spec.id, turn.status, work.mode, work.request]);
  async function decide(approved: boolean) {
    if (!plan || pending) return;
    setPending(true);
    try {
      await work.request({
        method: "plan.decide",
        params: {
          planId: plan.id,
          version: plan.version,
          approved,
          actor: "web-user",
        },
      });
      setPlan(undefined);
      await work.reloadDetail(turn.spec.sessionId);
    } catch (e) {
      work.setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <article className="mb-10">
      <div className="mb-7 flex justify-end">
        <div className="max-w-[90%] rounded-2xl rounded-br-md bg-secondary px-5 py-3 whitespace-pre-wrap">
          {turn.spec.request}
        </div>
      </div>
      <div className="mb-4 flex items-center gap-2">
        <span className="font-semibold tracking-tight">Harness</span>
        <StatusMarker status={displayStatus} />
        <span className="text-xs text-muted-foreground">
          {terminalResult?.status === "review" ? "待复核" : statusLabels[displayStatus]}
        </span>
        {work.mode === "demo" && (
          <Badge
            variant="outline"
            className="font-normal text-muted-foreground"
          >
            演示
          </Badge>
        )}
      </div>
      {turn.view && !turn.view.eventsComplete && <p role="status" className="text-xs text-muted-foreground">正在同步执行记录…</p>}
      {hasActivity && (
        <Collapsible open={processOpen} onOpenChange={setProcessOpen} className="mb-5 rounded-xl border bg-secondary/30">
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              className="h-9 w-full justify-between text-muted-foreground"
            >
              <span className="flex items-center gap-2">
                <Terminal className="size-3.5" />
                执行过程
              </span>
              <ChevronDown className="size-3.5" />
            </Button>
          </CollapsibleTrigger>
          {processOpen && <CollapsibleContent className="max-h-64 space-y-2 overflow-auto px-4 pb-4">
            {activity.map((e) => (
              <p
                key={e.id}
                className={
                  e.error ? "text-destructive" : "text-muted-foreground"
                }
              >
                {e.text}
              </p>
            ))}
            {turn.events.filter((event): event is Extract<AgentEvent, { type: "tool_finished" }> => event.type === "tool_finished").map(event => <ToolOutput key={event.id} event={event} />)}
          </CollapsibleContent>}
        </Collapsible>
      )}
      {terminalResult?.stop && terminalResult.status !== "paused" && <p role="status" className="mb-3 text-sm text-destructive">{terminalResult.stop.message}</p>}
      {answer && <Answer text={answer} />}
      {plan?.status === "awaiting_approval" && (
        <div className="mt-4 rounded-xl border p-4">
          <p className="font-medium">确认执行计划</p>
          <p className="mt-2">{plan.goal}</p>
          <pre className="mt-3 max-h-56 overflow-auto rounded bg-secondary p-3 text-xs whitespace-pre-wrap">
            {JSON.stringify({ steps: plan.steps, scope: plan.scope }, null, 2)}
          </pre>
          <div className="mt-3 flex gap-2">
            <Button disabled={pending} onClick={() => void decide(true)}>
              批准计划
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void decide(false)}
            >
              拒绝
            </Button>
          </div>
        </div>
      )}
      {busy && (
        <div
          role="status"
          aria-label="Harness 正在执行"
          className="mt-3 flex justify-start"
        >
          <span className="mascot-walk" aria-hidden="true" />
        </div>
      )}
      {!busy && (
        <div className="mt-4 flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={!answer}
            className="text-muted-foreground"
            onClick={() =>
              void navigator.clipboard
                .writeText(answer)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                })
                .catch(() => work.setError("复制失败，请手动选择文本复制。"))
            }
          >
            {copied ? <Check /> : <Copy />}
            {copied ? "已复制" : "复制"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={async () => {
              setReviewOpen(true);
              setReview(undefined);
              try {
                setReview(
                  await work.request<RunReview>({
                    method: "run.review",
                    params: { runId: turn.spec.id },
                  }),
                );
              } catch (e) {
                work.setError(errorMessage(e));
                setReviewOpen(false);
              }
            }}
          >
            <FileCode2 />
            代码变更
          </Button>
        </div>
      )}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>代码变更</DialogTitle>
            <DialogDescription>本次运行记录的文件差异</DialogDescription>
          </DialogHeader>
          {!review ? (
            <LoaderCircle className="animate-spin" />
          ) : !review.files.length ? (
            <p className="py-8 text-center text-muted-foreground">
              {review.reason || "此次运行没有记录文件变更。"}
            </p>
          ) : (
            review.files.map((file) => (
              <div
                key={file.path}
                className="overflow-hidden rounded-lg border"
              >
                <p className="flex gap-3 bg-secondary px-4 py-2">
                  <span className="min-w-0 flex-1 break-all">{file.path}</span>
                  <span className="text-emerald-600">+{file.added}</span>
                  <span className="text-destructive">−{file.deleted}</span>
                </p>
                <pre className="overflow-auto p-4 text-xs">{file.diff}</pre>
              </div>
            ))
          )}
        </DialogContent>
      </Dialog>
    </article>
  );
});

function ToolOutput({ event }: { event: Extract<AgentEvent, { type: "tool_finished" }> }) {
  if (isDeferredOutput(event.output)) return <p role="status">正在同步工具输出…</p>;
  return <pre className="max-h-64 overflow-auto whitespace-pre-wrap">{typeof event.output === "string" ? event.output : JSON.stringify(event.output, null, 2)}</pre>;
}

const turnKey = (turn: Turn) => turn.spec.id;

export function Conversation({ work }: { work: Workbench }) {
  const latest = useRef(work); latest.current = work;
  const actions = useMemo<TurnActions>(() => ({ mode: work.mode, request: work.request, setError: work.setError,
    reloadDetail: id => latest.current.reloadDetail(id) }), [work.mode, work.request, work.setError]);
  return <div className="relative min-h-0 flex-1">
    {work.content.error && <div role="alert">{work.content.error}<Button onClick={work.content.retry}>重试</Button></div>}
    <VirtualConversation key={work.activeId ?? "none"} items={work.detail?.runs ?? []} itemKey={turnKey}
      className="h-full overflow-y-auto [scrollbar-gutter:stable]" contentClassName="mx-auto max-w-3xl px-6"
      initialPosition={work.scrollPositions.current.get(work.activeId ?? "")}
      onPosition={position => { if (work.activeId) work.scrollPositions.current.set(work.activeId, position); }}
      onVisibleItems={work.content.prioritize}
      renderItem={turn => <TurnView turn={turn} work={actions} />}
      header={<>
        {work.detail?.hasMore && <p role="status">正在同步历史消息…</p>}
        {!work.detail ? <div role="status" className="flex items-center gap-2 text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在读取会话…</div>
          : !work.detail.runs.length ? <p className="py-16 text-center text-muted-foreground">项目已就绪，发送一条消息开始。</p> : null}
      </>}
    />
  </div>;
}

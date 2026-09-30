import {
  DEFAULT_PROFILE,
  SessionRecordSchema,
  AgentEventSchema,
  RunSpecSchema,
  RunStatusSchema,
  type DaemonRequestInput,
  type SessionDetail,
  type SessionSummary,
} from "@harness/protocol";
import { isActive } from "./model";

const storageKey = "harness.web.demo.v1";
const stamp = () => new Date().toISOString();
const message =
  "这是网页端的**交互演示**，没有调用模型，也没有修改项目文件。\n\n你可以在这里体验：\n\n- 连续对话与运行状态\n- 折叠项目、搜索历史任务\n- 暂停、继续和停止任务\n\n要执行真实开发任务，请在右上角选择 **连接本地服务**。连接后将使用本地 Harness 的项目、Profile 和模型配置。";
function seed(): SessionDetail[] {
  return [
    ["demo-1", "harness", "了解 Harness 的项目结构", "completed"],
    ["demo-2", "harness", "设计一个更专注的工作台", "completed"],
    ["demo-3", "design-system", "检查组件的无障碍体验", "paused"],
  ].map(([id, project, title, status]) => {
    const session = SessionRecordSchema.parse({
      id,
      title,
      workspacePath: `/demo/${project}`,
      profileId: "default",
      createdAt: stamp(),
      updatedAt: stamp(),
    });
    const spec = RunSpecSchema.parse({
      id: `${id}-run`,
      sessionId: id,
      request: title,
      workspacePath: session.workspacePath,
      profileId: "default",
      budget: DEFAULT_PROFILE.budget,
      createdAt: stamp(),
    });
    return {
      session,
      runs: [
        {
          spec,
          status: RunStatusSchema.parse(status),
          events: [
            {
              id: `${id}-event`,
              runId: spec.id,
              at: stamp(),
              sequence: 0,
              type: "result",
              text: message,
              status: RunStatusSchema.parse(status),
            },
          ],
        },
      ],
    };
  });
}

function restore(): SessionDetail[] {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(storageKey) ?? "null",
    );
    if (!Array.isArray(stored)) return seed();
    return stored.map((value) => ({
      session: SessionRecordSchema.parse(value.session),
      runs: value.runs.map((run: SessionDetail["runs"][number]) => ({
        spec: RunSpecSchema.parse(run.spec),
        status: isActive(run.status)
          ? ("paused" as const)
          : RunStatusSchema.parse(run.status),
        events: run.events.map((event) => AgentEventSchema.parse(event)),
      })),
    }));
  } catch {
    return seed();
  }
}

export function createDemo() {
  let sessions = restore();
  const active = new Map<string, number>();
  const save = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(sessions));
    } catch {
      /* Keep the in-memory demo available when storage is disabled/full. */
    }
  };
  function tick() {
    for (const session of sessions)
      for (const run of session.runs) {
        const started = active.get(run.spec.id);
        if (!started || !isActive(run.status)) continue;
        const elapsed = Date.now() - started;
        run.events = [
          {
            id: `${run.spec.id}-text`,
            runId: run.spec.id,
            at: stamp(),
            sequence: 0,
            type: "text_delta",
            delta: message.slice(
              0,
              Math.floor(Math.max(0, elapsed - 700) / 12),
            ),
          },
        ];
        if (elapsed > message.length * 12 + 1000) {
          run.status = "completed";
          run.events = [
            {
              id: `${run.spec.id}-result`,
              runId: run.spec.id,
              at: stamp(),
              sequence: 1,
              type: "result",
              text: message,
              status: "completed",
            },
          ];
          active.delete(run.spec.id);
          save();
        }
      }
  }
  async function request<T>(input: DaemonRequestInput): Promise<T> {
    tick();
    let result: unknown;
    switch (input.method) {
      case "health":
        result = { status: "ok" };
        break;
      case "profiles.list":
        result = [{ ...DEFAULT_PROFILE, name: "演示助手" }];
        break;
      case "projects.list":
        result = [...new Set(sessions.map((s) => s.session.workspacePath))].map(
          (path) => ({
            id: path,
            workspacePath: path,
            createdAt: stamp(),
            updatedAt: stamp(),
          }),
        );
        break;
      case "sessions.list":
        result = {
          items: sessions.map(({ session, runs }): SessionSummary => ({
            ...session,
            runCount: runs.length,
            ...(runs.length
              ? {
                  latestRunId: runs.at(-1)!.spec.id,
                  latestStatus: runs.at(-1)!.status,
                }
              : {}),
          })),
          hasMore: false,
        };
        break;
      case "session.get":
        result = sessions.find((s) => s.session.id === input.params.sessionId);
        break;
      case "sessions.create": {
        const session = SessionRecordSchema.parse(input.params);
        sessions.unshift({ session, runs: [] });
        save();
        result = session;
        break;
      }
      case "run.start": {
        const session = sessions.find(
          (s) => s.session.id === input.params.sessionId,
        );
        if (!session) throw new Error("会话不存在");
        session.session.title = session.runs.length
          ? session.session.title
          : input.params.request.slice(0, 60);
        session.session.updatedAt = stamp();
        session.runs.push({
          spec: input.params,
          status: "running",
          events: [],
        });
        active.set(input.params.id, Date.now());
        save();
        result = { runId: input.params.id };
        break;
      }
      case "run.pause":
      case "run.cancel":
      case "run.resume": {
        const run = sessions
          .flatMap((s) => s.runs)
          .find((r) => r.spec.id === input.params.runId);
        if (!run) throw new Error("运行不存在");
        run.status =
          input.method === "run.pause"
            ? "paused"
            : input.method === "run.cancel"
              ? "cancelled"
              : "running";
        if (run.status === "running") active.set(run.spec.id, Date.now());
        else active.delete(run.spec.id);
        save();
        result = {};
        break;
      }
      case "skills.list":
        result = [
          {
            key: "demo-explore",
            manifest: {
              name: "代码探索",
              description: "梳理项目结构，理解模块边界与关键逻辑。",
            },
            scope: "global",
          },
          {
            key: "demo-frontend",
            manifest: {
              name: "前端设计",
              description: "从布局、组件到细节，构建一致的使用体验。",
            },
            scope: "project",
          },
          {
            key: "demo-review",
            manifest: {
              name: "代码审查",
              description: "检查潜在问题，让每一次变更都更可靠。",
            },
            scope: "global",
          },
        ];
        break;
      case "plugins.list":
        result = [];
        break;
      case "approvals.list":
        result = [];
        break;
      case "project.inspect":
        result = { trusted: true, changed: false, files: [] };
        break;
      case "run.review":
        result = { runId: input.params.runId, status: "ready", files: [] };
        break;
      default:
        throw new Error("演示模式不执行此操作，请连接本地服务。");
    }
    return structuredClone(result) as T;
  }
  return { request };
}

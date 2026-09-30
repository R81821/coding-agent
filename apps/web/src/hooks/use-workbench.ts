import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApprovalRequest,
  DaemonRequestInput,
  Profile,
  ProjectRecord,
  SessionDetail,
  SessionPage,
} from "@harness/protocol";
import { rpc } from "../lib/api";
import { createDemo } from "../lib/demo";
import type { Plugin, Skill } from "../lib/model";

export function useWorkbench() {
  const [demo] = useState(createDemo);
  const [mode, setMode] = useState<"demo" | "local">("demo");
  const [sessions, setSessions] = useState<SessionPage>({
    items: [],
    hasMore: false,
  });
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [detail, setDetail] = useState<SessionDetail>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const generation = useRef(0);
  const pageCount = useRef(1);
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const request = useCallback(
    <T>(input: DaemonRequestInput) =>
      mode === "demo" ? demo.request<T>(input) : rpc<T>(input),
    [mode, demo],
  );
  const refresh = useCallback(async () => {
    const gen = generation.current;
    const [pages, allProjects, approvals] = await Promise.all([
      Promise.all(
        Array.from({ length: pageCount.current }, (_, page) =>
          request<SessionPage>({
            method: "sessions.list",
            params: { deleted: false, limit: 200, offset: page * 200 },
          }),
        ),
      ),
      request<ProjectRecord[]>({
        method: "projects.list",
        params: { deleted: false },
      }),
      request<ApprovalRequest[]>({ method: "approvals.list" }),
    ]);
    if (gen !== generation.current) return;
    const unique = new Map(
      pages
        .flatMap((page) => page.items)
        .map((session) => [session.id, session]),
    );
    setSessions({
      items: [...unique.values()],
      hasMore: pages.at(-1)?.hasMore ?? false,
    });
    setProjects(allProjects);
    setApprovals(approvals);
  }, [request]);

  const refreshCatalog = useCallback(
    async (workspacePath?: string) => {
      const gen = generation.current;
      const [profiles, skills, plugins] = await Promise.all([
        request<Profile[]>({ method: "profiles.list" }),
        request<Skill[]>({
          method: "skills.list",
          ...(workspacePath ? { params: { workspacePath } } : {}),
        }),
        request<Plugin[]>({ method: "plugins.list" }),
      ]);
      if (gen !== generation.current) return;
      setProfiles(profiles);
      setSkills(skills);
      setPlugins(plugins);
    },
    [request],
  );

  const selectedWorkspace = detail?.session.workspacePath;
  useEffect(() => {
    if (!selectedWorkspace) return;
    let current = true;
    void request<Skill[]>({
      method: "skills.list",
      params: { workspacePath: selectedWorkspace },
    })
      .then((skills) => {
        if (current) setSkills(skills);
      })
      .catch((e) => {
        if (current) setError(errorMessage(e));
      });
    return () => {
      current = false;
    };
  }, [selectedWorkspace, request]);

  useEffect(() => {
    let stopped = false;
    const gen = ++generation.current;
    pageCount.current = 1;
    setLoading(true);
    setDetail(undefined);
    const init = async () => {
      try {
        const [profiles, skills, plugins] = await Promise.all([
          request<Profile[]>({ method: "profiles.list" }),
          request<Skill[]>({ method: "skills.list" }),
          request<Plugin[]>({ method: "plugins.list" }),
        ]);
        if (stopped || gen !== generation.current) return;
        setProfiles(profiles);
        setSkills(skills);
        setPlugins(plugins);
        await refresh();
      } catch (e) {
        if (!stopped) setError(errorMessage(e));
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    void init();
    return () => {
      stopped = true;
    };
  }, [request, refresh]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    setDetail(undefined);
    const poll = async () => {
      try {
        if (activeId) {
          const next = await request<SessionDetail | undefined>({
            method: "session.get",
            params: { sessionId: activeId },
          });
          if (!stopped) setDetail(next);
        }
        if (!stopped) await refresh();
      } catch (e) {
        if (!stopped) setError(errorMessage(e));
      }
      if (!stopped) timer = setTimeout(poll, 1800);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [activeId, request, refresh]);

  async function connect() {
    setConnecting(true);
    setError("");
    try {
      await rpc({ method: "health" });
      generation.current++;
      setActiveId(undefined);
      setDetail(undefined);
      setSessions({ items: [], hasMore: false });
      setProjects([]);
      setMode("local");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setConnecting(false);
    }
  }
  function disconnect() {
    generation.current++;
    setActiveId(undefined);
    setDetail(undefined);
    setError("");
    setMode("demo");
  }
  async function reloadDetail(id: string) {
    const data = await request<SessionDetail>({
      method: "session.get",
      params: { sessionId: id },
    });
    if (activeRef.current === id) setDetail(data);
    await refresh();
  }
  async function loadMore() {
    pageCount.current++;
    try {
      await refresh();
    } catch (error) {
      pageCount.current--;
      throw error;
    }
  }
  return {
    mode,
    sessions,
    projects,
    profiles,
    skills,
    plugins,
    approvals,
    activeId,
    setActiveId,
    detail,
    error,
    setError,
    loading,
    connecting,
    connect,
    disconnect,
    request,
    refresh,
    refreshCatalog,
    reloadDetail,
    loadMore,
  };
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请重试。";
}
export type Workbench = ReturnType<typeof useWorkbench>;

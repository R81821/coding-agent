import { ConversationPositions, useSessionContent } from "@harness/conversation-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ApprovalRequest,
  DaemonRequestInput,
  Profile,
  ProjectRecord,
  SessionView,
  RunEventPage,
  SessionPage,
} from "@harness/protocol";
import { SessionViewCache, refreshSessionView, mergeViewEvents } from "@harness/protocol";
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
  const [activeId, selectActiveId] = useState<string>();
  const [detail, setDetail] = useState<SessionView>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const generation = useRef(0);
  const cache = useRef(new SessionViewCache());
  const navigation = useRef(0);
  const readVersion = useRef(0);
  const historyVersion = useRef(0);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [selectionRetry, setSelectionRetry] = useState(0);
  const scrollPositions = useRef(new ConversationPositions());
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const activeRef = useRef(activeId);
  function setActiveId(id: string | undefined) {
    if (id === activeRef.current) {
      if (!id || selectionLoading || !error) return;
      setSelectionRetry(value => value + 1);
    }
    if (detailRef.current) cache.current.set(detailRef.current);
    navigation.current++; readVersion.current++;
    activeRef.current = id;
    selectActiveId(id);
    setDetail(id ? cache.current.get(id) : undefined);
    setSelectionLoading(Boolean(id)); setError("");
  }
  const request = useCallback(
    async <T>(input: DaemonRequestInput) => {
      const result = await (mode === "demo" ? demo.request<T>(input) : rpc<T>(input));
      if (["session.delete", "session.purge", "session.skills", "project.delete", "project.trust", "profiles.memoryScopes", "plugins.trust", "plugins.disable", "skills.untrust", "skills.trust", "mcp.auth.logout"].includes(input.method)) {
        cache.current.clear(); scrollPositions.current.clear();
      }
      return result;
    },
    [mode, demo],
  );
  const refresh = useCallback(async () => {
    const gen = generation.current;
    const version = ++historyVersion.current;
    const [page, allProjects, approvals] = await Promise.all([
      request<SessionPage>({ method: "sessions.list", params: { deleted: false, limit: 50, offset: 0 } }),
      request<ProjectRecord[]>({ method: "projects.list", params: { deleted: false } }),
      request<ApprovalRequest[]>({ method: "approvals.list" }),
    ]);
    if (gen !== generation.current || version !== historyVersion.current) return;
    setSessions(page);
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

  const selectedWorkspace = detail?.session.workspacePath ?? sessions.items.find(item => item.id === activeId)?.workspacePath;
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
    cache.current.clear(); scrollPositions.current.clear();
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
    if (!activeId) return;
    const token = navigation.current;
    const version = ++readVersion.current;
    let stopped = false;
    setSelectionLoading(true);
    void request<SessionView | undefined>({ method: "session.view", params: { limit: 20, sessionId: activeId } })
      .then(next => {
        if (stopped || token !== navigation.current || version !== readVersion.current) return;
        if (!next) throw new Error("该会话不存在或已被删除");
        setDetail(current => refreshSessionView(current, next));
      })
      .catch(e => {
        if (!stopped && token === navigation.current && version === readVersion.current) {
          cache.current.delete(activeId); setDetail(undefined); setError(errorMessage(e));
        }
      })
      .finally(() => { if (!stopped && token === navigation.current && version === readVersion.current) setSelectionLoading(false); });
    return () => { stopped = true; };
  }, [activeId, request, selectionRetry]);

  const latestRun = detail?.runs.at(-1);
  const liveRunId = latestRun && ["queued", "planning", "running", "waiting_approval", "verifying"].includes(latestRun.status) ? latestRun.spec.id : undefined;
  useEffect(() => {
    if (!liveRunId || selectionLoading) return;
    const token = navigation.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sequence = detailRef.current?.runs.find(run => run.spec.id === liveRunId)?.view?.lastSequence ?? -1;
    const poll = async () => {
      try {
        const page = await request<RunEventPage>({ method: "run.eventPage", params: { limit: 100, runId: liveRunId, afterSequence: sequence } });
        if (stopped || token !== navigation.current) return;
        sequence = page.nextSequence;
        setDetail(current => current ? mergeViewEvents(current, liveRunId, page) : current);
        const live = ["queued", "planning", "running", "waiting_approval", "verifying"].includes(page.status);
        if (page.status === "waiting_approval") {
          const pending = await request<ApprovalRequest[]>({ method: "approvals.list" });
          if (stopped || token !== navigation.current) return;
          setApprovals(pending);
        }
        if (page.hasMore || live) timer = setTimeout(poll, page.hasMore ? 0 : 700);
        else void refresh().catch(e => { if (!stopped && token === navigation.current) setError(errorMessage(e)); });
      } catch (e) {
        if (stopped || token !== navigation.current) return;
        // A dropped poll is recoverable: keep other sessions' previews and try again instead of
        // leaving the run frozen until the user re-selects the conversation.
        setError(errorMessage(e));
        timer = setTimeout(poll, 1800);
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [liveRunId, selectionLoading, request, refresh]);

  async function connect() {
    setConnecting(true);
    setError("");
    try {
      await rpc({ method: "health" });
      generation.current++;
      setActiveId(undefined);
      cache.current.clear(); scrollPositions.current.clear();
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
    cache.current.clear(); scrollPositions.current.clear();
    setDetail(undefined);
    setError("");
    setMode("demo");
  }
  async function reloadDetail(id: string) {
    const token = navigation.current;
    const gen = generation.current;
    const version = activeRef.current === id ? ++readVersion.current : undefined;
    try {
      const data = await request<SessionView>({ method: "session.view", params: { limit: 20, sessionId: id } });
      if (gen !== generation.current) return;
      if (data) cache.current.set(data); else cache.current.delete(id);
      if (activeRef.current === id && token === navigation.current && version === readVersion.current) {
        setDetail(current => data ? refreshSessionView(current, data) : undefined);
      }
      await refresh();
    } finally {
      // Taking `version` above invalidated the selection effect's own reset, so this call owns the flag
      // until a newer read supersedes it — including when the read above rejects.
      if (version === readVersion.current) setSelectionLoading(false);
    }
  }
  async function loadMore() {
    const gen = generation.current;
    const version = historyVersion.current;
    const page = await request<SessionPage>({ method: "sessions.list", params: { deleted: false, limit: 50, offset: sessions.items.length } });
    if (gen !== generation.current || version !== historyVersion.current) return;
    setSessions(current => ({ items: [...new Map([...current.items, ...page.items].map(item => [item.id, item])).values()], hasMore: page.hasMore }));
  }
  const content = useSessionContent(activeId, detail, setDetail, request, !selectionLoading);
  return {
    mode,
    selectionLoading,
    content,
    scrollPositions,
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

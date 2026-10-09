import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { SessionContentLoader, type DaemonRequestInput, type SessionView } from "@harness/protocol";

export function useSessionContent(sessionId: string | undefined, view: SessionView | undefined, setView: Dispatch<SetStateAction<SessionView | undefined>>, request: <T>(input: DaemonRequestInput) => Promise<T>, enabled = true) {
  const latest = useRef({ view, setView, request }); latest.current = { view, setView, request };
  const loader = useRef<SessionContentLoader | undefined>(undefined);
  const visible = useRef<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    if (!sessionId || !enabled) return;
    const current = new SessionContentLoader({ sessionId, request: input => latest.current.request(input),
      read: () => latest.current.view,
      update: change => latest.current.setView(view => view ? change(view) : view), onError: setError });
    loader.current = current;
    current.prioritize(visible.current);
    return () => { current.stop(); loader.current = undefined; };
  }, [sessionId, request, enabled]);
  useEffect(() => { loader.current?.wake(); }, [view]);
  const prioritize = useCallback((ids: string[]) => { visible.current = ids; loader.current?.prioritize(ids); }, []);
  const retry = useCallback(() => { setError(""); loader.current?.retry(); }, []);
  return { prioritize, error, retry };
}

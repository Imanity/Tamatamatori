import { useCallback, useEffect, useRef, useState } from "react";
import type { OrbitSnapshot } from "../../domain/stations/orbit-data";
import { cachedOrbits, loadOrbits, ORBIT_CACHE_KEY, ORBIT_PAGE_REFRESH_MS } from "../../io/orbit-feed";

export function useOrbits(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<OrbitSnapshot | null>(null);
  const [phase, setPhase] = useState<"off" | "loading" | "ready" | "error">("off");
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now);
  const [attempt, setAttempt] = useState(0);
  const lastCheck = useRef(0), current = useRef(snapshot);
  current.current = snapshot;
  const refresh = useCallback(() => {
    if (Date.now() - lastCheck.current < 30_000) return;
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!enabled) { setPhase("off"); return; }
    let disposed = false;
    let request: AbortController | null = null;
    try {
      const cached = cachedOrbits(localStorage);
      if (!current.current && cached) { current.current = cached; setSnapshot(cached); }
    } catch { /* Storage can be disabled. The network remains usable. */ }
    const check = async () => {
      if (document.visibilityState === "hidden" || request) return;
      request = new AbortController();
      lastCheck.current = Date.now();
      setPhase("loading");
      setError("");
      const timeout = setTimeout(() => request?.abort(), 15000);
      try {
        const next = await loadOrbits(`${import.meta.env.BASE_URL}orbits/stations.json`, request.signal, current.current);
        if (disposed) return;
        current.current = next;
        setSnapshot(next);
        setPhase("ready");
        setCheckedAt(new Date().toISOString());
        try { localStorage.setItem(ORBIT_CACHE_KEY, JSON.stringify(next)); } catch { /* Optional cache. */ }
      } catch (cause) {
        if (!disposed) {
          setPhase("error");
          setError(cause instanceof Error && cause.name !== "AbortError" ? `轨道快照检查失败 · ${cause.message}` : "已发布轨道快照检查超时");
        }
      } finally {
        clearTimeout(timeout);
        request = null;
      }
    };
    const due = () => {
      setClock(Date.now());
      if (Date.now() - lastCheck.current >= ORBIT_PAGE_REFRESH_MS) void check();
    };
    void check();
    const timer = setInterval(due, 30_000);
    document.addEventListener("visibilitychange", due);
    return () => {
      disposed = true;
      request?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", due);
    };
  }, [enabled, attempt]);

  return { snapshot, phase, error, checkedAt, clock, refresh, canRefresh: clock - lastCheck.current >= 30_000 };
}
export type OrbitFeed = ReturnType<typeof useOrbits>;

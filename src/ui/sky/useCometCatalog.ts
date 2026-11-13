import { useCallback, useEffect, useRef, useState } from "react";
import type { CometCatalog } from "../../domain/comets/comet-catalog";
import { COMET_PAGE_REFRESH_MS, loadCometCatalog } from "../../io/comet-feed";

/** The published comet catalogue, read while the layer is on; the last valid copy is kept on failure. */
export function useCometCatalog(enabled: boolean) {
  const [catalog, setCatalog] = useState<CometCatalog | null>(null);
  const [phase, setPhase] = useState<"off" | "loading" | "ready" | "error">("off");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const current = useRef(catalog), lastCheck = useRef(0);
  current.current = catalog;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) { setPhase("off"); return; }
    let disposed = false, request: AbortController | null = null;
    const check = async () => {
      if (request || (document.visibilityState === "hidden" && current.current)) return;
      request = new AbortController();
      lastCheck.current = Date.now();
      setPhase("loading");
      setError("");
      const timeout = setTimeout(() => request?.abort(), 20000);
      try {
        const next = await loadCometCatalog(`${import.meta.env.BASE_URL}comets/catalog.json`, request.signal, current.current);
        if (disposed) return;
        current.current = next;
        setCatalog(next);
        setPhase("ready");
      } catch (cause) {
        if (!disposed) {
          setPhase("error");
          setError(cause instanceof Error && cause.name !== "AbortError" ? cause.message : "彗星目录读取超时");
        }
      } finally {
        clearTimeout(timeout);
        request = null;
      }
    };
    const due = () => { if (Date.now() - lastCheck.current >= COMET_PAGE_REFRESH_MS) void check(); };
    void check();
    const timer = setInterval(due, 60_000);
    document.addEventListener("visibilitychange", due);
    return () => {
      disposed = true;
      request?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", due);
    };
  }, [enabled, attempt]);

  return { catalog, phase, error, retry };
}
export type CometFeed = ReturnType<typeof useCometCatalog>;

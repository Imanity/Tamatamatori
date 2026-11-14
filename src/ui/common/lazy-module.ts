// Parts of the page read with import() when first wanted (docs/plan/lazy-loading.md):
// the 推算 module and the About sources. Once read a module stays; a failed
// read is tried again on request.
import { useEffect, useState } from "react";

export interface LazySource<T> {
  /** Reads the module, or returns the read in progress or done. */
  get: () => Promise<T>;
  /** The module when it has been read, else null. */
  loaded: () => T | null;
}

export function lazyModule<T>(load: () => Promise<T>): LazySource<T> {
  let pending: Promise<T> | null = null;
  let module: T | null = null;
  return {
    get: () => (pending ??= load().then(
      (value) => (module = value),
      (error) => {
        pending = null;
        throw error;
      },
    )),
    loaded: () => module,
  };
}

export interface ModuleLoad<T> {
  module: T | null;
  phase: "idle" | "loading" | "ready" | "failed";
  /** Why the read failed. */
  message: string;
  retry: () => void;
}

/** The module once `wanted` has been true; it stays after `wanted` turns false. */
export function useLazyModule<T>(source: LazySource<T>, wanted: boolean): ModuleLoad<T> {
  const [state, setState] = useState<Omit<ModuleLoad<T>, "retry">>(() => {
    const module = source.loaded();
    return module ? { module, phase: "ready", message: "" } : { module: null, phase: "idle", message: "" };
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!wanted || state.module) return;
    let alive = true;
    setState({ module: null, phase: "loading", message: "" });
    source.get().then(
      (module) => alive && setState({ module, phase: "ready", message: "" }),
      (error) => alive && setState({ module: null, phase: "failed", message: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      alive = false;
    };
  }, [source, wanted, attempt]);
  return { ...state, retry: () => setAttempt((value) => value + 1) };
}

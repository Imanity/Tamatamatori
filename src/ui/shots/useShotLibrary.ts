import { useEffect, useRef, useState } from "react";
import {
  browserStorage,
  newShotId,
  readLibrary,
  writeLibrary,
  SHOT_LIBRARY_KEY,
  SHOT_LIBRARY_LIMIT,
} from "../../domain/shots/shot-library";
import type { SavedShot, ShotLibrary } from "../../domain/shots/shot-library";
import type { Shot } from "../../domain/shots/shot";
import { LOCAL_MODE, localJson } from "../../io/local-client";

// Same-page instances (the shot menu and the 推算 panel's save) re-read after a write; `storage` only fires in other tabs.
const LOCAL_CHANGE = "tamatamatori:shots";

export function useShotLibrary() {
  const [storage] = useState(browserStorage);
  const [library, setLibrary] = useState<ShotLibrary>(() => LOCAL_MODE ? { phase: "unavailable", shots: [], broken: [] } : readLibrary(storage));
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(LOCAL_MODE);
  const [busy, setBusy] = useState(false);
  const revision = useRef<number | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  const latest = useRef(library);
  latest.current = library;
  useEffect(() => {
    alive.current = true;
    let serial = 0;
    const refresh = async () => {
      if (!LOCAL_MODE) { setLibrary(readLibrary(storage)); return; }
      const id = ++serial;
      try {
        const data = await localJson<{ version: number; revision: number; shots: unknown[] }>("/api/shots");
        if (!alive.current || id !== serial) return;
        if (revision.current !== null && data.revision < revision.current) return;
        revision.current = data.revision;
        const next = readLibrary({ getItem: () => JSON.stringify(data) });
        latest.current = next;
        setLibrary(next);
      } catch (cause) {
        if (alive.current && id === serial) setError(`本地机位库无法读取：${(cause as Error).message}`);
      } finally { if (alive.current && id === serial) setLoading(false); }
    };
    // Another tab saved or deleted shots.
    const changed = (event: StorageEvent) => {
      if (LOCAL_MODE) return;
      if (event.key === null || event.key === SHOT_LIBRARY_KEY) setLibrary(readLibrary(storage));
    };
    const local = () => { void refresh(); };
    if (LOCAL_MODE) void refresh();
    const timer = LOCAL_MODE ? window.setInterval(local, 5000) : undefined;
    window.addEventListener("focus", local);
    window.addEventListener("storage", changed);
    window.addEventListener(LOCAL_CHANGE, local);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", local);
      window.removeEventListener("storage", changed);
      window.removeEventListener(LOCAL_CHANGE, local);
    };
  }, [storage]);
  const commit = async (next: ShotLibrary) => {
    if (pending.current) return false;
    if (LOCAL_MODE && revision.current === null) { setError("本地机位库尚未就绪，请重试"); return false; }
    pending.current = true;
    setBusy(true);
    try {
      if (LOCAL_MODE) {
        const result = await localJson<{ revision: number }>("/api/shots", {
          method: "PUT",
          body: JSON.stringify({ version: 1, revision: revision.current, shots: [...next.shots, ...next.broken.map((entry) => entry.raw)] }),
        });
        revision.current = result.revision;
      } else writeLibrary(storage, next);
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
    latest.current = next;
    setLibrary(next);
    setError("");
    window.dispatchEvent(new Event(LOCAL_CHANGE));
    return true;
  };
  const now = () => new Date().toISOString();
  return {
    library,
    error,
    loading,
    busy,
    writable: !loading && !busy && library.phase === "ready" && (!LOCAL_MODE || revision.current !== null),
    local: LOCAL_MODE,
    refresh: () => { setError(""); window.dispatchEvent(new Event(LOCAL_CHANGE)); },
    clearError: () => setError(""),
    async importLibrary(text: string) {
      try {
        const value = JSON.parse(text);
        if (value.format !== "tamatamatori.library" || value.version !== 1 || !Array.isArray(value.shots)) throw new Error("不是机位库备份");
        const incoming = readLibrary({ getItem: () => text });
        if (incoming.phase !== "ready") throw new Error("机位库无法读取");
        const current = latest.current;
        const ids = new Set([...current.shots, ...current.broken].map((entry) => entry.id));
        const unseen = (entry: { id: string }) => {
          if (ids.has(entry.id)) return false;
          ids.add(entry.id); return true;
        };
        const shots = incoming.shots.filter(unseen);
        const broken = incoming.broken.filter(unseen);
        if (current.shots.length + shots.length > SHOT_LIBRARY_LIMIT) throw new Error(`最多保存 ${SHOT_LIBRARY_LIMIT} 个机位，请分批整理后导入`);
        return commit({ ...current, shots: [...shots, ...current.shots], broken: [...current.broken, ...broken] });
      } catch (cause) { setError((cause as Error).message); return false; }
    },
    async saveNew(shot: Shot): Promise<SavedShot | null> {
      const current = latest.current;
      if (current.shots.length >= SHOT_LIBRARY_LIMIT) {
        setError(`最多保存 ${SHOT_LIBRARY_LIMIT} 个机位，请先删除不用的机位`);
        return null;
      }
      const entry = { id: newShotId(), createdAt: now(), updatedAt: now(), shot };
      return await commit({ ...current, shots: [entry, ...current.shots] }) ? entry : null;
    },
    /** Replaces the shot and moves it to the top of the list. */
    async update(id: string, shot: Shot) {
      const current = latest.current, entry = current.shots.find((item) => item.id === id);
      if (!entry) return false;
      return commit({
        ...current,
        shots: [{ ...entry, shot, updatedAt: now() }, ...current.shots.filter((item) => item.id !== id)],
      });
    },
    rename(id: string, name: string) {
      const current = latest.current;
      return commit({
        ...current,
        shots: current.shots.map((item) => (item.id === id ? { ...item, shot: { ...item.shot, name } } : item)),
      });
    },
    async remove(id: string) {
      const current = latest.current, index = current.shots.findIndex((item) => item.id === id);
      if (index < 0) return null;
      const entry = current.shots[index];
      return await commit({ ...current, shots: current.shots.filter((item) => item.id !== id) }) ? { entry, index } : null;
    },
    restore(entry: SavedShot, index: number) {
      const current = latest.current, shots = [...current.shots];
      shots.splice(Math.min(index, shots.length), 0, entry);
      return commit({ ...current, shots });
    },
    removeBroken(id: string) {
      const current = latest.current;
      return commit({ ...current, broken: current.broken.filter((item) => item.id !== id) });
    },
    /** Only offered when the stored data cannot be read at all. */
    reset() {
      return commit({ phase: "ready", shots: [], broken: [] });
    },
  };
}

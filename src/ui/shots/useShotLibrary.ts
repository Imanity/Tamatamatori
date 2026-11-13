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

// Same-page instances (the shot menu and the 推算 panel's save) re-read after a write; `storage` only fires in other tabs.
const LOCAL_CHANGE = "tamatamatori:shots";

export function useShotLibrary() {
  const [storage] = useState(browserStorage);
  const [library, setLibrary] = useState<ShotLibrary>(() => readLibrary(storage));
  const [error, setError] = useState("");
  const latest = useRef(library);
  latest.current = library;
  useEffect(() => {
    // Another tab saved or deleted shots.
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key === SHOT_LIBRARY_KEY) setLibrary(readLibrary(storage));
    };
    const local = () => setLibrary(readLibrary(storage));
    window.addEventListener("storage", changed);
    window.addEventListener(LOCAL_CHANGE, local);
    return () => {
      window.removeEventListener("storage", changed);
      window.removeEventListener(LOCAL_CHANGE, local);
    };
  }, [storage]);
  const commit = (next: ShotLibrary) => {
    try {
      writeLibrary(storage, next);
    } catch (cause) {
      setError((cause as Error).message);
      return false;
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
    clearError: () => setError(""),
    saveNew(shot: Shot): SavedShot | null {
      const current = latest.current;
      if (current.shots.length >= SHOT_LIBRARY_LIMIT) {
        setError(`最多保存 ${SHOT_LIBRARY_LIMIT} 个机位，请先删除不用的机位`);
        return null;
      }
      const entry = { id: newShotId(), createdAt: now(), updatedAt: now(), shot };
      return commit({ ...current, shots: [entry, ...current.shots] }) ? entry : null;
    },
    /** Replaces the shot and moves it to the top of the list. */
    update(id: string, shot: Shot) {
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
    remove(id: string) {
      const current = latest.current, index = current.shots.findIndex((item) => item.id === id);
      if (index < 0) return null;
      const entry = current.shots[index];
      return commit({ ...current, shots: current.shots.filter((item) => item.id !== id) }) ? { entry, index } : null;
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

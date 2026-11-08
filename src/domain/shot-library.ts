import { parseShot, planFromShot, shotFromPlan } from "./shot.ts";
import type { Shot } from "./shot.ts";
import type { ShootingPlan } from "./plan.ts";

/**
 * Saved shots and the last working state live in this browser's localStorage.
 * Storage is passed in so tests can simulate missing, full or damaged storage.
 * Note: every GitHub Pages project under the same user domain shares one
 * origin, hence the application prefix on the keys.
 */
export const SHOT_LIBRARY_KEY = "tamatamatori.shots.v1";
export const SHOT_SESSION_KEY = "tamatamatori.session.v1";
export const SHOT_LIBRARY_LIMIT = 200;

export interface SavedShot {
  id: string;
  createdAt: string;
  updatedAt: string;
  shot: Shot;
}
/** An entry that no longer validates is kept verbatim until the user deletes it. */
export interface BrokenShot {
  id: string;
  raw: unknown;
  reason: string;
}
export interface ShotLibrary {
  phase: "ready" | "unavailable" | "corrupt";
  shots: SavedShot[];
  broken: BrokenShot[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function browserStorage(): Storage | null {
  try {
    return globalThis.window?.localStorage ?? null;
  } catch {
    return null;
  }
}

export function newShotId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function readLibrary(storage: Storage | null): ShotLibrary {
  const empty = (phase: ShotLibrary["phase"]): ShotLibrary => ({ phase, shots: [], broken: [] });
  if (!storage) return empty("unavailable");
  let text: string | null;
  try {
    text = storage.getItem(SHOT_LIBRARY_KEY);
  } catch {
    return empty("unavailable");
  }
  if (text === null) return empty("ready");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return empty("corrupt");
  }
  if (!isObject(data) || data.version !== 1 || !Array.isArray(data.shots)) return empty("corrupt");
  const library = empty("ready");
  for (const entry of data.shots) {
    const id = isObject(entry) && typeof entry.id === "string" ? entry.id : newShotId();
    if (!isObject(entry) || typeof entry.createdAt !== "string" || typeof entry.updatedAt !== "string") {
      library.broken.push({ id, raw: entry, reason: "条目结构不完整" });
      continue;
    }
    const parsed = parseShot(entry.shot);
    if (parsed.ok) library.shots.push({ id, createdAt: entry.createdAt, updatedAt: entry.updatedAt, shot: parsed.shot });
    else library.broken.push({ id, raw: entry, reason: parsed.errors[0] });
  }
  return library;
}

/** Writes the whole library; throws an Error with a user-facing message. */
export function writeLibrary(storage: Storage | null, library: ShotLibrary) {
  if (!storage || library.phase === "unavailable") throw new Error("此浏览器无法使用本地存储，机位未保存");
  if (library.phase === "corrupt") throw new Error("本地机位数据无法读取，为避免覆盖已暂停保存");
  const payload = {
    version: 1,
    shots: [...library.shots, ...library.broken.map((entry) => entry.raw)],
  };
  try {
    storage.setItem(SHOT_LIBRARY_KEY, JSON.stringify(payload));
  } catch (error) {
    const quota = error instanceof Error && /quota/i.test(`${error.name} ${error.message}`);
    throw new Error(quota ? "本地存储空间不足，机位未保存" : "本地存储不可用，机位未保存");
  }
}

/** Last working state, restored after a reload. Failures are silent: it is a convenience. */
export function readSession(storage: Storage | null): { plan: ShootingPlan; activeId: string | null } | null {
  try {
    const text = storage?.getItem(SHOT_SESSION_KEY);
    if (!text) return null;
    const data: unknown = JSON.parse(text);
    if (!isObject(data) || data.version !== 1) return null;
    const parsed = parseShot(data.shot);
    if (!parsed.ok) return null;
    return { plan: planFromShot(parsed.shot), activeId: typeof data.activeId === "string" ? data.activeId : null };
  } catch {
    return null;
  }
}

export function writeSession(storage: Storage | null, plan: ShootingPlan, activeId: string | null) {
  try {
    storage?.setItem(SHOT_SESSION_KEY, JSON.stringify({ version: 1, activeId, shot: shotFromPlan(plan) }));
    return true;
  } catch {
    return false;
  }
}

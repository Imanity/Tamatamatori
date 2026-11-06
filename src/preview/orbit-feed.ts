import { assertOrbitProgress, validateOrbitSnapshot } from "../domain/orbit-data.ts";
import type { OrbitSnapshot } from "../domain/orbit-data.ts";

export const ORBIT_CACHE_KEY = "tamatamatori-stations-v1";
export const ORBIT_PAGE_REFRESH_MS = 5 * 60 * 1000;

export function cachedOrbits(storage: Pick<Storage, "getItem">): OrbitSnapshot | null {
  try { return validateOrbitSnapshot(JSON.parse(storage.getItem(ORBIT_CACHE_KEY) ?? "null")); }
  catch { return null; }
}

export async function loadOrbits(url: string, signal: AbortSignal, previous: OrbitSnapshot | null, fetchImpl = fetch) {
  const response = await fetchImpl(url, { signal, cache: "no-cache", credentials: "same-origin" });
  if (!response.ok) throw new Error(`已发布轨道快照 HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 100_000) throw new Error("轨道快照超出大小限制");
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("已发布轨道快照格式无效"); }
  const snapshot = validateOrbitSnapshot(parsed);
  assertOrbitProgress(previous, snapshot);
  return snapshot;
}

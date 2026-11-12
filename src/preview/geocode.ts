/**
 * Place search through OpenStreetMap's public Nominatim service, under its
 * usage policy (https://operations.osmfoundation.org/policies/nominatim/):
 * only explicit searches (never search-as-you-type), at most one request per
 * second for the whole site — here at least 1.1 s between this page's
 * requests — and repeated queries answered from a page cache. The browser's
 * Referer identifies the site; results carry OpenStreetMap attribution.
 */
export interface PlaceResult {
  name: string;
  detail: string;
  latitude: number;
  longitude: number;
  /** South, north, west, east, when the place has an extent. */
  bounds: [number, number, number, number] | null;
}

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const MIN_INTERVAL = 1100;
const cache = new Map<string, PlaceResult[]>();
let lastRequest = 0;

const pause = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

export function parsePlaces(value: unknown): PlaceResult[] {
  if (!Array.isArray(value)) throw new Error("地点搜索结果格式无效");
  return value.flatMap((entry) => {
    const latitude = Number(entry?.lat), longitude = Number(entry?.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return [];
    const full = typeof entry.display_name === "string" ? entry.display_name : "";
    const name = typeof entry.name === "string" && entry.name ? entry.name : full.split(",")[0] ?? "";
    const box = Array.isArray(entry.boundingbox) ? entry.boundingbox.map(Number) : [];
    return [{
      name: name || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
      detail: full,
      latitude,
      longitude,
      bounds: box.length === 4 && box.every(Number.isFinite) ? [box[0], box[1], box[2], box[3]] as [number, number, number, number] : null,
    }];
  });
}

export async function searchPlaces(query: string, signal: AbortSignal): Promise<PlaceResult[]> {
  const text = query.trim();
  if (!text) return [];
  const key = text.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  // Timers run on a monotonic clock and may fire a millisecond or two early by
  // the wall clock (seen in CI: 1098 ms); wait again until the gap really holds.
  for (let wait = lastRequest + MIN_INTERVAL - Date.now(); wait > 0; wait = lastRequest + MIN_INTERVAL - Date.now())
    await pause(wait, signal);
  signal.throwIfAborted();
  const parameters = new URLSearchParams({ q: text, format: "jsonv2", limit: "8", "accept-language": "zh-CN,zh,en" });
  // The gap counts from when the request leaves: taking the time before
  // building and sending it let the next one start a millisecond short (CI: 1099 ms).
  const sending = fetch(`${ENDPOINT}?${parameters}`, { signal });
  lastRequest = Date.now();
  const response = await sending;
  if (response.status === 429 || response.status === 403)
    throw new Error("地点搜索服务暂时拒绝请求，请稍后再试");
  if (!response.ok) throw new Error(`地点搜索失败（${response.status}）`);
  const results = parsePlaces(await response.json());
  cache.set(key, results);
  if (cache.size > 30) cache.delete(cache.keys().next().value!);
  return results;
}

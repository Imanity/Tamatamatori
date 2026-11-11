import { addUsage, emptyUsage, readUsage, retryAfterSeconds } from "../domain/api-usage.ts";
import type { UsageLog } from "../domain/api-usage.ts";

/**
 * Open-Meteo calls made from this browser, kept in local storage so every tab
 * adds to one log. The service counts per IP, so other devices on the same
 * network and other sites using Open-Meteo are not included.
 */
const KEY = "tamatamatori.openMeteoUsage.v1";
let memory: UsageLog = emptyUsage();
const listeners = new Set<() => void>();

function storage() {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}
/** Whether the last write reached local storage; otherwise this page's memory is the log. */
let persisted = true;
export function openMeteoUsage(): UsageLog {
  const store = storage();
  if (!store || !persisted) return memory;
  try {
    const stored = store.getItem(KEY);
    memory = stored ? readUsage(JSON.parse(stored)) : emptyUsage();
  } catch { /* Unreadable: keep this page's log. */ }
  return memory;
}
function save(next: UsageLog) {
  memory = next;
  try { storage()?.setItem(KEY, JSON.stringify(next)); persisted = true; } catch { persisted = false; }
  listeners.forEach((listener) => listener());
}
export function subscribeUsage(listener: () => void) {
  listeners.add(listener);
  const fromOtherTab = (event: StorageEvent) => { if (event.key === KEY) listener(); };
  if (typeof window !== "undefined") window.addEventListener("storage", fromOtherTab);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", fromOtherTab);
  };
}

/**
 * Records one response: the reported `X-RateLimit-Cost` (or the estimate when
 * the API does not send it), the minute-window report, and a 429's wait.
 * Returns the `Retry-After` seconds of a rate-limited response.
 */
export function recordOpenMeteo(response: Response, estimate: number, now = Date.now()) {
  let log = openMeteoUsage();
  if (response.status === 429) {
    const seconds = retryAfterSeconds(response.headers.get("retry-after"), now);
    save({ ...log, limitedUntil: now + (seconds ?? 60) * 1000 });
    return seconds;
  }
  if (!response.ok) return null;
  const reported = Number(response.headers.get("x-ratelimit-cost"));
  log = addUsage(log, now, Number.isFinite(reported) && reported > 0 ? reported : estimate);
  const remaining = Number(response.headers.get("x-ratelimit-remaining"));
  const limit = Number(response.headers.get("x-ratelimit-limit")), reset = Number(response.headers.get("x-ratelimit-reset"));
  if ([remaining, limit, reset].every(Number.isFinite) && response.headers.get("x-ratelimit-window") === "60")
    log = { ...log, server: { remaining, limit, reset: reset * 1000, at: now } };
  if (log.limitedUntil && log.limitedUntil <= now) log = { buckets: log.buckets, ...(log.server ? { server: log.server } : {}) };
  save(log);
  return null;
}

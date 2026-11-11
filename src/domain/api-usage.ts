/**
 * Open-Meteo's free API: 600 calls a minute, 5,000 an hour and 10,000 a day,
 * counted per IP address. A request costs locations × max(1, variables ×
 * models / 10) × max(1, days / 14) calls; the forecast API reports the cost in
 * `X-RateLimit-Cost`, the marine API does not.
 */
export const OPEN_METEO_LIMITS = { minute: 600, hour: 5_000, day: 10_000 } as const;
const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

export function estimateOpenMeteoCost({ locations = 1, variables = 1, models = 1, days = 1 }: {
  locations?: number; variables?: number; models?: number; days?: number;
}) {
  return Math.round(locations * Math.max(1, (variables * models) / 10) * Math.max(1, days / 14) * 10) / 10;
}

/** Calls per started minute (UTC milliseconds), the last minute-window report and any rate limit. */
export interface UsageLog {
  buckets: Record<string, number>;
  server?: { remaining: number; limit: number; reset: number; at: number };
  limitedUntil?: number;
}
export const emptyUsage = (): UsageLog => ({ buckets: {} });

/** Adds a request's cost and drops minutes older than a day. */
export function addUsage(log: UsageLog, time: number, cost: number): UsageLog {
  const minute = Math.floor(time / MINUTE) * MINUTE, buckets: Record<string, number> = {};
  for (const [key, value] of Object.entries(log.buckets)) if (Number(key) > time - DAY) buckets[key] = value;
  buckets[minute] = Math.round(((buckets[minute] ?? 0) + cost) * 10) / 10;
  return { ...log, buckets };
}

/** Rolling sums over the last minute, hour and day. */
export function usageTotals(log: UsageLog, now: number) {
  const sum = (span: number) => Math.round(Object.entries(log.buckets)
    .filter(([key]) => Number(key) > now - span && Number(key) <= now)
    .reduce((total, [, value]) => total + value, 0) * 10) / 10;
  return { minute: sum(MINUTE), hour: sum(HOUR), day: sum(DAY) };
}

/** Accepts only a well-formed stored log; anything else starts afresh. */
export function readUsage(value: unknown): UsageLog {
  const record = value as Partial<UsageLog> | null;
  if (!record || typeof record !== "object" || !record.buckets || typeof record.buckets !== "object") return emptyUsage();
  const buckets: Record<string, number> = {};
  for (const [key, cost] of Object.entries(record.buckets))
    if (Number.isFinite(Number(key)) && typeof cost === "number" && Number.isFinite(cost) && cost >= 0) buckets[key] = cost;
  const server = record.server && [record.server.remaining, record.server.limit, record.server.reset, record.server.at].every(Number.isFinite)
    ? record.server : undefined;
  const limitedUntil = Number.isFinite(record.limitedUntil) ? record.limitedUntil : undefined;
  return { buckets, ...(server ? { server } : {}), ...(limitedUntil ? { limitedUntil } : {}) };
}

/** Seconds from a `Retry-After` header (seconds or an HTTP date); null when absent. */
export function retryAfterSeconds(header: string | null, now: number) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, Math.round((date - now) / 1000)) : null;
}

export const rateLimitMessage = (seconds: number | null) =>
  `Open-Meteo 限流：同一 IP 用量已满${seconds ? `，约 ${seconds} 秒后可重试` : "，请稍后重试"}`;

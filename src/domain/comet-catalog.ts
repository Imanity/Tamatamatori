import type { CometElements, MagnitudeLaw } from "./comet-orbit.ts";

/**
 * The comet catalogue is a published static file. A manual full build seeds
 * it; the scheduled CI job updates the apparitions whose observing window is
 * still open and keeps closed ones as they were. Update status travels with
 * the data, like the space station snapshot.
 */
export const COMET_CATALOG_VERSION = 2;
/**
 * Minimum time between two upstream updates. The CI schedule runs every three
 * hours; the margin lets a late scheduled run still update, while pushes in
 * between do not repeat a recent request (the station feed uses the same two hours).
 */
export const COMET_REFRESH_MS = 2 * 3_600_000;
/** About eight missed three-hourly updates: newly bright comets may be missing. */
export const COMET_STALE_MS = 86_400_000;
export const COMET_CATALOG_MAX_BYTES = 2_000_000;

export interface Comet {
  /** Designation and perihelion date: one apparition of one comet. */
  key: string;
  id: string;
  /** Perihelion date of the apparition, UTC. */
  apparition: string;
  name: string;
  designation: string;
  orbit: CometElements & { solution: string | null; record: string | null };
  photometry: { pre: MagnitudeLaw; post: MagnitudeLaw };
  fit: Record<"pre" | "post", { source: "cobs" | "mirrored"; nights?: number; rms?: number; fixedN?: boolean; from?: string; to?: string }>;
  observed: { from: string; to: string; nights: number; brightest: number };
  window: { from: string; to: string };
  status: "complete" | "ongoing";
  peak: { magnitude: number; date: string };
}
export interface CometCatalog {
  version: typeof COMET_CATALOG_VERSION;
  status: "ready" | "error";
  /** Last successful update (full or incremental) and last attempt, ISO UTC. */
  fetchedAt: string;
  attemptedAt: string;
  error: string | null;
  /** A failed update pauses automatic updates until a maintainer resumes them. */
  blocked: boolean;
  sources: {
    photometry: { name: string; url: string; license: string; licenseUrl: string; changes: string };
    orbit: { name: string; url: string; citation: string; changes: string };
  };
  selection: string;
  comets: Comet[];
}

const DATE = /^\d{4}-\d\d-\d\d$/;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const stamp = (value: unknown, now: number) =>
  typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 300_000;
const law = (value: unknown) => {
  const l = value as MagnitudeLaw;
  return !!l && finite(l.H) && l.H > -10 && l.H < 25 && finite(l.n) && l.n >= 0 && l.n <= 10 &&
    (l.range === undefined || (Array.isArray(l.range) && l.range.length === 2 && l.range.every(finite) && l.range[0] > 0 && l.range[0] <= l.range[1]));
};

function validComet(c: Comet) {
  const o = c?.orbit;
  return typeof c.key === "string" && c.key === `${c.id}/${c.apparition}` && typeof c.id === "string" && c.id.length > 0 &&
    DATE.test(c.apparition) && typeof c.name === "string" && c.name.length > 0 && typeof c.designation === "string" &&
    !!o && finite(o.q) && o.q > 0 && o.q < 30 && finite(o.e) && o.e >= 0 && o.e < 10 && finite(o.tp) &&
    [o.node, o.peri].every((angle) => finite(angle) && angle >= 0 && angle < 360) && finite(o.incl) && o.incl >= 0 && o.incl <= 180 &&
    // The apparition date is the perihelion of the elements.
    Math.abs((o.tp - 2440587.5) * 86_400_000 - Date.parse(`${c.apparition}T00:00:00Z`)) < 2 * 86_400_000 &&
    law(c.photometry?.pre) && law(c.photometry?.post) &&
    ["complete", "ongoing"].includes(c.status) &&
    [c.window?.from, c.window?.to, c.observed?.from, c.observed?.to].every((d) => typeof d === "string" && DATE.test(d)) &&
    c.window.from <= c.window.to && c.observed.from <= c.observed.to && finite(c.observed.nights) && c.observed.nights > 0 &&
    finite(c.observed.brightest) && finite(c.peak?.magnitude);
}

export function validateCometCatalog(value: unknown, now = Date.now()): CometCatalog {
  const data = value as CometCatalog;
  if (!data || data.version !== COMET_CATALOG_VERSION || !["ready", "error"].includes(data.status) ||
      typeof data.blocked !== "boolean" || !(data.error === null || typeof data.error === "string") ||
      !stamp(data.fetchedAt, now) || !stamp(data.attemptedAt, now) || Date.parse(data.fetchedAt) > Date.parse(data.attemptedAt) ||
      !Array.isArray(data.comets) || !data.sources?.orbit?.citation || !data.sources?.photometry?.license)
    throw new Error("彗星目录格式无效");
  if ((data.status === "ready" && (data.blocked || data.error !== null)) || (data.status === "error" && (!data.blocked || !data.error)))
    throw new Error("彗星目录更新状态不一致");
  const keys = new Set<string>();
  for (const comet of data.comets) {
    if (!validComet(comet)) throw new Error(`彗星条目无效 · ${(comet as Comet)?.key ?? "?"}`);
    if (keys.has(comet.key)) throw new Error(`彗星条目重复 · ${comet.key}`);
    keys.add(comet.key);
  }
  return data;
}

/** An update may refresh or add apparitions, never drop one or move back in time. */
export function assertCatalogProgress(previous: CometCatalog | null, next: CometCatalog) {
  if (!previous) return;
  if (Date.parse(next.attemptedAt) < Date.parse(previous.attemptedAt) || Date.parse(next.fetchedAt) < Date.parse(previous.fetchedAt))
    throw new Error("彗星目录更新记录回退，保留原目录");
  const keys = new Set(next.comets.map((comet) => comet.key));
  const lost = previous.comets.filter((comet) => !keys.has(comet.key));
  if (lost.length) throw new Error(`彗星目录丢失 ${lost.length} 次回归（${lost.slice(0, 3).map((comet) => comet.key).join("、")}），保留原目录`);
}

/** Catalogue age and update state for the information group. */
export function catalogFreshness(catalog: CometCatalog, now = Date.now()) {
  const age = now - Date.parse(catalog.fetchedAt);
  return { updated: catalog.fetchedAt.slice(0, 10), days: Math.floor(age / 86_400_000), stale: age > COMET_STALE_MS, paused: catalog.blocked };
}

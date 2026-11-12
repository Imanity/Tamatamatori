import { Body, DefineStar } from "astronomy-engine";

/**
 * The solvers' view of the bodies they aim at: the Sun, the Moon and fixed
 * bodies by id. Fixed bodies are looked up in a registry rather than the
 * catalogues, so the 两者都找 worker does not carry the star and deep-sky
 * data: the main thread registers the catalogue (sky-targets.ts), and a
 * worker registers the one body its message names.
 */
export type FixedBodyId = "galactic-center" | `hyg-${string}` | `dso-${string}`;
export type SolveBodyId = "sun" | "moon" | FixedBodyId;
export type FixedKind = "core" | "star" | "deepSky";
/** Fixed bodies are only solved while the Sun is at least this low (end of civil twilight), degrees. */
export const DARK_SUN_ELEVATION = -6;

export interface FixedPlace {
  id: FixedBodyId;
  kind: FixedKind;
  /** J2000 right ascension (hours) and declination (degrees). */
  ra: number;
  dec: number;
  /** Radius of the mark drawn for it, degrees (it has no disc). */
  radius: number;
}

const registry = new Map<string, FixedPlace>();
export function registerFixedBodies(list: readonly FixedPlace[]) {
  for (const { id, kind, ra, dec, radius } of list) registry.set(id, { id, kind, ra, dec, radius });
}
export const fixedPlace = (id: string) => registry.get(id) ?? null;
export const isFixedBody = (body: SolveBodyId): body is FixedBodyId => body !== "sun" && body !== "moon";

export const bodyKind = (body: SolveBodyId) => (body === "sun" || body === "moon" ? body : fixedPlace(body)?.kind ?? "star");
/** The layer a try-out turns on so the body is drawn. */
export function bodyLayer(body: SolveBodyId) {
  const kind = bodyKind(body);
  return kind === "core" ? "milkyWay" : kind === "deepSky" ? "deepSky" : kind === "star" ? "stars" : kind;
}
/** What the separation is counted in: the disc, or the mark drawn for a fixed body. */
export const sizeWord = (body: SolveBodyId) => (isFixedBody(body) ? "标记直径" : "视直径");

/**
 * The astronomy-engine body to compute with: the Sun, the Moon, or user star 1
 * defined for this fixed body (re-defined on every call; the solvers run
 * synchronously between calls). J2000 positions carried to the date
 * (precession, nutation); proper motion and annual parallax left out.
 */
export function astroBody(body: SolveBodyId): Body {
  if (body === "sun") return Body.Sun;
  if (body === "moon") return Body.Moon;
  const fixed = fixedPlace(body);
  if (!fixed) throw new RangeError(`未知天体：${body}`);
  DefineStar(Body.Star1, fixed.ra, fixed.dec, 1000);
  return Body.Star1;
}

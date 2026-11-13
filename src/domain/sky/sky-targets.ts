import stars from "../../data/bright-stars.json" with { type: "json" };
import deepSky from "../../data/deep-sky.json" with { type: "json" };
import { registerFixedBodies } from "./sky-coordinates.ts";
import type { FixedBodyId, FixedPlace, SolveBodyId } from "./sky-coordinates.ts";

export * from "./sky-coordinates.ts";

/**
 * What the 推算 solvers can aim at besides the Sun and the Moon: the Galactic
 * Centre, the named bright stars and the catalogued deep-sky targets, whose
 * direction is fixed against the stars. Importing this module registers them
 * for the solvers (sky-coordinates.ts).
 */
export interface FixedBody extends FixedPlace {
  name: string;
  magnitude: number | null;
}

type StarRow = [number, number, number, number, number, number, number, number, number];
const names = stars.names as Record<string, string>;
const namedStars: FixedBody[] = (stars.stars as StarRow[])
  .filter(([id]) => names[`hyg-${id}`])
  .map(([id, ra, dec, , , , , magnitude]) => ({
    id: `hyg-${id}` as const, name: names[`hyg-${id}`], kind: "star" as const, ra, dec, radius: 0.25, magnitude,
  }))
  .sort((a, b) => (a.magnitude ?? 99) - (b.magnitude ?? 99));
type DeepSkyRow = { id: string; name: string; ra: number; dec: number; majorArcmin: number; magnitude: number | null };
const deepSkyTargets: FixedBody[] = (deepSky.objects as DeepSkyRow[]).map((entry) => ({
  id: entry.id as `dso-${string}`, name: entry.name, kind: "deepSky" as const, ra: entry.ra / 15, dec: entry.dec,
  radius: Math.max(0.25, entry.majorArcmin / 120), magnitude: entry.magnitude,
}));

/** The Galactic Centre (Sgr A*, Gordon et al. 2022), as the preview's Milky Way reference; the mark spans the bright core. */
export const galacticCenter: FixedBody = {
  id: "galactic-center", name: "银心", kind: "core",
  ra: 17 + 45 / 60 + 40.034047 / 3600, dec: -29 - 28.21601 / 3600, radius: 1, magnitude: null,
};
export const fixedBodies: readonly FixedBody[] = [galacticCenter, ...namedStars, ...deepSkyTargets];
registerFixedBodies(fixedBodies);
const byId = new Map(fixedBodies.map((body) => [body.id, body]));

export const fixedBody = (id: string) => byId.get(id as FixedBodyId) ?? null;
export const isSolveBody = (value: unknown): value is SolveBodyId =>
  value === "sun" || value === "moon" || (typeof value === "string" && byId.has(value as FixedBodyId));

export function bodyName(body: SolveBodyId) {
  return body === "sun" ? "太阳" : body === "moon" ? "月亮" : fixedBody(body)?.name ?? body;
}

import catalog from "../data/bright-stars.json" with { type: "json" };
import figures from "../data/constellations.json" with { type: "json" };
import type { ShootingPlan } from "./plan.ts";
import { skyReference } from "./starfield.ts";
import type { SkyPoint } from "./starfield.ts";
import { constellationScene } from "./constellations.ts";
import { celestialBodies } from "./ephemeris.ts";
import type { SkyBody } from "./ephemeris.ts";

interface Descriptor {
  id: string;
  name: string;
  kind: string;
  layer: keyof ShootingPlan["layers"];
  aliases: string[];
}
export type SearchTarget = SkyPoint & Descriptor & { body?: SkyBody };
const names: Record<string, string> = catalog.names,
  aliases: Record<string, string[]> = catalog.aliases;
const index: Descriptor[] = [
  { id: "sun", name: "太阳", kind: "日月", layer: "sun", aliases: ["Sun"] },
  {
    id: "moon",
    name: "月亮",
    kind: "日月",
    layer: "moon",
    aliases: ["月球", "Moon"],
  },
  ...Object.entries(names).map(([id, name]) => ({
    id,
    name,
    kind: "亮星",
    layer: "stars" as const,
    aliases: aliases[id] ?? [],
  })),
  {
    id: "venus",
    name: "金星",
    kind: "行星",
    layer: "stars",
    aliases: ["Venus"],
  },
  {
    id: "jupiter",
    name: "木星",
    kind: "行星",
    layer: "stars",
    aliases: ["Jupiter"],
  },
  {
    id: "galactic-center",
    name: "银心",
    kind: "银河",
    layer: "milkyWay",
    aliases: ["银河", "Milky Way", "Galactic Center", "Sgr A*"],
  },
  ...figures.constellations.map((f) => ({
    id: `constellation-${f.id}`,
    name: f.name,
    kind: "星座",
    layer: "constellations" as const,
    aliases: [f.id, f.latin],
  })),
];
const normalized = (text: string) =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/** Search is local and independent of display switches. No plan mutations. */
export function searchTargets(
  plan: ShootingPlan,
  query: string,
): SearchTarget[] {
  const words = query
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];
  const exact = normalized(query);
  const matches = index
    .filter((t) =>
      words.every((word) =>
        normalized([t.name, t.kind, ...t.aliases].join(" ")).includes(
          normalized(word),
        ),
      ),
    )
    .sort(
      (a, b) =>
        Number(
          normalized(b.name) === exact ||
            b.aliases.some((x) => normalized(x) === exact),
        ) -
          Number(
            normalized(a.name) === exact ||
              a.aliases.some((x) => normalized(x) === exact),
          ) || a.name.localeCompare(b.name, "zh-CN"),
    );
  if (!matches.length) return [];
  const needsSky = matches.some(
      (t) => t.layer === "stars" || t.layer === "milkyWay",
    ),
    sky = needsSky ? skyReference(plan) : null;
  const points = new Map(sky?.points.map((p) => [p.id, p]) ?? []);
  if (sky) points.set(sky.core.id, sky.core);
  if (matches.some((t) => t.layer === "constellations"))
    for (const p of constellationScene(plan).anchors) points.set(p.id, p);
  const bodies = matches.some((t) => t.id === "sun" || t.id === "moon")
    ? celestialBodies(plan)
    : null;
  return matches.map((target) => {
    if ((target.id === "sun" || target.id === "moon") && bodies) {
      const body = bodies[target.id];
      return {
        ...body,
        ...target,
        body,
        magnitude: 0,
        color: [1, 1, 1] as const,
      };
    }
    const point = points.get(target.id);
    if (!point) throw new Error("搜索目标的星历不可用");
    return { ...point, ...target };
  });
}

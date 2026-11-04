import type { Map as MapLibreMap, SkySpecification, ExpressionSpecification } from "maplibre-gl";
import type { solarPosition } from "../domain/solar.ts";
import { terrainColors } from "../domain/terrain.ts";

// Artistic clear-sky colours, not radiance, exposure or a weather forecast.
const stops = [
  { elevation: -18, sky: "#080f25", horizon: "#17233e", fog: "#111c30", brightness: 0.11, warmth: 0 },
  { elevation: -12, sky: "#152445", horizon: "#354461", fog: "#28364d", brightness: 0.18, warmth: 0 },
  { elevation: -6, sky: "#35496c", horizon: "#a37886", fog: "#676276", brightness: 0.34, warmth: 0.15 },
  { elevation: 0, sky: "#7189a5", horizon: "#efb799", fog: "#b69f96", brightness: 0.6, warmth: 0.45 },
  { elevation: 6, sky: "#8fb2d2", horizon: "#f2d8b2", fog: "#d1c7b2", brightness: 0.85, warmth: 0.25 },
  { elevation: 25, sky: "#9fc5e1", horizon: "#e7ede5", fog: "#d9e4db", brightness: 1, warmth: 0 },
];
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const channels = (color: string) => [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16));
const hex = (values: number[]) => `#${values.map((value) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
const mix = (a: number, b: number, weight: number) => a + (b - a) * weight;
const mixColor = (a: string, b: string, weight: number) => hex(channels(a).map((value, index) => mix(value, channels(b)[index], weight)));

export function environmentForSun(sun: ReturnType<typeof solarPosition>) {
  if (!Number.isFinite(sun.elevation) || !Number.isFinite(sun.azimuth))
    throw new RangeError("光照需要有效的太阳位置");
  const elevation = clamp(sun.elevation, -18, 25);
  const upper = stops.findIndex((stop) => stop.elevation >= elevation);
  const a = stops[Math.max(0, upper - 1)], b = stops[upper];
  const linear = a === b ? 0 : (elevation - a.elevation) / (b.elevation - a.elevation);
  const weight = linear * linear * (3 - 2 * linear);
  const brightness = mix(a.brightness, b.brightness, weight);
  const warmth = mix(a.warmth, b.warmth, weight);
  const surface = (color: string) => hex(channels(mixColor(color, "#ffb87d", warmth * 0.15)).map((value) => value * brightness));
  const direct = clamp(sun.elevation / 6, 0, 1);
  return {
    sky: {
      "sky-color": mixColor(a.sky, b.sky, weight),
      "horizon-color": mixColor(a.horizon, b.horizon, weight),
      "fog-color": mixColor(a.fog, b.fog, weight),
      "sky-horizon-blend": 0.65,
      "horizon-fog-blend": 0.2,
      "fog-ground-blend": 0.06,
    } satisfies SkySpecification,
    ground: surface(terrainColors.ground),
    landcover: ["match", ["get", "class"],
      "wood", surface(terrainColors.wood), "grass", surface(terrainColors.grass),
      "sand", surface(terrainColors.sand), "ice", surface(terrainColors.ice),
      surface(terrainColors.land),
    ] as ExpressionSpecification,
    water: surface(terrainColors.water),
    shading: {
      "hillshade-illumination-anchor": "map",
      "hillshade-illumination-direction": clamp(sun.azimuth, 0, 359),
      "hillshade-illumination-altitude": clamp(sun.elevation, 0, 90),
      "hillshade-shadow-color": surface("#586651"),
      "hillshade-highlight-color": surface("#f0edda"),
      "hillshade-accent-color": surface("#697b58"),
      "hillshade-exaggeration": 0.4 * direct * direct * (3 - 2 * direct),
    },
  };
}

export function applyEnvironment(
  map: Pick<MapLibreMap, "setSky" | "setPaintProperty">,
  environment: ReturnType<typeof environmentForSun>,
) {
  map.setSky(environment.sky);
  map.setPaintProperty("preview-ground", "background-color", environment.ground);
  map.setPaintProperty("preview-landcover", "fill-color", environment.landcover);
  map.setPaintProperty("preview-water", "fill-color", environment.water);
  map.setPaintProperty("preview-waterways", "line-color", environment.water);
  for (const property of Object.keys(environment.shading) as Array<keyof typeof environment.shading>)
    map.setPaintProperty("preview-shading", property, environment.shading[property]);
}

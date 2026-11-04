import type { Map as MapLibreMap, SkySpecification, ExpressionSpecification } from "maplibre-gl";
import type { celestialBodies } from "../domain/ephemeris.ts";
import { terrainColors } from "../domain/terrain.ts";

// Artistic clear-sky colours, not radiance, exposure or a weather forecast.
const stops = [
  { elevation: -18, sky: "#1b2c46", horizon: "#34465c", fog: "#29394c", brightness: 0.20, warmth: 0 },
  { elevation: -12, sky: "#283c59", horizon: "#475b72", fog: "#3a4e65", brightness: 0.26, warmth: 0 },
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
const smoothstep = (low: number, high: number, value: number) => {
  const t = clamp((value - low) / (high - low), 0, 1);
  return t * t * (3 - 2 * t);
};
type Bodies = ReturnType<typeof celestialBodies>;

export function environmentForSky(sun: Pick<Bodies["sun"], "elevation" | "azimuth">,
  moon: Pick<Bodies["moon"], "elevation" | "illuminatedFraction">) {
  if (!Number.isFinite(sun.elevation) || !Number.isFinite(sun.azimuth))
    throw new RangeError("光照需要有效的太阳位置");
  if (!Number.isFinite(moon.elevation) || Math.abs(moon.elevation) > 90 ||
    !Number.isFinite(moon.illuminatedFraction) || moon.illuminatedFraction < 0 || moon.illuminatedFraction > 1)
    throw new RangeError("光照需要有效的月亮高度与亮面比例");
  const elevation = clamp(sun.elevation, -18, 25);
  const upper = stops.findIndex((stop) => stop.elevation >= elevation);
  const a = stops[Math.max(0, upper - 1)], b = stops[upper];
  const linear = a === b ? 0 : (elevation - a.elevation) / (b.elevation - a.elevation);
  const weight = linear * linear * (3 - 2 * linear);
  const nightWeight = mix(1-smoothstep(-18,-6,a.elevation),1-smoothstep(-18,-6,b.elevation),weight);
  // A display weight, not physical illuminance. Hidden/off-screen Moon discs
  // still illuminate the environment; a Moon below the geometric horizon does not.
  const moonlight = moon.illuminatedFraction ** 2 * Math.sqrt(Math.sin(Math.max(0,moon.elevation) * Math.PI / 180)) *
    nightWeight;
  const skyColor = (first: string, second: string, lift: number[]) => {
    const to = channels(second);
    // Round only once, after solar interpolation and lunar lift are combined.
    return hex(channels(first).map((value,i)=>mix(value,to[i],weight)+lift[i]*moonlight));
  };
  const brightness = mix(a.brightness, b.brightness, weight) + 0.12 * moonlight;
  const warmth = mix(a.warmth, b.warmth, weight);
  const surface = (color: string) => hex(channels(mixColor(color, "#ffb87d", warmth * 0.15)).map((value) => value * brightness));
  const direct = clamp(sun.elevation / 6, 0, 1);
  return {
    sky: {
      "sky-color": skyColor(a.sky, b.sky, [21,25,29]),
      "horizon-color": skyColor(a.horizon, b.horizon, [30,35,35]),
      "fog-color": skyColor(a.fog, b.fog, [30,32,32]),
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
  environment: ReturnType<typeof environmentForSky>,
) {
  map.setSky(environment.sky);
  map.setPaintProperty("preview-ground", "background-color", environment.ground);
  map.setPaintProperty("preview-landcover", "fill-color", environment.landcover);
  map.setPaintProperty("preview-water", "fill-color", environment.water);
  map.setPaintProperty("preview-waterways", "line-color", environment.water);
  for (const property of Object.keys(environment.shading) as Array<keyof typeof environment.shading>)
    map.setPaintProperty("preview-shading", property, environment.shading[property]);
}

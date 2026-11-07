import type { MapPoint } from "./map.ts";
import type { Vector3 } from "./ephemeris.ts";
import type { WeatherSample } from "./weather.ts";

export interface WeatherClouds {
  layers: [number, number, number];
  drift: [number, number];
}
export const CLOUD_HORIZON_HEIGHT = 0.12;
// Representative heights above the observer and horizontal feature sizes in
// kilometres. These distinguish layers without claiming measured cloud bases.
export const CLOUD_LAYERS = [
  { height: 1.5, size: 2.8, stretch: [1, 1], fine: 0.35, edge: 0.14, opacity: 0.99, tint: [0.82, 0.86, 0.92] },
  { height: 5, size: 7, stretch: [1, 1.3], fine: 0.2, edge: 0.18, opacity: 0.94, tint: [0.93, 0.95, 0.98] },
  { height: 10, size: 12, stretch: [0.4, 2.6], fine: 0.45, edge: 0.23, opacity: 0.58, tint: [1, 1, 1] },
] as const;
const smooth = (low: number, high: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
};
function hash(x: number, y: number, seed: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise(x: number, y: number, seed: number) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(0, 1, x - ix), fy = smooth(0, 1, y - iy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

export function weatherClouds(sample: WeatherSample, point: MapPoint): WeatherClouds {
  // A fixed world/time pattern for this point forecast. Drift and cloud heights
  // are display choices, not measured cloud motion or a spatial forecast field.
  const hours = (sample.time - Date.UTC(2020, 0, 1)) / 3_600_000;
  return { layers: [sample.low, sample.mid, sample.high],
    drift: [point.longitude * 0.12 + hours * 0.03, point.latitude * 0.12 + hours * 0.017] };
}

export function cloudLayerOpacities(ray: Vector3, clouds: WeatherClouds) {
  const length = Math.hypot(...ray), height = Math.max(0, ray[2] / length);
  const detail = smooth(0, CLOUD_HORIZON_HEIGHT, height);
  return CLOUD_LAYERS.map((layer, index) => {
    const cover = clouds.layers[index];
    // Curvature bounds distant projection continuously. Near the horizon,
    // unresolved structure converges to mean coverage instead of vertical bars.
    const distance = 2 * layer.height / (height + Math.sqrt(height * height + 2 * layer.height / 6371));
    const x = (ray[0] / length * distance / layer.size + clouds.drift[0] + index * 19) * layer.stretch[0];
    const y = (ray[1] / length * distance / layer.size + clouds.drift[1] + index * 31) * layer.stretch[1];
    const value = noise(x, y, index + 1) * (1 - layer.fine) + noise(x * 2.1, y * 2.1, index + 11) * layer.fine;
    const pattern = cover <= 0 ? 0 : cover >= 1 ? 1 : smooth(1 - cover - layer.edge, 1 - cover + layer.edge, value);
    const amount = cover + (pattern - cover) * detail;
    return amount * layer.opacity;
  });
}

export function cloudOpacity(ray: Vector3, clouds?: WeatherClouds) {
  if (!clouds) return 0;
  const transmission = cloudLayerOpacities(ray, clouds).reduce((value, opacity) => value * (1 - opacity), 1);
  return 1 - transmission;
}

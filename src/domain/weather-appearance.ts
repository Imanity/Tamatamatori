import type { MapPoint } from "./map.ts";
import type { Vector3 } from "./ephemeris.ts";
import type { WeatherSample } from "./weather.ts";

export interface WeatherClouds {
  layers: [number, number, number];
  drift: [number, number];
}
export const CLOUD_HORIZON_HEIGHT = 0.12;
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

export function cloudOpacity(ray: Vector3, clouds?: WeatherClouds) {
  if (!clouds) return 0;
  const length = Math.hypot(...ray), height = Math.max(0, ray[2] / length);
  // A hard distance cap freezes the vertical texture coordinate near the
  // horizon. Keep the projection continuous and converge unresolved distant
  // structure to the forecast's mean coverage. DEM depth clips the ground.
  const distance = 2 / (height + Math.sqrt(height * height + CLOUD_HORIZON_HEIGHT ** 2));
  const detail = smooth(0, CLOUD_HORIZON_HEIGHT, height);
  let transmission = 1;
  clouds.layers.forEach((cover, index) => {
    const scale = [1.6, 1, 0.7][index];
    const x = ray[0] / length * distance * scale + clouds.drift[0] + index * 19;
    const y = ray[1] / length * distance * scale + clouds.drift[1] + index * 31;
    const value = noise(x, y, index + 1) * 0.7 + noise(x * 2.1, y * 2.1, index + 11) * 0.3;
    const pattern = cover <= 0 ? 0 : cover >= 1 ? 1 : smooth(1 - cover - 0.14, 1 - cover + 0.14, value);
    const amount = cover + (pattern - cover) * detail;
    transmission *= 1 - amount * [0.99, 0.94, 0.58][index];
  });
  return 1 - transmission;
}

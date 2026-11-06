import catalog from "../data/deep-sky.json" with { type: "json" };
import type { ShootingPlan } from "./plan.ts";
import type { Vector3 } from "./ephemeris.ts";
import { degrees, unit } from "./ephemeris.ts";
import { skyReference, skyPointView } from "./starfield.ts";
import type { SkyPoint } from "./starfield.ts";
import { refractDirection } from "./refraction.ts";
import { projectDirection } from "./celestial-projection.ts";
import { fieldOfView } from "./plan.ts";

export interface DeepSkyEntry {
  id: string;
  catalogId: string;
  name: string;
  aliases: string[];
  model: "galaxy" | "mixed" | "reflection" | "emission" | "dark";
  catalogType: string;
  ra: number;
  dec: number;
  majorArcmin: number;
  minorArcmin: number;
  positionAngle: number | null;
  magnitude: number | null;
  tile: number;
  atlasRect: number[];
  texture: { file: string; width: number; height: number; sha256: string; bytes: number; alphaData: string };
  bounds: number[];
  starIds?: string[];
}
export const deepSkyCatalog = catalog.objects as DeepSkyEntry[];
export const deepSkyCount = deepSkyCatalog.length;
export const deepSkyImageCredits = catalog.imageSources;
export const deepSkySourceNote = (catalogId: string) => {
  const source = deepSkyImageCredits.find(source => source.catalogId === catalogId);
  return source && "sourceNote" in source ? String(source.sourceNote) : undefined;
};
// A qualitative red-only increment, not measured sensor/spectral response.
// Adding arbitrary G/B here can make an already red cloud less red.
export const deepSkyRedEnhancementColor = [1, 0, 0] as const;
export const deepSkyTextureBudget = 64 * 1024 * 1024;
export const deepSkyKinds = {
  galaxy: "星系",
  mixed: "混合星云",
  reflection: "星团与反射云",
  emission: "发射星云",
  dark: "暗云与发射背景",
};
export type DeepSkyTarget = SkyPoint & {
  entry: DeepSkyEntry;
  boundary: Vector3[];
  offset: number;
  count: number;
};
let cachedKey = "",
  cached:
    | {
        vertices: Float32Array;
        objects: DeepSkyTarget[];
        clusterStars: SkyPoint[];
      }
    | undefined;
export function deepSkyScene(plan: ShootingPlan) {
  const key = [
    plan.latitude,
    plan.longitude,
    plan.instant,
    plan.refraction,
  ].join("/");
  if (cached && cachedKey === key) return cached;
  const sky = skyReference(plan),
    vertices: number[] = [];
  const objects = deepSkyCatalog.map((entry) => {
    const a = entry.ra * degrees,
      d = entry.dec * degrees;
    const center: Vector3 = [
      Math.cos(d) * Math.cos(a),
      Math.cos(d) * Math.sin(a),
      Math.sin(d),
    ];
    const east: Vector3 = [-Math.sin(a), Math.cos(a), 0];
    const north: Vector3 = [
      -Math.sin(d) * Math.cos(a),
      -Math.sin(d) * Math.sin(a),
      Math.cos(d),
    ];
    const direction = sky.horizontal(center),
      offset = vertices.length / 8;
    const [x0, y0, x1, y1] = entry.bounds;
    const { width: atlasWidth, height: atlasHeight } = entry.texture;
    const nx = Math.max(4, Math.min(32, Math.ceil((x1 - x0) / degrees / 0.25))),
      ny = Math.max(4, Math.min(32, Math.ceil((y1 - y0) / degrees / 0.25)));
    const grid: { ray: Vector3; uv: number[] }[] = [],
      boundary: Vector3[] = [];
    for (let y = 0; y <= ny; y++)
      for (let x = 0; x <= nx; x++) {
        const u = x / nx,
          v = y / ny,
          tx = x0 + (x1 - x0) * u,
          ty = y1 - (y1 - y0) * v;
        const eq = unit(
          center.map(
            (c, i) => c + tx * east[i] + ty * north[i],
          ) as unknown as Vector3,
        );
        const ray = refractDirection(sky.horizontal(eq), plan.refraction);
        grid.push({
          ray,
          uv: [
            (0.5 + (atlasWidth - 1) * u) / atlasWidth,
            (0.5 + (atlasHeight - 1) * v) / atlasHeight,
          ],
        });
        if (x === 0 || x === nx || y === 0 || y === ny) boundary.push(ray);
      }
    const color: Vector3 =
      entry.model === "galaxy"
        ? [1, 0.86, 0.68]
        : entry.model === "reflection"
          ? [0.36, 0.64, 1]
          : [0.65, 0.76, 1];
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const i = y * (nx + 1) + x,
          j = i + nx + 1;
        for (const index of [i, j, i + 1, i + 1, j, j + 1])
          // RGB is already coloured in the atlas; the mesh must not tint it.
          vertices.push(...grid[index].ray, ...grid[index].uv, 1, 1, 1);
      }
    return {
      id: entry.id,
      name: entry.name,
      entry,
      boundary,
      offset,
      count: vertices.length / 8 - offset,
      direction,
      azimuth: (Math.atan2(direction[0], direction[1]) / degrees + 360) % 360,
      elevation: Math.asin(direction[2]) / degrees,
      magnitude: entry.magnitude ?? 99,
      color,
    };
  });
  const clusterIds = new Set(
    deepSkyCatalog.flatMap((entry) => entry.starIds ?? []),
  );
  cached = {
    vertices: new Float32Array(vertices),
    objects,
    clusterStars: sky.points
      .filter((point) => clusterIds.has(point.id))
      .map((point) => ({ ...point, name: undefined })),
  };
  cachedKey = key;
  return cached;
}
/** Extended targets may intersect the frame while their centres are outside. */
export function deepSkyView(plan: ShootingPlan, target: DeepSkyTarget) {
  const center = skyPointView(plan, target);
  const rays = [...target.boundary, center.ray];
  const visible = rays
    .filter((ray) => ray[2] > 0)
    .map((ray) => projectDirection(plan, ray))
    .filter((point) => point !== null);
  const overlap =
    visible.length > 0 &&
    Math.min(...visible.map((p) => p.x)) <= 1 &&
    Math.max(...visible.map((p) => p.x)) >= -1 &&
    Math.min(...visible.map((p) => p.y)) <= 1 &&
    Math.max(...visible.map((p) => p.y)) >= -1;
  const state = rays.every((ray) => ray[2] <= 0)
    ? "地平线下"
    : overlap
      ? "画面内"
      : "视场外";
  return {
    ...center,
    state,
    partialFrame: state === "画面内" && center.state !== "画面内",
  };
}
export const deepSkyResponseLabel = (
  response: ShootingPlan["cameraResponse"],
) => (response === "ha-modified" ? "天文改机 · Hα 增强示意" : "未改机 · 近似参考");

/** Display-resolution policy only; celestial geometry does not use this LOD. */
export function deepSkyTextureRequests(plan: ShootingPlan, objects: DeepSkyTarget[], width: number, height: number, deviceMax: number) {
  if (!plan.layers.deepSky) return [];
  const fov = fieldOfView(plan);
  const requests = objects.filter(object => deepSkyView(plan, object).state === "画面内").map(object => {
    const [x0, y0, x1, y1] = object.entry.bounds;
    const pixels = Math.max((x1-x0)/degrees/fov.horizontal*width, (y1-y0)/degrees/fov.vertical*height);
    const texture = object.entry.texture;
    const native = Math.max(texture.width, texture.height);
    const size = Math.min(native, deviceMax, 2 ** Math.ceil(Math.log2(Math.max(256, pixels*1.5))));
    return { object, maxSize: Math.max(1, size) };
  });
  const bytes = (request: typeof requests[number]) => {
    const { width, height } = request.object.entry.texture;
    const scale = Math.min(1, request.maxSize/Math.max(width, height));
    return Math.floor(width*scale)*Math.floor(height*scale)*4*4/3;
  };
  // Budget every selected allocation, including downloads awaiting upload.
  while (requests.reduce((sum, request) => sum+bytes(request), 0) > deepSkyTextureBudget) {
    const largest = requests.filter(r => r.maxSize > 1).sort((a,b) => bytes(b)-bytes(a))[0];
    if (!largest) break;
    largest.maxSize = Math.max(1, Math.floor(largest.maxSize/2));
  }
  return requests;
}

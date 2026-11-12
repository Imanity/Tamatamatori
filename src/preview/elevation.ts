import { sampleElevationTile, terrainTile, tileSampler, TERRAIN_ZOOM } from "../domain/terrain.ts";
import type { ElevationTile } from "../domain/terrain.ts";
import type { MapPoint } from "../domain/map.ts";

interface Metadata {
  tiles: string[];
  bounds?: number[];
}
const metadataCache = new Map<string, Promise<Metadata>>();
const tileCache = new Map<string, ElevationTile>();

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("请求已取消", "AbortError");
}

async function request<T>(
  url: string,
  read: (response: Response) => Promise<T>,
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`地形数据请求失败（${response.status}）`);
    return await read(response);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function metadata(url: string) {
  let pending = metadataCache.get(url);
  if (!pending) {
    pending = request(url, (response) => response.json())
      .then((data: Record<string, unknown>) => {
        if (
          data.encoding !== "terrarium" ||
          (data.scheme && data.scheme !== "xyz") ||
          !Array.isArray(data.tiles) ||
          !data.tiles.length ||
          !data.tiles.every(
            (tile) =>
              typeof tile === "string" &&
              tile.includes("{z}") &&
              tile.includes("{x}") &&
              tile.includes("{y}"),
          )
        )
          throw new Error("地形源需为 xyz / Terrarium 瓦片");
        return {
          tiles: data.tiles as string[],
          bounds: Array.isArray(data.bounds)
            ? (data.bounds as number[])
            : undefined,
        };
      })
      .catch((error) => {
        metadataCache.delete(url);
        throw error;
      });
    metadataCache.set(url, pending);
  }
  return pending;
}

async function decodeImage(blob: Blob): Promise<ElevationTile> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, {
      colorSpaceConversion: "none",
      premultiplyAlpha: "none",
    });
  } catch {
    throw new Error("地形瓦片图像无法解码，请重试。");
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || bitmap.width !== 512 || bitmap.height !== 512)
      throw new Error("无法解码 512 像素地形瓦片");
    context.drawImage(bitmap, 0, 0);
    return {
      width: bitmap.width,
      height: bitmap.height,
      pixels: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
    };
  } finally {
    bitmap.close();
  }
}

export async function groundElevation(
  point: MapPoint,
  url: string,
  signal: AbortSignal,
  zoom = TERRAIN_ZOOM,
) {
  checkAbort(signal);
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > TERRAIN_ZOOM)
    throw new RangeError("地形采样级别超出当前来源范围");
  const info = await metadata(url);
  checkAbort(signal);
  if (
    info.bounds &&
    (point.latitude < info.bounds[1] || point.latitude > info.bounds[3])
  )
    throw new RangeError("当前机位超出地形数据覆盖范围");
  const position = terrainTile(point, zoom);
  const tileUrl = info.tiles[0]
    .replace("{z}", String(position.z))
    .replace("{x}", String(position.x))
    .replace("{y}", String(position.y));
  let tile = tileCache.get(tileUrl);
  if (!tile) {
    const blob = await request(tileUrl, (response) => response.blob(), signal);
    tile = await decodeImage(blob);
    checkAbort(signal);
    tileCache.set(tileUrl, tile);
    if (tileCache.size > 8) tileCache.delete(tileCache.keys().next().value!);
  } else {
    tileCache.delete(tileUrl);
    tileCache.set(tileUrl, tile);
  }
  try {
    return {
      height: sampleElevationTile(tile, position.u, position.v),
      zoom: position.z,
    };
  } catch (error) {
    tileCache.delete(tileUrl);
    throw error;
  }
}

// Decoded tiles kept for line sampling (推算 · 找机位); each is 1 MiB of RGBA.
const lineCache = new Map<string, ElevationTile>();
export const LINE_TILE_LIMIT = 40;
/** Coarsest zoom a wide search may fall back to. */
export const LINE_MIN_ZOOM = 10;

/** The tiles under the points at the finest zoom (z12 down to z10) that stays within LINE_TILE_LIMIT. */
export function lineTiles(points: readonly MapPoint[], inside: (point: MapPoint) => boolean = () => true) {
  let keys = new Map<string, { z: number; x: number; y: number }>();
  for (let zoom = TERRAIN_ZOOM; zoom >= LINE_MIN_ZOOM; zoom--) {
    keys = new Map();
    for (const point of points) {
      if (!inside(point)) continue;
      const tile = terrainTile(point, zoom);
      keys.set(`${tile.z}/${tile.x}/${tile.y}`, tile);
    }
    if (keys.size <= LINE_TILE_LIMIT) return { zoom, keys };
  }
  throw new RangeError(`推算范围经过 ${keys.size} 块地形瓦片，超过单次 ${LINE_TILE_LIMIT} 块的上限，请缩小最远距离。`);
}

/**
 * Loads every tile under the given points (z12, or a coarser zoom when z12
 * would need more than LINE_TILE_LIMIT tiles) and returns a synchronous
 * sampler (null outside the loaded tiles, the source bounds or valid pixels).
 */
export async function elevationTiles(
  points: readonly MapPoint[],
  url: string,
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
) {
  checkAbort(signal);
  const info = await metadata(url);
  checkAbort(signal);
  const inside = (point: MapPoint) =>
    !info.bounds || (point.latitude >= info.bounds[1] && point.latitude <= info.bounds[3]);
  const { zoom, keys } = lineTiles(points, inside);
  const loaded = new Map<string, ElevationTile>();
  let done = 0;
  onProgress?.(0, keys.size);
  const queue = [...keys];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [key, tile] = next;
      const tileUrl = info.tiles[0].replace("{z}", String(tile.z)).replace("{x}", String(tile.x)).replace("{y}", String(tile.y));
      let decoded = lineCache.get(tileUrl);
      if (!decoded) {
        const blob = await request(tileUrl, (response) => response.blob(), signal);
        decoded = await decodeImage(blob);
        checkAbort(signal);
        lineCache.set(tileUrl, decoded);
        if (lineCache.size > LINE_TILE_LIMIT + 8) lineCache.delete(lineCache.keys().next().value!);
      }
      loaded.set(key, decoded);
      onProgress?.(++done, keys.size);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  // The tiles travel with the sampler so a worker can rebuild it (structured clone).
  return Object.assign(tileSampler(loaded, info.bounds), { tiles: loaded as ReadonlyMap<string, ElevationTile>, bounds: info.bounds, zoom });
}

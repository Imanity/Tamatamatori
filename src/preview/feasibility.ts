import { VectorTile, classifyRings } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { buildingHeights } from "../domain/buildings.ts";
import { CHECK_TILE_LIMIT, CHECK_ZOOM } from "../domain/feasibility.ts";
import type { Area, Coordinate, Features, Footprint } from "../domain/feasibility.ts";
import { terrainTile } from "../domain/terrain.ts";

/**
 * "检查机位": water areas and building outlines from the same OpenFreeMap
 * vector tiles as the preview (z14), read only when asked. Decoded tiles are
 * kept for the page (at most 64) so a second check nearby reads nothing.
 */
const MAX_TILE_BYTES = 3 * 1024 * 1024;
const CACHE_TILES = 64;
const cache = new Map<string, Features>();
const sources = new Map<string, { at: number; template: string }>();

async function read(url: string, signal: AbortSignal, limit: number) {
  const abort = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const response = await fetch(url, { signal: abort });
  if (!response.ok) throw new Error(`矢量瓦片请求失败（${response.status}）`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("矢量瓦片响应无数据流");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new Error("矢量瓦片超出读取预算");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  abort.throwIfAborted();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function template(url: string, signal: AbortSignal) {
  const known = sources.get(url);
  if (known && Date.now() - known.at < 3_600_000) return known.template;
  const data = JSON.parse(new TextDecoder().decode(await read(url, signal, 128 * 1024)));
  const layers = Array.isArray(data.vector_layers) ? data.vector_layers.map((layer: { id?: string }) => layer?.id) : [];
  if (!Array.isArray(data.tiles) || typeof data.tiles[0] !== "string" || !Number.isFinite(data.maxzoom) || data.maxzoom < CHECK_ZOOM ||
    !layers.includes("water") || !layers.includes("building"))
    throw new Error("矢量瓦片源缺少 z14 的水体或建筑图层");
  const value = new URL(data.tiles[0], url).href.replaceAll("%7B", "{").replaceAll("%7D", "}");
  if (!/^https?:/.test(value) || !["{x}", "{y}", "{z}"].every((key) => value.includes(key))) throw new Error("矢量瓦片地址无效");
  sources.set(url, { at: Date.now(), template: value });
  return value;
}

/** Water polygons and building outlines of one tile, in latitude/longitude. */
export function decodeFeatures(bytes: Uint8Array, tile: { z: number; x: number; y: number }): Features {
  const decoded = new VectorTile(new PbfReader(bytes));
  const scale = 2 ** tile.z;
  const convert = (extent: number) => (point: { x: number; y: number }): Coordinate => ({
    longitude: ((tile.x + point.x / extent) / scale) * 360 - 180,
    latitude: Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + point.y / extent)) / scale))) / (Math.PI / 180),
  });
  const water: Area[] = [], buildings: Footprint[] = [];
  const layer = (name: string) => {
    const found = decoded.layers[name];
    if (found && (!Number.isFinite(found.extent) || found.extent <= 0 || found.length > 200_000)) throw new Error("矢量瓦片结构异常");
    return found;
  };
  const waterLayer = layer("water");
  for (let index = 0; waterLayer && index < waterLayer.length; index++) {
    const feature = waterLayer.feature(index);
    if (feature.type !== 3) continue;
    const toCoordinate = convert(waterLayer.extent);
    for (const rings of classifyRings(feature.loadGeometry())) water.push({ rings: rings.map((ring) => ring.map(toCoordinate)) });
  }
  const buildingLayer = layer("building");
  for (let index = 0; buildingLayer && index < buildingLayer.length; index++) {
    const feature = buildingLayer.feature(index);
    const heights = buildingHeights(feature.properties);
    if (feature.type !== 3 || !heights) continue;
    const toCoordinate = convert(buildingLayer.extent);
    for (const rings of classifyRings(feature.loadGeometry()))
      buildings.push({ rings: rings.map((ring) => ring.map(toCoordinate)), height: heights.height, base: heights.base });
  }
  return { water, buildings };
}

/** z14 tiles under the points, in order of first appearance. */
export function featureTiles(points: readonly Coordinate[]) {
  const tiles = new Map<string, { z: number; x: number; y: number }>();
  for (const point of points) {
    const tile = terrainTile(point, CHECK_ZOOM);
    tiles.set(`${tile.z}/${tile.x}/${tile.y}`, { z: tile.z, x: tile.x, y: tile.y });
  }
  return tiles;
}

export async function loadFeatures(points: readonly Coordinate[], url: string, signal: AbortSignal, onProgress?: (done: number, total: number) => void) {
  const tiles = featureTiles(points);
  if (tiles.size > CHECK_TILE_LIMIT) throw new RangeError(`需要 ${tiles.size} 块矢量瓦片，超过单次 ${CHECK_TILE_LIMIT} 块的上限`);
  const pattern = await template(url, signal);
  const features: Features = { water: [], buildings: [] };
  let done = 0, read_ = 0;
  onProgress?.(0, tiles.size);
  const queue = [...tiles.values()];
  const worker = async () => {
    for (let tile = queue.shift(); tile; tile = queue.shift()) {
      const address = pattern.replace("{z}", String(tile.z)).replace("{x}", String(tile.x)).replace("{y}", String(tile.y));
      let decoded = cache.get(address);
      if (decoded) {
        cache.delete(address);
      } else {
        decoded = decodeFeatures(await read(address, signal, MAX_TILE_BYTES), tile);
        read_++;
        while (cache.size >= CACHE_TILES) cache.delete(cache.keys().next().value!);
      }
      cache.set(address, decoded);
      features.water.push(...decoded.water);
      features.buildings.push(...decoded.buildings);
      onProgress?.(++done, tiles.size);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  signal.throwIfAborted();
  return { features, tiles: tiles.size, fetched: read_ };
}

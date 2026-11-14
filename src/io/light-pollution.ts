import {
  lightPollutionAtlas as atlas,
  lightPollutionCells,
  interpolatePollution,
} from "../domain/environment/light-pollution.ts";
import type { MapPoint } from "../domain/core/map.ts";

const tiles = new Map<string, Uint8Array>();
const entries = new Map(
  atlas.tiles.map((tile) => [`${tile.x}/${tile.y}`, tile]),
);
const checkAbort = (signal: AbortSignal) => {
  if (signal.aborted) throw new DOMException("光污染请求已取消", "AbortError");
};

/** Reads one compressed atlas file (`file` inside the atlas directory). */
export { lightPollutionAtlas, lightPollutionCells } from "../domain/environment/light-pollution.ts";
export type PollutionReader = (file: string, version: string, signal: AbortSignal) => Promise<ArrayBuffer>;
const fetchTile: PollutionReader = async (file, version, signal) => {
  const response = await fetch(`${import.meta.env.BASE_URL}${atlas.directory}${file}?v=${version}`, { signal });
  if (!response.ok) throw new Error(`光污染数据请求失败（${response.status}）`);
  return response.arrayBuffer();
};

async function loadTile(id: string, signal: AbortSignal, read: PollutionReader) {
  checkAbort(signal);
  const entry = entries.get(id);
  if (!entry) throw new Error("光污染分块索引缺失");
  let bytes = tiles.get(id);
  if (!bytes) {
    if (typeof DecompressionStream === "undefined")
      throw new Error("浏览器无法解码光污染数据");
    const compressed = await read(entry.file, entry.sha256.slice(0, 12), signal);
    if (compressed.byteLength !== entry.bytes)
      throw new Error("光污染分块下载不完整");
    const digest = await crypto.subtle.digest("SHA-256", compressed);
    const hash = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== entry.sha256) throw new Error("光污染分块版本校验失败");
    const body = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(body).arrayBuffer());
    checkAbort(signal);
    if (bytes.length !== entry.width * entry.height)
      throw new Error("光污染分块尺寸无效");
  }
  tiles.delete(id);
  tiles.set(id, bytes);
  if (tiles.size > 4) tiles.delete(tiles.keys().next().value!);
  return { entry, bytes };
}

export async function sampleLightPollution(
  point: MapPoint,
  signal: AbortSignal,
  read: PollutionReader = fetchTile,
) {
  checkAbort(signal);
  const cells = lightPollutionCells(point);
  if (!cells) return null;
  const tileId = (x: number, y: number) =>
    `${Math.floor(x / atlas.tileSize)}/${Math.floor(y / atlas.tileSize)}`;
  const ids = [...new Set(cells.map((cell) => tileId(cell.x, cell.y)))];
  const loaded = new Map(
    await Promise.all(
      ids.map(async (id) => [id, await loadTile(id, signal, read)] as const),
    ),
  );
  checkAbort(signal);
  return interpolatePollution(
    cells.map((cell) => {
      const { entry, bytes } = loaded.get(tileId(cell.x, cell.y))!;
      const x = cell.x % atlas.tileSize,
        y = cell.y % atlas.tileSize;
      return { code: bytes[y * entry.width + x], weight: cell.weight };
    }),
  );
}

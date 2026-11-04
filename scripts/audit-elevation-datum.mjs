// Optional, bounded online audit; not an app or CI dependency. Reuses the
// vector-tile/PBF readers already locked through MapLibre. No DEM downloads.
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { terrainTile, DEFAULT_TERRAIN_URL } from "../src/domain/terrain.ts";

const upstreamCommit = "2c4195dd90b91a8dde5cfa3e27a1167f64808a41";
const coverageUrl = "https://single-archive-tiles.mapterhorn.com/coverage.json";
const points = [
  { name: "山中湖眼点", latitude: 35.4172, longitude: 138.8729 },
  { name: "剣ヶ峰参考点", latitude: 35.36083333333333, longitude: 138.7275 },
];
const requests = [];
async function read(url, limit = 65536) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Audit request failed: ${response.status} ${url}`);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new Error(`Audit response exceeded ${limit} bytes: ${url}`);
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = Buffer.concat(chunks);
  requests.push({ url, bytes: length, sha256: createHash("sha256").update(bytes).digest("hex"),
    etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified") });
  return bytes;
}
const json = async url => JSON.parse((await read(url)).toString("utf8"));
const tilejson = await json(DEFAULT_TERRAIN_URL);
const coverage = await json(coverageUrl);
// Keep this one-shot audit constrained to the verified official endpoints.
const template = "https://single-archive-tiles.mapterhorn.com/coverage/{z}/{x}/{y}.mvt";
if (coverage.tiles?.[0] !== template) throw new Error("Coverage endpoint changed; review before rerunning");
const records = [];
for (const point of points) {
  const tile = terrainTile(point, 12);
  const url = template.replace("{z}", "12").replace("{x}", String(tile.x)).replace("{y}", String(tile.y));
  const decoded = new VectorTile(new PbfReader(await read(url)));
  const layer = decoded.layers.coverage;
  if (!layer) throw new Error("Expected coverage layer is missing");
  const features = Array.from({ length: layer.length }, (_, i) => {
    const feature = layer.feature(i);
    return { properties: feature.properties, bounds: feature.bbox() };
  });
  records.push({ point, tile: { z: 12, x: tile.x, y: tile.y }, extent: layer.extent,
    tileListedSources: [...new Set(features.map(f => f.properties.source))], features });
}
// Hash the reviewed code; these are implementation snapshots, not proof of
// which deployment generated the live tiles. Never infer pixel provenance.
for (const path of ["pipelines/aggregation_reproject.py", "pipelines/aggregation_merge.py", "pipelines/create_coverage_index.py"])
  await read(`https://raw.githubusercontent.com/mapterhorn/mapterhorn/${upstreamCommit}/${path}`);

const output = process.argv[2] ?? "docs/plan/elevation-datum-evidence/audit.json";
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ accessedAt: new Date().toISOString(), node: process.version,
  upstreamCommit, tilejson, coverageTilejson: coverage, records, requests,
  limitation: "来源仅列于所在覆盖瓦片中；并不证明覆盖当前点、选中像素、混合权重或垂直基准。代码快照与在线瓦片未建立版本绑定。",
}, null, 2) + "\n");
console.log(`Saved ${records.length} coverage records / ${requests.length} bounded requests to ${output}`);

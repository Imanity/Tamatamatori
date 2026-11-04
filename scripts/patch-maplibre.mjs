import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// 6.16.0 passes the public source LOD function to DEM loading but omits it
// from terrain mesh coverage. Keep that one hand-off identical in both paths.
// Patch the shipped ESM and source used by SDK CPU tests; no runtime internals.
const require = createRequire(import.meta.url);
const root = dirname(require.resolve("maplibre-gl/package.json"));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (manifest.version !== "6.16.0") throw new Error("MapLibre 地形补丁需要重新验证 SDK 版本");
const changes = [
  ["src/tile/terrain_tile_manager.ts", "            reparseOverscaled: false,\n            terrain\n", "            reparseOverscaled: false,\n            terrain,\n            calculateTileZoom: this.getSource().calculateTileZoom\n"],
  ["dist/maplibre-gl.mjs", "maxzoom:this.maxzoom,reparseOverscaled:!1,terrain:t}", "maxzoom:this.maxzoom,reparseOverscaled:!1,terrain:t,calculateTileZoom:this.getSource().calculateTileZoom}"],
];
// Validate every signature before writing either file; tolerate a second run.
const edits = changes.map(([file, before, after]) => {
  const filename = join(root, file), text = readFileSync(filename, "utf8").replaceAll("\r\n", "\n");
  if (text.split(after).length === 2 && !text.includes(before)) return null;
  if (text.split(before).length !== 2 || text.includes(after)) throw new Error(`MapLibre 补丁签名不匹配：${file}`);
  return { filename, content: text.replace(before, after).replace(/\/\/# sourceMappingURL=.*$/m, "") };
});
for (const edit of edits) if (edit) writeFileSync(edit.filename, edit.content);
console.log("MapLibre 6.16.0：地形绘制沿用公开 LOD 策略");

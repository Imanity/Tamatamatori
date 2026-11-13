import { defineConfig, normalizePath } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const inputs = ["scripts/patch-maplibre.mjs", "scripts/patch-terrain-perspective.mjs", "scripts/patch-terrain-depth.mjs",
  "scripts/patch-terrain-range.mjs",
  "src/render/scene/terrain-projection.glsl", "src/render/scene/terrain-depth.glsl"]
  .map(path => fileURLToPath(new URL(path, import.meta.url)));

// Pulling a shader fix need not change package-lock or rerun postinstall.
// Apply the version/signature-checked, idempotent patch before Vite reads the SDK.
execFileSync(process.execPath, [inputs[0]], { stdio: "inherit" });
const signature = createHash("sha256");
for (const path of inputs) signature.update(readFileSync(path));
export default defineConfig({
  worker: { format: "es" },
  plugins: [react(), {
    name: "terrain-sdk-inputs",
    configResolved(config) {
      // readFileSync inputs are not discovered as imports. Register them so a
      // running server also reapplies patches and selects a fresh prebundle.
      config.configFileDependencies.push(...inputs.map(normalizePath));
    },
  }],
  cacheDir: `node_modules/.vite-terrain-${signature.digest("hex").slice(0,12)}`,
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Postinstall changes the SDK without changing its package version. Keep Vite
// from reusing a planar/stale prebundle after the projection kernel is updated.
const signature = createHash("sha256");
for (const path of ["scripts/patch-maplibre.mjs", "scripts/patch-terrain-perspective.mjs", "scripts/patch-terrain-depth.mjs",
  "src/preview/terrain-projection.glsl", "src/preview/terrain-depth.glsl"])
  signature.update(readFileSync(new URL(path,import.meta.url)));
export default defineConfig({ plugins: [react()], cacheDir: `node_modules/.vite-terrain-${signature.digest("hex").slice(0,12)}` });

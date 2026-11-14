import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The source layers and what each may import (docs/plan/code-structure.md):
// domain is pure and loads in the browser, the worker, the command line and
// Node tests alike, so it stays clear of loaders, rendering and the UI.
const src = fileURLToPath(new URL("../../src/", import.meta.url));
const allowed = {
  domain: ["domain", "data"],
  io: ["domain", "data", "io"],
  render: ["domain", "data", "io", "render"],
};
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = resolve(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const source = walk(src).filter((path) => /\.(ts|tsx)$/.test(path));
const layerOf = (path) => relative(src, path).split(sep)[0];
const specifiers = (text) => [...text.matchAll(/(?:\bfrom|\bimport|new URL)\s*\(?\s*["'](\.{1,2}\/[^"'?]+)/g)].map((match) => match[1]);

test("源码分层：领域只引用领域与数据，加载器不引用绘制与界面，绘制不引用界面", () => {
  const problems = [];
  const counts = {};
  for (const file of source) {
    const layer = layerOf(file);
    if (!allowed[layer]) continue;
    counts[layer] = (counts[layer] ?? 0) + 1;
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      const target = layerOf(resolve(dirname(file), spec));
      if (!allowed[layer].includes(target)) problems.push(`${relative(src, file).replaceAll(sep, "/")} → ${spec}`);
    }
  }
  assert.deepEqual(problems, []);
  // Not vacuous: every layer has files.
  for (const layer of Object.keys(allowed)) assert.ok(counts[layer] > 10, `${layer}: ${counts[layer]}`);
});

test("源码分层：领域、绘制与界面的文件都在功能子目录中，不散放在层的根目录", () => {
  for (const layer of ["domain", "render", "ui"]) {
    const loose = readdirSync(resolve(src, layer)).filter((name) => statSync(resolve(src, layer, name)).isFile());
    assert.deepEqual(loose, [], layer);
  }
});

// The page's first load (docs/plan/lazy-loading.md): the files reached from
// src/main.tsx through static imports. Type-only imports and import() are not
// followed, nor assets (?url, ?raw, CSS, JSON) and packages.
function staticGraph(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    const found = [
      ...[...text.matchAll(/^(?:import|export)\s+(type\s)?[^;()]*?\bfrom\s*["']([^"']+)["']/gm)].filter((match) => !match[1]).map((match) => match[2]),
      ...[...text.matchAll(/^import\s*["']([^"']+)["']/gm)].map((match) => match[1]),
    ];
    for (const spec of found) {
      if (!spec.startsWith(".") || spec.includes("?")) continue;
      const base = resolve(dirname(file), spec);
      const target = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")].find((path) => /\.tsx?$/.test(path) && source.includes(path));
      if (target) visit(target);
    }
  };
  visit(entry);
  return [...seen].map((path) => relative(src, path).replaceAll(sep, "/"));
}

test("首屏静态引用不含推算的计算与界面、天体目录、星表、星空图层、流星雨、空间站计算、光污染索引与 About 来源列表，它们在用到时才读取", () => {
  const first = staticGraph(resolve(src, "main.tsx"));
  // Not vacuous: the workspace, the 推算 state and its words are there.
  for (const file of ["App.tsx", "ui/map/MapPanel.tsx", "ui/workspace/ScenePanels.tsx", "ui/solve/useComposition.ts", "ui/solve/composition-format.ts", "ui/workspace/About.tsx"])
    assert.ok(first.includes(file), file);
  const late = first.filter((file) =>
    file.startsWith("domain/solve/")
    || (file.startsWith("ui/solve/") && !["ui/solve/useComposition.ts", "ui/solve/composition-format.ts"].includes(file))
    || file === "domain/sky/sky-targets.ts"
    || file === "ui/workspace/AboutSources.tsx"
    // The star catalogues and the star layer (round 19): read when a sky layer is on or a search typed.
    || ["domain/sky/starfield.ts", "domain/sky/deep-sky.ts", "domain/sky/constellations.ts", "domain/sky/target-search.ts", "ui/sky/star-catalogs.ts", "render/sky/starfield-layer.ts"].includes(file)
    // Meteor showers, SGP4 and the light pollution index (round 20): read with their layer.
    || ["domain/sky/meteor-showers.ts", "domain/stations/stations.ts", "domain/stations/station-passes.ts", "ui/sky/station-module.ts", "domain/environment/light-pollution.ts"].includes(file));
  // satellite.js is imported (beyond its types) only from the files read later.
  const sgp4 = first.filter((file) => /^import\s+(?!type\b)[^;]*?from\s*["']satellite\.js["']/m.test(readFileSync(resolve(src, file), "utf8")));
  assert.deepEqual(sgp4, []);
  assert.deepEqual(late, []);
  // Both are still read, with import().
  assert.match(readFileSync(resolve(src, "ui/solve/useComposition.ts"), "utf8"), /import\("\.\/solve-module"\)/);
  assert.match(readFileSync(resolve(src, "ui/workspace/About.tsx"), "utf8"), /import\("\.\/AboutSources"\)/);
  assert.match(readFileSync(resolve(src, "ui/sky/star-catalog-source.ts"), "utf8"), /import\("\.\/star-catalogs"\)/);
  assert.match(readFileSync(resolve(src, "ui/preview/TerrainScene.tsx"), "utf8"), /import\("\.\.\/\.\.\/render\/sky\/starfield-layer"\)/);
  // The comets and the readouts use the frame, which carries no catalogue.
  assert.ok(first.includes("domain/sky/sky-frame.ts"));
  // The module side reaches what the first load leaves out.
  const module = staticGraph(resolve(src, "ui/solve/solve-module.ts"));
  for (const file of ["domain/solve/composition.ts", "domain/solve/composition-run.ts", "domain/solve/solve.ts", "domain/sky/sky-targets.ts", "ui/solve/Composition.tsx", "ui/solve/SolveLink.tsx"])
    assert.ok(module.includes(file), file);
});

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

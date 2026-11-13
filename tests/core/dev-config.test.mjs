import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, normalizePath } from "vite";

test("开发服务启动及着色器更新时重新应用补丁并切换预构建缓存", { timeout: 20000 }, async () => {
  // A disposable project exercises the real config and Vite watcher. Its patch
  // stub records the kernel it received; the application's SDK is never edited.
  const root = await mkdtemp(fileURLToPath(new URL("./.dev-config-", import.meta.url)));
  let server;
  try {
    const inputs = ["scripts/patch-maplibre.mjs", "scripts/patch-terrain-perspective.mjs", "scripts/patch-terrain-depth.mjs",
      "scripts/patch-terrain-range.mjs",
      "src/preview/terrain-projection.glsl", "src/preview/terrain-depth.glsl"];
    await writeFile(join(root, "vite.config.ts"), await readFile(new URL("../../vite.config.ts", import.meta.url)));
    await writeFile(join(root, "index.html"), "<html><body>fixture</body></html>");
    for (const path of inputs) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "// fixture v1\n");
    }
    await writeFile(join(root, inputs[0]), `
      import { readFileSync, writeFileSync } from 'node:fs';
      writeFileSync(new URL('../applied.txt', import.meta.url),
        readFileSync(new URL('../src/preview/terrain-depth.glsl', import.meta.url)));
    `);
    server = await createServer({
      root, configFile: join(root, "vite.config.ts"), logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await server.listen();
    assert.equal(await readFile(join(root, "applied.txt"), "utf8"), "// fixture v1\n");
    for (const path of inputs)
      assert.ok(server.config.configFileDependencies.includes(normalizePath(join(root, path))), path);
    const cache = server.config.cacheDir;
    // Watcher paths can use native separators on Windows. Bound discovery so
    // a missed ready event cannot leave the test and its server hanging.
    const watched = () => Object.entries(server.watcher.getWatched()).some(([dir, names]) =>
      normalizePath(dir) === normalizePath(join(root, "src/preview")) && names.includes("terrain-depth.glsl"));
    const discoveryDeadline = Date.now() + 5000;
    while (!watched() && Date.now() < discoveryDeadline) await delay(50);
    assert.ok(watched(), JSON.stringify(server.watcher.getWatched()));
    await writeFile(join(root, "src/preview/terrain-depth.glsl"), "// fixture v2\n");
    const deadline = Date.now() + 10000;
    while ((server.config.cacheDir === cache || !server.httpServer?.listening) && Date.now() < deadline) await delay(50);
    assert.notEqual(server.config.cacheDir, cache, "kernel change must restart Vite with a fresh cache");
    assert.ok(server.httpServer?.listening, "restarted server must finish listening before cleanup");
    assert.equal(await readFile(join(root, "applied.txt"), "utf8"), "// fixture v2\n");
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

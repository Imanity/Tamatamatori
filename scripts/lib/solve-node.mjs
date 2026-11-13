// Terrain and light pollution for the command line (scripts/solve.mjs): the
// same loaders as the web page, with the terrain tiles' WebP decoded by
// @jsquash/webp (WebAssembly) and the light pollution atlas read from the
// repository's public/ folder.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import decodeWebp, { init as initWebp } from '@jsquash/webp/decode.js';
import { elevationTiles } from '../../src/io/elevation.ts';
import { sampleLightPollution } from '../../src/io/light-pollution.ts';
import { lightPollutionAtlas } from '../../src/domain/environment/light-pollution.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

// The decoder builds an ImageData; Node has none.
if (typeof globalThis.ImageData === 'undefined')
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };

let ready = null;
const decoder = () => (ready ??= readFile(require.resolve('@jsquash/webp/codec/dec/webp_dec.wasm')).then((bytes) => WebAssembly.compile(bytes)).then((module) => initWebp(module)));

/** A terrain tile (Mapterhorn's 512 px Terrarium WebP) as RGBA pixels, like the browser's decoder gives. */
export async function decodeTile(blob) {
  await decoder();
  let image;
  try {
    image = await decodeWebp(await blob.arrayBuffer());
  } catch {
    throw new Error('地形瓦片图像无法解码，请重试。');
  }
  if (image.width !== 512 || image.height !== 512) throw new Error('无法解码 512 像素地形瓦片');
  return { width: image.width, height: image.height, pixels: image.data };
}

/** The executor's environment on Node: terrain from `terrainUrl`, light pollution from the repository. */
export function nodeEnvironment(terrainUrl) {
  return {
    terrain: (points, signal, progress) => elevationTiles(points, terrainUrl, signal, progress, decodeTile),
    lightPollution: (place, signal) => sampleLightPollution(place, signal, async (file) => {
      const bytes = await readFile(join(ROOT, 'public', lightPollutionAtlas.directory, file));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }),
  };
}

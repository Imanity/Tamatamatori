import catalog from "../data/deep-sky.json" with { type: "json" };
import type { DeepSkyEntry } from "../domain/deep-sky.ts";

export function deepSkyImageUrl(catalogId: string) {
  const entry = catalog.objects.find(object => object.catalogId === catalogId);
  const name = (entry && "imageReference" in entry ? String(entry.imageReference) : catalogId).toLowerCase();
  return new URL(`../data/deep-sky/${name}.png`, import.meta.url);
}

export async function loadDeepSkyImage(
  signal: AbortSignal,
  maxSize: number,
  entry: DeepSkyEntry = catalog.objects[0] as DeepSkyEntry,
): Promise<ImageBitmap> {
  const response = await fetch(
    deepSkyImageUrl(entry.catalogId),
    { signal },
  );
  if (!response.ok) throw new Error(`Deep-sky atlas HTTP ${response.status}`);
  const { width, height } = entry.texture;
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const image = await createImageBitmap(await response.blob(), {
    resizeWidth: Math.max(1, Math.floor(width * scale)),
    resizeHeight: Math.max(1, Math.floor(height * scale)),
    resizeQuality: "high",
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  if (signal.aborted) {
    image.close();
    throw new DOMException("Aborted", "AbortError");
  }
  return image;
}

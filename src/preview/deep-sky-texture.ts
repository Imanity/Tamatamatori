import catalog from "../data/deep-sky.json" with { type: "json" };

export async function loadDeepSkyImage(
  signal: AbortSignal,
  maxSize: number,
): Promise<ImageBitmap> {
  const response = await fetch(
    new URL("../data/deep-sky-atlas.png", import.meta.url),
    { signal },
  );
  if (!response.ok) throw new Error(`Deep-sky atlas HTTP ${response.status}`);
  const { width, height } = catalog.atlas;
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

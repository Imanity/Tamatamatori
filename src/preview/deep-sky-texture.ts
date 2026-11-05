export async function loadDeepSkyImage(
  signal: AbortSignal,
  maxSize: number,
): Promise<ImageBitmap> {
  const response = await fetch(
    new URL("../data/deep-sky-atlas.png", import.meta.url),
    { signal },
  );
  if (!response.ok) throw new Error(`Deep-sky atlas HTTP ${response.status}`);
  const width = Math.min(4096, maxSize);
  const image = await createImageBitmap(await response.blob(), {
    resizeWidth: width,
    resizeHeight: width / 2,
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

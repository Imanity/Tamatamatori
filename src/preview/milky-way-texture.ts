/** Same-origin static asset; no request until the Milky Way is enabled. */
export async function loadMilkyWayImage(
  signal: AbortSignal,
  maxSize: number,
): Promise<ImageBitmap> {
  const response = await fetch(
    new URL("../data/milky-way.webp", import.meta.url),
    { signal },
  );
  if (!response.ok) throw new Error(`Milky Way image HTTP ${response.status}`);
  const width = Math.min(4096, maxSize);
  const image = await createImageBitmap(await response.blob(), {
    resizeWidth: width,
    resizeHeight: width / 8,
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

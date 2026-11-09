import { assertCatalogProgress, COMET_CATALOG_MAX_BYTES, validateCometCatalog } from "../domain/comet-catalog.ts";
import type { CometCatalog } from "../domain/comet-catalog.ts";

/** The published catalogue changes at most daily; a page re-checks it this often while comets are shown. */
export const COMET_PAGE_REFRESH_MS = 30 * 60 * 1000;

export async function loadCometCatalog(url: string, signal: AbortSignal, previous: CometCatalog | null, fetchImpl = fetch) {
  const response = await fetchImpl(url, { signal, cache: "no-cache", credentials: "same-origin" });
  if (!response.ok) throw new Error(`彗星目录 HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > COMET_CATALOG_MAX_BYTES) throw new Error("彗星目录超出大小限制");
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("彗星目录格式无效"); }
  const catalog = validateCometCatalog(parsed);
  // A stale copy from a cache must not replace a newer catalogue already shown.
  assertCatalogProgress(previous, catalog);
  return catalog;
}

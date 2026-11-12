/**
 * Where the published site lives. Links and `$schema` addresses are built from
 * the page's own location at run time (so a fork or a local build points to
 * itself); the generated format documents use the public address.
 */
export const PUBLIC_SITE = "https://imanity.github.io/Tamatamatori/";
export const SHOT_SCHEMA_FILE = "shot.schema.json";
export const SOLVE_SCHEMA_FILE = "solve.schema.json";

/** The running site's base URL, e.g. "https://imanity.github.io/Tamatamatori/" or "http://127.0.0.1:5173/". */
export function siteBase(location: { origin: string }, base = "/") {
  return new URL(base, location.origin).href;
}

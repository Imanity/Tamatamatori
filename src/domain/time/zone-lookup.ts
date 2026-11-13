import { Temporal } from "@js-temporal/polyfill";
import tzlookup from "@photostructure/tz-lookup";

/**
 * IANA time zone at a position, for the "local time zone" option. The lookup
 * is a lossy grid derived from timezone-boundary-builder: it may be wrong near
 * borders and offshore, and Xinjiang returns Asia/Urumqi (UTC+6). Returns null
 * for invalid coordinates or a zone the runtime does not know.
 */
export function localTimeZone(latitude: number, longitude: number): string | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90) return null;
  const wrapped = ((((longitude + 180) % 360) + 360) % 360) - 180;
  try {
    const zone = tzlookup(latitude, wrapped);
    return Temporal.Instant.from("2000-01-01T00:00:00Z").toZonedDateTimeISO(zone).timeZoneId;
  } catch {
    return null;
  }
}

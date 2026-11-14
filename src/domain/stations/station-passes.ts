// Visible passes of the space stations over a timeline span, with SGP4
// (satellite.js). Read with the station layer (docs/plan/lazy-loading.md);
// the timeline receives it as its `passes` input.
import { eciToEcf, ecfToLookAngles, gstime, jday, json2satrec, propagate, shadowFraction, sunPos } from "satellite.js";
import { sunPosition } from "../core/ephemeris.ts";
import { orbitEpoch, stationCatalog } from "./orbit-data.ts";
import type { OrbitSnapshot } from "./orbit-data.ts";
import type { EventPlan, TimelineWindow } from "../time/timeline.ts";

/**
 * Passes of each station above 10°, sunlit, while the Sun is below −6°;
 * minute steps. `covered` is false when no station has usable elements for
 * any minute of the span (published elements are used for 72 hours around
 * their epoch, as for the station markers).
 */
export function visiblePasses(plan: EventPlan, window: TimelineWindow, snapshot: OrbitSnapshot) {
  const start = Date.parse(window.start), end = Date.parse(window.end);
  const sun = new Map<number, number>();
  const sunAt = (time: number) => {
    // Sun elevation every 10 minutes, interpolated in between.
    const a = Math.floor((time - start) / 600_000) * 600_000 + start, b = a + 600_000;
    const value = (at: number) => {
      if (!sun.has(at)) sun.set(at, sunPosition({ latitude: plan.latitude, longitude: plan.longitude, instant: new Date(at).toISOString() }).elevation);
      return sun.get(at)!;
    };
    return value(a) + ((value(b) - value(a)) * (time - a)) / 600_000;
  };
  const observer = { latitude: (plan.latitude * Math.PI) / 180, longitude: (plan.longitude * Math.PI) / 180, height: plan.cameraHeight / 1000 };
  const passes: { station: (typeof stationCatalog)[number]; from: number; to: number; peak: number }[] = [];
  let covered = false;
  for (const station of stationCatalog) {
    const element = snapshot.objects.find((entry) => entry.NORAD_CAT_ID === station.noradId);
    if (!element) continue;
    let epoch: number, satellite;
    try {
      epoch = orbitEpoch(element.EPOCH);
      satellite = json2satrec(element);
    } catch {
      continue;
    }
    let current: { from: number; to: number; peak: number } | null = null;
    for (let time = start; time < end; time += 60_000) {
      let visible = false, elevation = -90;
      if (Math.abs(time - epoch) <= 72 * 3_600_000) {
        const date = new Date(time), state = propagate(satellite, date);
        if (state && state.position && !satellite.error) {
          covered = true;
          elevation = (ecfToLookAngles(observer, eciToEcf(state.position, gstime(date))).elevation * 180) / Math.PI;
          visible = elevation >= 10 && sunAt(time) < -6 && shadowFraction(sunPos(jday(date)).rsun, state.position) < 1;
        }
      }
      if (visible) {
        if (!current) current = { from: time, to: time, peak: elevation };
        current.to = time;
        current.peak = Math.max(current.peak, elevation);
      } else if (current) {
        passes.push({ station, ...current });
        current = null;
      }
    }
    if (current) passes.push({ station, ...current });
  }
  return { passes: passes.sort((a, b) => a.from - b.from), covered };
}

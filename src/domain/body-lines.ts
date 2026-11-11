import { Temporal } from "@js-temporal/polyfill";
import type { ShootingPlan } from "./plan.ts";
import { celestialBodies } from "./ephemeris.ts";
import { apparentElevation } from "./refraction.ts";
import { sunMoonEvents } from "./day-events.ts";
import { fixedHorizontal, fixedRiseSet, galacticCentre, timelineMode, timelineWindow } from "./timeline.ts";

export type LineBody = "sun" | "moon" | "core";
export interface BodyLine {
  body: LineBody;
  /** At the shooting instant, or the rise or set inside the timeline's span. */
  kind: "now" | "rise" | "set";
  azimuth: number;
  /** Above the horizon (apparent, with the plan's refraction) at that instant. */
  above: boolean;
  instant: string;
}

type LinePlan = Pick<ShootingPlan, "latitude" | "longitude" | "instant" | "timeZone" | "refraction" | "layers">;

/**
 * Azimuth lines for the map: Sun, Moon and Milky Way core at the shooting
 * instant, plus their rises and sets inside the same span as the timeline.
 * Each body follows its layer switch (the core follows the Milky Way).
 */
export function bodyLines(plan: LinePlan): BodyLine[] {
  const lines: BodyLine[] = [];
  const at = (instant: string) => celestialBodies({ latitude: plan.latitude, longitude: plan.longitude, instant });
  const now = at(plan.instant);
  for (const body of ["sun", "moon"] as const) {
    if (!plan.layers[body]) continue;
    const position = now[body];
    lines.push({ body, kind: "now", azimuth: position.azimuth, above: apparentElevation(position.elevation, plan.refraction) > 0, instant: plan.instant });
  }
  const window = timelineWindow(plan.instant, plan.timeZone, timelineMode(plan.layers));
  if (plan.layers.sun || plan.layers.moon)
    for (const event of sunMoonEvents(plan, Temporal.Instant.from(window.start), Temporal.Instant.from(window.end))) {
      const body = event.id.startsWith("sun") ? "sun" : event.id.startsWith("moon") ? "moon" : null;
      if (!body || !plan.layers[body] || !event.instant) continue;
      lines.push({ body, kind: event.id.endsWith("rise") ? "rise" : "set", azimuth: at(event.instant)[body].azimuth, above: true, instant: event.instant });
    }
  if (plan.layers.milkyWay) {
    const core = fixedHorizontal(plan, galacticCentre.ra, galacticCentre.dec, plan.instant);
    lines.push({ body: "core", kind: "now", azimuth: core.azimuth, above: apparentElevation(core.altitude, plan.refraction) > 0, instant: plan.instant });
    for (const { direction, time } of fixedRiseSet(plan, window, galacticCentre.ra, galacticCentre.dec)) {
      const instant = Temporal.Instant.fromEpochMilliseconds(Math.round(time / 1000) * 1000).toString();
      lines.push({ body: "core", kind: direction === 1 ? "rise" : "set", azimuth: fixedHorizontal(plan, galacticCentre.ra, galacticCentre.dec, instant).azimuth, above: true, instant });
    }
  }
  return lines;
}

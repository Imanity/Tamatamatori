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

export interface LineLabel {
  /** Where it sits: the end of a shooting-instant line, or of a rise or set line. */
  ring: "now" | "event";
  azimuth: number;
  text: string;
  /** The body named, or null when labels of several bodies were merged. */
  body: LineBody | null;
}
const nowNames: Record<LineBody, string> = { sun: "太阳", moon: "月亮", core: "银心" };
const eventNames: Record<LineBody, Record<"rise" | "set", string>> = {
  sun: { rise: "日出", set: "日落" },
  moon: { rise: "月出", set: "月落" },
  core: { rise: "银心升起", set: "银心落下" },
};
/** Labels at the same ring closer than this (degrees of azimuth) are merged into one. */
export const LABEL_MERGE_ANGLE = 12;

/**
 * Names for the map's lines: the body at the shooting instant (noting when it
 * is below the horizon) and its rises and sets with the local time. Labels
 * that would sit on top of each other are merged, in the lines' order.
 */
export function lineLabels(lines: readonly BodyLine[], timeZone: string): LineLabel[] {
  const labels: LineLabel[] = [];
  for (const line of lines) {
    const text = line.kind === "now"
      ? `${nowNames[line.body]}${line.above ? "" : " · 地平线下"}`
      : `${eventNames[line.body][line.kind]} ${Temporal.Instant.from(line.instant).toZonedDateTimeISO(timeZone).toPlainTime().toString({ smallestUnit: "minute" })}`;
    const ring = line.kind === "now" ? "now" : "event";
    const near = labels.find((label) => label.ring === ring && Math.abs(((line.azimuth - label.azimuth + 540) % 360) - 180) <= LABEL_MERGE_ANGLE);
    if (near) {
      near.text = `${near.text} · ${text}`;
      if (near.body !== line.body) near.body = null;
    } else labels.push({ ring, azimuth: line.azimuth, text, body: line.body });
  }
  return labels;
}

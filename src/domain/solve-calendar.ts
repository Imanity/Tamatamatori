import { skyConditionNames } from "./alignment.ts";
import type { Alignment, AlignmentBody } from "./alignment.ts";
import { localDateTime } from "./plan.ts";
import type { ShootingPlan } from "./plan.ts";
import { pointPlan } from "./position-alignment.ts";
import type { PositionPoint } from "./position-alignment.ts";
import { mergeCandidates } from "./range-alignment.ts";
import type { RangeCandidate } from "./range-alignment.ts";
import { SHOT_NAME_LIMIT, shotFromPlan, shotLink } from "./shot.ts";
import { bodyLayer, bodyName, sizeWord } from "./sky-targets.ts";

/**
 * 推算 results as an iCalendar file (RFC 5545): one event per result, in UTC,
 * each with the camera position and a `#shot=` link that opens it.
 */
export const CALENDAR_LIMIT = 200;

export interface CalendarEvent {
  uid: string;
  start: number;
  end: number;
  summary: string;
  description: string;
  location?: { latitude: number; longitude: number };
  url?: string;
}

const escapeText = (text: string) => text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (time: number) => new Date(Math.round(time / 1000) * 1000).toISOString().replace(/[-:]/g, "").replace(".000", "");
const encoder = new TextEncoder();

/** Content lines longer than 75 octets continue on lines starting with one space; characters are never split. */
export function foldLine(line: string) {
  const parts: string[] = [];
  let current = "", size = 0;
  for (const character of line) {
    const bytes = encoder.encode(character).length;
    const limit = parts.length ? 74 : 75;
    if (size + bytes > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += character;
    size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

export function calendarText(events: readonly CalendarEvent[], name: string, now = Date.now()) {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tamatamatori//Solve//ZH", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(name)}`,
  ];
  for (const event of events.slice(0, CALENDAR_LIMIT)) {
    lines.push("BEGIN:VEVENT", `UID:${event.uid}`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(event.start)}`,
      // A one-minute result still occupies a minute in the calendar.
      `DTEND:${stamp(Math.max(event.end, event.start + 60_000))}`,
      `SUMMARY:${escapeText(event.summary)}`, `DESCRIPTION:${escapeText(event.description)}`);
    if (event.location) {
      const { latitude, longitude } = event.location;
      lines.push(`LOCATION:${escapeText(`${latitude.toFixed(6)}, ${longitude.toFixed(6)}`)}`, `GEO:${latitude.toFixed(6)};${longitude.toFixed(6)}`);
    }
    if (event.url) lines.push(`URL:${event.url}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

/** "目标或地点 · 天体 月-日 时:分", within the shot name limit. */
export function solveShotName(place: string, body: AlignmentBody, instant: string, timeZone: string) {
  const local = localDateTime(instant, timeZone);
  return [...`${place} · ${bodyName(body)} ${local.slice(5, 10)} ${local.slice(11, 16)}`].slice(0, SHOT_NAME_LIMIT).join("");
}

export interface CalendarContext {
  plan: ShootingPlan;
  body: AlignmentBody;
  /** The target's name, or the camera's place for 找时间. */
  place: string;
  /** Site base for the `#shot=` links. */
  site: string;
}
const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
const km = (meters: number) => (meters / 1000).toFixed(meters < 10_000 ? 2 : 1);
const clock = (time: number, timeZone: string) => localDateTime(new Date(time).toISOString(), timeZone).slice(11, 16);
const sightNames = { clear: "通视", blocked: "被 DEM 挡住", unknown: "高程不全" } as const;
const footer = "Tamatamatori 推算：基于星历与地形的构图模拟，不含天气，不代表实景一定可见。";
function linkFor(context: CalendarContext, patch: Partial<ShootingPlan>) {
  const plan = { ...context.plan, ...patch };
  return shotLink(shotFromPlan(plan, solveShotName(context.place, context.body, plan.instant, plan.timeZone)), context.site);
}

/** 找时间: each alignment, over its span within the tolerance. */
export function timeEvents(alignments: readonly Alignment[], context: CalendarContext): CalendarEvent[] {
  const { plan, body } = context, name = bodyName(body);
  return alignments.map((found, index) => {
    const url = linkFor(context, { instant: found.instant, layers: { ...plan.layers, [bodyLayer(body)]: true } });
    const ratio = found.separation / found.diameter;
    return {
      uid: `time-${stamp(Date.parse(found.instant))}-${index}@tamatamatori`,
      start: Date.parse(found.from), end: Date.parse(found.to),
      summary: `${name}对齐 · ${context.place}`,
      description: [
        `${clock(Date.parse(found.instant), plan.timeZone)}（${plan.timeZone}）${name}中心${ratio < 0.02 ? "几乎居中" : `偏离期望位置 ${ratio.toFixed(2)} 个${sizeWord(body)}（${found.offset}）`}`,
        `天空：${skyConditionNames[found.sky]}${found.illuminated === null ? "" : `，亮面 ${percent(found.illuminated)}`}`,
        `机位：${plan.latitude.toFixed(6)}, ${plan.longitude.toFixed(6)}，离地 ${plan.cameraHeight} m`,
        `打开机位：${url}`, footer,
      ].join("\n"),
      location: { latitude: plan.latitude, longitude: plan.longitude },
      url,
    };
  });
}

/** 找机位: each alignment line (nearly coincident lines once), placed at its middle minute. */
export function positionEvents(points: readonly PositionPoint[], context: CalendarContext): CalendarEvent[] {
  const branches = new Map<number, PositionPoint[]>();
  for (const point of points) branches.set(point.branch, [...(branches.get(point.branch) ?? []), point]);
  const segments = [...branches.values()].map((run) => ({
    points: run, start: run[0].time, end: run.at(-1)!.time, middle: run[Math.floor(run.length / 2)],
    clear: run.filter((point) => point.sight === "clear").length / run.length,
  }));
  return mergeCandidates(segments).candidates.map((segment, index) => {
    const { middle } = segment, name = bodyName(context.body);
    const url = linkFor(context, pointPlan(context.plan.layers, middle, context.body));
    const distances = segment.points.map((point) => point.distance);
    return {
      uid: `position-${stamp(segment.start)}-${index}@tamatamatori`,
      start: segment.start, end: segment.end,
      summary: `${name}对齐线 · ${context.place}`,
      description: [
        `机位沿对齐线随时间移动，距目标 ${km(Math.min(...distances))}—${km(Math.max(...distances))} km；通视 ${percent(segment.clear)}（按 DEM）`,
        `链接为 ${clock(middle.time, context.plan.timeZone)} 的机位，距目标 ${km(middle.distance)} km，${sightNames[middle.sight]}`,
        `打开机位：${url}`, footer,
      ].join("\n"),
      location: { latitude: middle.latitude, longitude: middle.longitude },
      url,
    };
  });
}

/** 两者都找: each candidate, placed at its middle minute. */
export function rangeEvents(candidates: readonly RangeCandidate[], context: CalendarContext): CalendarEvent[] {
  const name = bodyName(context.body);
  return candidates.map((candidate, index) => {
    const { middle } = candidate;
    const url = linkFor(context, pointPlan(context.plan.layers, middle, context.body));
    const share = candidate.share ? `，主体占画面 ${percent(candidate.share[0])}—${percent(candidate.share[1])}` : "";
    return {
      uid: `range-${stamp(candidate.start)}-${index}@tamatamatori`,
      start: candidate.start, end: candidate.end,
      summary: `${name} · ${context.place}`,
      description: [
        `距目标 ${km(candidate.near)}—${km(candidate.far)} km${share}`,
        `天空：${skyConditionNames[candidate.sky]}${candidate.illuminated === null ? "" : `，亮面 ${percent(candidate.illuminated)}`}；通视 ${percent(candidate.clear)}（按 DEM）`,
        `链接为 ${clock(middle.time, context.plan.timeZone)} 的机位：${middle.latitude.toFixed(6)}, ${middle.longitude.toFixed(6)}`,
        `打开机位：${url}`, footer,
      ].join("\n"),
      location: { latitude: middle.latitude, longitude: middle.longitude },
      url,
    };
  });
}

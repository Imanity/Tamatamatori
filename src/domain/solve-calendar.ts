import { skyConditionNames } from "./alignment.ts";
import type { Alignment, AlignmentBody, FramePoint } from "./alignment.ts";
import { localDateTime } from "./plan.ts";
import type { ShootingPlan } from "./plan.ts";
import { pointPlan } from "./position-alignment.ts";
import type { PositionPoint } from "./position-alignment.ts";
import type { Candidate, RangeCandidate } from "./range-alignment.ts";
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
  /** 找机位 / 两者都找: where the target sits in the frame (the centre when absent). */
  frame?: FramePoint;
}
const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
const km = (meters: number) => (meters / 1000).toFixed(meters < 10_000 ? 2 : 1);
const clock = (time: number, timeZone: string) => localDateTime(new Date(time).toISOString(), timeZone).slice(11, 16);
const footer = "Tamatamatori 推算：基于星历与地形的构图模拟，不含天气，不代表实景一定可见。";
const framed = (context: CalendarContext, point: PositionPoint) =>
  pointPlan(context.plan.layers, point, context.body, context.frame ? { frame: context.frame, lens: context.plan } : undefined);
const terrainNote = (clear: number) => (clear < 1 ? `；${percent(1 - clear)}的分钟地形数据不全` : "");
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

/** 找机位: each listed stretch of an alignment line (sight not cut by the terrain), placed at its middle minute. */
export function positionEvents(candidates: readonly Candidate<PositionPoint>[], context: CalendarContext): CalendarEvent[] {
  return candidates.map((candidate, index) => {
    const { middle } = candidate, name = bodyName(context.body);
    const url = linkFor(context, framed(context, middle));
    return {
      uid: `position-${stamp(candidate.start)}-${index}@tamatamatori`,
      start: candidate.start, end: candidate.end,
      summary: `${name}对齐 · ${context.place}`,
      description: [
        `机位沿对齐线随时间移动，距目标 ${km(candidate.near)}—${km(candidate.far)} km；视线未被地形挡住${terrainNote(candidate.clear)}`,
        `天空：${skyConditionNames[candidate.sky]}${candidate.illuminated === null ? "" : `，亮面 ${percent(candidate.illuminated)}`}`,
        `链接为 ${clock(middle.time, context.plan.timeZone)} 的机位，距目标 ${km(middle.distance)} km`,
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
    const url = linkFor(context, framed(context, middle));
    const share = candidate.share ? `，主体占画面 ${percent(candidate.share[0])}—${percent(candidate.share[1])}` : "";
    return {
      uid: `range-${stamp(candidate.start)}-${index}@tamatamatori`,
      start: candidate.start, end: candidate.end,
      summary: `${name} · ${context.place}`,
      description: [
        `距目标 ${km(candidate.near)}—${km(candidate.far)} km${share}`,
        `天空：${skyConditionNames[candidate.sky]}${candidate.illuminated === null ? "" : `，亮面 ${percent(candidate.illuminated)}`}；视线未被地形挡住${terrainNote(candidate.clear)}`,
        `链接为 ${clock(middle.time, context.plan.timeZone)} 的机位：${middle.latitude.toFixed(6)}, ${middle.longitude.toFixed(6)}`,
        `打开机位：${url}`, footer,
      ].join("\n"),
      location: { latitude: middle.latitude, longitude: middle.longitude },
      url,
    };
  });
}

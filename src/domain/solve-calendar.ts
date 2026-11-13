import { skyConditionNames } from "./alignment.ts";
import type { AlignmentBody } from "./alignment.ts";
import { localDateTime } from "./plan.ts";
import type { ShootingPlan } from "./plan.ts";
import { tryPatch } from "./composition.ts";
import type { ResultItem, SearchBasis } from "./composition.ts";
import { SHOT_NAME_LIMIT, shotFromPlan, shotLink } from "./shot.ts";
import { bodyName } from "./sky-targets.ts";

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
const footer = "Tamatamatori 推算：基于星历与地形的构图模拟，不含天气，不代表实景一定可见。";
const terrainNote = (clear: number) => (clear < 1 ? `；${percent(1 - clear)}的分钟地形数据不全` : "");
function linkFor(context: CalendarContext, patch: Partial<ShootingPlan>) {
  const plan = { ...context.plan, ...patch };
  return shotLink(shotFromPlan(plan, solveShotName(context.place, context.body, plan.instant, plan.timeZone)), context.site);
}

/** 构图约束搜索: one event per result row, linked to its try-out. */
export function resultEvents(items: readonly ResultItem[], context: CalendarContext & { basis: SearchBasis; names: string }): CalendarEvent[] {
  return items.map((item, index) => {
    const patch = tryPatch(item, context.basis, context.plan.layers);
    const url = linkFor(context, patch);
    const span = item.start === item.end ? clock(item.start, context.plan.timeZone) : `${clock(item.start, context.plan.timeZone)}–${clock(item.end, context.plan.timeZone)}`;
    return {
      uid: `result-${stamp(item.start)}-${index}@tamatamatori`,
      start: item.start, end: item.end,
      summary: `${context.names} · ${context.place}`,
      description: [
        `${span}（${context.plan.timeZone}）${item.points ? "机位沿线随时间移动" : "机位固定"}；最大偏差 ${(item.deviation * 100).toFixed(1)}% 画面高`,
        ...(item.near !== null && item.far !== null ? [`距地面目标 ${km(item.near)}—${km(item.far)} km${terrainNote(item.clear)}`] : []),
        `天空：${skyConditionNames[item.sky]}；月亮${item.moonElevation < 0 ? "在地平线下" : `高 ${item.moonElevation.toFixed(0)}°，亮面 ${percent(item.moonLit)}`}`,
        `链接为 ${clock(item.best, context.plan.timeZone)} 的机位：${item.camera.latitude.toFixed(6)}, ${item.camera.longitude.toFixed(6)}`,
        `打开机位：${url}`, footer,
      ].join("\n"),
      location: { latitude: item.camera.latitude, longitude: item.camera.longitude },
      url,
    };
  });
}

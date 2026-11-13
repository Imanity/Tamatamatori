// Number, time and date wording shared by the 推算 panel, its results and the map.
import { Temporal } from "@js-temporal/polyfill";
import { localDateTime } from "../../domain/core/plan";

export const MINUTE = 60_000;
export const iso = (time: number) => new Date(time).toISOString().replace(".000Z", "Z");
export const clock = (time: number, timeZone: string) => localDateTime(iso(time), timeZone).slice(11, 16);
export const km = (meters: number) => (meters / 1000).toFixed(meters < 10_000 ? 2 : 1);
export const percent = (value: number) => `${Math.round(value * 100)}%`;
const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
/** "11/13 周五", with the year when it is not `year` (a search crossing into another year). */
export function dayWords(day: string, year?: number) {
  const date = Temporal.PlainDate.from(day);
  return `${year !== undefined && date.year !== year ? `${date.year}/` : ""}${date.month}/${date.day} ${weekdays[date.dayOfWeek - 1]}`;
}
export const localDay = (time: number, timeZone: string) => localDateTime(iso(time), timeZone).slice(0, 10);

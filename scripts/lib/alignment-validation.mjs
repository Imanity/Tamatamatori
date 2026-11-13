// Pure helpers shared by scripts/alignment-validation.mjs (online) and
// tests/solve/alignment-validation.test.mjs (offline recomputation).
import { solveAlignment } from '../../src/domain/alignment.ts';
import { instantFromLocal, localDateTime } from '../../src/domain/plan.ts';

export const ZONE = 'Asia/Tokyo';
export const DAY = 86_400_000;
export const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
export const minute = (date, time) => Date.parse(instantFromLocal(`${date}T${time}`, ZONE));
export const dayStart = (date) => Date.parse(instantFromLocal(`${date}T00:00`, ZONE));
export const local = (time) => localDateTime(new Date(time).toISOString(), ZONE);
export const afternoon = (instant) => Number(local(Date.parse(instant)).slice(11, 13)) >= 12;

/** Passes of the Sun's centre by the mark (the app's 找时间 solver, standard refraction), as separations in diameters. */
export function passesOf(observer, mark, from, to, tolerance) {
  return solveAlignment({
    latitude: observer.latitude, longitude: observer.longitude, refraction: 'standard',
    target: { body: 'sun', azimuth: mark.azimuth, elevation: mark.elevation }, tolerance,
  }, from, to).alignments.map((found) => ({ instant: found.instant, ratio: found.separation / found.diameter, offset: found.offset }));
}

/** Seasons of a year's passes (gaps over 20 days): the best day and the days within 0.25 and 0.5 diameters. */
export function seasons(passes) {
  const groups = [];
  for (const pass of passes) {
    const last = groups.at(-1);
    if (last && Date.parse(pass.instant) - Date.parse(last.at(-1).instant) < 20 * DAY) last.push(pass);
    else groups.push([pass]);
  }
  return groups.map((group) => {
    const best = group.reduce((a, b) => (b.ratio < a.ratio ? b : a));
    const days = (limit) => [...new Set(group.filter((pass) => pass.ratio <= limit).map((pass) => local(Date.parse(pass.instant)).slice(0, 10)))];
    return { best: local(Date.parse(best.instant)), bestRatio: round(best.ratio, 3), quarter: days(0.25), half: days(0.5) };
  });
}

export const dayNumber = (date) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY);
/** Days from a month-day range (no year) to a date: 0 inside, negative before, positive after; the nearest year's range counts. */
export function daysFrom(range, date) {
  const year = Number(date.slice(0, 4)), value = dayNumber(date);
  let nearest = null;
  for (const offset of [-1, 0, 1]) {
    const [from, to] = range.map((day) => dayNumber(`${year + offset}-${day}`));
    const days = value < from ? value - from : value > to ? value - to : 0;
    if (nearest === null || Math.abs(days) < Math.abs(nearest)) nearest = days;
  }
  return nearest;
}
/** The schedule's range nearest to a date, and the days from it. */
export function nearestRange(ranges, date) {
  return ranges.map((range) => ({ range, days: daysFrom(range, date) }))
    .reduce((a, b) => (Math.abs(b.days) < Math.abs(a.days) ? b : a));
}

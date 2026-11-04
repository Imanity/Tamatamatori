import { Temporal } from "@js-temporal/polyfill";
import type { ShootingPlan } from "./plan.ts";

const radians = Math.PI / 180;
const wrap = (value: number, period: number) => ((value % period) + period) % period;

/** NOAA/Meeus approximation; geometric solar centre, without refraction or terrain masking.
 * https://gml.noaa.gov/grad/solcalc/main.js
 * Azimuth is clockwise from true north; elevation is relative to the ideal horizon.
 */
export function solarPosition(
  plan: Pick<ShootingPlan, "latitude" | "longitude" | "instant">,
) {
  if (
    !Number.isFinite(plan.latitude) || Math.abs(plan.latitude) > 90 ||
    !Number.isFinite(plan.longitude) || Math.abs(plan.longitude) > 180
  ) throw new RangeError("太阳位置需要有效的经纬度");
  const timestamp = Temporal.Instant.from(plan.instant).epochMilliseconds;
  // Valid local dates at the ends of the UI's range can cross a UTC year.
  if (timestamp < Date.UTC(1900, 0, 1) - 14 * 3600000 || timestamp >= Date.UTC(2101, 0, 1) + 12 * 3600000)
    throw new RangeError("太阳模型支持 1900—2100 年的当地日期");
  const century = (timestamp / 86400000 + 2440587.5 - 2451545) / 36525;
  const meanLongitude = wrap(280.46646 + century * (36000.76983 + century * 0.0003032), 360) * radians;
  const anomaly = (357.52911 + century * (35999.05029 - 0.0001537 * century)) * radians;
  const eccentricity = 0.016708634 - century * (0.000042037 + 0.0000001267 * century);
  const centre = Math.sin(anomaly) * (1.914602 - century * (0.004817 + 0.000014 * century))
    + Math.sin(2 * anomaly) * (0.019993 - 0.000101 * century)
    + Math.sin(3 * anomaly) * 0.000289;
  const omega = (125.04 - 1934.136 * century) * radians;
  const longitude = meanLongitude + (centre - 0.00569 - 0.00478 * Math.sin(omega)) * radians;
  const obliquity = (23 + (26 + (21.448 - century * (46.815 + century * (0.00059 - century * 0.001813))) / 60) / 60
    + 0.00256 * Math.cos(omega)) * radians;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(longitude));
  const y = Math.tan(obliquity / 2) ** 2;
  const equationOfTime = (y * Math.sin(2 * meanLongitude) - 2 * eccentricity * Math.sin(anomaly)
    + 4 * eccentricity * y * Math.sin(anomaly) * Math.cos(2 * meanLongitude)
    - 0.5 * y * y * Math.sin(4 * meanLongitude) - 1.25 * eccentricity ** 2 * Math.sin(2 * anomaly)) * 4 / radians;
  const utcMinutes = wrap(timestamp, 86400000) / 60000;
  const hourAngle = (wrap(utcMinutes + equationOfTime + 4 * plan.longitude, 1440) / 4 - 180) * radians;
  const latitude = plan.latitude * radians;
  const sineElevation = Math.sin(latitude) * Math.sin(declination)
    + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sineElevation))) / radians;
  const azimuth = wrap(Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(latitude) - Math.tan(declination) * Math.cos(latitude),
  ) / radians + 180, 360);
  return { elevation, azimuth };
}

export function daylightPhase(elevation: number) {
  if (elevation < -18) return "夜间";
  if (elevation < -12) return "天文暮光";
  if (elevation < -6) return "航海暮光";
  if (elevation < 0) return "民用暮光";
  if (elevation < 6) return "低角度日照";
  return "白昼";
}

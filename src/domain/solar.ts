// Keep the environment and rendered Sun on the same topocentric ephemeris.
export { sunPosition as solarPosition } from "./ephemeris.ts";

export function daylightPhase(elevation: number) {
  if (elevation < -18) return "夜间";
  if (elevation < -12) return "天文暮光";
  if (elevation < -6) return "航海暮光";
  if (elevation < 0) return "民用暮光";
  if (elevation < 6) return "低角度日照";
  return "白昼";
}

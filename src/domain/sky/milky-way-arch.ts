// The Milky Way arch and where to aim for it (docs/plan/review.md §6).
// The galactic equator is a great circle, so its part above the horizon spans
// two opposite azimuths and peaks in the vertical plane through the galactic
// pole. The shooting centre faces that peak at half its height, so the horizon
// and the top of the arch sit evenly above and below the middle of the frame.
import { RotateVector, Rotation_GAL_EQJ, Vector } from "astronomy-engine";
import type { ShootingPlan } from "../core/plan.ts";
import { degrees } from "../core/ephemeris.ts";
import { apparentElevation } from "../core/refraction.ts";
import { skyFrame } from "./sky-frame.ts";

/** Below this peak height the band lies along the horizon and there is no arch to frame. */
export const ARCH_MIN_ELEVATION = 10;

export interface MilkyWayArch {
  /** Highest point of the galactic equator, apparent (with the plan's refraction). */
  apex: { azimuth: number; elevation: number };
  /** Azimuths where the arch meets the horizon: 90° either side of the apex. */
  ends: [number, number];
  /** Camera direction for the whole arch: the apex azimuth, half the apex height. */
  center: { azimuth: number; pitch: number };
  /** The band lies along the horizon (apex below ARCH_MIN_ELEVATION). */
  flat: boolean;
}

const wrap = (azimuth: number) => ((azimuth % 360) + 360) % 360;

export function milkyWayArch(
  plan: Pick<ShootingPlan, "latitude" | "longitude" | "instant" | "refraction">,
): MilkyWayArch {
  const sky = skyFrame(plan);
  const pole = RotateVector(Rotation_GAL_EQJ(), new Vector(0, 0, 1, sky.time));
  const n = sky.horizontal([pole.x, pole.y, pole.z]);
  // The circle peaks 90° from the pole, in the vertical plane through it: on
  // the side away from the pole when the pole is up. With the pole at the
  // zenith the band lies on the horizon; with the pole on the horizon the band
  // passes through the zenith and either side is the same.
  const poleHeight = Math.asin(Math.max(-1, Math.min(1, n[2]))) / degrees;
  const poleAzimuth = Math.hypot(n[0], n[1]) < 1e-12 ? 0 : Math.atan2(n[0], n[1]) / degrees;
  const azimuth = wrap(poleHeight > 0 ? poleAzimuth + 180 : poleAzimuth);
  const elevation = apparentElevation(90 - Math.abs(poleHeight), plan.refraction);
  return {
    apex: { azimuth, elevation },
    ends: [wrap(azimuth - 90), wrap(azimuth + 90)],
    center: { azimuth, pitch: elevation / 2 },
    flat: elevation < ARCH_MIN_ELEVATION,
  };
}

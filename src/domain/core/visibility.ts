import type { ShootingPlan } from "./plan.ts";
import { sensorKey } from "./plan.ts";

export type Occlusion = "waiting" | "clear" | "partial" | "blocked" | "subpixel" | "error";
export interface VisibilitySnapshot {
  planKey: string;
  states: Record<"sun" | "moon", Occlusion>;
  message?: string;
  labelKey?: string;
  labelStates?: Partial<Record<"sun" | "moon", Occlusion>>;
}
export const emptyVisibility: VisibilitySnapshot = { planKey: "", states: { sun: "waiting", moon: "waiting" } };

export function celestialPlanKey(plan: ShootingPlan) {
  return [plan.longitude, plan.latitude, plan.instant, plan.azimuth, plan.pitch, plan.focalLength,
    sensorKey(plan), plan.aspectRatio, plan.orientation, plan.cameraHeight, plan.refraction,
    plan.layers.sun, plan.layers.moon, !!plan.layers.stars, !!plan.layers.milkyWay, !!plan.layers.constellations, !!plan.layers.deepSky, !!plan.layers.stations, !!plan.layers.buildings,
    !!plan.layers.meteors, !!plan.layers.meteorDensity, !!plan.layers.comets].join("/");
}

// Turning or zooming the camera does not move a target relative to a mountain.
// Labels can retain confirmed direction tests while the new viewport is probed.
export function skyLabelKey(plan: ShootingPlan) {
  return [plan.longitude, plan.latitude, plan.instant, plan.cameraHeight, plan.refraction,
    !!plan.layers.sun, !!plan.layers.moon, !!plan.layers.stars, !!plan.layers.milkyWay, !!plan.layers.constellations,
    !!plan.layers.deepSky, !!plan.layers.stations, !!plan.layers.buildings,
    !!plan.layers.meteors, !!plan.layers.meteorDensity, !!plan.layers.comets].join("/");
}

export function classifyOcclusion(clear: boolean, blocked: boolean): Occlusion {
  return clear ? (blocked ? "partial" : "clear") : blocked ? "blocked" : "subpixel";
}

export const occlusionLabels: Record<Occlusion, string> = {
  waiting: "遮挡待测", clear: "未被地形遮挡", partial: "部分山体遮挡",
  blocked: "山体遮挡", subpixel: "像素不足", error: "遮挡未知",
};

export function occlusionText(state: Occlusion, plan: ShootingPlan) {
  if(!plan.layers.buildings)return occlusionLabels[state];
  return ({clear:"已载场景未遮挡",partial:"部分场景遮挡",blocked:"场景遮挡"} as Partial<Record<Occlusion,string>>)[state]??occlusionLabels[state];
}

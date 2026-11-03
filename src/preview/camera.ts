import { LngLat, MercatorCoordinate } from "maplibre-gl";
import type { ShootingPlan } from "../domain/plan.ts";
import { fieldOfView } from "../domain/plan.ts";
import { isMapPosition } from "../domain/map.ts";

export function terrainCamera(plan: ShootingPlan, ground: number) {
  if (
    !isMapPosition(plan) ||
    !Number.isFinite(ground) ||
    !Number.isFinite(plan.cameraHeight) ||
    plan.cameraHeight <= 0
  )
    throw new RangeError("需要有效地形和大于 0 的相机离地高度");
  const altitude = ground + plan.cameraHeight;
  const eye = MercatorCoordinate.fromLngLat(
    [plan.longitude, plan.latitude],
    altitude,
  );
  const scale = eye.meterInMercatorCoordinateUnits() * 20;
  const heading = (plan.azimuth * Math.PI) / 180,
    pitch = (plan.pitch * Math.PI) / 180;
  const target = new MercatorCoordinate(
    eye.x + Math.sin(heading) * Math.cos(pitch) * scale,
    eye.y - Math.cos(heading) * Math.cos(pitch) * scale,
    eye.z + Math.sin(pitch) * scale,
  );
  const targetPoint = target.toLngLat();
  return {
    eye: new LngLat(plan.longitude, plan.latitude),
    altitude,
    target: targetPoint,
    targetAltitude: target.toAltitude(),
    bearing: plan.azimuth,
    pitch: 90 + plan.pitch,
    verticalFov: fieldOfView(plan).vertical,
  };
}

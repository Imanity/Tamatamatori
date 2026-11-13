import { LngLat, MercatorCoordinate } from "maplibre-gl";
import type { ShootingPlan } from "../../domain/core/plan.ts";
import { fieldOfView } from "../../domain/core/plan.ts";
import { isMapPosition } from "../../domain/core/map.ts";

export const terrainRenderOptions = {
  maxZoom: 32,
  // Photographic FOV needs a high virtual zoom at a fixed eye point. Keep
  // vector tile IDs at the source's native limit instead of splitting towards
  // maxZoom - 4, which can exceed MapLibre's canonical tile limit (z25).
  zoomLevelsToOverscale: 32,
};

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
  // At exactly horizontal pitch the SDK's terrain LOD heuristic can divide
  // 0 by 0 for the tile containing the eye and recurse beyond its tile limit.
  // Stay within 1e-7 degree of the requested horizon, below calibration tolerance.
  const renderPitch = Math.abs(plan.pitch) < 1e-7
    ? (plan.pitch < 0 ? -1e-7 : 1e-7)
    : plan.pitch;
  const heading = (plan.azimuth * Math.PI) / 180,
    pitch = (renderPitch * Math.PI) / 180;
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
    pitch: 90 + renderPitch,
    verticalFov: fieldOfView(plan).vertical,
  };
}

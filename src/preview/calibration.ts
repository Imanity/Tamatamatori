import { MercatorCoordinate } from "maplibre-gl";
import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";
import type { ShootingPlan } from "../domain/plan.ts";
import { groundElevation } from "./elevation.ts";
import { compareEarthModels, matrixPixel, mercatorMeter, mercatorXY, referencePixel } from "./calibration-math.ts";
import { matrixEye } from "./rendered-camera.ts";
import { TERRAIN_CELL_PIXELS, TERRAIN_MAX_MESH_ZOOM } from "./terrain-detail.ts";

export const calibrationTarget = {
  name: "富士山剣ヶ峰参考点", longitude: 138.7275, latitude: 35.36083333333333, altitude: 3776,
  source: "https://www.data.jma.go.jp/vois/data/tokyo/314_Fujisan/314_index.html",
};
type Pixel = { x: number; y: number } | null;
export interface CalibrationSnapshot {
  ready: boolean;
  width: number; height: number;
  plan: ShootingPlan;
  ground: number;
  eye: { longitude: number; latitude: number; altitude: number; horizontalError: number; altitudeError: number; heightAboveDem: number; pitch: number; bearing: number };
  target: typeof calibrationTarget & { independentDem: number | null; renderedDem: number | null; demLevels: Record<number, number>; error: string };
  detail: { cellPixels: number; viewportHeight: number; maxMeshZoom: number };
  curvature: {
    heightAssumption: string;
    dem: ReturnType<typeof compareEarthModels> | null;
    published: ReturnType<typeof compareEarthModels>;
    gpuResidual: number | null;
    gpuRay: number[] | null;
  };
  pixels: { sdkDem: Pixel; matrixDem: Pixel; requestedDem: Pixel; actualDem: Pixel; publishedPlanar: Pixel; publishedSpherical: Pixel; demEllipsoidal: Pixel; gpuDem: Pixel };
}

/** Development-only instrument; no private SDK fields. Optional GPU probe restores GL state. */
export function calibrationLayer(map: MapLibreMap, current: () => { plan: ShootingPlan; ground: number | null }, url: string, report: (snapshot: CalibrationSnapshot) => void,
  probe?: (point: {latitude:number;longitude:number;altitude:number},width:number,height:number) => {x:number;y:number;ray:number[]}|null): CustomLayerInterface {
  const controller = new AbortController();
  let dem: number | null = null, error = "", previous = "";
  const demLevels: Record<number, number> = {};
  return {
    id: "preview-camera-calibration", type: "custom", renderingMode: "3d",
    onAdd() {
      for (const zoom of [9, 10, 11, 12]) void groundElevation(calibrationTarget, url, controller.signal, zoom).then((result) => {
        if (!controller.signal.aborted) {
          demLevels[zoom] = result.height;
          if (zoom === 12) dem = result.height;
          map.triggerRepaint();
        }
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) { error = String(reason); map.triggerRepaint(); }
      });
    },
    render(_gl, input) {
      const { plan, ground } = current(), host = map.getContainer();
      if (ground === null || !host.clientWidth || !host.clientHeight) return;
      const width = host.clientWidth, height = host.clientHeight, worldSize = 512 * 2 ** map.getZoom();
      const point = matrixEye(input.modelViewProjectionMatrix);
      const location = new MercatorCoordinate(point.x / worldSize, point.y / worldSize).toLngLat();
      const requested = mercatorXY(plan), scale = mercatorMeter(plan.latitude);
      const rawDem = map.queryTerrainElevation([calibrationTarget.longitude, calibrationTarget.latitude]);
      const renderedDem = rawDem !== null && rawDem !== 0 && Number.isFinite(rawDem) ? rawDem : null;
      const target = { ...calibrationTarget, altitude: renderedDem ?? 0 };
      const sdkPixel = renderedDem === null ? null : map.project([target.longitude, target.latitude]);
      const actualPlan = { ...plan, azimuth: (map.getBearing() % 360 + 360) % 360, pitch: map.getPitch() - 90 };
      const actualEye = { longitude: location.lng, latitude: location.lat, altitude: point.altitude };
      const compare = (reference: typeof target) => compareEarthModels(actualPlan, actualEye, reference, width, height, map.getCenter().lat);
      const demModels = renderedDem === null ? null : compare(target);
      const gpu = renderedDem === null ? null : probe?.(target,width,height);
      const expected = demModels?.ellipsoid.pixel;
      const snapshot: CalibrationSnapshot = {
        ready: map.areTilesLoaded(), width, height, plan, ground,
        eye: { longitude: location.lng, latitude: location.lat, altitude: point.altitude,
          horizontalError: Math.hypot(point.x / worldSize - requested[0], point.y / worldSize - requested[1]) / scale,
          altitudeError: point.altitude - ground - plan.cameraHeight,
          heightAboveDem: point.altitude - ground, pitch: map.getPitch() - 90, bearing: map.getBearing() },
        target: { ...calibrationTarget, independentDem: dem, renderedDem, demLevels: { ...demLevels }, error },
        detail: { cellPixels: TERRAIN_CELL_PIXELS, viewportHeight: height, maxMeshZoom: TERRAIN_MAX_MESH_ZOOM },
        curvature: {
          heightAssumption: "同一实际眼点；同源高程作为椭球参考曲面，未作垂直基准转换或地面大气折射；真实网格使用 ENU 投影，不代表实景精度",
          dem: demModels, published: compare(calibrationTarget),
          gpuResidual: gpu && expected ? Math.hypot(gpu.x-expected.x,gpu.y-expected.y):null,
          gpuRay: gpu?.ray ?? null,
        },
        pixels: {
          sdkDem: sdkPixel && { x: sdkPixel.x, y: sdkPixel.y },
          matrixDem: renderedDem === null ? null : matrixPixel(input.modelViewProjectionMatrix, target, worldSize, width, height),
          requestedDem: renderedDem === null ? null : referencePixel(plan, ground, target, width, height, false, map.getCenter().lat),
          actualDem: renderedDem === null ? null : referencePixel({ ...plan, latitude: location.lat, longitude: location.lng,
            azimuth: (map.getBearing() % 360 + 360) % 360, pitch: map.getPitch() - 90 }, point.altitude - plan.cameraHeight, target, width, height, false, map.getCenter().lat),
          publishedPlanar: referencePixel(plan, ground, calibrationTarget, width, height, false, map.getCenter().lat),
          publishedSpherical: referencePixel(plan, ground, calibrationTarget, width, height, true),
          demEllipsoidal: demModels?.ellipsoid.pixel ?? null,
          gpuDem: gpu ? {x:gpu.x,y:gpu.y}:null,
        },
      };
      // Round only the comparison key; retain full precision in the evidence.
      const key = JSON.stringify(snapshot, (_key, value) => typeof value === "number" ? +value.toFixed(7) : value);
      if (previous !== key) { previous = key; report(snapshot); }
    },
    onRemove() { controller.abort(); },
  };
}

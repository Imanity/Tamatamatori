import { MercatorCoordinate } from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";

export interface RenderedCamera {
  planKey: string;
  longitude: number; latitude: number; altitude: number;
  azimuth: number; pitch: number;
}

/** Optical centre solves clip x = clip y = clip w = 0. The public custom-layer
 * modelViewProjectionMatrix uses world XY pixels and Z metres on Mercator. */
export function matrixEye(matrix: ArrayLike<number>) {
  const rows = [0, 1, 3].map((r) => [matrix[r], matrix[4 + r], matrix[8 + r], -matrix[12 + r]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const divisor = rows[col][col];
    if (!Number.isFinite(divisor) || Math.abs(divisor) < 1e-14) throw new Error("校准矩阵不可逆");
    rows[col] = rows[col].map((v) => v / divisor);
    for (let row = 0; row < 3; row++) if (row !== col) {
      const factor = rows[row][col];
      rows[row] = rows[row].map((v, i) => v - factor * rows[col][i]);
    }
  }
  const result = rows.map((r) => r[3]);
  if (!result.every(Number.isFinite)) throw new Error("校准眼点无效");
  return { x: result[0], y: result[1], altitude: result[2] };
}

export function renderedCamera(map: MapLibreMap, matrix: ArrayLike<number>, planKey: string): RenderedCamera {
  const eye = matrixEye(matrix), worldSize = 512 * 2 ** map.getZoom();
  const point = new MercatorCoordinate(eye.x / worldSize, eye.y / worldSize).toLngLat();
  return { planKey, longitude: point.lng, latitude: point.lat, altitude: eye.altitude,
    azimuth: (map.getBearing() % 360 + 360) % 360, pitch: map.getPitch() - 90 };
}

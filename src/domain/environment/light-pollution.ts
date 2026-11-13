import atlas from "../../data/light-pollution.json" with { type: "json" };
import type { MapPoint } from "../core/map.ts";

export const lightPollutionAtlas = atlas;
export interface PollutionCell {
  x: number;
  y: number;
  weight: number;
}
export interface PollutionSample {
  artificialMcd: number;
}

/** Cell centres on the source's geographic grid. Longitude wraps at the dateline. */
export function lightPollutionCells(point: MapPoint): PollutionCell[] | null {
  const { longitude, latitude } = point;
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    latitude < atlas.south ||
    latitude > atlas.north
  )
    return null;
  const lon = ((((longitude + 180) % 360) + 360) % 360) - 180;
  const x = (lon - atlas.west) / atlas.pixelSize - 0.5;
  const y = Math.max(
    0,
    Math.min(
      atlas.height - 1,
      (atlas.rasterNorth - latitude) / atlas.pixelSize - 0.5,
    ),
  );
  const left = Math.floor(x),
    top = Math.floor(y);
  const fx = x - left,
    fy = y - top;
  return [
    { x: left, y: top, weight: (1 - fx) * (1 - fy) },
    { x: left + 1, y: top, weight: fx * (1 - fy) },
    { x: left, y: Math.min(top + 1, atlas.height - 1), weight: (1 - fx) * fy },
    { x: left + 1, y: Math.min(top + 1, atlas.height - 1), weight: fx * fy },
  ]
    .filter((cell) => cell.weight > 0)
    .map((cell) => ({
      ...cell,
      x: (cell.x + atlas.width) % atlas.width,
    }));
}

export function decodePollutionValue(code: number): number | null {
  if (!Number.isInteger(code) || code < 0 || code > 255)
    throw new RangeError("光污染像元编码无效");
  return code === 0
    ? null
    : atlas.encoding.unitMcd * Math.expm1((code - 1) / atlas.encoding.scale);
}

export function interpolatePollution(
  cells: { code: number; weight: number }[],
): PollutionSample | null {
  const values = cells.map((cell) => ({
    value: decodePollutionValue(cell.code),
    weight: cell.weight,
  }));
  if (values.some((cell) => cell.value === null)) return null;
  return {
    artificialMcd: values.reduce(
      (sum, cell) => sum + cell.value! * cell.weight,
      0,
    ),
  };
}

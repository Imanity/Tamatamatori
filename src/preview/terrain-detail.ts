import type { CalculateTileZoomFunction, Map as MapLibreMap } from "maplibre-gl";
import { TERRAIN_SOURCE, TERRAIN_ZOOM } from "../domain/terrain.ts";

// A 128-segment mesh at z14 matches the spacing of the native 512px z12 DEM.
// Further near-camera subdivision adds no source resolution and wastes RTTs.
export const TERRAIN_MAX_MESH_ZOOM = TERRAIN_ZOOM + 2;
export const TERRAIN_CELL_PIXELS = 8;
export function terrainTileZoom(viewportHeight: number): CalculateTileZoomFunction {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) throw new RangeError("地形细节需要有效取景框高度");
  return (_zoom, distanceXY, distanceZ, _distanceCenter, fov) => {
    const distance = Math.max(1e-12, Math.hypot(distanceXY, distanceZ));
    const unitsPerPixel = 2 * distance * Math.tan(fov * Math.PI / 360) / viewportHeight;
    // In normalized Mercator coordinates a mesh cell spans 1/(128*2^z).
    // Aim for eight CSS pixels per cell, bounded by native DEM spacing.
    return Math.max(0, Math.min(TERRAIN_MAX_MESH_ZOOM, Math.log2(1 / (128 * unitsPerPixel * TERRAIN_CELL_PIXELS))));
  };
}
export function applyTerrainDetail(map: MapLibreMap, viewportHeight: number) {
  // The public setter invalidates coverage, then the public Source callback
  // supplies photographic screen-space LOD instead of the map-browsing preset.
  map.setSourceTileLodParams(9.314, 3, TERRAIN_SOURCE);
  const source = map.getSource(TERRAIN_SOURCE);
  if (!source?.calculateTileZoom) throw new Error("当前 SDK 不支持地形细节策略");
  // This is the public Source LOD callback installed by the public Map method.
  // The pinned SDK compatibility patch forwards it to mesh coverage as well.
  source.calculateTileZoom = terrainTileZoom(viewportHeight);
}

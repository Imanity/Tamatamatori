import type { StyleSpecification } from "maplibre-gl";
import type { MapPoint } from "./map.ts";
import { isMapPosition } from "./map.ts";
import { normalizeLongitude } from "./plan.ts";

export const TERRAIN_SOURCE = "preview-terrain";
export const WATER_SOURCE = "preview-surface";
export const TERRAIN_ZOOM = 12;
export const DEFAULT_TERRAIN_URL = "https://tiles.mapterhorn.com/tilejson.json";
export const DEFAULT_WATER_URL = "https://tiles.openfreemap.org/planet";
export const terrainColors = {
  ground: "#c2cdb2", wood: "#9caf92", grass: "#b5c6a3", sand: "#d8cfb4",
  ice: "#edf0e8", land: "#bfcbb0", water: "#739faa",
};

export interface ElevationTile {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

export function terrainTile(point: MapPoint, zoom = TERRAIN_ZOOM) {
  if (!isMapPosition(point) || !Number.isInteger(zoom) || zoom < 0 || zoom > 22)
    throw new RangeError("机位或地形瓦片级别超出范围");
  const scale = 2 ** zoom;
  const worldX = ((normalizeLongitude(point.longitude) + 180) / 360) * scale;
  const latitude = (point.latitude * Math.PI) / 180;
  const worldY = Math.max(
    0,
    Math.min(
      scale - Number.EPSILON * scale,
      ((1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2) * scale,
    ),
  );
  const x = Math.floor(worldX),
    y = Math.floor(worldY);
  return { z: zoom, x, y, u: worldX - x, v: worldY - y };
}

export function decodeTerrarium(
  red: number,
  green: number,
  blue: number,
  alpha = 255,
) {
  const value = red * 256 + green + blue / 256 - 32768;
  if (alpha === 0 || !Number.isFinite(value) || value < -12000 || value > 10000)
    throw new RangeError("地形像素缺失或高程无效");
  return value;
}

export function sampleElevationTile(tile: ElevationTile, u: number, v: number) {
  if (
    !Number.isFinite(u) ||
    !Number.isFinite(v) ||
    u < 0 ||
    u > 1 ||
    v < 0 ||
    v > 1 ||
    tile.width < 1 ||
    tile.height < 1 ||
    tile.pixels.length !== tile.width * tile.height * 4
  )
    throw new RangeError("地形采样坐标或像素数据无效");
  const x = Math.max(0, Math.min(tile.width - 1, u * tile.width - 0.5));
  const y = Math.max(0, Math.min(tile.height - 1, v * tile.height - 0.5));
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    dx = x - x0,
    dy = y - y0;
  const heights = [
    [x0, y0, (1 - dx) * (1 - dy)],
    [Math.min(x0 + 1, tile.width - 1), y0, dx * (1 - dy)],
    [x0, Math.min(y0 + 1, tile.height - 1), (1 - dx) * dy],
    [
      Math.min(x0 + 1, tile.width - 1),
      Math.min(y0 + 1, tile.height - 1),
      dx * dy,
    ],
  ];
  let height = 0;
  for (const [px, py, weight] of heights) {
    if (!weight) continue;
    const index = (py * tile.width + px) * 4;
    height +=
      decodeTerrarium(
        tile.pixels[index],
        tile.pixels[index + 1],
        tile.pixels[index + 2],
        tile.pixels[index + 3],
      ) * weight;
  }
  return height;
}

export function terrainStyle(
  terrainUrl = DEFAULT_TERRAIN_URL,
  waterUrl = DEFAULT_WATER_URL,
): StyleSpecification {
  return {
    version: 8,
    transition: { duration: 0, delay: 0 },
    sources: {
      [TERRAIN_SOURCE]: {
        type: "raster-dem",
        url: terrainUrl,
        encoding: "terrarium",
        tileSize: 512,
        maxzoom: TERRAIN_ZOOM,
      },
      "preview-shade": {
        type: "raster-dem",
        url: terrainUrl,
        encoding: "terrarium",
        tileSize: 512,
        maxzoom: TERRAIN_ZOOM,
      },
      [WATER_SOURCE]: { type: "vector", url: waterUrl },
    },
    terrain: { source: TERRAIN_SOURCE, exaggeration: 1 },
    sky: {
      "sky-color": "#b9d1de",
      "horizon-color": "#e7ede5",
      "fog-color": "#d9e4db",
      "sky-horizon-blend": 0.65,
      "horizon-fog-blend": 0.2,
      "fog-ground-blend": 0.06,
    },
    layers: [
      {
        id: "preview-ground",
        type: "background",
        paint: { "background-color": terrainColors.ground },
      },
      {
        id: "preview-landcover",
        type: "fill",
        source: WATER_SOURCE,
        "source-layer": "landcover",
        paint: {
          "fill-color": [
            "match",
            ["get", "class"],
            "wood",
            terrainColors.wood,
            "grass",
            terrainColors.grass,
            "sand",
            terrainColors.sand,
            "ice",
            terrainColors.ice,
            terrainColors.land,
          ],
          "fill-opacity": 0.8,
        },
      },
      {
        id: "preview-shading",
        type: "hillshade",
        source: "preview-shade",
        paint: {
          "hillshade-shadow-color": "#586651",
          "hillshade-highlight-color": "#f0edda",
          "hillshade-accent-color": "#697b58",
          "hillshade-exaggeration": 0.4,
        },
      },
      {
        id: "preview-water",
        type: "fill",
        source: WATER_SOURCE,
        "source-layer": "water",
        filter: ["!=", ["get", "brunnel"], "tunnel"],
        paint: { "fill-color": terrainColors.water, "fill-opacity": 1 },
      },
      {
        id: "preview-waterways",
        type: "line",
        source: WATER_SOURCE,
        "source-layer": "waterway",
        filter: ["!=", ["get", "brunnel"], "tunnel"],
        paint: {
          "line-color": terrainColors.water,
          "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.4, 16, 1.8],
        },
      },
    ],
  };
}

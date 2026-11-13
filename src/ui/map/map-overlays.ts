// The map's own sources and layers over the base map: the view cone, body
// azimuth lines and their labels, the eclipse band, aurora and tide marks, and
// the 推算 targets and results. MapPanel adds them once the style loads and
// updates them on every draw.
import type { Map as MapLibreMap, GeoJSONSource } from "maplibre-gl";
import { bodyKind } from "../../domain/sky/sky-targets";
import type { SolveBodyId } from "../../domain/sky/sky-targets";
import type { ShootingPlan } from "../../domain/core/plan";
import { lineLabels } from "../../domain/sun-moon/body-lines";
import type { BodyLine } from "../../domain/sun-moon/body-lines";
import { unwrap } from "../../domain/sun-moon/eclipses";
import type { CentralPath } from "../../domain/sun-moon/eclipses";
import { destination, isMapPosition, nearbyLongitude, viewGeometry, viewRadiusMeters } from "../../domain/core/map";

export const viewSourceId = "tamatamatori-view";
const linesSourceId = "tamatamatori-body-lines";
const labelSourceId = "tamatamatori-line-labels";
const eclipseSourceId = "tamatamatori-eclipse";
const environmentSourceId = "tamatamatori-environment";
const alignmentSourceId = "tamatamatori-alignment";
export const emptyFeatures: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
export type EclipseMap = { kind: CentralPath["kind"]; path: CentralPath; footprint: [number, number][] | null } | null;

/** Central eclipse band (both edges), its centre line and the umbra at the shooting instant. */
function eclipseGeometry(eclipse: EclipseMap): GeoJSON.FeatureCollection {
  if (!eclipse) return { type: "FeatureCollection", features: [] };
  const features: GeoJSON.Feature[] = [];
  const side = (index: 0 | 1) => eclipse.path.samples.map((sample) => sample.edges[index]).filter((point): point is [number, number] => !!point);
  const ring = unwrap([...side(0), ...side(1).reverse()]);
  if (ring.length >= 4) features.push({ type: "Feature", properties: { kind: "band" }, geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] } });
  const centre = unwrap(eclipse.path.samples.map((sample) => sample.centre));
  if (centre.length >= 2) features.push({ type: "Feature", properties: { kind: "centre" }, geometry: { type: "LineString", coordinates: centre } });
  if (eclipse.footprint) {
    const outline = unwrap(eclipse.footprint);
    features.push({ type: "Feature", properties: { kind: "umbra" }, geometry: { type: "Polygon", coordinates: [[...outline, outline[0]]] } });
  }
  return { type: "FeatureCollection", features };
}
export const bodyNames = { sun: "太阳", moon: "月亮", core: "银心" } as const;
export const bodyColors = { sun: "#e0892c", moon: "#5f7fc4", core: "#8b5fc4" } as const;
/** Alignment lines: the Sun and the Moon as their azimuth lines; fixed bodies by kind. */
const alignmentColor = (body: string) => {
  const kind = bodyKind(body as SolveBodyId);
  return kind === "sun" || kind === "moon" || kind === "core" ? bodyColors[kind] : kind === "deepSky" ? "#a0568a" : "#3f7f8f";
};

/** Body azimuth lines from the camera, as long as the view cone at this zoom. */
function lineGeometry(plan: ShootingPlan, lines: BodyLine[], zoom: number): GeoJSON.FeatureCollection {
  const radius = viewRadiusMeters(plan, zoom);
  if (radius < 1 || !isMapPosition(plan)) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: lines.map((line) => {
      const end = destination(plan, line.azimuth, radius * (line.kind === "now" ? 1.4 : 1.15));
      return {
        type: "Feature",
        properties: { body: line.body, kind: line.kind, above: line.above },
        geometry: { type: "LineString", coordinates: [[plan.longitude, plan.latitude], [nearbyLongitude(end.longitude, plan.longitude), end.latitude]] },
      };
    }),
  };
}
/** The text anchor that puts a label outside the end of a line pointing `angle` (degrees clockwise from screen up). */
function outward(angle: number) {
  const anchors = ["bottom", "bottom-left", "left", "top-left", "top", "top-right", "right", "bottom-right"] as const;
  return anchors[Math.round((((angle % 360) + 360) % 360) / 45) % 8];
}
/** Names at the ends of the body lines (rises and sets with their times) and of the shooting direction. */
function labelGeometry(plan: ShootingPlan, lines: BodyLine[], zoom: number, bearing: number): GeoJSON.FeatureCollection {
  const radius = viewRadiusMeters(plan, zoom);
  if (radius < 1 || !isMapPosition(plan)) return { type: "FeatureCollection", features: [] };
  const point = (azimuth: number, distance: number, properties: { text: string; color: string; offset: number }): GeoJSON.Feature => {
    const end = destination(plan, azimuth, distance);
    return {
      type: "Feature",
      properties: { ...properties, anchor: outward(azimuth - bearing) },
      geometry: { type: "Point", coordinates: [nearbyLongitude(end.longitude, plan.longitude), end.latitude] },
    };
  };
  return {
    type: "FeatureCollection",
    features: [
      ...lineLabels(lines, plan.timeZone).map((label) =>
        point(label.azimuth, radius * (label.ring === "now" ? 1.4 : 1.15), { text: label.text, color: label.body ? bodyColors[label.body] : "#2f3b30", offset: 0.4 })),
      // Clear of the direction handle at the end of that line.
      point(plan.azimuth, radius, { text: "拍摄方向", color: "#326d51", offset: 1.4 }),
    ],
  };
}

/** What the overlays show; MapPanel keeps the latest in a ref. */
export type OverlayData = {
  plan: ShootingPlan;
  lines: BodyLine[];
  eclipse: EclipseMap;
  environment: GeoJSON.FeatureCollection;
  alignmentFeatures: GeoJSON.FeatureCollection;
  alignmentBody: string;
};
/** What was last written to the map, so that unchanged data is not written again. */
export type DrawnOverlays = {
  lines: string;
  labels: string;
  eclipse?: EclipseMap;
  environment?: GeoJSON.FeatureCollection;
  alignment?: GeoJSON.FeatureCollection;
  body: string;
};
export const drawnOverlays = (): DrawnOverlays => ({ lines: "", labels: "", body: "" });

/** Adds the sources and layers, in drawing order, with the current data. */
export function addOverlays(map: MapLibreMap, data: OverlayData, drawn: DrawnOverlays) {
  map.addSource(viewSourceId, {
    type: "geojson",
    data: viewGeometry(data.plan, map.getZoom()),
  });
  map.addLayer({
    id: "tamatamatori-field",
    type: "fill",
    source: viewSourceId,
    filter: ["==", ["get", "kind"], "field"],
    paint: {
      "fill-color": "#34715a",
      "fill-opacity": 0.2,
      "fill-outline-color": "#34715a",
    },
  });
  // Aurora nowcast, oval edge and view line; the tide cell.
  map.addSource(environmentSourceId, { type: "geojson", data: data.environment });
  drawn.environment = data.environment;
  map.addLayer({
    id: "tamatamatori-aurora-cells", type: "fill", source: environmentSourceId,
    filter: ["==", ["get", "kind"], "aurora-cell"],
    paint: { "fill-color": "#2f9e62", "fill-opacity": ["match", ["get", "band"], 3, 0.5, 2, 0.32, 0.16] },
  });
  map.addLayer({
    id: "tamatamatori-aurora-edge", type: "line", source: environmentSourceId,
    filter: ["==", ["get", "kind"], "aurora-edge"],
    paint: { "line-color": "#1f8a52", "line-width": 1.8, "line-opacity": 0.85 },
  });
  map.addLayer({
    id: "tamatamatori-aurora-view", type: "line", source: environmentSourceId,
    filter: ["==", ["get", "kind"], "aurora-view"],
    paint: { "line-color": "#1f8a52", "line-width": 1.4, "line-opacity": 0.75, "line-dasharray": [4, 3] },
  });
  map.addLayer({
    id: "tamatamatori-tide-cell", type: "circle", source: environmentSourceId,
    filter: ["==", ["get", "kind"], "tide-cell"],
    paint: { "circle-radius": 6, "circle-color": "#2f6fae", "circle-opacity": 0.85, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 },
  });
  // Eclipse band under everything else drawn for the shot.
  map.addSource(eclipseSourceId, { type: "geojson", data: eclipseGeometry(data.eclipse) });
  drawn.eclipse = data.eclipse;
  map.addLayer({
    id: "tamatamatori-eclipse-band", type: "fill", source: eclipseSourceId,
    filter: ["==", ["get", "kind"], "band"],
    paint: { "fill-color": "#4a3566", "fill-opacity": 0.16 },
  });
  map.addLayer({
    id: "tamatamatori-eclipse-edge", type: "line", source: eclipseSourceId,
    filter: ["==", ["get", "kind"], "band"],
    paint: { "line-color": "#5b3f80", "line-width": 1.2, "line-opacity": 0.8 },
  });
  map.addLayer({
    id: "tamatamatori-eclipse-centre", type: "line", source: eclipseSourceId,
    filter: ["==", ["get", "kind"], "centre"],
    paint: { "line-color": "#5b3f80", "line-width": 1, "line-opacity": 0.7, "line-dasharray": [3, 3] },
  });
  map.addLayer({
    id: "tamatamatori-eclipse-umbra", type: "fill", source: eclipseSourceId,
    filter: ["==", ["get", "kind"], "umbra"],
    paint: { "fill-color": "#26173a", "fill-opacity": 0.45, "fill-outline-color": "#26173a" },
  });
  // Body azimuth lines under the view cone's direction line.
  map.addSource(linesSourceId, { type: "geojson", data: lineGeometry(data.plan, data.lines, map.getZoom()) });
  const lineColor = ["match", ["get", "body"], "sun", bodyColors.sun, "moon", bodyColors.moon, bodyColors.core] as unknown as string;
  map.addLayer({
    id: "tamatamatori-body-riseset",
    type: "line",
    source: linesSourceId,
    filter: ["!=", ["get", "kind"], "now"],
    paint: { "line-color": lineColor, "line-width": 1.5, "line-opacity": 0.65, "line-dasharray": [4, 2] },
  });
  map.addLayer({
    id: "tamatamatori-body-below",
    type: "line",
    source: linesSourceId,
    filter: ["all", ["==", ["get", "kind"], "now"], ["!", ["get", "above"]]],
    paint: { "line-color": lineColor, "line-width": 2.5, "line-opacity": 0.6, "line-dasharray": [1, 1.5] },
  });
  map.addLayer({
    id: "tamatamatori-body-now",
    type: "line",
    source: linesSourceId,
    filter: ["all", ["==", ["get", "kind"], "now"], ["get", "above"]],
    paint: { "line-color": lineColor, "line-width": 3, "line-opacity": 0.9 },
  });
  // 推算 · 找机位: the stretches of line where the body sits on the target (sight not cut by the terrain).
  map.addSource(alignmentSourceId, { type: "geojson", data: data.alignmentFeatures });
  drawn.alignment = data.alignmentFeatures;
  drawn.body = data.alignmentBody;
  const lineColor_ = alignmentColor(drawn.body);
  map.addLayer({
    id: "tamatamatori-alignment-sector", type: "fill", source: alignmentSourceId,
    filter: ["==", ["get", "kind"], "sector"],
    paint: { "fill-color": lineColor_, "fill-opacity": 0.1 },
  });
  // Two ground points: the ground around each camera place where the second point stays within tolerance.
  map.addLayer({
    id: "tamatamatori-alignment-area", type: "fill", source: alignmentSourceId,
    filter: ["==", ["get", "kind"], "area"],
    paint: { "fill-color": "#b4372b", "fill-opacity": ["case", ["get", "selected"], 0.3, 0.16], "fill-outline-color": "#b4372b" },
  });
  map.addLayer({
    id: "tamatamatori-alignment-ring", type: "line", source: alignmentSourceId,
    filter: ["==", ["get", "kind"], "ring"],
    paint: { "line-color": "#2f3b30", "line-width": 1.2, "line-opacity": 0.6, "line-dasharray": [3, 3] },
  });
  map.addLayer({
    id: "tamatamatori-alignment-segment", type: "line", source: alignmentSourceId,
    filter: ["==", ["get", "kind"], "segment"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["interpolate", ["linear"], ["get", "order"], 0, "#e7b46a", 1, "#7a2e12"],
      "line-width": ["case", ["get", "selected"], 6, 3.5],
      "line-opacity": 0.9,
    },
  });
  map.addLayer({
    id: "tamatamatori-alignment-segment-dot", type: "circle", source: alignmentSourceId,
    filter: ["==", ["get", "kind"], "segment-dot"],
    paint: { "circle-radius": ["case", ["get", "selected"], 5, 3.5], "circle-color": ["interpolate", ["linear"], ["get", "order"], 0, "#e7b46a", 1, "#7a2e12"] },
  });
  map.addLayer({
    id: "tamatamatori-alignment-casing", type: "line", source: alignmentSourceId,
    filter: ["==", ["get", "kind"], "line"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": ["case", ["get", "selected"], 8.5, 6], "line-opacity": 0.8 },
  });
  map.addLayer({
    id: "tamatamatori-alignment-clear", type: "line", source: alignmentSourceId,
    filter: ["all", ["==", ["get", "kind"], "line"], ["==", ["get", "sight"], "clear"]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": lineColor_, "line-width": ["case", ["get", "selected"], 5.5, 3.5] },
  });
  map.addLayer({
    id: "tamatamatori-alignment-blocked", type: "line", source: alignmentSourceId,
    filter: ["all", ["==", ["get", "kind"], "line"], ["!=", ["get", "sight"], "clear"]],
    // Only "terrain data missing somewhere" is listed besides a clear sight: dotted.
    paint: { "line-color": lineColor_, "line-width": ["case", ["get", "selected"], 4.5, 3], "line-opacity": 0.55, "line-dasharray": [0.6, 1.4] },
  });
  map.addLayer({
    id: "tamatamatori-alignment-dot", type: "circle", source: alignmentSourceId,
    filter: ["==", ["get", "kind"], "dot"],
    paint: { "circle-radius": ["case", ["get", "selected"], 5, 3.5], "circle-color": lineColor_, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1 },
  });
  map.addLayer({
    id: "tamatamatori-alignment-labels", type: "symbol", source: alignmentSourceId,
    filter: ["==", ["get", "kind"], "label"],
    layout: {
      "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 11,
      "text-offset": [0, -1.1], "text-allow-overlap": false, "symbol-sort-key": 1,
    },
    paint: { "text-color": "#2f3b30", "text-halo-color": "#ffffff", "text-halo-width": 1.6 },
  });
  map.addLayer({
    id: "tamatamatori-alignment-target", type: "circle", source: alignmentSourceId,
    filter: ["==", ["get", "kind"], "target"],
    paint: { "circle-radius": 7, "circle-color": "#b4372b", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.5 },
  });
  map.addLayer({
    id: "tamatamatori-direction",
    type: "line",
    source: viewSourceId,
    filter: ["==", ["get", "kind"], "direction"],
    paint: {
      "line-color": "#326d51",
      "line-width": 2,
      "line-dasharray": [3, 2],
    },
  });
  // What each line from the camera is: on top, ahead of the base map's labels.
  map.addSource(labelSourceId, { type: "geojson", data: labelGeometry(data.plan, data.lines, map.getZoom(), map.getBearing()) });
  map.addLayer({
    id: "tamatamatori-line-labels", type: "symbol", source: labelSourceId,
    layout: {
      "text-field": ["get", "text"], "text-font": ["Noto Sans Regular"], "text-size": 12,
      "text-anchor": ["get", "anchor"], "text-radial-offset": ["get", "offset"],
      "text-allow-overlap": true,
    },
    paint: { "text-color": ["get", "color"], "text-halo-color": "#ffffff", "text-halo-width": 1.8 },
  });
}

/** Writes changed data to the sources; `viewKey` changes with the camera, lens and zoom. */
export function updateOverlays(map: MapLibreMap, data: OverlayData, drawn: DrawnOverlays, viewKey: string) {
  const lineSource = map.getSource(linesSourceId) as GeoJSONSource | undefined;
  const nextLinesKey = `${viewKey}/${JSON.stringify(data.lines)}`;
  if (lineSource && nextLinesKey !== drawn.lines) {
    lineSource.setData(lineGeometry(data.plan, data.lines, map.getZoom()));
    drawn.lines = nextLinesKey;
  }
  // Labels turn with the map so they stay outside the line ends.
  const labelSource = map.getSource(labelSourceId) as GeoJSONSource | undefined;
  const nextLabelsKey = `${nextLinesKey}/${data.plan.timeZone}/${Math.round(map.getBearing() / 15)}`;
  if (labelSource && nextLabelsKey !== drawn.labels) {
    labelSource.setData(labelGeometry(data.plan, data.lines, map.getZoom(), map.getBearing()));
    drawn.labels = nextLabelsKey;
  }
  const eclipseSource = map.getSource(eclipseSourceId) as GeoJSONSource | undefined;
  if (eclipseSource && data.eclipse !== drawn.eclipse) {
    eclipseSource.setData(eclipseGeometry(data.eclipse));
    drawn.eclipse = data.eclipse;
  }
  const environmentSource = map.getSource(environmentSourceId) as GeoJSONSource | undefined;
  if (environmentSource && data.environment !== drawn.environment) {
    environmentSource.setData(data.environment);
    drawn.environment = data.environment;
  }
  const alignmentSource = map.getSource(alignmentSourceId) as GeoJSONSource | undefined;
  if (alignmentSource && data.alignmentFeatures !== drawn.alignment) {
    alignmentSource.setData(data.alignmentFeatures);
    drawn.alignment = data.alignmentFeatures;
  }
  if (alignmentSource && data.alignmentBody !== drawn.body) {
    drawn.body = data.alignmentBody;
    const color = alignmentColor(drawn.body);
    for (const id of ["tamatamatori-alignment-clear", "tamatamatori-alignment-blocked", "tamatamatori-alignment-dot", "tamatamatori-alignment-sector"])
      map.setPaintProperty(id, id.endsWith("dot") ? "circle-color" : id.endsWith("sector") ? "fill-color" : "line-color", color);
  }
}

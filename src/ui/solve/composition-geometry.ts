// The 推算 map geometry: ground targets, the search range, sectors and result
// lines. Part of the 推算 module (solve-module.ts).
import { MIN_DISTANCE, travel } from "../../domain/solve/position-alignment";
import type { CompositionState } from "./useComposition";
import { clock, dayWords, localDay } from "./composition-format";

const circle = (centre: { latitude: number; longitude: number }, radius: number) =>
  Array.from({ length: 73 }, (_, index) => {
    const point = travel(centre, (index * 5) % 360, radius);
    return [point.longitude, point.latitude];
  });
/** Ground targets, the search range, sectors and result lines (light to dark by date) for the map. */
export function compositionGeometry(state: CompositionState | null, timeZone: string): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (!state?.active) return { type: "FeatureCollection", features };
  for (const target of state.composition.targets)
    if (target.kind === "ground")
      features.push({ type: "Feature", properties: { kind: "target" }, geometry: { type: "Point", coordinates: [target.longitude, target.latitude] } });
  const run = state.run;
  if (!run || run.phase === "error") return { type: "FeatureCollection", features };
  for (const ring of run.rings) features.push({ type: "Feature", properties: { kind: "ring" }, geometry: { type: "LineString", coordinates: circle(ring, ring.radius) } });
  const ground = run.basis.ground;
  if (ground && run.strategy.kind === "line")
    for (const [from, to] of run.sectors) {
      const steps = Math.max(2, Math.ceil(to - from));
      const outer = run.rings[0]?.radius ?? 30_000;
      const arc = (radius: number) => Array.from({ length: steps + 1 }, (_, index) => {
        const point = travel(ground, from + ((to - from) * index) / steps, radius);
        return [point.longitude, point.latitude];
      });
      const far = arc(run.composition.camera.mode === "near" ? 30_000 : outer), near = arc(MIN_DISTANCE).reverse();
      features.push({ type: "Feature", properties: { kind: "sector" }, geometry: { type: "Polygon", coordinates: [[...far, ...near, far[0]]] } });
    }
  run.items.filter((item) => item.place).forEach((item, index) => {
    const selected = item === state.current;
    const outline = item.place!.area.map((point) => [point.longitude, point.latitude]);
    if (outline.length > 2) features.push({ type: "Feature", properties: { kind: "area", selected }, geometry: { type: "Polygon", coordinates: [[...outline, outline[0]]] } });
    const at = [item.camera.longitude, item.camera.latitude];
    features.push({ type: "Feature", properties: { kind: "dot", selected }, geometry: { type: "Point", coordinates: at } });
    features.push({ type: "Feature", properties: { kind: "label", label: `机位 ${index + 1}` }, geometry: { type: "Point", coordinates: at } });
  });
  const lines = run.items.filter((item) => item.points);
  const single = run.composition.time.mode === "instant" || (run.composition.time.mode === "range" && run.composition.time.days === 1);
  lines.forEach((item, index) => {
    const order = lines.length > 1 ? index / (lines.length - 1) : 0;
    const selected = item === state.current;
    const points = item.points!;
    const coordinates = points.map((point) => [point.longitude, point.latitude]);
    features.push(coordinates.length > 1
      ? { type: "Feature", properties: { kind: "segment", order, selected }, geometry: { type: "LineString", coordinates } }
      : { type: "Feature", properties: { kind: "segment-dot", order, selected }, geometry: { type: "Point", coordinates: coordinates[0] } });
    const label = (point: (typeof points)[number], text: string) =>
      features.push({ type: "Feature", properties: { kind: "label", label: text }, geometry: { type: "Point", coordinates: [point.longitude, point.latitude] } });
    if (selected) {
      const first = points[0], last = points.at(-1)!;
      label(first, clock(first.time, timeZone));
      if (last !== first) label(last, clock(last.time, timeZone));
      for (const point of points) if (point !== first && point !== last && clock(point.time, timeZone).endsWith("0")) label(point, clock(point.time, timeZone));
    } else if (single) {
      label(points[0], clock(points[0].time, timeZone));
      if (points.length > 1) label(points.at(-1)!, clock(points.at(-1)!.time, timeZone));
    } else {
      const middle = points[Math.floor(points.length / 2)];
      label(middle, `${dayWords(localDay(middle.time, timeZone)).split(" ")[0]} ${clock(middle.time, timeZone)}`);
    }
  });
  return { type: "FeatureCollection", features };
}

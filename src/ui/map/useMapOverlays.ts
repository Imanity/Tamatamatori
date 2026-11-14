// What MapPanel draws over the map, derived from the plan and the layer feeds:
// body azimuth lines, a central eclipse band, aurora and tide marks, and the
// 推算 targets and results.
import { useMemo } from "react";
import type { ShootingPlan } from "../../domain/core/plan";
import { bodyLines } from "../../domain/sun-moon/body-lines";
import type { BodyLine } from "../../domain/sun-moon/body-lines";
import { timelineMode, timelineWindow } from "../../domain/time/timeline";
import { centralEclipseInSpan, centralPath, umbraFootprint } from "../../domain/sun-moon/eclipses";
import { auroraLines, kpAt, ovationApplies, ovationCells } from "../../domain/environment/aurora";
import type { TideFeed } from "../environment/TideScene";
import type { AuroraFeed } from "../environment/AuroraScene";
import type { CompositionState } from "../solve/useComposition";
import { emptyFeatures } from "./map-overlays";
import type { EclipseMap } from "./map-overlays";

export function useMapOverlays(plan: ShootingPlan, tides: TideFeed | undefined, aurora: AuroraFeed | undefined, alignment: CompositionState | null | undefined) {
  const layers = plan.layers;
  // Sun, Moon and Milky Way core directions for the shooting instant and their
  // rises and sets in the timeline's span; each follows its layer.
  const lines = useMemo(() => {
    try {
      return bodyLines(plan);
    } catch {
      return [] as BodyLine[];
    }
  }, [plan.latitude, plan.longitude, plan.instant, plan.timeZone, plan.refraction, layers.sun, layers.moon, layers.milkyWay, timelineMode(layers)]);
  // A total or annular eclipse in the timeline's span: its band, and the umbra at the shooting instant.
  const span = timelineWindow(plan.instant, plan.timeZone, timelineMode(layers));
  const central = useMemo(() => {
    if (!layers.sun) return null;
    try {
      const found = centralEclipseInSpan(span);
      return found ? centralPath(found.instant) : null;
    } catch {
      return null;
    }
  }, [span.start, span.end, layers.sun]);
  const eclipse: EclipseMap = useMemo(() => {
    if (!central) return null;
    try {
      return { kind: central.kind, path: central, footprint: umbraFootprint(plan.instant) };
    } catch {
      return { kind: central.kind, path: central, footprint: null };
    }
  }, [central, plan.instant]);
  // The sea cell used for tides; the auroral oval edge and view line for the
  // shooting instant's Kp, and the OVATION nowcast when it applies.
  const tideCell = layers.tides && tides?.phase === "ready" ? tides.series?.cell ?? null : null;
  const auroraKp = layers.aurora && aurora?.phase === "ready"
    ? kpAt(Date.parse(plan.instant), aurora.kp ?? null, aurora.outlook ?? null)?.kp ?? null : null;
  const nowcast = layers.aurora && aurora?.ovation && ovationApplies(aurora.ovation, Date.parse(plan.instant)) ? aurora.ovation : null;
  const environment = useMemo<GeoJSON.FeatureCollection>(() => {
    const features: GeoJSON.Feature[] = [];
    try {
      if (nowcast)
        for (const cell of ovationCells(nowcast))
          features.push({ type: "Feature", properties: { kind: "aurora-cell", band: cell.band }, geometry: { type: "Polygon", coordinates: [cell.ring] } });
      if (auroraKp !== null)
        for (const line of auroraLines(plan.instant, auroraKp))
          features.push({ type: "Feature", properties: { kind: `aurora-${line.kind}` }, geometry: { type: "LineString", coordinates: line.coordinates } });
    } catch { /* The panel reports aurora failures. */ }
    if (tideCell) features.push({ type: "Feature", properties: { kind: "tide-cell" }, geometry: { type: "Point", coordinates: [tideCell.longitude, tideCell.latitude] } });
    return { type: "FeatureCollection", features };
  }, [tideCell?.latitude, tideCell?.longitude, auroraKp, nowcast, auroraKp === null ? "" : plan.instant]);
  // 推算: ground targets placed by a click, and the results drawn as lines (geometry and body kinds from its module).
  const solve = alignment?.active ? alignment : null;
  const placingTarget = !!solve?.placing;
  const alignmentFeatures = useMemo(
    () => (solve ? solve.module.compositionGeometry(solve, plan.timeZone) : emptyFeatures),
    [solve, solve?.composition.targets, solve?.run, solve?.current, plan.timeZone],
  );
  const alignmentBody = solve?.run?.basis.bodies[0] ?? solve?.composition.targets.find((target) => target.kind === "sky")?.body ?? "sun";
  const alignmentKind = solve ? solve.module.bodyKind(alignmentBody) : "sun";
  return { lines, eclipse, environment, tideCell, auroraKp, solve, placingTarget, alignmentFeatures, alignmentKind };
}

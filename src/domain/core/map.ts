import type { FeatureCollection, LineString, Polygon, Position } from "geojson";
import { fieldOfView, normalizeLongitude, signedAngle } from "./plan.ts";
import type { ShootingPlan } from "./plan.ts";
import { ellipsoidalRay } from "./geodesy.ts";

export const MAX_MAP_LATITUDE = 85.0511287798066;
const EARTH_RADIUS = 6_371_008.8;
const radians = (degrees: number) => (degrees * Math.PI) / 180;
const degrees = (value: number) => (value * 180) / Math.PI;

export interface MapPoint {
  longitude: number;
  latitude: number;
}
export interface MapViewport extends MapPoint {
  zoom: number;
  bearing: number;
}
export type MapMode = "browse" | "position" | "direction";
export type ViewGeometry = FeatureCollection<
  Polygon | LineString,
  { kind: "field" | "direction" }
>;

export function isMapPosition(point: MapPoint) {
  return (
    Number.isFinite(point.longitude) &&
    Number.isFinite(point.latitude) &&
    Math.abs(point.latitude) <= MAX_MAP_LATITUDE
  );
}

// Use the closest copy of a longitude when the map has crossed the date line.
export function nearbyLongitude(longitude: number, reference: number) {
  return reference + signedAngle(longitude - reference);
}

export function initialBearing(from: MapPoint, to: MapPoint): number | null {
  if (
    ![from.longitude, from.latitude, to.longitude, to.latitude].every(
      Number.isFinite,
    ) ||
    Math.abs(from.latitude) >= 90 ||
    Math.abs(to.latitude) > 90
  )
    return null;
  if(Math.abs(from.latitude+to.latitude)<1e-10 && Math.abs(Math.abs(signedAngle(to.longitude-from.longitude))-180)<1e-10)return null;
  const [east,north] = ellipsoidalRay(
    { ...from, longitude:normalizeLongitude(from.longitude), ellipsoidalHeight:0 },
    { ...to, longitude:normalizeLongitude(to.longitude), ellipsoidalHeight:0 });
  if (Math.hypot(east,north) < 1e-6) return null;
  return (degrees(Math.atan2(east,north)) + 360) % 360;
}

function sphericalDestination(
  from: MapPoint,
  bearing: number,
  meters: number,
): MapPoint {
  const start = radians(from.latitude);
  const angle = meters / EARTH_RADIUS;
  const heading = radians(bearing);
  const latitude = Math.asin(
    Math.max(
      -1,
      Math.min(
        1,
        Math.sin(start) * Math.cos(angle) +
          Math.cos(start) * Math.sin(angle) * Math.cos(heading),
      ),
    ),
  );
  const longitude =
    radians(from.longitude) +
    Math.atan2(
      Math.sin(heading) * Math.sin(angle) * Math.cos(start),
      Math.cos(angle) - Math.sin(start) * Math.sin(latitude),
    );
  return {
    longitude: normalizeLongitude(degrees(longitude)),
    latitude: degrees(latitude),
  };
}

// The radius is schematic. Keep each ray's actual local ENU azimuth exact so
// the map handle/cone agrees with the photographic camera, even at long focal lengths.
export function destination(from:MapPoint,bearing:number,meters:number):MapPoint {
  let heading=bearing,point=sphericalDestination(from,heading,meters);
  for(let i=0;i<4;i++){
    const actual=initialBearing(from,point);if(actual===null)break;
    const correction=signedAngle(bearing-actual);if(Math.abs(correction)<1e-10)break;
    heading+=correction;point=sphericalDestination(from,heading,meters);
  }
  return point;
}

export function mapSelection(
  plan: ShootingPlan,
  point: MapPoint,
  mode: MapMode,
): Partial<ShootingPlan> | null {
  if (mode === "browse") return null;
  if (!isMapPosition(point)) return null;
  if (mode === "position")
    return {
      longitude: normalizeLongitude(point.longitude),
      latitude: point.latitude,
    };
  if (!isMapPosition(plan)) return null;
  const azimuth = initialBearing(plan, point);
  return azimuth === null
    ? null
    : { azimuth };
}

export function viewRadiusMeters(point: MapPoint, zoom: number) {
  if (!isMapPosition(point) || !Number.isFinite(zoom)) return 0;
  const pixelRadius = 140;
  const onScreen =
    ((2 * Math.PI * EARTH_RADIUS * Math.cos(radians(point.latitude))) /
      (512 * 2 ** zoom)) *
    pixelRadius;
  const toCoverageEdge =
    radians(MAX_MAP_LATITUDE - Math.abs(point.latitude)) * EARTH_RADIUS * 0.75;
  return Math.max(0, Math.min(Math.max(25, onScreen), 250_000, toCoverageEdge));
}

export function viewGeometry(plan: ShootingPlan, zoom: number): ViewGeometry {
  const radius = viewRadiusMeters(plan, zoom);
  if (radius < 1) return { type: "FeatureCollection", features: [] };
  const origin: Position = [plan.longitude, plan.latitude];
  const coordinates = (point: MapPoint): Position => [
    nearbyLongitude(point.longitude, plan.longitude),
    point.latitude,
  ];
  const halfView = fieldOfView(plan).horizontal / 2;
  // Reverse the arc to give the polygon exterior counterclockwise winding.
  const arc = Array.from({ length: 49 }, (_, index) =>
    coordinates(
      destination(
        plan,
        plan.azimuth + halfView - (index / 48) * halfView * 2,
        radius,
      ),
    ),
  );
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { kind: "field" },
        geometry: { type: "Polygon", coordinates: [[origin, ...arc, origin]] },
      },
      {
        type: "Feature",
        properties: { kind: "direction" },
        geometry: {
          type: "LineString",
          coordinates: [
            origin,
            coordinates(destination(plan, plan.azimuth, radius)),
          ],
        },
      },
    ],
  };
}

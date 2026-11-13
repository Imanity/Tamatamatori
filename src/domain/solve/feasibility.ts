import { travel } from "./position-alignment.ts";

/**
 * "检查机位": is a solved camera position on water, inside a building
 * outline, or looking into a building within the first stretch of its sight
 * line? Pure geometry over decoded vector features and a DEM sampler.
 */
export const CHECK_RADIUS = 2000;
/** Positions and vector tiles read by one check. */
export const CHECK_LIMIT = 60;
export const CHECK_TILE_LIMIT = 40;
export const CHECK_ZOOM = 14;
const EARTH = 6_371_008.8;
const degrees = Math.PI / 180;
// Points along each sight line whose tiles are read, metres apart.
const SIGHT_STEP = 250;

export type Coordinate = { latitude: number; longitude: number };
/** One polygon: the outer ring first, holes after (rings need not be closed). */
export interface Area {
  rings: Coordinate[][];
}
export interface Footprint extends Area {
  /** Top and bottom above the ground, metres (render_height, render_min_height). */
  height: number;
  base: number;
}
export interface Features {
  water: Area[];
  buildings: Footprint[];
}
export interface CheckTarget {
  key: string;
  latitude: number;
  longitude: number;
  /** DEM ground under the camera when the solver knows it; sampled otherwise. */
  ground?: number;
  cameraHeight: number;
  /** Direction of the sight line (to the body), degrees. */
  azimuth: number;
  elevation: number;
}
export interface PlaceCheck {
  water: boolean;
  inside: boolean;
  /** The nearest building that rises above the sight line within CHECK_RADIUS. */
  blocked: { distance: number; above: number; height: number } | null;
  /** No DEM ground for the camera: the sight line could not be placed. */
  unknown: boolean;
}

type Point = { x: number; y: number };
/** Local east/north metres around an origin (enough within a few kilometres). */
export function projector(origin: Coordinate) {
  const scale = Math.cos(origin.latitude * degrees);
  return (point: Coordinate): Point => ({
    x: (point.longitude - origin.longitude) * degrees * EARTH * scale,
    y: (point.latitude - origin.latitude) * degrees * EARTH,
  });
}

/** Even-odd rule over all rings, so holes count. */
export function insideRings(rings: readonly (readonly Point[])[], point: Point) {
  let inside = false;
  for (const ring of rings)
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const a = ring[index], b = ring[previous];
      if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  return inside;
}

/** Distances along the ray from the origin (unit `direction`) where it crosses the rings' edges, up to `limit`, sorted. */
export function rayCrossings(rings: readonly (readonly Point[])[], direction: Point, limit: number) {
  const found: number[] = [];
  for (const ring of rings)
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const a = ring[previous], b = ring[index];
      const edge = { x: b.x - a.x, y: b.y - a.y };
      const denominator = direction.x * edge.y - direction.y * edge.x;
      if (Math.abs(denominator) < 1e-12) continue;
      // origin + t·direction = a + s·edge
      const t = (a.x * edge.y - a.y * edge.x) / denominator;
      const s = (a.x * direction.y - a.y * direction.x) / denominator;
      if (t > 0 && t <= limit && s >= 0 && s < 1) found.push(t);
    }
  return found.sort((a, b) => a - b);
}

/** Height of the straight sight line above the reference sphere's surface at a ground distance: rises with the angle and with the curve. */
export const sightHeight = (eye: number, distance: number, elevation: number) =>
  eye + distance * Math.tan(elevation * degrees) + (distance * distance) / (2 * EARTH);

/** Where the tiles of a check come from: the camera and points along its sight line. */
export function checkPoints(target: CheckTarget) {
  const points: Coordinate[] = [{ latitude: target.latitude, longitude: target.longitude }];
  for (let distance = SIGHT_STEP; distance <= CHECK_RADIUS; distance += SIGHT_STEP) points.push(travel(target, target.azimuth, distance));
  return points;
}

const boundsOf = (area: Area) => {
  let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
  for (const point of area.rings[0] ?? []) {
    south = Math.min(south, point.latitude); north = Math.max(north, point.latitude);
    west = Math.min(west, point.longitude); east = Math.max(east, point.longitude);
  }
  return { south, north, west, east };
};
/** Bounds once per feature, for the quick rejection of far ones. */
export function indexFeatures(features: Features) {
  return {
    water: features.water.map((area) => ({ area, bounds: boundsOf(area) })),
    buildings: features.buildings.map((area) => ({ area, bounds: boundsOf(area) })),
  };
}
type Indexed = ReturnType<typeof indexFeatures>;

export function checkPlace(target: CheckTarget, features: Indexed, ground: (latitude: number, longitude: number) => number | null): PlaceCheck {
  const project = projector(target);
  const origin = { x: 0, y: 0 };
  const contains = (bounds: ReturnType<typeof boundsOf>) =>
    target.latitude >= bounds.south && target.latitude <= bounds.north && target.longitude >= bounds.west && target.longitude <= bounds.east;
  const water = features.water.some(({ area, bounds }) => contains(bounds) && insideRings(area.rings.map((ring) => ring.map(project)), origin));
  const cameraGround = target.ground ?? ground(target.latitude, target.longitude);
  const direction = { x: Math.sin(target.azimuth * degrees), y: Math.cos(target.azimuth * degrees) };
  let inside = false;
  let blocked: PlaceCheck["blocked"] = null;
  for (const { area, bounds } of features.buildings) {
    // Quick rejection: the outline's box must reach the sight line's first CHECK_RADIUS metres.
    const corners = [project({ latitude: bounds.south, longitude: bounds.west }), project({ latitude: bounds.north, longitude: bounds.east })];
    const centre = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
    const reach = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y) / 2;
    const along = centre.x * direction.x + centre.y * direction.y;
    const across = Math.abs(centre.x * direction.y - centre.y * direction.x);
    const atCamera = Math.hypot(centre.x, centre.y) <= reach;
    if (!atCamera && (across > reach || along < -reach || along > CHECK_RADIUS + reach)) continue;
    const rings = area.rings.map((ring) => ring.map(project));
    if (insideRings(rings, origin)) {
      // The camera's own outline: reported, not counted as an obstruction.
      inside = true;
      continue;
    }
    if (cameraGround === null) continue;
    const crossings = rayCrossings(rings, direction, CHECK_RADIUS);
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const enter = crossings[index], leave = crossings[index + 1];
      if (blocked && enter >= blocked.distance) break;
      const point = travel(target, target.azimuth, enter);
      const base = ground(point.latitude, point.longitude) ?? cameraGround;
      const eye = cameraGround + target.cameraHeight;
      const low = Math.min(sightHeight(eye, enter, target.elevation), sightHeight(eye, leave, target.elevation));
      const high = Math.max(sightHeight(eye, enter, target.elevation), sightHeight(eye, leave, target.elevation));
      const top = base + area.height, bottom = base + area.base;
      if (low < top && high > bottom) {
        blocked = { distance: Math.round(enter), above: Math.round(top - sightHeight(eye, enter, target.elevation)), height: area.height };
        break;
      }
    }
  }
  return { water, inside, blocked, unknown: cameraGround === null };
}

/** Short label for a result row. */
export function checkLabel(check: PlaceCheck) {
  const parts: string[] = [];
  if (check.water) parts.push("机位在水面");
  if (check.inside) parts.push("机位在建筑轮廓内");
  if (check.unknown) parts.push("机位处地形数据不全，未查遮挡");
  else if (check.blocked) parts.push(`${check.blocked.distance < 1 ? "紧邻的" : `${check.blocked.distance} m 处`}建筑高出视线 ${Math.max(1, check.blocked.above)} m`);
  else parts.push(`${CHECK_RADIUS / 1000} km 内无建筑遮挡`);
  return parts.join(" · ");
}

/** Targets, in list order, that fit one check: at most CHECK_LIMIT positions and CHECK_TILE_LIMIT z14 tiles. */
export function fitTargets(targets: readonly CheckTarget[], tileOf: (point: Coordinate) => string) {
  const chosen: CheckTarget[] = [];
  const tiles = new Set<string>();
  for (const target of targets.slice(0, CHECK_LIMIT)) {
    const own = new Set(checkPoints(target).map(tileOf));
    const added = [...own].filter((key) => !tiles.has(key));
    if (tiles.size + added.length > CHECK_TILE_LIMIT) break;
    for (const key of added) tiles.add(key);
    chosen.push(target);
  }
  return { targets: chosen, tiles: tiles.size };
}

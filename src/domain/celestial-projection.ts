import type { ShootingPlan } from "./plan.ts";
import { fieldOfView } from "./plan.ts";
import type { SkyBody, Vector3 } from "./ephemeris.ts";
import { add, degrees, direction, dot, scale, unit } from "./ephemeris.ts";
import { apparentElevation, refractDirection } from "./refraction.ts";

export type View = Pick<ShootingPlan, "azimuth" | "pitch" | "focalLength" | "sensor" | "aspectRatio" | "orientation"> & Partial<Pick<ShootingPlan, "refraction">>;
const cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function cameraBasis(plan: View) {
  const az = plan.azimuth * degrees, pitch = plan.pitch * degrees;
  const fov = fieldOfView(plan);
  return {
    forward: direction(plan.azimuth, plan.pitch),
    right: [Math.cos(az), -Math.sin(az), 0] as Vector3,
    up: [-Math.sin(az) * Math.sin(pitch), -Math.cos(az) * Math.sin(pitch), Math.cos(pitch)] as Vector3,
    tx: Math.tan(fov.horizontal * degrees / 2), ty: Math.tan(fov.vertical * degrees / 2),
  };
}

export function projectDirection(plan: View, ray: Vector3) {
  const basis = cameraBasis(plan), depth = dot(ray, basis.forward);
  if (depth <= 1e-9) return null;
  return { x: dot(ray, basis.right) / (depth * basis.tx), y: -dot(ray, basis.up) / (depth * basis.ty) };
}

/** Camera-plane bearing to an off-screen target, including targets behind us. */
export function frameEdgeDirection(plan: View, ray: Vector3) {
  const basis = cameraBasis(plan), depth = dot(ray,basis.forward);
  let right = dot(ray,basis.right), down = -dot(ray,basis.up);
  if (![depth,right,down].every(Number.isFinite) || Math.hypot(...ray)<1e-12) return null;
  // At the exact antipode every turning plane is valid; choose a stable side.
  const antipode = Math.hypot(right,down)<1e-9;
  if (antipode) { right=1; down=0; }
  const x=right/basis.tx,y=down/basis.ty,extent=Math.max(Math.abs(x),Math.abs(y));
  const angle=Math.atan2(down,right)/degrees;
  const labels=["右方","右下方","下方","左下方","左方","左上方","上方","右上方"];
  const behind=depth < -1e-9;
  return {x:x/extent,y:y/extent,angle,behind,
    label:antipode&&behind?"后方":labels[(Math.round(angle/45)+8)%8]};
}

// Clip in 3D before dividing by depth: safe at the horizon and camera plane.
function clipPolygon(points: Vector3[], plane: (point: Vector3) => number) {
  const output: Vector3[] = [];
  for (let index = 0; index < points.length; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    const da = plane(a), db = plane(b);
    if (da >= 0) output.push(a);
    if ((da >= 0) !== (db >= 0)) output.push(add(a, scale(add(b, scale(a, -1)), da / (da - db))));
  }
  return output;
}

function projectedPolygon(plan: View, points: Vector3[]) {
  points = points.map((point) => refractDirection(point, plan.refraction));
  const basis = cameraBasis(plan);
  const planes = [
    (p: Vector3) => p[2],
    (p: Vector3) => dot(p, basis.forward) - 1e-9,
    (p: Vector3) => dot(p, basis.forward) * basis.tx - dot(p, basis.right),
    (p: Vector3) => dot(p, basis.forward) * basis.tx + dot(p, basis.right),
    (p: Vector3) => dot(p, basis.forward) * basis.ty - dot(p, basis.up),
    (p: Vector3) => dot(p, basis.forward) * basis.ty + dot(p, basis.up),
  ];
  for (const plane of planes) points = clipPolygon(points, plane);
  return points.map((point) => projectDirection(plan, point)).filter((point) => point !== null);
}

function tangentAxes(body: SkyBody) {
  const az = body.azimuth * degrees;
  const right: Vector3 = [Math.cos(az), -Math.sin(az), 0];
  return { right, up: cross(right, body.direction) };
}

function discRay(body: SkyBody, right: Vector3, up: Vector3, x: number, y: number) {
  const radius = Math.tan(body.angularRadius * degrees);
  return add(body.direction, add(scale(right, radius * x), scale(up, radius * y)));
}

export function bodyPolygons(plan: View, body: SkyBody) {
  const axes = tangentAxes(body);
  const samples = 64;
  const circle = Array.from({ length: samples }, (_, index) => {
    const angle = 2 * Math.PI * index / samples;
    return discRay(body, axes.right, axes.up, Math.cos(angle), Math.sin(angle));
  });
  const outline = projectedPolygon(plan, circle);
  let illuminated = outline;
  if (body.id === "moon") {
    const cosine = dot(body.lightDirection, body.direction);
    const tangent = add(body.lightDirection, scale(body.direction, -cosine));
    const brightSide = Math.hypot(...tangent) > 1e-10 ? unit(tangent) : axes.right;
    const up = cross(brightSide, body.direction);
    const limb: Vector3[] = [], terminator: Vector3[] = [];
    for (let index = 0; index <= samples / 2; index++) {
      const angle = Math.PI * index / (samples / 2);
      limb.push(discRay(body, brightSide, up, Math.sin(angle), Math.cos(angle)));
      terminator.unshift(discRay(body, brightSide, up, cosine * Math.sin(angle), Math.cos(angle)));
    }
    illuminated = projectedPolygon(plan, [...limb, ...terminator]);
  }
  const visualElevation = apparentElevation(body.elevation, plan.refraction);
  const state = apparentElevation(Math.min(90, body.elevation + body.angularRadius), plan.refraction) <= 0
    ? "地平线下"
    : outline.length < 3 ? "视场外" : "画面内";
  const ray = refractDirection(body.direction, plan.refraction);
  return { outline, illuminated, centre: projectDirection(plan, ray), state, visualElevation,
    indicator: state === "视场外" ? frameEdgeDirection(plan,ray) : null };
}

export function polygonPath(points: { x: number; y: number }[]) {
  return points.length < 3 ? "" : `${points.map((p, index) => `${index ? "L" : "M"}${p.x.toFixed(8)},${p.y.toFixed(8)}`).join(" ")}Z`;
}

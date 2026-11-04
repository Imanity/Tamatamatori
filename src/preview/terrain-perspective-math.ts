import { ellipsoidalRay } from "../domain/geodesy.ts";
import type { EllipsoidalPoint } from "../domain/geodesy.ts";
import type { ShootingPlan } from "../domain/plan.ts";
import { fieldOfView, normalizeLongitude } from "../domain/plan.ts";

type Vec3 = [number, number, number];
export type PhotoTile = { z: number; x: number; y: number };
const rad = Math.PI / 180;
const e2 = 0.0066943799901413165;
export const photoFragmentDepth = (distance: number) => Math.max(0,Math.min(0.9999999,Math.log1p(Math.max(0,distance))/Math.log1p(1e7)));
/** Reference for the shared fragment kernel, after homogeneous interpolation. */
export const photoFogDepth = (z: number, w: number) => w <= 0 ? 0 : Math.max(0,Math.min(1,z/w*0.5+0.5));
const axes = (lat: number, lon: number): Vec3[] => {
  const a = lat * rad, b = lon * rad, s = Math.sin(a), c = Math.cos(a), t = Math.sin(b), u = Math.cos(b);
  return [[-t,u,0],[-s*u,-s*t,c],[c*u,c*t,s]];
};
const dot = (a: number[], b: number[]) => a.reduce((s,v,i) => s + v*b[i],0);

export function photoTileFrame(eye: EllipsoidalPoint, tile: PhotoTile, wrap = 0) {
  const scale = 2 ** tile.z;
  const longitude = (tile.x + 0.5) / scale * 360 - 180;
  const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tile.y + 0.5) / scale))) / rad;
  // Physical positions repeat after a world wrap; ECEF needs no huge X offset.
  void wrap;
  const a = axes(eye.latitude, eye.longitude), b = axes(latitude, longitude);
  const sin = Math.sin(latitude * rad), cos = Math.cos(latitude * rad);
  return {
    tile: [sin, cos, 6378137 / Math.sqrt(1 - e2 * sin * sin), 2 * Math.PI / scale / 8192],
    base: ellipsoidalRay({ ...eye, longitude: normalizeLongitude(eye.longitude) }, { latitude, longitude, ellipsoidalHeight: 0 }),
    basis: b.flatMap(axis => a.map(observerAxis => dot(axis, observerAxis))),
  };
}

export function photoCameraMatrix(plan: Pick<ShootingPlan,"azimuth"|"pitch"|"sensor"|"focalLength"|"aspectRatio"|"orientation"|"cameraHeight">) {
  const az = plan.azimuth * rad, pitch = plan.pitch * rad, fov = fieldOfView(plan);
  const right = [Math.cos(az),-Math.sin(az),0];
  const up = [-Math.sin(az)*Math.sin(pitch),-Math.cos(az)*Math.sin(pitch),Math.cos(pitch)];
  const forward = [Math.sin(az)*Math.cos(pitch),Math.cos(az)*Math.cos(pitch),Math.sin(pitch)];
  const tx = Math.tan(fov.horizontal*rad/2), ty = Math.tan(fov.vertical*rad/2);
  const near = Math.max(0.005,Math.min(1,plan.cameraHeight/4));
  // Infinite-far perspective; the celestial background sits at clip z/w = 1.
  return new Float32Array([0,1,2].flatMap(i => [right[i]/tx,up[i]/ty,forward[i],forward[i]]).concat([0,0,-2*near,0]));
}

/** CPU replay of the stable shader kernel, checked against independent ECEF. */
export function photoTileRay(frame: ReturnType<typeof photoTileFrame>, p: [number,number], h: number): Vec3 {
  const [s,c,n0,step] = frame.tile, t = -(p[1]-4096)*step, sh = Math.sinh(t/2);
  const dp = 2*Math.atan(c*sh/(Math.sqrt(1+sh*sh)+s*sh)), dl=(p[0]-4096)*step;
  const sd=Math.sin(dp),cp1=-2*Math.sin(dp/2)**2,cl1=-2*Math.sin(dl/2)**2;
  const ds=s*cp1+c*sd,cos=c*(1+cp1)-s*sd;
  const v=e2*ds*(2*s+ds)/(1-e2*s*s),root=Math.sqrt(1-v),dn=n0*v/(root*(1+root));
  const n=n0+dn,r=n+h,k=e2*(dn*s+n*ds);
  const local=[r*cos*Math.sin(dl),r*sd-k*c-r*cos*s*cl1,h+dn-k*s+r*(cp1+cos*c*cl1)];
  return frame.base.map((v,i)=>v+local.reduce((sum,x,j)=>sum+frame.basis[j*3+i]*x,0)) as Vec3;
}

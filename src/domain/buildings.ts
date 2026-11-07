import earcut from "earcut";
import { normalizeLongitude } from "./plan.ts";
import type { ShootingPlan } from "./plan.ts";
import { terrainTile } from "./terrain.ts";
import type { PhotoTile } from "../preview/terrain-perspective-math.ts";
import type { EllipsoidalPoint } from "./geodesy.ts";

export const BUILDING_NEAR_RADIUS = 2000;
export const BUILDING_RADIUS = 5000;
export const BUILDING_FAR_MIN_HEIGHT = 20;
export const BUILDING_MAX_TILES = 48;
export const BUILDING_MAX_TRIANGLES = 300000;
export const BUILDING_MAX_POINTS = 160000;
export type BuildingPoint = { x: number; y: number };
export interface BuildingPolygon {
  rings: BuildingPoint[][];
  height: number;
  base: number;
}
export interface BuildingMesh { tile: PhotoTile; vertices: Float32Array; indices?:Uint32Array; anchor?:EllipsoidalPoint }
export interface BuildingStatus {
  key: string;
  phase: "off" | "loading" | "ready" | "empty" | "error";
  limited: boolean;
  tiles: number;
  polygons: number;
  triangles: number;
  bytes: number;
  skipped: number;
  candidates?: number;
  distant?: number;
  distantCandidates?: number;
  removedPoints?: number;
  version?: string;
  fetchedAt?: string;
  message?: string;
  landmark?: { phase:"applied"|"fallback"; triangles?:number; distance?:number; message:string };
}
export const emptyBuildings: BuildingStatus = { key: "", phase: "off", limited: false, tiles: 0, polygons: 0, triangles: 0, bytes: 0, skipped: 0 };
export const buildingKey = (plan: Pick<ShootingPlan,"longitude"|"latitude">) => `${plan.longitude}/${plan.latitude}`;

export interface BuildingCandidate {
  id: string;
  points: number;
  triangles: number;
  height: number;
  east: number;
  north: number;
  footprint: number;
}

/** Remove only redundant source vertices; no tolerance or footprint expansion. */
export function simplifyBuilding(polygon:BuildingPolygon):BuildingPolygon {
  return {...polygon,rings:polygon.rings.map(ring=>{
    const open:BuildingPoint[]=[];
    for(const p of ring)if(!open.length||p.x!==open.at(-1)!.x||p.y!==open.at(-1)!.y)open.push(p);
    if(open.length>1&&open[0].x===open.at(-1)!.x&&open[0].y===open.at(-1)!.y)open.pop();
    const reduced=open.filter((p,i)=>{
      const a=open[(i+open.length-1)%open.length],b=open[(i+1)%open.length];
      const ux=p.x-a.x,uy=p.y-a.y,vx=b.x-p.x,vy=b.y-p.y;
      return ux*vy-uy*vx!==0||ux*vx+uy*vy<0;
    });
    const result=reduced.length>=3?reduced:open;
    return result.length?[...result,result[0]]:[];
  })};
}

/** Conservative roof + courtyard + walls cost, including raised undersides. */
export function buildingCost(polygon: BuildingPolygon) {
  const rings=polygon.rings.map(r=>r.length>1&&r[0].x===r.at(-1)!.x&&r[0].y===r.at(-1)!.y?r.slice(0,-1):r).filter(r=>r.length>=3);
  const vertices=rings.reduce((sum,r)=>sum+r.length,0);
  return {points:polygon.rings.reduce((sum,r)=>sum+r.length,0),
    triangles:rings.length?Math.max(0,vertices+2*(rings.length-1)-2)*(polygon.base>0?2:1)+2*vertices:0};
}

/** Stable regional selection: high-rise reserve, spatial coverage, then detail. */
export function selectBuildings<T extends BuildingCandidate>(candidates:T[],maxPoints=BUILDING_MAX_POINTS,maxTriangles=BUILDING_MAX_TRIANGLES) {
  const score=(c:T)=>Math.max(c.height,c.footprint*0.5)/Math.max(20,Math.hypot(c.east,c.north));
  const sorted=[...candidates].sort((a,b)=>score(b)-score(a)||a.id.localeCompare(b.id));
  const selected:T[]=[],ids=new Set<string>();let points=0,triangles=0;
  const add=(c:T,fraction:number)=>{
    if(ids.has(c.id)||!c.triangles||points+c.points>maxPoints*fraction||triangles+c.triangles>maxTriangles*fraction)return false;
    ids.add(c.id);selected.push(c);points+=c.points;triangles+=c.triangles;return true;
  };
  for(const c of sorted)if(Math.hypot(c.east,c.north)>BUILDING_NEAR_RADIUS)add(c,0.25);
  for(const c of sorted)if(c.height>=80)add(c,0.5);
  const cells=new Map<string,T[]>();
  for(const c of sorted){if(Math.hypot(c.east,c.north)>BUILDING_NEAR_RADIUS)continue;const key=`${Math.floor(c.east/500)}/${Math.floor(c.north/500)}`;const cell=cells.get(key)??[];cell.push(c);cells.set(key,cell);}
  const groups=[...cells].sort(([a],[b])=>a.localeCompare(b)).map(([,cell])=>cell);
  for(let row=0;groups.some(g=>row<g.length);row++) {
    if(points>=maxPoints*0.7||triangles>=maxTriangles*0.7)break;
    for(const g of groups)if(g[row])add(g[row],0.7);
  }
  for(const c of sorted)add(c,1);
  return {selected,points,triangles,limited:selected.length<candidates.length};
}

/** A bounded square around the observer, independent of camera rotation/lens. */
export function buildingTiles(point: Pick<ShootingPlan,"longitude"|"latitude">) {
  const tile = terrainTile(point,14), n=2**14;
  const width=40075016.686*Math.cos(point.latitude*Math.PI/180)/n;
  const radius=Math.ceil(BUILDING_RADIUS/width+0.5);
  const all: Array<PhotoTile & { distance: number }> = [];
  for(let dy=-radius;dy<=radius;dy++) for(let dx=-radius;dx<=radius;dx++) {
    const x=tile.x+dx,y=tile.y+dy;
    if(y<0||y>=n) continue;
    const distance=Math.hypot(dx+0.5-tile.u,dy+0.5-tile.v)*width;
    // Include tiles whose bounding box intersects the requested circle.
    const near=Math.hypot(Math.max(0,Math.abs(dx+0.5-tile.u)-0.5),Math.max(0,Math.abs(dy+0.5-tile.v)-0.5))*width;
    if(near<=BUILDING_RADIUS) all.push({z:14,x:(x%n+n)%n,y,distance});
  }
  all.sort((a,b)=>a.distance-b.distance||a.y-b.y||a.x-b.x);
  return { tiles: all.slice(0,BUILDING_MAX_TILES).map(({z,x,y})=>({z,x,y})), limited: all.length>BUILDING_MAX_TILES };
}

export function buildingHeights(properties: Record<string,unknown>) {
  if(properties.hide_3d === true || properties.hide_3d === 1) return null;
  const height=properties.render_height,base=properties.render_min_height;
  if(typeof height!=="number" || typeof base!=="number" || !Number.isFinite(height) || !Number.isFinite(base) ||
    height<=0 || height>1500 || base<0 || base>=height) return null;
  return {height,base};
}

export function buildingCoordinates(tile: PhotoTile, x: number, y: number) {
  const n=2**tile.z;
  return { longitude: normalizeLongitude((tile.x+x/8192)/n*360-180),
    latitude: Math.atan(Math.sinh(Math.PI*(1-2*(tile.y+y/8192)/n)))*180/Math.PI };
}

export function buildingBounds(polygon: BuildingPolygon) {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const p of polygon.rings[0]) { minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y); }
  return {minX,minY,maxX,maxY,x:(minX+maxX)/2,y:(minY+maxY)/2};
}

/** Flat local roof, underground skirt for ground-level walls; no invented height. */
export function buildingGeometry(polygon: BuildingPolygon, ground: number, minimumGround: number) {
  if(!Number.isFinite(ground)||!Number.isFinite(minimumGround)) throw new RangeError("建筑基座高程无效");
  const rings=polygon.rings.map(r=>r.length>1&&r[0].x===r.at(-1)!.x&&r[0].y===r.at(-1)!.y?r.slice(0,-1):r).filter(r=>r.length>=3);
  if(!rings.length) return [];
  const flat:number[]=[],holes:number[]=[];
  rings.forEach((ring,i)=>{if(i)holes.push(flat.length/2);for(const p of ring)flat.push(p.x,p.y);});
  const roof=ground+polygon.height,base=polygon.base>0?ground+polygon.base:Math.min(ground,minimumGround)-2;
  const vertices:number[]=[];
  const add=(p:BuildingPoint,z:number,nx:number,ny:number,nz:number)=>vertices.push(p.x,p.y,z,nx,ny,nz);
  const triangles=earcut(flat,holes,2);
  for(const index of triangles) add({x:flat[index*2],y:flat[index*2+1]},roof,0,0,1);
  // Elevated parts have an opaque underside; keep courtyards open on both
  // surfaces. Ground-level skirts need no extra buried floor triangles.
  if(polygon.base>0)for(const index of triangles) add({x:flat[index*2],y:flat[index*2+1]},base,0,0,-1);
  rings.forEach((ring,index)=>{
    const area=ring.reduce((sum,p,i)=>{const q=ring[(i+1)%ring.length];return sum+p.x*q.y-q.x*p.y;},0);
    const sign=(area>=0?1:-1)*(index? -1:1);
    for(let i=0;i<ring.length;i++) {
      const p=ring[i],q=ring[(i+1)%ring.length],dx=q.x-p.x,dy=q.y-p.y,len=Math.hypot(dx,dy);
      if(!len)continue;
      // Tile buffer is clipped in the fragment shader. Suppress artificial
      // zero-buffer boundary walls, preserving roofs and real crossing walls.
      if([0,8192].some(edge=>(p.x===edge&&q.x===edge)||(p.y===edge&&q.y===edge)))continue;
      const nx=sign*dy/len,ny=sign*dx/len;
      add(p,base,nx,ny,0);add(q,base,nx,ny,0);add(q,roof,nx,ny,0);
      add(p,base,nx,ny,0);add(q,roof,nx,ny,0);add(p,roof,nx,ny,0);
    }
  });
  return vertices;
}

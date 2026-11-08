import { ellipsoidalRay } from "./geodesy.ts";
import type { EllipsoidalPoint } from "./geodesy.ts";
import catalog from "../data/landmarks.generated.json" with { type: "json" };

export interface LandmarkDefinition {
  id:string; name:string; latitude:number; longitude:number;
  tile:{z:number;x:number;y:number};
  parts:readonly {id:number;height:number;base:number;tile?:{z:number;x:number;y:number}}[];
  partRadius:number;
  bounds:{horizontal:number;height:number};
  asset:{file:string;sha256:string;decodedSha256:string;bytes:number;decodedBytes:number;vertices:number;triangles:number};
  credit:{title:string;author:string;authorPage:string;page:string;license:string;licenseUrl:string;use?:string;changes:string;registration:string;references:readonly {title:string;url:string}[]};
  validation:{cpu:string;visual:string};
}
/** Generated offline from reviewed recipes; never edit individual entries here. */
export const landmarks:readonly LandmarkDefinition[]=catalog;
export const skytree=landmarks.find(t=>t.id==="tokyo-skytree")!;
export const shanghaiTower=landmarks.find(t=>t.id==="shanghai-tower")!;
export const tokyoTower=landmarks.find(t=>t.id==="tokyo-tower")!;
export type LandmarkGeometry = { vertices:Float32Array; indices:Uint32Array };
export const LANDMARK_RADIUS=50000;

/** Bounded registered asset format; no runtime glTF or image decoder. */
export function decodeLandmark(bytes:Uint8Array,target:LandmarkDefinition=skytree):LandmarkGeometry {
  if(bytes.length<32||bytes.length>4*1024*1024)throw new Error("地标文件长度无效");
  const copy=new Uint8Array(bytes),view=new DataView(copy.buffer);
  if(new TextDecoder().decode(copy.subarray(0,4))!=="TTLM"||view.getUint32(4,true)!==1||view.getUint32(16,true)!==6||
    [20,24,28].some(i=>view.getUint32(i,true)!==0))throw new Error("地标格式无效");
  const count=view.getUint32(8,true),length=view.getUint32(12,true);
  if(!count||count>128000||!length||length%3||length>300000||32+count*24+length*4!==copy.length)throw new Error("地标网格超出预算");
  const vertices=new Float32Array(copy.buffer,32,count*6),indices=new Uint32Array(copy.buffer,32+count*24,length);
  for(let i=0;i<vertices.length;i+=6){const [e,n,u,nx,ny,nz]=vertices.subarray(i,i+6);
    if(![e,n,u,nx,ny,nz].every(Number.isFinite)||Math.abs(e)>target.bounds.horizontal||Math.abs(n)>target.bounds.horizontal||u<-.01||u>target.bounds.height+.01||Math.hypot(nx,ny,nz)<.1||Math.hypot(nx,ny,nz)>1.1)throw new Error("地标坐标无效");
  }
  for(const index of indices)if(index>=count)throw new Error("地标索引无效");
  return {vertices,indices};
}

/** Anchor ENU metres -> observer ENU, using WGS84 at both tangent frames. */
export function landmarkFrame(eye:EllipsoidalPoint,anchor:EllipsoidalPoint) {
  const axes=(p:EllipsoidalPoint)=>{const lat=p.latitude*Math.PI/180,lon=p.longitude*Math.PI/180,s=Math.sin(lat),c=Math.cos(lat),t=Math.sin(lon),u=Math.cos(lon);
    return [[-t,u,0],[-s*u,-s*t,c],[c*u,c*t,s]];};
  const a=axes(eye),b=axes(anchor);
  return {base:ellipsoidalRay(eye,anchor),basis:b.flatMap(axis=>a.map(other=>axis.reduce((s,v,i)=>s+v*other[i],0)))};
}

// Full WGS84 chord length: projecting only to horizontal ENU would also admit
// the antipode, whose horizontal offset is near zero but vertical offset huge.
export function landmarkDistance(point:{longitude:number;latitude:number},target:LandmarkDefinition) {
  return Math.hypot(...ellipsoidalRay({...point,ellipsoidalHeight:0},{...target,ellipsoidalHeight:0}));
}
export const landmarksInRange=(point:{longitude:number;latitude:number})=>landmarks.map(target=>({target,distance:landmarkDistance(point,target)}))
  .filter(item=>item.distance<=LANDMARK_RADIUS).sort((a,b)=>a.distance-b.distance||a.target.id.localeCompare(b.target.id));
export const skytreeDistance=(point:{longitude:number;latitude:number})=>landmarkDistance(point,skytree);
export const skytreeInRange=(point:{longitude:number;latitude:number})=>skytreeDistance(point)<=LANDMARK_RADIUS;

/** Never replace neighbours or merely similarly tall buildings. */
export function landmarkPart(target:LandmarkDefinition,tile:{z:number;x:number;y:number},id:number|undefined,height:number,base:number,point:{longitude:number;latitude:number}) {
  return target.parts.some(p=>{const t=p.tile??target.tile;return tile.z===t.z&&tile.x===t.x&&tile.y===t.y&&p.id===id&&p.height===height&&p.base===base;})&&
    landmarkDistance(point,target)<target.partRadius;
}
export const landmarkPartKey=(tile:{z:number;x:number;y:number},id:number)=>`${tile.z}/${tile.x}/${tile.y}/${id}`;
export const skytreePart=(tile:{z:number;x:number;y:number},id:number|undefined,height:number,base:number,point:{longitude:number;latitude:number})=>landmarkPart(skytree,tile,id,height,base,point);

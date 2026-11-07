import { ellipsoidalRay } from "./geodesy.ts";
import type { EllipsoidalPoint } from "./geodesy.ts";

export const skytree = {
  latitude:35.71004508243534, longitude:139.81071889400482,
  tile:{z:14,x:14554,y:6450},
  parts:[{id:3623514152,height:350,base:290},{id:2882691482,height:450,base:410},{id:3623514142,height:634,base:0}],
};
export type LandmarkGeometry = { vertices:Float32Array; indices:Uint32Array };
export const LANDMARK_RADIUS=50000;

/** Bounded, single registered asset format; no runtime glTF or image decoder. */
export function decodeLandmark(bytes:Uint8Array):LandmarkGeometry {
  if(bytes.length<32||bytes.length>4*1024*1024)throw new Error("地标文件长度无效");
  const copy=new Uint8Array(bytes),view=new DataView(copy.buffer);
  if(new TextDecoder().decode(copy.subarray(0,4))!=="TTLM"||view.getUint32(4,true)!==1||view.getUint32(16,true)!==6||
    [20,24,28].some(i=>view.getUint32(i,true)!==0))throw new Error("地标格式无效");
  const count=view.getUint32(8,true),length=view.getUint32(12,true);
  if(!count||count>80000||!length||length%3||length>300000||32+count*24+length*4!==copy.length)throw new Error("地标网格超出预算");
  const vertices=new Float32Array(copy.buffer,32,count*6),indices=new Uint32Array(copy.buffer,32+count*24,length);
  for(let i=0;i<vertices.length;i+=6){const [e,n,u,nx,ny,nz]=vertices.subarray(i,i+6);
    if(![e,n,u,nx,ny,nz].every(Number.isFinite)||Math.abs(e)>100||Math.abs(n)>100||u<-.01||u>634.01||Math.hypot(nx,ny,nz)<.1||Math.hypot(nx,ny,nz)>1.1)throw new Error("地标坐标无效");
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
export function skytreeDistance(point:{longitude:number;latitude:number}) {
  return Math.hypot(...ellipsoidalRay({...point,ellipsoidalHeight:0},{...skytree,ellipsoidalHeight:0}));
}
export const skytreeInRange=(point:{longitude:number;latitude:number})=>skytreeDistance(point)<=LANDMARK_RADIUS;

/** Never replace neighbours or merely similarly tall buildings. */
export function skytreePart(tile:{z:number;x:number;y:number},id:number|undefined,height:number,base:number,point:{longitude:number;latitude:number}) {
  return tile.z===skytree.tile.z&&tile.x===skytree.tile.x&&tile.y===skytree.tile.y&&
    skytree.parts.some(p=>p.id===id&&p.height===height&&p.base===base)&&
    Math.hypot(...ellipsoidalRay({...skytree,ellipsoidalHeight:0},{...point,ellipsoidalHeight:0}).slice(0,2))<60;
}

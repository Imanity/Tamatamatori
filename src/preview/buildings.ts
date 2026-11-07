import { VectorTile, classifyRings } from "@mapbox/vector-tile";
import { PbfReader, PbfWriter } from "pbf";
import { buildingKey, buildingTiles, buildingHeights, buildingCoordinates, buildingBounds, buildingGeometry,
  buildingCost, selectBuildings, simplifyBuilding, BUILDING_MAX_POINTS, BUILDING_MAX_TRIANGLES, BUILDING_RADIUS, BUILDING_NEAR_RADIUS, BUILDING_FAR_MIN_HEIGHT } from "../domain/buildings.ts";
import { landmarks, landmarksInRange, landmarkPart, landmarkPartKey } from "../domain/landmarks.ts";
import { loadLandmark, clearLandmarkCache } from "./landmarks.ts";
import type { BuildingPolygon, BuildingMesh, BuildingStatus, BuildingCandidate } from "../domain/buildings.ts";
import type { ShootingPlan } from "../domain/plan.ts";
import type { PhotoTile } from "./terrain-perspective-math.ts";
import { groundElevation } from "./elevation.ts";

const MAX_TILE_BYTES=3*1024*1024, MAX_CACHE_BYTES=16*1024*1024, MAX_SOURCE_BYTES=40*1024*1024;
const cache=new Map<string,{bytes:Uint8Array;sourceBytes:number}>();
let cachedBytes=0;
const sources=new Map<string,{at:number;template:string;version:string}>();
export function clearBuildingCache() { cache.clear();cachedBytes=0;sources.clear();clearLandmarkCache(); }

async function request(url:string,signal:AbortSignal,limit:number) {
  const abort=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
  const response=await fetch(url,{signal:abort});
  if(!response.ok)throw new Error(`建筑数据请求失败（${response.status}）`);
  const reader=response.body?.getReader();
  if(!reader)throw new Error("建筑响应无数据流");
  const chunks:Uint8Array[]=[];let length=0;
  try {
    for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;
      if(length>limit)throw new Error("建筑瓦片超出读取预算");chunks.push(value);}
  } finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
  abort.throwIfAborted();
  const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  return bytes;
}
async function source(url:string,signal:AbortSignal) {
  const old=sources.get(url);if(old&&Date.now()-old.at<3600000)return old;
  const bytes=await request(url,signal,128*1024),data=JSON.parse(new TextDecoder().decode(bytes));
  if(data.scheme&&data.scheme!=="xyz" || !Array.isArray(data.tiles) || !data.tiles.length ||
    typeof data.tiles[0]!=="string" || !["{x}","{y}","{z}"].every(k=>data.tiles[0].includes(k)) || !Number.isFinite(data.maxzoom) || data.maxzoom<14 ||
    !Array.isArray(data.vector_layers) || !data.vector_layers.some((l:{id:string})=>l?.id==="building")) throw new Error("建筑源缺少 z14 building 图层");
  const template=new URL(data.tiles[0],url).href.replaceAll("%7B","{").replaceAll("%7D","}");
  if(!/^https?:/.test(template))throw new Error("建筑瓦片地址无效");
  const result={at:Date.now(),template,version:template.match(/planet\/([^/]+)\//)?.[1]??"来源未提供版本"};
  sources.set(url,result);if(sources.size>4)sources.delete(sources.keys().next().value!);return result;
}
async function tileBytes(url:string,signal:AbortSignal) {
  signal.throwIfAborted();const old=cache.get(url);
  if(old){cache.delete(url);cache.set(url,old);return old;}
  const raw=await request(url,signal,MAX_TILE_BYTES);signal.throwIfAborted();
  const bytes=extractBuildingTile(raw),value={bytes,sourceBytes:raw.length};
  while(cache.size>=48||cachedBytes+bytes.length>MAX_CACHE_BYTES){const key=cache.keys().next().value!;cachedBytes-=cache.get(key)!.bytes.length;cache.delete(key);}
  cache.set(url,value);cachedBytes+=bytes.length;return value;
}

/** Keep source building payload bytes verbatim, dropping unrelated map layers. */
export function extractBuildingTile(bytes:Uint8Array) {
  const writer=new PbfWriter();
  new PbfReader(bytes).readFields((tag,_value,reader)=>{
    if(tag!==3)return;
    const payload=reader.readBytes();let name="";
    new PbfReader(payload).readFields((field,_layer,pbf)=>{if(field===1)name=pbf.readString();},undefined);
    if(name==="building")writer.writeBytesField(3,payload);
  },undefined);
  return writer.finish().slice();
}

export function decodeBuildings(bytes:Uint8Array,maximumPoints=BUILDING_MAX_POINTS) {
  const layer=new VectorTile(new PbfReader(bytes)).layers.building;
  const polygons:BuildingPolygon[]=[];let points=0,skipped=0,limited=false;
  if(!layer)return {polygons,points,skipped,limited};
  if(!Number.isFinite(layer.extent)||layer.extent<=0||layer.length>100000)throw new Error("建筑瓦片结构异常");
  outer:for(let i=0;i<layer.length;i++) {
    const feature=layer.feature(i),height=buildingHeights(feature.properties);
    if(feature.type!==3||!height){skipped++;continue;}
    for(const rings of classifyRings(feature.loadGeometry())) {
      const count=rings.reduce((n,r)=>n+r.length,0);
      if(points+count>maximumPoints){limited=true;break outer;}
      if(!rings.length||rings[0].length<4||rings.some(r=>r.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>layer.extent*2||Math.abs(p.y)>layer.extent*2))){skipped++;continue;}
      points+=count;
      polygons.push({...height,rings:rings.map(r=>r.map(p=>({x:p.x*8192/layer.extent,y:p.y*8192/layer.extent})))});
    }
  }
  return {polygons,points,skipped,limited};
}

export async function loadBuildings(plan:Pick<ShootingPlan,"longitude"|"latitude">,url:string,demUrl:string,signal:AbortSignal,
  elevation=groundElevation,landmarkLoader=loadLandmark):Promise<{meshes:BuildingMesh[];status:BuildingStatus}> {
  const info=await source(url,signal),selection=buildingTiles(plan);
  const status:BuildingStatus={key:buildingKey(plan),phase:"empty",limited:selection.limited,tiles:0,polygons:0,triangles:0,bytes:0,skipped:0,
    version:info.version,fetchedAt:new Date().toISOString()};
  const meshes:BuildingMesh[]=[];
  type Candidate = BuildingCandidate & {tileIndex:number;featureIndex:number;polygonIndex:number;distant:boolean;removedPoints:number;landmarkId?:string};
  const candidates:Candidate[]=[];
  const confirmedParts=new Set<string>();
  const tiles:Array<{tile:PhotoTile;layer:VectorTile["layers"][string]}> = [];
  let scannedPoints=0,sourceBytes=0;
  for(const tile of selection.tiles) {
    signal.throwIfAborted();
    const response=await tileBytes(info.template.replace("{z}",String(tile.z)).replace("{x}",String(tile.x)).replace("{y}",String(tile.y)),signal);
    sourceBytes+=response.sourceBytes;
    if(sourceBytes>MAX_SOURCE_BYTES)throw new Error("建筑区域源数据超出读取预算");
    const layer=new VectorTile(new PbfReader(response.bytes)).layers.building;
    const tileIndex=tiles.length;tiles.push({tile,layer});status.tiles++;
    if(!layer)continue;
    if(!Number.isFinite(layer.extent)||layer.extent<=0||layer.length>100000)throw new Error("建筑瓦片结构异常");
    const eye=buildingCoordinates(tile,4096,4096),metresPerUnit=40075016.686*Math.cos(eye.latitude*Math.PI/180)/2**14/8192;
    const n=2**14,delta=(plan.longitude+180)/360*n-tile.x,
      observerX=(((delta+n/2)%n+n)%n-n/2)*8192,
      observerY=((1-Math.asinh(Math.tan(plan.latitude*Math.PI/180))/Math.PI)/2*n-tile.y)*8192;
    for(let featureIndex=0;featureIndex<layer.length;featureIndex++) {
      if(featureIndex%256===0){await new Promise(resolve=>setTimeout(resolve,0));signal.throwIfAborted();}
      const feature=layer.feature(featureIndex),height=buildingHeights(feature.properties);
      if(feature.type!==3||!height){status.skipped++;continue;}
      const polygons=classifyRings(feature.loadGeometry());
      for(let polygonIndex=0;polygonIndex<polygons.length;polygonIndex++) {
        const rings=polygons[polygonIndex];
        scannedPoints+=rings.reduce((sum,r)=>sum+r.length,0);
        if(scannedPoints>4000000)throw new Error("建筑区域轮廓超出扫描预算");
        if(!rings.length||rings[0].length<4||rings.some(r=>r.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>layer.extent*2||Math.abs(p.y)>layer.extent*2))){status.skipped++;continue;}
        const original={...height,rings},raw=buildingBounds(original),scale=8192/layer.extent;
        const b={minX:raw.minX*scale,minY:raw.minY*scale,maxX:raw.maxX*scale,maxY:raw.maxY*scale,x:raw.x*scale,y:raw.y*scale};
        // Check the full tile before the ordinary 5 km footprint filter. At
        // the window boundary only some tower parts may become candidates.
        const landmarkId=landmarks.find(target=>landmarkPart(target,tile,feature.id,height.height,height.base,buildingCoordinates(tile,b.x,b.y)))?.id;
        if(landmarkId!==undefined)confirmedParts.add(`${landmarkId}/${landmarkPartKey(tile,feature.id!)}`);
        const near=Math.hypot(Math.max(0,b.minX-observerX,observerX-b.maxX),Math.max(0,b.minY-observerY,observerY-b.maxY))*metresPerUnit;
        if(near>BUILDING_RADIUS)continue;
        const distant=Math.hypot(b.x-observerX,b.y-observerY)*metresPerUnit>BUILDING_NEAR_RADIUS;
        if(distant&&height.height<BUILDING_FAR_MIN_HEIGHT)continue;
        const polygon=simplifyBuilding(original),removedPoints=buildingCost(original).points-buildingCost(polygon).points;
        if(candidates.length>=100000)throw new Error("建筑区域分部超出扫描预算");
        candidates.push({...buildingCost(polygon),height:height.height,tileIndex,featureIndex,polygonIndex,distant,removedPoints,landmarkId,
          id:`${tile.z}/${tile.x}/${tile.y}/${featureIndex}/${polygonIndex}`,
          east:(b.x-observerX)*metresPerUnit,north:(observerY-b.y)*metresPerUnit,
          footprint:Math.hypot(b.maxX-b.minX,b.maxY-b.minY)*metresPerUnit});
      }
    }
  }
  signal.throwIfAborted();
  let available=candidates,remaining=BUILDING_MAX_TRIANGLES;
  status.landmarks=[];
  for(const {target,distance} of landmarksInRange(plan)){
    const overlap=distance<=BUILDING_RADIUS+target.bounds.horizontal;
    // Outside the ordinary window there are no coarse tower parts to replace.
    // Use the registered static model without fetching a remote city region.
    if(!overlap||target.parts.length>0&&target.parts.every(part=>confirmedParts.has(`${target.id}/${landmarkPartKey(part.tile??target.tile,part.id)}`))){
      if(target.asset.triangles>remaining){status.limited=true;status.landmarks.push({id:target.id,phase:"fallback",distance,message:`${target.name}未应用：剩余三角面预算不足。${overlap?"保留粗体块。":"该距离未加载对应粗体块。"}`});continue;}
      try{
        const model=await landmarkLoader(target,signal),ground=(await elevation(target,demUrl,signal)).height;
        signal.throwIfAborted();
        if(!Number.isFinite(ground)||model.indices.length/3>remaining||model.indices.length/3!==target.asset.triangles||model.vertices.length/6!==target.asset.vertices)throw new Error("地标几何或基座超出预算");
        meshes.push({tile:target.tile,...model,anchor:{longitude:target.longitude,latitude:target.latitude,ellipsoidalHeight:ground}});
        remaining-=model.indices.length/3;status.triangles+=model.indices.length/3;status.bytes+=model.vertices.byteLength+model.indices.byteLength;
        available=available.filter(c=>c.landmarkId!==target.id);
        status.landmarks.push({id:target.id,phase:"applied",distance,triangles:model.indices.length/3,message:`${target.name}无纹理精细模型 · 定位与朝向近似${target.validation.visual==="pending"?" · 画面待验":""}`});
      }catch{signal.throwIfAborted();status.landmarks.push({id:target.id,phase:"fallback",distance,message:overlap?`${target.name}精细模型未应用，保留粗体块；可重新读取建筑。`:`${target.name}精细模型未应用；该距离未加载对应粗体块，可重新读取建筑。`});}
    }else status.landmarks.push({id:target.id,phase:"fallback",distance,message:`${target.name}粗分部对应关系未确认，保留源体块。`});
  }
  const chosen=selectBuildings(available,BUILDING_MAX_POINTS,remaining);status.candidates=available.length;status.distantCandidates=available.filter(c=>c.distant).length;status.distant=0;status.removedPoints=0;status.limited ||= chosen.limited;
  const samples=new Map<string,number>();
  const heightAt=async(tile:PhotoTile,x:number,y:number)=>{
    const p=buildingCoordinates(tile,x,y),key=`${p.longitude.toFixed(8)}/${p.latitude.toFixed(8)}`;
    let value=samples.get(key);if(value===undefined){value=(await elevation(p,demUrl,signal)).height;samples.set(key,value);}return value;
  };
  for(let tileIndex=0;tileIndex<tiles.length;tileIndex++) {
    const {tile,layer}=tiles[tileIndex],selected=chosen.selected.filter(c=>c.tileIndex===tileIndex);
    if(!selected.length)continue;
    selected.sort((a,b)=>a.featureIndex-b.featureIndex||a.polygonIndex-b.polygonIndex);
    const data=new Float32Array(selected.reduce((sum,c)=>sum+c.triangles*18,0));let offset=0,previous=-1;
    let polygons:ReturnType<typeof classifyRings>=[];
    for(const candidate of selected) {
      signal.throwIfAborted();
      if(candidate.featureIndex!==previous){polygons=classifyRings(layer.feature(candidate.featureIndex).loadGeometry());previous=candidate.featureIndex;}
      const feature=layer.feature(candidate.featureIndex),height=buildingHeights(feature.properties)!;
      const p:BuildingPolygon=simplifyBuilding({...height,rings:polygons[candidate.polygonIndex]} );
      p.rings=p.rings.map(r=>r.map(q=>({x:q.x*8192/layer.extent,y:q.y*8192/layer.extent})));
      const b=buildingBounds(p),ground=await heightAt(tile,b.x,b.y);let minimum=ground;
      if(p.base===0)for(const [x,y] of [[b.minX,b.minY],[b.maxX,b.minY],[b.maxX,b.maxY],[b.minX,b.maxY]])minimum=Math.min(minimum,await heightAt(tile,x,y));
      signal.throwIfAborted();
      const geometry=buildingGeometry(p,ground,minimum),triangles=geometry.length/18;
      if(triangles>candidate.triangles)throw new Error("建筑三角面超出预估预算");
      if(!geometry.length){status.skipped++;continue;}
      data.set(geometry,offset);offset+=geometry.length;status.triangles+=triangles;status.polygons++;status.distant+=candidate.distant?1:0;status.removedPoints+=candidate.removedPoints;
      if(status.polygons%64===0)await new Promise(resolve=>setTimeout(resolve,0));
    }
    if(offset){const vertices=data.subarray(0,offset);meshes.push({tile,vertices});status.bytes+=vertices.byteLength;}
  }
  signal.throwIfAborted();status.phase=status.polygons||status.landmarks.some(item=>item.phase==="applied")?"ready":"empty";
  return {meshes,status};
}

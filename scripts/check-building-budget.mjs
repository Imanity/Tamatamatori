// Replay cached, versioned real MVT with identical model and synthetic flat DEM.
// Only the selected-point and triangle caps differ; no network or GPU benchmark.
import {readFile,writeFile,mkdir} from 'node:fs/promises';import {createHash} from 'node:crypto';import {stripTypeScriptTypes} from 'node:module';import {gunzipSync} from 'node:zlib';
import {loadBuildings,clearBuildingCache,extractBuildingTile} from '../src/preview/buildings.ts';import {decodeLandmark} from '../src/domain/landmarks.ts';
const loaderUrl=new URL('../src/preview/buildings.ts',import.meta.url);let code=await readFile(loaderUrl,'utf8');
if(code.split('BUILDING_MAX_POINTS, BUILDING_MAX_TRIANGLES,').length!==2)throw Error('Budget import signature changed');
code=code.replace('BUILDING_MAX_POINTS, BUILDING_MAX_TRIANGLES,','').replaceAll('BUILDING_MAX_POINTS','80000').replaceAll('BUILDING_MAX_TRIANGLES','120000');
code=stripTypeScriptTypes(code,{mode:'transform'}).replace(/from "(\.[^"]+)"/g,(_,p)=>`from "${new URL(p,loaderUrl).href}"`);
await mkdir('.cache/landmark-distance',{recursive:true});
await writeFile('.cache/landmark-distance/old-loader.mjs',code);const old=await import(new URL('../.cache/landmark-distance/old-loader.mjs',import.meta.url).href);
const model=decodeLandmark(gunzipSync(await readFile('public/landmarks/skytree-v1.ttlm.gz'))),version='20261101_080013_pt',meta={maxzoom:14,tiles:[`https://tiles.openfreemap.org/planet/${version}/{z}/{x}/{y}.pbf`],vector_layers:[{id:'building'}]};
const native=globalThis.fetch,requests=[];globalThis.fetch=async url=>{
 if(String(url).endsWith('/meta'))return new Response(JSON.stringify(meta));
 const m=String(url).match(/\/(14)\/(\d+)\/(\d+)\.pbf$/);if(!m)throw Error('Unexpected URL '+url);
 const name=`${version}-${m[1]}-${m[2]}-${m[3]}.pbf`;let b;
 try{b=await readFile('.cache/building-assessment/storage/'+name);}catch{b=await readFile('.cache/building-distance/'+name);}
 requests.push({url:String(url),bytes:b.length,buildingBytes:extractBuildingTile(b).length,sha256:createHash('sha256').update(b).digest('hex')});return new Response(b);
};
const results=[];try{for(const point of [{name:'original-skytree',latitude:35.70698835542723,longitude:139.79386910980952},{name:'shanghai',latitude:31.2397,longitude:121.5008}]){
 const pairs=[];for(const [name,loader,clear] of [['old-120k-80k',old.loadBuildings,old.clearBuildingCache],['new-300k-160k',loadBuildings,clearBuildingCache]]){
 clear();requests.length=0;const t=performance.now(),result=await loader(point,'https://audit.test/meta','synthetic-zero',new AbortController().signal,async()=>({height:0}),async()=>model);
 pairs.push({name,status:result.status,cpuMilliseconds:performance.now()-t,meshes:result.meshes.length,allFinite:result.meshes.every(m=>m.vertices.every(Number.isFinite)),requests:[...requests]});}
 results.push({point,pairs});console.log(JSON.stringify({point,pairs:pairs.map(p=>({name:p.name,status:p.status,cpuMilliseconds:p.cpuMilliseconds}))}));}
}finally{globalThis.fetch=native;clearBuildingCache();old.clearBuildingCache();}
await writeFile('docs/plan/landmark-distance-evidence/cpu-budget.json',JSON.stringify({checkedAt:new Date().toISOString(),scope:'Identical cached real MVT, synthetic flat DEM 0m, identical landmark; old pair changes only selected point/triangle caps. Node wall time is not GPU or browser frame performance.',results},null,2)+'\n');

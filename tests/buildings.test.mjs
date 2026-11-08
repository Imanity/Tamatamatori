import test from "node:test";
import assert from "node:assert/strict";
import { PbfWriter } from "pbf";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { initialPlan } from "../src/domain/plan.ts";
import { buildingTiles, buildingHeights, buildingGeometry, buildingCoordinates, buildingBounds, buildingCost, simplifyBuilding, selectBuildings, BUILDING_RADIUS, BUILDING_MAX_TILES, BUILDING_MAX_POINTS, BUILDING_MAX_TRIANGLES, emptyBuildings } from "../src/domain/buildings.ts";
import { decodeBuildings, loadBuildings, clearBuildingCache, extractBuildingTile } from "../src/preview/buildings.ts";
import { photoTileFrame, photoTileRay, photoFragmentDepth } from "../src/preview/terrain-perspective-math.ts";
import { ellipsoidalRay } from "../src/domain/geodesy.ts";
import { skyLabelKey, occlusionText } from "../src/domain/visibility.ts";
import { skytree, shanghaiTower, tokyoTower, landmarks, landmarkPart, landmarksInRange, skytreePart, skytreeInRange, skytreeDistance, LANDMARK_RADIUS, decodeLandmark, landmarkFrame } from "../src/domain/landmarks.ts";
import { loadLandmark, loadSkytree, clearLandmarkCache } from "../src/preview/landmarks.ts";
import { gunzipSync } from "node:zlib";
import { geodeticEcef } from "../src/domain/geodesy.ts";

const point=(x,y)=>({x,y});
const rectangle=(x,y,w,h)=>[point(x,y),point(x+w,y),point(x+w,y+h),point(x,y+h),point(x,y)];
const polygon={height:40,base:0,rings:[rectangle(100,100,200,200),rectangle(150,150,100,100).reverse()]};
const close=(a,b,t=1e-6)=>assert.ok(Math.abs(a-b)<t,`${a} vs ${b}`);

// A synthetic MVT with explicit properties; no network dependency in tests.
function fixture(features=[polygon]) {
  const tile=new PbfWriter();
  tile.writeMessage(3,(_,layer)=>{
    layer.writeStringField(1,"building");layer.writeVarintField(15,2);layer.writeVarintField(5,8192);
    ["render_height","render_min_height","hide_3d"].forEach(k=>layer.writeStringField(3,k));
    let offset=0;
    for(const feature of features){
      const values=[feature.height,feature.base,feature.hide??false];
      layer.writeMessage(2,(_,p)=>{
        if(feature.id!==undefined)p.writeVarintField(1,feature.id);
        p.writeVarintField(3,3);p.writePackedVarint(2,[0,offset,1,offset+1,2,offset+2]);
        let x=0,y=0;const geometry=[];const zig=n=>n<0?-n*2-1:n*2;
        for(const closed of feature.rings){const ring=closed.slice(0,-1);
          geometry.push(9,zig(ring[0].x-x),zig(ring[0].y-y));x=ring[0].x;y=ring[0].y;
          geometry.push(((ring.length-1)<<3)|2);
          for(const q of ring.slice(1)){geometry.push(zig(q.x-x),zig(q.y-y));x=q.x;y=q.y;}
          geometry.push(15);
        }p.writePackedVarint(4,geometry);
      });
      for(const value of values)layer.writeMessage(4,(_,v)=>typeof value==="boolean"?v.writeBooleanField(7,value):v.writeDoubleField(3,value));
      offset+=3;
    }
  });return tile.finish();
}

function withRoads(building,padding) {
  const writer=new PbfWriter();
  writer.writeMessage(3,(_,layer)=>{layer.writeStringField(1,"transportation");layer.writeVarintField(15,2);layer.writeStringField(3,"x".repeat(padding));});
  const roads=writer.finish(),combined=new Uint8Array(building.length+roads.length);combined.set(building);combined.set(roads,building.length);return combined;
}

test("建筑缓存无损提取原始 building 载荷，不保留其他图层",()=>{
  const building=fixture([polygon,{...polygon,base:12},{...polygon,hide:true}]);
  const combined=withRoads(building,1024*1024),extracted=extractBuildingTile(combined);
  assert.deepEqual(extracted,building);assert.deepEqual(decodeBuildings(extracted),decodeBuildings(building));
  assert.equal(extractBuildingTile(withRoads(new Uint8Array(),100)).length,0);
  assert.throws(()=>extractBuildingTile(new Uint8Array([255,255,255])));
});

test("整窗超过16 MiB时只缓存建筑层避免重开抖动，原始响应仍受40 MiB区域上限约束",async()=>{
  const original=globalThis.fetch,observer=buildingCoordinates({z:14,x:8192,y:8192},4096,4096);
  const building=fixture(),padded=withRoads(building,900*1024);let calls=0;
  const metadata={maxzoom:14,tiles:["https://example.test/planet/compact/{z}/{x}/{y}.pbf"],vector_layers:[{id:"building"}]};
  globalThis.fetch=async url=>{calls++;return new Response(String(url).endsWith("meta")?JSON.stringify(metadata):padded);};
  try {
    clearBuildingCache();const signal=new AbortController().signal,elevation=async()=>({height:0});
    const first=await loadBuildings(observer,"https://example.test/meta","flat",signal,elevation),count=calls;
    assert.ok(buildingTiles(observer).tiles.length*padded.length>16*1024*1024);
    const second=await loadBuildings(observer,"https://example.test/meta","flat",signal,elevation);
    assert.equal(calls,count);assert.equal(first.status.polygons,second.status.polygons);assert.equal(first.status.triangles,second.status.triangles);
    clearBuildingCache();const large=withRoads(building,2500*1024);
    globalThis.fetch=async url=>new Response(String(url).endsWith("meta")?JSON.stringify(metadata):large);
    await assert.rejects(loadBuildings(observer,"https://example.test/meta","flat",signal,elevation),/区域源数据超出读取预算/);
  }finally{globalThis.fetch=original;clearBuildingCache();}
});

test("加载进度按读取、精模、生成单调推进至完成，覆盖半径随瓦片上限截断",async()=>{
  assert.equal(buildingTiles({longitude:0,latitude:0}).coverage,BUILDING_RADIUS);
  const polar=buildingTiles({longitude:0,latitude:80});assert.ok(polar.limited);assert.ok(polar.coverage>0&&polar.coverage<BUILDING_RADIUS);
  const original=globalThis.fetch,bytes=fixture(),observer={longitude:skytree.longitude-0.05,latitude:skytree.latitude};
  const metadata={maxzoom:14,tiles:["https://example.test/planet/progress/{z}/{x}/{y}.pbf"],vector_layers:[{id:"building"}]};
  globalThis.fetch=async url=>new Response(String(url).endsWith("meta")?JSON.stringify(metadata):bytes);
  try {
    clearBuildingCache();const events=[];
    const result=await loadBuildings(observer,"https://example.test/meta","dem",new AbortController().signal,async()=>({height:0}),async item=>registeredModels.get(item.id).model,value=>events.push(value));
    const tiles=buildingTiles(observer).tiles.length,nearby=landmarksInRange(observer).length;
    assert.ok(nearby>0);assert.equal(result.status.coverage,BUILDING_RADIUS);
    assert.deepEqual(events[0],{stage:"tiles",done:0,total:tiles*2+nearby});assert.deepEqual(events.at(-1),{stage:"geometry",done:tiles*2+nearby,total:tiles*2+nearby});
    assert.ok(events.every((e,i)=>!i||e.done===events[i-1].done+1));
    const order=events.slice(1).map(e=>e.stage);
    assert.deepEqual([...new Set(order)],["tiles","landmarks","geometry"]);
    assert.equal(order.filter(stage=>stage==="tiles").length,tiles);assert.equal(order.filter(stage=>stage==="landmarks").length,nearby);
  }finally{globalThis.fetch=original;clearBuildingCache();}
});

test("建筑窗口有界、穿越日期线仍使用合法瓦片，高纬明确截断",()=>{
  for(const point of [initialPlan,{longitude:179.999,latitude:0},{longitude:-179.999,latitude:0},{longitude:0,latitude:80}]){
    const selected=buildingTiles(point);assert.ok(selected.tiles.length>0&&selected.tiles.length<=BUILDING_MAX_TILES);
    assert.equal(new Set(selected.tiles.map(t=>`${t.x}/${t.y}`)).size,selected.tiles.length);
    assert.ok(selected.tiles.every(t=>t.z===14&&t.x>=0&&t.x<16384&&t.y>=0&&t.y<16384));
  }
  assert.ok(buildingTiles({longitude:0,latitude:80}).limited);
});

test("建筑高度拒绝未知、非有限、倒置与隐藏外轮廓，不补虚构楼高",()=>{
  for(const p of [{},{render_height:20},{render_height:"20",render_min_height:0},{render_height:NaN,render_min_height:0},
    {render_height:20,render_min_height:21},{render_height:20,render_min_height:-1},{render_height:3000,render_min_height:0},
    {render_height:20,render_min_height:0,hide_3d:true}])assert.equal(buildingHeights(p),null);
  assert.deepEqual(buildingHeights({render_height:40,render_min_height:12}),{height:40,base:12});
});

test("建筑屋顶三角化保留内院面积，坡地下裙和架空底高分别处理",()=>{
  const geometry=buildingGeometry(polygon,100,92);let area=0;
  for(let i=0;i<geometry.length;i+=18){
    if(geometry[i+5]===1){
      close(geometry[i+2],140);close(geometry[i+8],140);close(geometry[i+14],140);
      area+=Math.abs((geometry[i+6]-geometry[i])*(geometry[i+13]-geometry[i+1])-(geometry[i+12]-geometry[i])*(geometry[i+7]-geometry[i+1]))/2;
    }
  }
  close(area,30000);assert.ok(geometry.some((v,i)=>i%6===2&&v===90));
  const raised=buildingGeometry({...polygon,base:12},100,80);
  assert.ok(raised.filter((_,i)=>i%6===2).every(z=>z===112||z===140));
  let underside=0;
  for(let i=0;i<raised.length;i+=18)if(raised[i+5]===-1){
    close(raised[i+2],112);
    underside+=Math.abs((raised[i+6]-raised[i])*(raised[i+13]-raised[i+1])-(raised[i+12]-raised[i])*(raised[i+7]-raised[i+1]))/2;
  }
  close(underside,30000);
});

test("MVT 解析保留孔洞和多个建筑，不绘制 hide_3d，点预算截断明确",()=>{
  const bytes=fixture([polygon,{...polygon,hide:true},{height:12,base:0,rings:[rectangle(600,600,90,90)]}]);
  const decoded=decodeBuildings(bytes);assert.equal(decoded.polygons.length,2);assert.equal(decoded.polygons[0].rings.length,2);
  assert.equal(decoded.skipped,1);assert.equal(decoded.limited,false);
  assert.ok(decodeBuildings(bytes,5).limited);assert.equal(decodeBuildings(bytes,5).polygons.length,0);
  assert.throws(()=>decodeBuildings(new Uint8Array([255,255,255])));
});

test("固定楼顶按独立 ECEF/ENU 复算，有限建筑与 DEM 对数深度一致",()=>{
  const tile={z:14,x:14554,y:6450},eye={longitude:139.80,latitude:35.71,ellipsoidalHeight:30};
  const frame=photoTileFrame(eye,tile);
  for(const h of [10,140,634])for(const p of [[100,100],[4096,4096],[8192,8192]]){
    const ll=buildingCoordinates(tile,...p),a=photoTileRay(frame,p,h),b=ellipsoidalRay(eye,{...ll,ellipsoidalHeight:h});
    a.forEach((v,i)=>close(v,b[i],0.00001));
  }
  assert.ok(photoFragmentDepth(1000)<photoFragmentDepth(1200));assert.ok(photoFragmentDepth(1200)<1);
  assert.deepEqual(buildingBounds(polygon),{minX:100,minY:100,maxX:300,maxY:300,x:200,y:200});
});

test("跨瓦片预算与输入顺序无关，保留远处高层并为不同方向分配覆盖",()=>{
  const candidates=Array.from({length:1000},(_,i)=>({id:`low/${i}`,height:8,points:5,triangles:10,east:40+(i%4)*500,north:40,footprint:10}));
  candidates.push({id:"far/tower",height:634,points:9,triangles:28,east:-1560,north:20,footprint:3});
  candidates.push({id:"south/house",height:10,points:5,triangles:10,east:50,north:-1200,footprint:10});
  const a=selectBuildings(candidates,100,200),b=selectBuildings([...candidates].reverse(),100,200);
  assert.deepEqual(a.selected.map(c=>c.id),b.selected.map(c=>c.id));
  assert.ok(a.selected.some(c=>c.id==="far/tower"));assert.ok(a.selected.some(c=>c.id==="south/house"));
  assert.equal(new Set(a.selected.map(c=>Math.floor(c.east/500))).size,5);
  assert.ok(a.points<=100&&a.triangles<=200&&a.limited);
  assert.equal(selectBuildings([{...candidates[0],points:101}],100,200).selected.length,0);
});

test("点与三角面上界覆盖孔洞、架空底面及边界裁切",()=>{
  for(const p of [polygon,{...polygon,base:12},{height:30,base:0,rings:[rectangle(0,0,8192,8192)]}]){
    const cost=buildingCost(p);assert.ok(cost.triangles>=buildingGeometry(p,0,-4).length/18);
    assert.equal(cost.points,p.rings.flat().length);
  }
});

test("五公里窗口包含旧范围外目标，原始轮廓清理保留面积、孔洞与分部高度",()=>{
  assert.equal(BUILDING_RADIUS,5000);
  const observer={longitude:139.765,latitude:35.70698835542723};
  assert.ok(buildingTiles(observer).tiles.some(t=>t.x===14554&&t.y===6450));
  const detailed={height:100,base:60,rings:[
    [point(0,0),point(50,0),point(50,0),point(100,0),point(100,50),point(100,100),point(50,100),point(0,100),point(0,50),point(0,0)],
    [point(20,20),point(20,40),point(20,60),point(60,60),point(60,20),point(20,20)]
  ]};
  const clean=simplifyBuilding(detailed),area=r=>r.reduce((sum,p,i)=>{const q=r[(i+1)%r.length];return sum+p.x*q.y-q.x*p.y;},0)/2;
  assert.equal(clean.height,100);assert.equal(clean.base,60);assert.equal(clean.rings.length,2);
  detailed.rings.forEach((r,i)=>assert.equal(area(clean.rings[i]),area(r)));
  assert.ok(buildingCost(clean).triangles<buildingCost(detailed).triangles);
  assert.deepEqual(simplifyBuilding(clean),clean);
  // A narrow, non-collinear step is retained, even though it is sub-metre.
  const step={height:20,base:0,rings:[[point(0,0),point(50,0),point(50,0.01),point(100,0.01),point(100,100),point(0,100),point(0,0)]]};
  assert.deepEqual(simplifyBuilding(step),step);
  const geometry=buildingGeometry(clean,0,0);
  assert.ok(geometry.some((v,i)=>i%6===2&&v===60));assert.ok(geometry.some((v,i)=>i%6===2&&v===100));
});

test("远景保留绘制份额，近处密集房屋不会挤掉四公里高楼",()=>{
  const near=Array.from({length:1000},(_,i)=>({id:`near/${i}`,height:10,points:5,triangles:10,east:30+i%10,north:30,footprint:10}));
  const far=Array.from({length:100},(_,i)=>({id:`far/${i}`,height:i?30:634,points:5,triangles:10,east:4000,north:i,footprint:10}));
  const result=selectBuildings([...near,...far],100,200);
  assert.ok(result.selected.some(c=>c.id==="far/0"));
  assert.ok(result.selected.filter(c=>c.id.startsWith("far/")).length>=5);
  assert.ok(result.selected.some(c=>c.id.startsWith("near/")));
  assert.ok(result.points<=100&&result.triangles<=200);
});

test("加载器远景保留楼高与底高，过滤小屋和隐藏总轮廓",async()=>{
  const original=globalThis.fetch,observer=buildingCoordinates({z:14,x:8192,y:8192},4096,4096);
  const features=[19,20,80].map(height=>({height,base:height===80?30:0,rings:[rectangle(4000,4000,50,50)]}));
  const bytes=fixture([...features,{...features[2],height:634,hide:true}]);
  globalThis.fetch=async url=>new Response(String(url).endsWith("meta")?JSON.stringify({maxzoom:14,tiles:["https://example.test/planet/far/{z}/{x}/{y}.pbf"],vector_layers:[{id:"building"}]}):bytes);
  try {
    clearBuildingCache();const result=await loadBuildings(observer,"https://example.test/meta","flat",new AbortController().signal,async()=>({height:0}));
    assert.ok(result.status.distant>0);assert.equal(result.status.distant,result.status.distantCandidates);
    let farMeshes=0;
    for(const mesh of result.meshes){
      const p=buildingCoordinates(mesh.tile,4025,4025),distance=Math.hypot(p.longitude-observer.longitude,p.latitude-observer.latitude)*111320;
      const heights=mesh.vertices.filter((_,i)=>i%6===2);
      if(distance>2100){farMeshes++;assert.ok(!heights.includes(19));assert.ok(heights.includes(20));assert.ok(heights.includes(80)&&heights.includes(30));}
      assert.ok(!heights.includes(634));
    }
    assert.ok(farMeshes>0);
  }finally{globalThis.fetch=original;clearBuildingCache();}
});

test("密集首瓦片不阻止后续瓦片读取，16万轮廓点之后的高层仍可入选",async()=>{
  const original=globalThis.fetch,point=buildingCoordinates({z:14,x:8192,y:8192},4096,4096),tiles=buildingTiles(point).tiles;
  const low={height:8,base:0,rings:[rectangle(4000,4000,20,20)]};
  const dense=fixture([...Array.from({length:33000},()=>low),{height:634,base:0,rings:[rectangle(4100,4100,10,10)]}]);
  const requested=[];
  globalThis.fetch=async url=>{
    if(String(url).endsWith("meta"))return new Response(JSON.stringify({maxzoom:14,tiles:["https://example.test/planet/v2/{z}/{x}/{y}.pbf"],vector_layers:[{id:"building"}]}));
    requested.push(String(url));const [,x,y]=String(url).match(/\/(\d+)\/(\d+)\.pbf$/);
    const clamp=v=>Math.max(100,Math.min(8000,v));
    const sparse=fixture([{...low,rings:[rectangle(clamp(4096+(8192-Number(x))*8192),clamp(4096+(8192-Number(y))*8192),20,20)]}]);
    return new Response(String(url).includes(`/${tiles[0].x}/${tiles[0].y}.pbf`)?dense:sparse);
  };
  try {
    clearBuildingCache();const result=await loadBuildings(point,"https://example.test/meta","flat",new AbortController().signal,async()=>({height:0}));
    assert.equal(requested.length,tiles.length);assert.equal(result.status.tiles,tiles.length);
    assert.ok(result.status.candidates>=33001&&result.status.limited);assert.ok(result.status.triangles<=BUILDING_MAX_TRIANGLES);
    assert.ok(result.status.polygons*5<=BUILDING_MAX_POINTS);assert.ok(result.meshes.length>1);
    assert.ok(result.meshes.some(mesh=>mesh.vertices.some((v,i)=>i%6===2&&v===634)));
  }finally{globalThis.fetch=original;clearBuildingCache();}
});

test("建筑开关改变遮挡身份，纯转向保留身份，读数不宣称 DEM 代表建筑",()=>{
  const plan={...initialPlan,layers:{...initialPlan.layers,buildings:true}};
  assert.notEqual(skyLabelKey(plan),skyLabelKey(initialPlan));assert.equal(skyLabelKey(plan),skyLabelKey({...plan,azimuth:90,focalLength:1000}));
  assert.equal(occlusionText("clear",plan),"已载场景未遮挡");assert.equal(occlusionText("blocked",plan),"场景遮挡");
  assert.equal(occlusionText("clear",initialPlan),"当前 DEM 未遮挡");
});

test("有界请求复用版本瓦片、缺高程不以零替代，失败和取消可恢复",async()=>{
  const original=globalThis.fetch;let calls=0;const bytes=fixture();
  const metadata={maxzoom:14,tiles:["https://example.test/planet/v1/{z}/{x}/{y}.pbf"],vector_layers:[{id:"building"}]};
  globalThis.fetch=async url=>{calls++;return new Response(String(url).endsWith("meta")?JSON.stringify(metadata):bytes);};
  try {
    clearBuildingCache();const plan={longitude:0,latitude:0};const controller=new AbortController();
    const elevation=async()=>({height:100});
    const first=await loadBuildings(plan,"https://example.test/meta","dem",controller.signal,elevation);
    assert.equal(first.status.phase,"ready");assert.ok(first.status.tiles<=BUILDING_MAX_TILES);assert.ok(first.status.triangles>0);
    const previous=calls;await loadBuildings(plan,"https://example.test/meta","dem",controller.signal,elevation);assert.equal(calls,previous);
    await assert.rejects(loadBuildings(plan,"https://example.test/meta","dem",controller.signal,async()=>{throw new Error("DEM unavailable");}),/DEM unavailable/);
    controller.abort();await assert.rejects(loadBuildings(plan,"https://example.test/meta","dem",controller.signal,elevation),{name:"AbortError"});
    clearBuildingCache();globalThis.fetch=async()=>new Response("failed",{status:503});
    await assert.rejects(loadBuildings(plan,"https://example.test/meta","dem",new AbortController().signal,elevation),/503/);
  }finally{globalThis.fetch=original;clearBuildingCache();}
});

// Replace only Vite raw-file imports; execute the actual layer's logic.
const layerUrl=new URL("../src/preview/building-layer.ts",import.meta.url);
let source=readFileSync(layerUrl,"utf8");
for(const [name,file] of [["projection","terrain-projection.glsl"],["depth","terrain-depth.glsl"]])
  source=source.replace(new RegExp(`import ${name} from "[^"\\n]+";`),`const ${name}=${JSON.stringify(readFileSync(new URL("../src/preview/"+file,import.meta.url),"utf8"))};`);
source=stripTypeScriptTypes(source,{mode:"transform"}).replace(/from "(\.[^"]+)"/g,(_,path)=>`from "${new URL(path,layerUrl).href}"`);
const {BuildingLayer}=await import("data:text/javascript,"+encodeURIComponent(source+"\n//# sourceURL=tamatamatori-building-layer-test.mjs"));
const environment={building:"#a09080",sky:{"fog-color":"#b0c0d0"}};

test("建筑图层纯转向不重取，换机位/关闭/重试/卸载取消旧请求且忽略迟到响应",async()=>{
  const reports=[],requests=[];const loader=(plan,_url,_dem,signal)=>new Promise((resolve,reject)=>requests.push({plan,signal,resolve,reject}));
  const layer=new BuildingLayer(status=>reports.push(status),"tiles","dem",loader);
  layer.onAdd({triggerRepaint(){}},{deleteProgram(){}});
  const plan={...initialPlan,layers:{...initialPlan.layers,buildings:true}};
  layer.setScene(plan,environment,[0,0,1]);layer.setScene({...plan,azimuth:90},environment,[0,0,1]);assert.equal(requests.length,1);
  const moved={...plan,longitude:140};layer.setScene(moved,environment,[0,0,1]);assert.ok(requests[0].signal.aborted);
  requests[0].resolve({meshes:[],status:{...emptyBuildings,key:"old",phase:"ready"}});await Promise.resolve();assert.notEqual(reports.at(-1).key,"old");
  requests[1].reject(new Error("test failure"));await Promise.resolve();await Promise.resolve();assert.equal(reports.at(-1).phase,"error");
  layer.setScene(moved,environment,[0,0,1],undefined,1);assert.equal(requests.length,3);
  layer.setScene({...moved,layers:{...moved.layers,buildings:false}},environment,[0,0,1]);assert.ok(requests[2].signal.aborted);assert.equal(reports.at(-1).phase,"off");
  // No allocated GPU program when disabled; unload still cancels the controller.
  layer.onRemove();requests[2].resolve({meshes:[],status:{...emptyBuildings,phase:"ready"}});await Promise.resolve();assert.equal(reports.at(-1).phase,"off");
});

function fakeGL(){
  const gl={},names=["VERTEX_SHADER","FRAGMENT_SHADER","COMPILE_STATUS","LINK_STATUS","CURRENT_PROGRAM","VERTEX_ARRAY_BINDING","ARRAY_BUFFER_BINDING","DEPTH_TEST","CULL_FACE","BLEND","STENCIL_TEST","DEPTH_FUNC","DEPTH_RANGE","DEPTH_WRITEMASK","COLOR_WRITEMASK","ARRAY_BUFFER","STATIC_DRAW","FLOAT","TRIANGLES","LEQUAL","ELEMENT_ARRAY_BUFFER","UNSIGNED_INT"];
  names.forEach((n,i)=>gl[n]=i+1);
  const state=new Map([[gl.CURRENT_PROGRAM,{}],[gl.VERTEX_ARRAY_BINDING,{}],[gl.ARRAY_BUFFER_BINDING,{}],[gl.DEPTH_FUNC,999],[gl.DEPTH_RANGE,[0,0.7]],[gl.DEPTH_WRITEMASK,false],[gl.COLOR_WRITEMASK,[false,true,false,true]]]);
  const resources=new Set(),enabled=new Set([gl.BLEND,gl.STENCIL_TEST]),sources=[],draws=[];
  for(const type of ["Shader","Program","Buffer","VertexArray"]){gl["create"+type]=()=>{const o={};resources.add(o);return o;};gl["delete"+type]=o=>resources.delete(o);}
  gl.compile=true;gl.getShaderParameter=()=>gl.compile;gl.getProgramParameter=()=>true;gl.getUniformLocation=(_,name)=>name;
  gl.shaderSource=(_,source)=>sources.push(source);
  for(const name of ["compileShader","attachShader","linkProgram","bufferData","enableVertexAttribArray","vertexAttribPointer","uniformMatrix3fv","uniformMatrix4fv","uniform1f","uniform3fv","uniform4fv"])gl[name]=()=>{};
  gl.getShaderInfoLog=()=>"synthetic compilation failure";
  gl.getParameter=p=>state.get(p);gl.isEnabled=p=>enabled.has(p);gl.enable=p=>enabled.add(p);gl.disable=p=>enabled.delete(p);
  const elements=new Map();
  gl.useProgram=p=>state.set(gl.CURRENT_PROGRAM,p);gl.bindVertexArray=p=>state.set(gl.VERTEX_ARRAY_BINDING,p);gl.bindBuffer=(target,p)=>target===gl.ELEMENT_ARRAY_BUFFER?elements.set(state.get(gl.VERTEX_ARRAY_BINDING),p):state.set(gl.ARRAY_BUFFER_BINDING,p);
  gl.depthFunc=p=>state.set(gl.DEPTH_FUNC,p);gl.depthMask=p=>state.set(gl.DEPTH_WRITEMASK,p);gl.depthRange=(...p)=>state.set(gl.DEPTH_RANGE,p);gl.colorMask=(...p)=>state.set(gl.COLOR_WRITEMASK,p);
  gl.drawArrays=(_,start,count)=>draws.push({start,count,range:state.get(gl.DEPTH_RANGE),write:state.get(gl.DEPTH_WRITEMASK),depth:enabled.has(gl.DEPTH_TEST)});
  gl.drawElements=(_,count,type,start)=>draws.push({start,count,type,index:elements.get(state.get(gl.VERTEX_ARRAY_BINDING)),range:state.get(gl.DEPTH_RANGE),write:state.get(gl.DEPTH_WRITEMASK),depth:enabled.has(gl.DEPTH_TEST)});
  return {gl,state,resources,enabled,sources,draws};
}
const cameraInput={modelViewProjectionMatrix:[1,0,0,0,0,1,0,0,0,0,0,1,-256,-256,0,-10]};
const map={triggerRepaint(){},getZoom:()=>0,getBearing:()=>90,getPitch:()=>94};

test("建筑实际图层使用共享核和可写主深度，绘制/隐藏/关闭/卸载完整恢复 GL",async()=>{
  const {gl,state,resources,enabled,sources,draws}=fakeGL(),before=new Map(state),caps=new Set(enabled),reports=[];
  const mesh={tile:{z:14,x:8192,y:8192},vertices:new Float32Array(buildingGeometry(polygon,0,0))};
  const layer=new BuildingLayer(s=>reports.push(s),"tiles","dem",async()=>({meshes:[mesh],status:{...emptyBuildings,phase:"ready"}}));
  layer.onAdd(map,gl);const plan={...initialPlan,layers:{...initialPlan.layers,buildings:true}};
  layer.setScene(plan,environment,[1,0,0]);await Promise.resolve();layer.render(gl,cameraInput);
  assert.equal(draws.length,1);assert.ok(draws[0].write&&draws[0].depth);assert.deepEqual(draws[0].range,[0,1]);
  assert.ok(sources[0].includes("photoRay"));assert.ok(sources[1].includes("photoFragmentDepth(v_photo_depth)"));assert.ok(sources[1].includes("greaterThanEqual(v_tile"));
  assert.deepEqual(state,before);assert.deepEqual(enabled,caps);
  layer.setVisible(false);layer.render(gl,cameraInput);assert.equal(draws.length,1);
  layer.setVisible(true);layer.render(gl,cameraInput);assert.equal(draws.length,2);
  layer.setScene({...plan,layers:{...plan.layers,buildings:false}},environment,[1,0,0]);layer.render(gl,cameraInput);
  assert.equal(reports.at(-1).phase,"off");assert.equal(resources.size,1,"only compiled program may remain while off");
  layer.onRemove();assert.equal(resources.size,0);assert.deepEqual(state,before);
});

test("建筑绘制失败清理网格并报告独立错误，单独重试恢复",async()=>{
  const {gl,resources}=fakeGL(),reports=[];
  const mesh={tile:{z:14,x:8192,y:8192},vertices:new Float32Array(buildingGeometry(polygon,0,0))};
  const loader=async()=>({meshes:[mesh],status:{...emptyBuildings,phase:"ready"}});
  const layer=new BuildingLayer(s=>reports.push(s),"tiles","dem",loader),plan={...initialPlan,layers:{...initialPlan.layers,buildings:true}};
  layer.onAdd(map,gl);gl.compile=false;layer.setScene(plan,environment,[0,0,1]);await Promise.resolve();layer.render(gl,cameraInput);
  assert.equal(reports.at(-1).phase,"error");assert.equal(resources.size,0);
  gl.compile=true;layer.setScene(plan,environment,[0,0,1],undefined,1);await Promise.resolve();layer.render(gl,cameraInput);
  assert.equal(reports.at(-1).phase,"ready");assert.ok(resources.size>0);layer.onRemove();assert.equal(resources.size,0);
});

const landmarkCompressed=readFileSync(new URL('../public/landmarks/skytree-v1.ttlm.gz',import.meta.url));
const landmarkBytes=gunzipSync(landmarkCompressed),model=decodeLandmark(landmarkBytes);
const landmarkStatus=(result,target=skytree)=>result.status.landmarks?.find(item=>item.id===target.id);
const registeredModels=new Map(landmarks.map(target=>[target.id,{
  compressed:readFileSync(new URL('../public/landmarks/'+target.asset.file,import.meta.url)),
  model:decodeLandmark(gunzipSync(readFileSync(new URL('../public/landmarks/'+target.asset.file,import.meta.url))),target),
}]));
test('晴空塔静态模型有界解析，索引完整且高度634m，截断、错版本与越界被拒绝',()=>{
  assert.equal(model.indices.length/3,88581);assert.equal(model.vertices.length/6,65576);
  let top=-Infinity;for(let i=2;i<model.vertices.length;i+=6)top=Math.max(top,model.vertices[i]);close(top,634,.001);
  assert.throws(()=>decodeLandmark(landmarkBytes.subarray(0,-4)));
  for(const [offset,value] of [[4,2],[8,80001],[16,8],[landmarkBytes.length-4,80000]]){const bad=Buffer.from(landmarkBytes);bad.writeUInt32LE(value,offset);assert.throws(()=>decodeLandmark(bad));}
  const bad=Buffer.from(landmarkBytes);bad.writeFloatLE(NaN,32);assert.throws(()=>decodeLandmark(bad));
});
test('晴空塔加载校验压缩与已解压响应，失败可重试，取消不命中缓存',async()=>{
  const original=globalThis.fetch;let calls=0;
  try{clearLandmarkCache();globalThis.fetch=async()=>{calls++;return new Response(landmarkCompressed);};
    const a=await loadSkytree(new AbortController().signal);assert.equal(a.indices.length,model.indices.length);
    assert.equal(await loadSkytree(new AbortController().signal),a);assert.equal(calls,1);
    clearLandmarkCache();globalThis.fetch=async()=>new Response(landmarkBytes);assert.equal((await loadSkytree(new AbortController().signal)).vertices.length,model.vertices.length);
    clearLandmarkCache();globalThis.fetch=async()=>new Response('bad');await assert.rejects(loadSkytree(new AbortController().signal),/校验/);
    const aborted=new AbortController();aborted.abort();await assert.rejects(loadSkytree(aborted.signal),{name:'AbortError'});
    globalThis.fetch=async()=>new Response(landmarkCompressed);assert.equal((await loadSkytree(new AbortController().signal)).indices.length,model.indices.length);
  }finally{globalThis.fetch=original;clearLandmarkCache();}
});

test('地标缓存按资产身份隔离、有界淘汰，清理后迟到的请求不重新驻留',async()=>{
  const original=globalThis.fetch,signal=new AbortController().signal;let calls=0;
  // Same known payload at four test identities isolates cache policy from I/O.
  const targets=Array.from({length:4},(_,i)=>({...skytree,id:`cache-fixture-${i}`,asset:{...skytree.asset,file:`fixture-${i}.ttlm.gz`}}));
  try{
    clearLandmarkCache();globalThis.fetch=async()=>{calls++;return new Response(landmarkCompressed);};
    for(const target of targets)await loadLandmark(target,signal);
    assert.equal(calls,4);await loadLandmark(targets[3],signal);assert.equal(calls,4);
    await loadLandmark(targets[0],signal);assert.equal(calls,5,'oldest entry evicted by the 8 MiB bound');
    let release;clearLandmarkCache();globalThis.fetch=()=>new Promise(resolve=>{release=resolve;});
    const pending=loadLandmark(skytree,signal);clearLandmarkCache();release(new Response(landmarkCompressed));await pending;
    calls=0;globalThis.fetch=async()=>{calls++;return new Response(landmarkCompressed);};
    await loadLandmark(skytree,signal);assert.equal(calls,1,'cleared in-flight request did not repopulate the cache');
    const changed={...skytree,asset:{...skytree.asset,sha256:'0'.repeat(64)}};
    await assert.rejects(loadLandmark(changed,signal),/校验/);
  }finally{globalThis.fetch=original;clearLandmarkCache();}
});

test('已注册地标实际文件独立校验与跨城市缓存，总高误差有界且单位法线保留',async()=>{
  const original=globalThis.fetch,signal=new AbortController().signal,requests=[];
  try{
    clearLandmarkCache();globalThis.fetch=async url=>{
      requests.push(String(url));const target=landmarks.find(t=>String(url).endsWith(t.asset.file));
      return target?new Response(registeredModels.get(target.id).compressed):new Response('',{status:404});
    };
    for(const target of landmarks){
      const model=await loadLandmark(target,signal);let top=0;
      for(let i=0;i<model.vertices.length;i+=6){top=Math.max(top,model.vertices[i+2]);close(Math.hypot(...model.vertices.subarray(i+3,i+6)),1,1e-5);}
      close(top,target.bounds.height,.1);assert.ok(model.indices.length/3<=100000);
      const part=target.parts[0];if(part){assert.ok(landmarkPart(target,part.tile??target.tile,part.id,part.height,part.base,target));
      assert.ok(!landmarkPart(target,part.tile??target.tile,part.id,part.height+1,part.base,target));}
    }
    assert.equal(requests.length,landmarks.length);
    const last=landmarks.at(-1);await loadLandmark(last,signal);assert.equal(requests.length,landmarks.length,'recent model remains cached');
    for(const target of landmarks)await loadLandmark(target,signal);assert.ok(requests.length>landmarks.length,'three decoded assets exceed 8 MiB; oldest assets are evicted');
    clearLandmarkCache();globalThis.fetch=async()=>new Response(landmarkCompressed);
    await assert.rejects(loadLandmark(shanghaiTower,signal),/校验/,'a Skytree payload must not be reused for Shanghai');
    assert.deepEqual(landmarksInRange(shanghaiTower).map(item=>item.target.id),[shanghaiTower.id,'shanghai-wfc','oriental-pearl'],'same-city landmarks are ordered by distance');
  }finally{globalThis.fetch=original;clearLandmarkCache();}
});

test('上海中心只替换已确认三处塔身并保留邻楼，失败独立保留粗体块',async()=>{
  const original=globalThis.fetch,target=shanghaiTower,meta={maxzoom:14,tiles:['https://example.test/planet/v1/{z}/{x}/{y}.pbf'],vector_layers:[{id:'building'}]};
  const x=Math.round(((target.longitude+180)/360*2**14-target.tile.x)*8192),y=Math.round(((1-Math.asinh(Math.tan(target.latitude*Math.PI/180))/Math.PI)/2*2**14-target.tile.y)*8192);
  const parts=target.parts.map(p=>({...p,rings:[rectangle(x-8,y-8,16,16)]}));parts.push({height:40,base:0,rings:[rectangle(x+150,y,40,40)]});
  globalThis.fetch=async url=>new Response(String(url).endsWith('meta')?JSON.stringify(meta):String(url).endsWith(`/14/${target.tile.x}/${target.tile.y}.pbf`)?fixture(parts):fixture([]));
  try{
    clearBuildingCache();const result=await loadBuildings(target,'https://example.test/meta','dem',new AbortController().signal,async()=>({height:9}),async item=>registeredModels.get(item.id).model);
    assert.equal(landmarkStatus(result,target).phase,'applied');assert.equal(result.status.polygons,1);assert.equal(result.meshes.filter(m=>m.anchor).length,1);
    assert.equal(result.status.triangles,registeredModels.get(target.id).model.indices.length/3+result.meshes.filter(m=>!m.anchor).reduce((sum,m)=>sum+m.vertices.length/18,0));
    const failed=await loadBuildings(target,'https://example.test/meta','dem',new AbortController().signal,async()=>({height:9}),async()=>{throw Error('unavailable');});
    assert.equal(landmarkStatus(failed,target).phase,'fallback');assert.equal(failed.status.polygons,4);assert.ok(!failed.meshes.some(m=>m.anchor));
  }finally{globalThis.fetch=original;clearBuildingCache();}
});

test('东京塔替换七类塔身但保留 FootTown，晴空塔可在同一场景独立应用',async()=>{
  const original=globalThis.fetch,target=tokyoTower,meta={maxzoom:14,tiles:['https://example.test/planet/tokyo/{z}/{x}/{y}.pbf'],vector_layers:[{id:'building'}]};
  const x=Math.round(((target.longitude+180)/360*2**14-target.tile.x)*8192),y=Math.round(((1-Math.asinh(Math.tan(target.latitude*Math.PI/180))/Math.PI)/2*2**14-target.tile.y)*8192);
  const parts=target.parts.map(p=>({...p,rings:[rectangle(x-2,y-2,4,4)]}));parts.push({id:42473133,height:20,base:0,rings:[rectangle(x-40,y-30,80,60)]});
  globalThis.fetch=async url=>new Response(String(url).endsWith('meta')?JSON.stringify(meta):String(url).endsWith(`/14/${target.tile.x}/${target.tile.y}.pbf`)?fixture(parts):fixture([]));
  try{
    clearBuildingCache();const result=await loadBuildings(target,'https://example.test/meta','dem',new AbortController().signal,async()=>({height:12}),async item=>registeredModels.get(item.id).model);
    assert.equal(landmarkStatus(result,target).phase,'applied');assert.equal(landmarkStatus(result,target).message.includes('画面待验'),target.validation.visual==='pending');
    assert.equal(landmarkStatus(result,skytree).phase,'applied');assert.equal(result.meshes.filter(m=>m.anchor).length,2);assert.equal(result.status.polygons,1,'FootTown is retained');
    assert.equal(landmarkStatus(result,target).ground,12);assert.equal(landmarkStatus(result,target).reason,undefined);
    assert.ok(!landmarkPart(target,target.tile,42473133,20,0,target));assert.ok(result.status.triangles<=BUILDING_MAX_TRIANGLES);
    const failed=await loadBuildings(target,'https://example.test/meta','dem',new AbortController().signal,async()=>({height:12}),async item=>{if(item.id===target.id)throw Error('Tokyo only');return registeredModels.get(item.id).model;});
    assert.equal(landmarkStatus(failed,target).phase,'fallback');assert.equal(landmarkStatus(failed,skytree).phase,'applied');assert.equal(failed.status.polygons,parts.length);
    assert.equal(landmarkStatus(failed,target).reason,'failed');assert.equal(landmarkStatus(failed,target).ground,undefined);
  }finally{globalThis.fetch=original;clearBuildingCache();}
});

test('没有粗分部映射时近处保留源数据；预算不足的远景模型不下载',async()=>{
  const original=globalThis.fetch,target=tokyoTower,parts=target.parts,triangles=target.asset.triangles;
  const meta={maxzoom:14,tiles:['https://example.test/planet/budget/{z}/{x}/{y}.pbf'],vector_layers:[{id:'building'}]};
  globalThis.fetch=async url=>new Response(String(url).endsWith('meta')?JSON.stringify(meta):fixture([]));const calls=[];
  const loader=async item=>{calls.push(item.id);return registeredModels.get(item.id).model;};
  try{
    target.parts=[];clearBuildingCache();let result=await loadBuildings(target,'https://example.test/meta','dem',new AbortController().signal,async()=>({height:0}),loader);
    assert.equal(landmarkStatus(result,target).phase,'fallback');assert.match(landmarkStatus(result,target).message,/对应关系未确认/);assert.ok(!calls.includes(target.id));
    assert.equal(landmarkStatus(result,target).reason,'unconfirmed');
    target.parts=parts;target.asset.triangles=BUILDING_MAX_TRIANGLES;calls.length=0;clearBuildingCache();
    // East of both towers: Skytree is nearer, receives budget first.
    result=await loadBuildings({longitude:139.95,latitude:skytree.latitude},'https://example.test/meta','dem',new AbortController().signal,async()=>({height:0}),loader);
    assert.equal(landmarkStatus(result,skytree).phase,'applied');assert.match(landmarkStatus(result,target).message,/预算不足/);assert.ok(!calls.includes(target.id));assert.ok(result.status.limited);
    assert.equal(landmarkStatus(result,target).reason,'budget');
  }finally{target.parts=parts;target.asset.triangles=triangles;globalThis.fetch=original;clearBuildingCache();}
});

test('同城双地标索引网格在 GL 替身共享场景绘制并全部释放',async()=>{
  const {gl,state,resources,draws}=fakeGL(),before=new Map(state),meshes=[skytree,tokyoTower].map(target=>({tile:target.tile,...registeredModels.get(target.id).model,anchor:{...target,ellipsoidalHeight:10}}));
  const layer=new BuildingLayer(()=>{},'tiles','dem',async()=>({meshes,status:{...emptyBuildings,phase:'ready'}}));
  layer.onAdd(map,gl);layer.setScene({...initialPlan,layers:{...initialPlan.layers,buildings:true}},environment,[0,0,1]);await Promise.resolve();layer.render(gl,cameraInput);
  assert.equal(draws.length,2);assert.ok(draws.every(d=>d.type===gl.UNSIGNED_INT&&d.index));assert.deepEqual(draws.map(d=>d.count),meshes.map(m=>m.indices.length));assert.deepEqual(state,before);
  layer.onRemove();assert.equal(resources.size,0);assert.deepEqual(state,before);
});
test('地标局部ENU转换与独立ECEF矩阵相符，保留远景曲率及三维尺度',()=>{
  const axis=p=>{const a=p.latitude*Math.PI/180,b=p.longitude*Math.PI/180;return [[-Math.sin(b),Math.cos(b),0],[-Math.sin(a)*Math.cos(b),-Math.sin(a)*Math.sin(b),Math.cos(a)],[Math.cos(a)*Math.cos(b),Math.cos(a)*Math.sin(b),Math.sin(a)]];};
  const anchor={...skytree,ellipsoidalHeight:4};
  for(const eye of [{latitude:35.70698835542723,longitude:139.79386910980952,ellipsoidalHeight:104},{latitude:35.70698835542723,longitude:139.765,ellipsoidalHeight:104},{latitude:35.75,longitude:139.81,ellipsoidalHeight:5},{latitude:35.98,longitude:139.81,ellipsoidalHeight:104},{latitude:36.16,longitude:139.81,ellipsoidalHeight:104}]){
    const f=landmarkFrame(eye,anchor),a=axis(anchor),b=axis(eye),origin=geodeticEcef(eye),base=geodeticEcef(anchor);
    for(const p of [[0,0,0],[32,-40,0],[0,0,634]]){
      const dest=base.map((v,i)=>v+a.reduce((s,ax,j)=>s+ax[i]*p[j],0)),d=dest.map((v,i)=>v-origin[i]);
      const independent=b.map(ax=>ax.reduce((s,v,i)=>s+v*d[i],0));
      const actual=f.base.map((v,i)=>v+p.reduce((s,x,j)=>s+x*f.basis[j*3+i],0));actual.forEach((v,i)=>close(v,independent[i],1e-8));
    }
  }
  assert.ok(skytreeInRange({longitude:139.765,latitude:35.70698835542723}));assert.ok(skytreeInRange({longitude:139.7,latitude:35.7}));
  assert.ok(!skytreeInRange({longitude:139,latitude:35.7}));assert.ok(!skytreeInRange({longitude:skytree.longitude-180,latitude:-skytree.latitude}));
  const part=skytree.parts[0];assert.ok(skytreePart(skytree.tile,part.id,part.height,part.base,skytree));
  assert.ok(!skytreePart(skytree.tile,part.id,part.height,part.base,{longitude:139.8,latitude:35.7}));assert.ok(!skytreePart(skytree.tile,part.id,351,part.base,skytree));
});
test('晴空塔确认三分部后替换并保留邻楼，共用全场面数预算；模型失败及对应变化回退',async()=>{
  const original=globalThis.fetch,metadata={maxzoom:14,tiles:['https://example.test/planet/v1/{z}/{x}/{y}.pbf'],vector_layers:[{id:'building'}]};
  const x=Math.round(((skytree.longitude+180)/360*2**14-skytree.tile.x)*8192),y=Math.round(((1-Math.asinh(Math.tan(skytree.latitude*Math.PI/180))/Math.PI)/2*2**14-skytree.tile.y)*8192);
  const parts=skytree.parts.map(p=>({...p,rings:[rectangle(x-8,y-8,16,16)]}));parts.push({height:40,base:0,rings:[rectangle(x+120,y,40,40)]});
  let change=false;globalThis.fetch=async url=>new Response(String(url).endsWith('meta')?JSON.stringify(metadata):String(url).endsWith('/14/14554/6450.pbf')?fixture(change?parts.slice(1):parts):fixture([]));
  const elevation=async()=>({height:7}),signal=new AbortController().signal;
  try{
    clearBuildingCache();let result=await loadBuildings(skytree,'https://example.test/meta','dem',signal,elevation,async()=>model);
    assert.equal(landmarkStatus(result).phase,'applied');assert.equal(result.status.polygons,1);assert.equal(result.meshes.filter(m=>m.anchor).length,1);assert.ok(result.status.triangles<=BUILDING_MAX_TRIANGLES);assert.equal(result.meshes.find(m=>m.anchor).anchor.ellipsoidalHeight,7);
    result=await loadBuildings(skytree,'https://example.test/meta','dem',signal,elevation,async()=>{throw new Error('network');});assert.equal(landmarkStatus(result).phase,'fallback');assert.equal(result.status.polygons,4);assert.ok(!result.meshes.some(m=>m.anchor));
    change=true;clearBuildingCache();result=await loadBuildings(skytree,'https://example.test/meta','dem',signal,elevation,async()=>{throw new Error('must not load');});assert.equal(landmarkStatus(result).phase,'fallback');assert.equal(result.status.polygons,3);
  }finally{globalThis.fetch=original;clearBuildingCache();}
});
test('实际图层同时绘制索引地标与普通体块，索引归属VAO并回收全部资源',async()=>{
  const {gl,state,resources,draws}=fakeGL(),before=new Map(state);
  const coarse={tile:skytree.tile,vertices:new Float32Array(buildingGeometry(polygon,0,0))};
  const fine={tile:skytree.tile,...model,anchor:{...skytree,ellipsoidalHeight:7}};
  const layer=new BuildingLayer(()=>{},'tiles','dem',async()=>({meshes:[fine,coarse],status:{...emptyBuildings,phase:'ready'}}));
  layer.onAdd(map,gl);layer.setScene({...initialPlan,layers:{...initialPlan.layers,buildings:true}},environment,[0,0,1]);await Promise.resolve();layer.render(gl,cameraInput);
  assert.equal(draws.length,2);assert.equal(draws[0].count,model.indices.length);assert.equal(draws[0].type,gl.UNSIGNED_INT);assert.ok(draws[0].index);assert.ok(!draws[1].index);assert.deepEqual(state,before);
  layer.onRemove();assert.equal(resources.size,0);assert.deepEqual(state,before);
});

test('地标50公里上限不扩大普通瓦片窗口，曲率使远处基座下沉而非沿平地悬浮',()=>{
  assert.equal(LANDMARK_RADIUS,50000);assert.equal(BUILDING_RADIUS,5000);
  const pointAt=north=>({latitude:skytree.latitude+north/111000,longitude:skytree.longitude});
  for(const nominal of [10000,30000,49000]){
    const eye={...pointAt(nominal),ellipsoidalHeight:100};const f=landmarkFrame(eye,{...skytree,ellipsoidalHeight:0});
    const distance=skytreeDistance(eye);assert.ok(distance>nominal*.995&&distance<nominal*1.005);assert.ok(skytreeInRange(eye));
    assert.ok(f.base[2]<-100-nominal**2/(2*6500000));assert.ok(f.base[2]>-100-nominal**2/(2*6200000));
    assert.ok(!buildingTiles(eye).tiles.some(t=>t.x===skytree.tile.x&&t.y===skytree.tile.y));
  }
  assert.ok(skytreeInRange(pointAt(50000)));assert.ok(!skytreeInRange(pointAt(50300)));
});

test('较大预算在保留地标的同时增加普通建筑，仍受面数和轮廓点双重上限约束',()=>{
  const candidates=Array.from({length:30000},(_,i)=>({id:String(i),height:20,points:5,triangles:10,east:(i%20)*200,north:Math.floor(i/20)%20*200,footprint:10}));
  const old=selectBuildings(candidates,80000,120000-model.indices.length/3),next=selectBuildings(candidates,BUILDING_MAX_POINTS,BUILDING_MAX_TRIANGLES-model.indices.length/3);
  assert.ok(next.selected.length>old.selected.length*5);assert.ok(next.points<=BUILDING_MAX_POINTS);assert.ok(next.triangles+model.indices.length/3<=BUILDING_MAX_TRIANGLES);assert.ok(next.limited);
  const pointBound=selectBuildings(candidates,100,BUILDING_MAX_TRIANGLES);assert.equal(pointBound.points,100);
});

test('五公里外的地标无需远处MVT或粗分部，失败不假称保留粗体块，范围外不读取模型',async()=>{
  const original=globalThis.fetch,requests=[];const metadata={maxzoom:14,tiles:['https://example.test/planet/v1/{z}/{x}/{y}.pbf'],vector_layers:[{id:'building'}]};
  globalThis.fetch=async url=>{requests.push(String(url));return new Response(String(url).endsWith('meta')?JSON.stringify(metadata):fixture([]));};
  const signal=new AbortController().signal,point={longitude:139.5,latitude:skytree.latitude};let modelCalls=0;
  try{
    clearBuildingCache();const result=await loadBuildings(point,'https://example.test/meta','dem',signal,async()=>({height:8}),async target=>{if(target.id!==skytree.id)throw Error('fixture only');modelCalls++;return model;});
    assert.equal(result.status.phase,'ready');assert.equal(result.status.polygons,0);assert.equal(landmarkStatus(result).phase,'applied');assert.ok(landmarkStatus(result).distance>27000);assert.equal(result.status.triangles,model.indices.length/3);
    assert.equal(modelCalls,1);assert.ok(!requests.some(r=>r.endsWith('/14554/6450.pbf')));assert.equal(result.status.tiles,buildingTiles(point).tiles.length);
    const failed=await loadBuildings(point,'https://example.test/meta','dem',signal,async()=>({height:8}),async()=>{throw Error('model unavailable');});assert.equal(failed.status.phase,'empty');assert.equal(landmarkStatus(failed).phase,'fallback');assert.match(landmarkStatus(failed).message,/未加载对应粗体块/);assert.equal(failed.meshes.length,0);
    await loadBuildings({longitude:139,latitude:skytree.latitude},'https://example.test/meta','dem',signal,async()=>({height:8}),async()=>{modelCalls++;return model;});assert.equal(modelCalls,1);
    const abort=new AbortController();await assert.rejects(loadBuildings(point,'https://example.test/meta','dem',abort.signal,async()=>({height:8}),async()=>{abort.abort();return model;}),{name:'AbortError'});
  }finally{globalThis.fetch=original;clearBuildingCache();}
});

test('普通窗口边缘仅部分粗分部入选时，仍按整块源瓦片确认替换，避免五公里断层',async()=>{
  const original=globalThis.fetch,point={latitude:skytree.latitude+5000/111000,longitude:skytree.longitude};
  const x=Math.round(((skytree.longitude+180)/360*2**14-skytree.tile.x)*8192),y=Math.round(((1-Math.asinh(Math.tan(skytree.latitude*Math.PI/180))/Math.PI)/2*2**14-skytree.tile.y)*8192);
  const parts=skytree.parts.map((p,i)=>({...p,rings:[rectangle(x-2,y+(i-1)*120-2,4,4)]}));
  const meta={maxzoom:14,tiles:['https://example.test/planet/edge/{z}/{x}/{y}.pbf'],vector_layers:[{id:'building'}]};
  let missing=false;globalThis.fetch=async url=>new Response(String(url).endsWith('meta')?JSON.stringify(meta):String(url).endsWith('/14554/6450.pbf')?fixture(missing?parts.slice(1):parts):fixture([]));
  try{
    clearBuildingCache();const result=await loadBuildings(point,'https://example.test/meta','dem',new AbortController().signal,async()=>({height:0}),async()=>model);
    assert.equal(landmarkStatus(result).phase,'applied');assert.equal(result.status.polygons,0);assert.equal(result.meshes.length,1);
    const fallback=await loadBuildings(point,'https://example.test/meta','dem',new AbortController().signal,async()=>({height:0}),async()=>{throw Error('fail');});assert.equal(landmarkStatus(fallback).phase,'fallback');assert.ok(fallback.status.polygons>0&&fallback.status.polygons<3);
    missing=true;clearBuildingCache();const changed=await loadBuildings(point,'https://example.test/meta','dem',new AbortController().signal,async()=>({height:0}),async()=>{throw Error('must not load');});assert.match(landmarkStatus(changed).message,/对应关系未确认/);
  }finally{globalThis.fetch=original;clearBuildingCache();}
});

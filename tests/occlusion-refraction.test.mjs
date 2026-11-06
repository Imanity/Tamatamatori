import test from "node:test";
import assert from "node:assert/strict";
import { apparentElevation, refractDirection } from "../src/domain/refraction.ts";
import { bodyPolygons } from "../src/domain/celestial-projection.ts";
import { direction } from "../src/domain/ephemeris.ts";
import { initialPlan } from "../src/domain/plan.ts";
import { CelestialLayer, triangulate } from "../src/preview/celestial-layer.ts";
import { StarfieldLayer } from "../src/preview/starfield-layer.ts";
import { skyReference } from "../src/domain/starfield.ts";
import { photoCameraMatrix } from "../src/preview/terrain-perspective-math.ts";
import {constellationScene} from '../src/domain/constellations.ts';
import {skyPointView} from '../src/domain/starfield.ts';
import {deepSkyScene} from '../src/domain/deep-sky.ts';
import {DeepSkyTextures} from '../src/preview/deep-sky-textures.ts';
import { parseWeather, sampleWeather } from '../src/domain/weather.ts';
import { weatherResponse } from './fixtures/weather.mjs';

const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} vs ${b}`);
const disc = (elevation) => ({ id: "sun", elevation, azimuth: 0, angularRadius: 0.25, distanceKm: 1.5e8, direction: direction(0, elevation) });

test("标准折射抬高近地平线目标，天顶有限，无折射保留几何方向", () => {
  close(apparentElevation(0, "standard"), 0.483032, 1e-5);
  close(apparentElevation(10, "standard"), 10.090128, 1e-5);
  for (const elevation of [-90, -10, -1, 0, 10, 89, 90]) {
    close(apparentElevation(elevation, "none"), elevation);
    assert.ok(apparentElevation(elevation, "standard") >= elevation);
    assert.ok(apparentElevation(elevation, "standard") <= 90);
    assert.ok(refractDirection(direction(37, elevation), "standard").every(Number.isFinite));
  }
  assert.throws(() => apparentElevation(NaN, "standard"));
});

test("逐轮廓折射压扁近地平线圆盘，并允许几何地平线下的上缘出现", () => {
  const geometric = { ...initialPlan, azimuth: 0, pitch: 0.5, refraction: "none", focalLength: 200 };
  const standard = { ...geometric, refraction: "standard" };
  const a = bodyPolygons(geometric, disc(0.3)), b = bodyPolygons(standard, disc(0.3));
  const extent = (points, axis) => Math.max(...points.map((p) => p[axis])) - Math.min(...points.map((p) => p[axis]));
  assert.ok(extent(b.outline, "y") < extent(a.outline, "y") * 0.95);
  close(extent(b.outline, "x"), extent(a.outline, "x"), 1e-4);
  assert.equal(bodyPolygons(geometric, disc(-0.5)).state, "地平线下");
  assert.equal(bodyPolygons(standard, disc(-0.5)).state, "画面内");
  assert.ok(b.visualElevation > 0.3);
});

test("三角化保留凹月相轮廓面积，空和退化轮廓不产生三角形", () => {
  const points = [{x:0,y:0},{x:2,y:0},{x:2,y:2},{x:1,y:1},{x:0,y:2}];
  const mesh = triangulate(points);
  let area = 0;
  for (let i = 0; i < mesh.length; i += 6)
    area += Math.abs((mesh[i+2]-mesh[i])*(mesh[i+5]-mesh[i+1])-(mesh[i+4]-mesh[i])*(mesh[i+3]-mesh[i+1]))/2;
  close(area, 3);
  assert.equal(triangulate([]).length, 0);
  assert.equal(triangulate([{x:0,y:0},{x:1,y:0}]).length, 0);
});

// Tests asynchronous query/state/resource management, not WebGL rasterization.
function fakeGL() {
  const gl = {}, names = ['VERTEX_SHADER','FRAGMENT_SHADER','COMPILE_STATUS','LINK_STATUS','CURRENT_PROGRAM','VERTEX_ARRAY_BINDING','ARRAY_BUFFER_BINDING','DEPTH_TEST','CULL_FACE','BLEND','STENCIL_TEST','DEPTH_FUNC','DEPTH_RANGE','DEPTH_WRITEMASK','COLOR_WRITEMASK','BLEND_SRC_RGB','BLEND_DST_RGB','BLEND_SRC_ALPHA','BLEND_DST_ALPHA','ARRAY_BUFFER','FLOAT','ONE','ONE_MINUS_SRC_ALPHA','LEQUAL','GREATER','LESS','STREAM_DRAW','TRIANGLES','LINE_LOOP','ANY_SAMPLES_PASSED','QUERY_RESULT_AVAILABLE','QUERY_RESULT'];
  names.forEach((name, i) => gl[name] = i + 1);
  for(const name of ['POINTS','LINES','ELEMENT_ARRAY_BUFFER','STATIC_DRAW','UNSIGNED_SHORT','ACTIVE_TEXTURE','TEXTURE0','TEXTURE_2D','TEXTURE_BINDING_2D','MAX_TEXTURE_SIZE','UNPACK_FLIP_Y_WEBGL','UNPACK_PREMULTIPLY_ALPHA_WEBGL','UNPACK_COLORSPACE_CONVERSION_WEBGL','UNPACK_ALIGNMENT','NONE','RGBA','UNSIGNED_BYTE','TEXTURE_MIN_FILTER','TEXTURE_MAG_FILTER','TEXTURE_WRAP_S','TEXTURE_WRAP_T','LINEAR_MIPMAP_LINEAR','LINEAR','REPEAT','CLAMP_TO_EDGE','SAMPLER_BINDING'])gl[name]=names.length+Object.keys(gl).length+1;
  const state = new Map([[gl.CURRENT_PROGRAM,{}],[gl.VERTEX_ARRAY_BINDING,{}],[gl.ARRAY_BUFFER_BINDING,{}],[gl.DEPTH_FUNC,gl.LESS],[gl.DEPTH_RANGE,[0,0.8]],[gl.DEPTH_WRITEMASK,true],[gl.COLOR_WRITEMASK,[false,true,false,true]],...['BLEND_SRC_RGB','BLEND_DST_RGB','BLEND_SRC_ALPHA','BLEND_DST_ALPHA'].map(name=>[gl[name],gl.ONE])]);
  const enabled = new Set([gl.CULL_FACE, gl.STENCIL_TEST]);
  for (const [key,value] of [[gl.ACTIVE_TEXTURE,gl.TEXTURE0+7],[gl.MAX_TEXTURE_SIZE,2048],[gl.UNPACK_FLIP_Y_WEBGL,true],[gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true],[gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,999],[gl.UNPACK_ALIGNMENT,8],[`texture${gl.TEXTURE0}`,{}],[`texture${gl.TEXTURE0+7}`,{}],[`sampler${gl.TEXTURE0}`,{}]]) state.set(key,value);
  const queries = new Set(), resources = new Set();
  gl.results = []; gl.draws = []; gl.uploads=[]; gl.compile = true;
  const uniforms=new Map();
  const allocate = () => { const object={}; resources.add(object); return object; };
  for (const type of ['Shader','Program','Buffer','VertexArray','Texture']) { gl[`create${type}`]=allocate; gl[`delete${type}`]=(object)=>resources.delete(object); }
  gl.activeTexture=value=>state.set(gl.ACTIVE_TEXTURE,value);
  gl.bindTexture=(_,value)=>state.set(`texture${state.get(gl.ACTIVE_TEXTURE)}`,value);
  gl.bindSampler=(unit,value)=>state.set(`sampler${gl.TEXTURE0+unit}`,value);
  gl.pixelStorei=(key,value)=>state.set(key,value);
  gl.textureUploads=0;gl.texImage2D=()=>{gl.textureUploads++;if(gl.textureFailure)throw new Error('texture upload');};
  gl.texParameteri=()=>{};gl.generateMipmap=()=>{};
  for (const name of ['shaderSource','compileShader','attachShader','linkProgram','enableVertexAttribArray','vertexAttribPointer','uniform4fv','bufferData']) gl[name]=()=>{};
  gl.bufferData=(_,data)=>gl.uploads.push(data.slice());
  gl.getShaderParameter=()=>gl.compile; gl.getProgramParameter=()=>true; gl.getUniformLocation=(_,name)=>name;
  gl.uniform1f=(name,value)=>uniforms.set(name,value);gl.uniformMatrix4fv=()=>{};
  gl.uniform1i=gl.uniform1f;
  gl.uniform2fv=gl.uniform3fv=(name,value)=>uniforms.set(name,Array.from(value));
  gl.isContextLost=()=>false; gl.getParameter=(key)=>key===gl.TEXTURE_BINDING_2D?state.get(`texture${state.get(gl.ACTIVE_TEXTURE)}`):key===gl.SAMPLER_BINDING?state.get(`sampler${state.get(gl.ACTIVE_TEXTURE)}`):state.get(key); gl.isEnabled=(cap)=>enabled.has(cap);
  gl.enable=(cap)=>enabled.add(cap); gl.disable=(cap)=>enabled.delete(cap);
  gl.useProgram=(value)=>state.set(gl.CURRENT_PROGRAM,value); gl.bindVertexArray=(value)=>state.set(gl.VERTEX_ARRAY_BINDING,value);
  gl.bindBuffer=(_,value)=>state.set(gl.ARRAY_BUFFER_BINDING,value); gl.depthFunc=(value)=>state.set(gl.DEPTH_FUNC,value);
  gl.depthRange=(...value)=>state.set(gl.DEPTH_RANGE,value); gl.depthMask=(value)=>state.set(gl.DEPTH_WRITEMASK,value);
  gl.colorMask=(...value)=>state.set(gl.COLOR_WRITEMASK,value);
  gl.blendFunc=(src,dst)=>gl.blendFuncSeparate(src,dst,src,dst);
  gl.blendFuncSeparate=(...values)=>['BLEND_SRC_RGB','BLEND_DST_RGB','BLEND_SRC_ALPHA','BLEND_DST_ALPHA'].forEach((name,i)=>state.set(gl[name],values[i]));
  gl.createQuery=()=>{const query={available:false}; queries.add(query);return query;};gl.deleteQuery=(query)=>queries.delete(query);
  gl.beginQuery=(_,query)=>{query.result=gl.results.shift();};gl.endQuery=()=>{};
  gl.drawArrays=(mode,_,count)=>gl.draws.push({mode,count,probe:uniforms.get('u_probe'),haGain:uniforms.get('u_ha_gain'),dark:uniforms.get('u_dark'),depth:state.get(gl.DEPTH_FUNC),write:state.get(gl.DEPTH_WRITEMASK),colorMask:[...state.get(gl.COLOR_WRITEMASK)],weatherMode:uniforms.get('u_mode'),depthTest:enabled.has(gl.DEPTH_TEST),clouds:uniforms.get('u_layers')});
  gl.drawElements=(mode,count)=>gl.draws.push({mode,count,strength:uniforms.get('u_strength'),depth:state.get(gl.DEPTH_FUNC),write:state.get(gl.DEPTH_WRITEMASK)});
  gl.getQueryParameter=(query,key)=>key===gl.QUERY_RESULT_AVAILABLE?query.available:query.result;
  gl.complete=()=>queries.forEach(query=>query.available=true);
  return {gl,queries,resources,state,enabled};
}
const polygon = [{x:-0.2,y:-0.2},{x:0.2,y:-0.2},{x:0.2,y:0.2},{x:-0.2,y:0.2}];
const frame = (key, ready=true) => ({key,planKey:key,ready,bodies:[{id:'sun',outline:polygon,illuminated:polygon}]});

test('天气云层使用天空深度，降水可覆盖前景且不写深度，关闭和卸载恢复宿主', () => {
  const {gl,resources,state,enabled} = fakeGL(), reports=[];
  const previous=new Map(state), previousEnabled=new Set(enabled);
  const layer=new CelestialLayer(s=>reports.push(s));layer.onAdd({triggerRepaint(){}},gl);
  const weather=sampleWeather(parseWeather(weatherResponse(),Date.now()),initialPlan.instant);
  layer.setScene({...frame('weather',false),plan:initialPlan,weather}); layer.render(gl);
  const cloud=gl.draws.find(d=>d.weatherMode===0), rain=gl.draws.find(d=>d.weatherMode===1);
  assert.deepEqual(cloud.clouds,[0.4,0.25,0.2]); assert.ok(cloud.depthTest); assert.equal(cloud.depth,gl.LEQUAL);
  assert.equal(rain.depthTest,false); assert.equal(rain.write,false);
  assert.deepEqual(state,previous);assert.deepEqual(enabled,previousEnabled);
  const count=gl.draws.length;layer.setScene({...frame('off',false),plan:initialPlan});layer.render(gl);
  assert.equal(gl.draws.length-count,2);layer.onRemove();assert.equal(resources.size,0);
});

test("异步 GPU 查询区分无遮挡、部分、全部遮挡和亚像素，且恢复宿主 GL 状态", () => {
  for (const [results,expected] of [[[true,false],'clear'],[[true,true],'partial'],[[false,true],'blocked'],[[false,false],'subpixel']]) {
    const {gl,queries,resources,state,enabled}=fakeGL(), reports=[];
    const before=new Map(state), previousEnabled=new Set(enabled);
    const layer=new CelestialLayer(snapshot=>reports.push(snapshot));
    layer.onAdd({triggerRepaint(){}},gl);layer.setScene(frame('a'));gl.results=[...results];
    layer.render(gl);assert.equal(reports.at(-1).states.sun,'waiting');assert.equal(queries.size,2);
    assert.ok(gl.draws.every(draw=>draw.write===false));assert.deepEqual(state,before);assert.deepEqual(enabled,previousEnabled);
    gl.complete();layer.render(gl);assert.equal(reports.at(-1).states.sun,expected);assert.equal(queries.size,0);
    layer.onRemove();assert.equal(resources.size,0);
  }
});

test("旧查询在改时刻、地形失效或隐藏时丢弃，恢复后必须重新测量", () => {
  const {gl,queries,resources}=fakeGL(),reports=[];
  const layer=new CelestialLayer(snapshot=>reports.push(snapshot));layer.onAdd({triggerRepaint(){}},gl);
  layer.setScene(frame('old'));gl.results=[false,true];layer.render(gl);
  layer.setScene(frame('new'));assert.equal(queries.size,0);assert.equal(reports.at(-1).planKey,'new');
  gl.results=[true,false];layer.render(gl);gl.complete();layer.invalidate();assert.equal(queries.size,0);
  layer.render(gl);assert.equal(reports.at(-1).states.sun,'waiting');assert.equal(queries.size,0);
  layer.setScene(frame('new'));gl.results=[true,true];layer.render(gl);gl.complete();layer.render(gl);
  assert.equal(reports.at(-1).states.sun,'partial');layer.onRemove();assert.equal(resources.size,0);
});

test("编译失败明确报告错误，待处理查询在卸载时释放", () => {
  const {gl,queries,resources}=fakeGL(),reports=[];
  const layer=new CelestialLayer(snapshot=>reports.push(snapshot));gl.compile=false;
  layer.onAdd({triggerRepaint(){}},gl);assert.equal(reports.at(-1).states.sun,'error');layer.onRemove();assert.equal(resources.size,0);
  const next=new CelestialLayer(snapshot=>reports.push(snapshot));gl.compile=true;next.onAdd({triggerRepaint(){}},gl);
  next.setScene(frame('pending'));gl.results=[true,false];next.render(gl);assert.equal(queries.size,2);
  next.onRemove();assert.equal(queries.size,0);assert.equal(resources.size,0);
});

test("GPU 查询未完成时保持未知，超时停止轮询并释放查询", (t) => {
  let clock=1000;t.mock.method(Date,'now',()=>clock);
  const {gl,queries}=fakeGL(),reports=[];
  const layer=new CelestialLayer(snapshot=>reports.push(snapshot));layer.onAdd({triggerRepaint(){}},gl);
  layer.setScene(frame('timeout'));gl.results=[true,false];layer.render(gl);
  clock+=6000;layer.render(gl);
  assert.equal(reports.at(-1).states.sun,'error');assert.ok(reports.at(-1).message.includes('超时'));
  assert.equal(queries.size,0);layer.onRemove();
});

// Controlled camera feedback isolates query lifecycle; actual rasterization is Chrome-verified.
function starFrame(key,ready=true){
  const plan={...initialPlan,focalLength:1000,instant:'2026-07-01T13:00:00Z',refraction:'none',layers:{sun:false,moon:false,stars:true,milkyWay:true,constellations:false}};
  const point=skyReference(plan).points.find(p=>p.name==='北极星');
  return {key,planKey:key,ready,plan:{...plan,azimuth:point.azimuth,pitch:point.elevation}};
}
async function prepareStars(gl,reports){
  const layer=new StarfieldLayer(s=>reports.push(s),async()=>({width:2048,height:256,close(){}}));
  layer.onAdd({triggerRepaint(){},getContainer:()=>({clientWidth:600,clientHeight:400}),getCanvas:()=>({width:1200})},gl);
  const frame=starFrame('a');layer.setScene(frame);
  layer.camera={azimuth:frame.plan.azimuth,pitch:frame.plan.pitch};layer.matrix=photoCameraMatrix(frame.plan);
  await Promise.resolve();
  return layer;
}
test('星空与银河共享天空深度、恢复宿主状态，异步查询区分清晰与山体遮挡',async()=>{
  for(const clear of [true,false]){
    const {gl,state,enabled,queries,resources}=fakeGL(),reports=[],before=new Map(state),previousEnabled=new Set(enabled);
    const layer=await prepareStars(gl,reports);gl.results=[clear];layer.render(gl);
    assert.equal(queries.size,1);assert.equal(reports.at(-1).ready,false);
    assert.ok(gl.draws.some(d=>d.mode===gl.TRIANGLES&&d.count===103680));
    assert.ok(gl.draws.some(d=>d.mode===gl.POINTS&&d.count===928));
    assert.ok(gl.draws.every(d=>d.depth===gl.LEQUAL&&d.write===false));
    assert.deepEqual(state,before);assert.deepEqual(enabled,previousEnabled);
    gl.complete();layer.render(gl);const id=skyReference(starFrame('a').plan).points.find(p=>p.name==='北极星').id;
    assert.equal(reports.at(-1).states[id],clear?'clear':'blocked');assert.equal(queries.size,0);
    layer.onRemove();assert.equal(resources.size,0);
  }
});
test('空间站独立显示、轨迹共享地形深度，轨道更新丢弃旧查询并释放资源', async () => {
  const { gl, queries, resources } = fakeGL(), reports = [];
  const layer = await prepareStars(gl, reports);
  const point = { id: 'station-25544', name: 'ISS', azimuth: 0, elevation: 30, direction: direction(0, 30), magnitude: 0, color: [0.7, 0.9, 1] };
  const plan = { ...initialPlan, azimuth: 0, pitch: 30, layers: { sun: false, moon: false, stars: false, milkyWay: false, constellations: false, deepSky: false, stations: true } };
  const stations = { key: 'orbit-a', points: [point, { ...point, id: 'station-48274', elevation: -0.2, direction: direction(0, -0.2) }], trail: [{ ...point, id: 'station-25544-trail-10', name: undefined }] };
  layer.setScene({ key: 'station-a', planKey: 'station-plan', ready: true, plan, stations });
  layer.camera = { azimuth: 0, pitch: 30 };
  layer.matrix = photoCameraMatrix(plan);
  gl.results = [true]; layer.render(gl);
  assert.equal(queries.size, 1);
  const data = gl.uploads.at(-1);
  assert.equal(data.length, 18);
  close(data[8], 0.95); close(data[17], 0.45);
  assert.ok(gl.draws.at(-1).depth === gl.LEQUAL);
  layer.setScene({ key: 'station-b', planKey: 'station-plan', ready: true, plan, stations: { ...stations, key: 'orbit-b' } });
  assert.equal(queries.size, 0);
  assert.equal(reports.at(-1).orbitKey, 'orbit-b');
  assert.equal(reports.at(-1).ready, false);
  gl.results = [false]; layer.render(gl); gl.complete(); layer.render(gl);
  assert.equal(reports.at(-1).states['station-25544'], 'blocked');
  assert.equal(reports.at(-1).states['station-48274'], undefined);
  layer.onRemove(); assert.equal(queries.size, 0); assert.equal(resources.size, 0);
});

test('转向时延续星空与深空标注遮挡，最新读数保持待测，新机位和故障清空', async () => {
  for (const deep of [false, true]) {
    const { gl } = fakeGL(), reports = [];
    const prepared = deep ? await prepareDeep(gl, reports) : { layer: await prepareStars(gl, reports) };
    const layer = prepared.layer;
    gl.results = Array(30).fill(true); layer.render(gl); gl.complete(); layer.render(gl);
    const confirmed = reports.at(-1).labelStates;
    assert.ok(Object.keys(confirmed).length > 0);
    const original = layer.frame;
    layer.setScene({ ...original, key: 'turned', planKey: 'turned', plan: { ...original.plan, azimuth: original.plan.azimuth + 1 } });
    assert.equal(reports.at(-1).ready, false);
    assert.deepEqual(reports.at(-1).states, {});
    assert.deepEqual(reports.at(-1).labelStates, confirmed);
    layer.invalidate(); assert.deepEqual(reports.at(-1).labelStates, confirmed);
    layer.setScene({ ...original, key: 'moved', planKey: 'moved', plan: { ...original.plan, latitude: original.plan.latitude + 0.01 } });
    assert.deepEqual(reports.at(-1).labelStates, {});
    layer.fail('测试失败'); assert.deepEqual(reports.at(-1).labelStates, {});
    layer.onRemove();
  }
});

test('星空查询在计划/地形失效后废弃，失败明确反馈并释放资源',async t=>{
  const {gl,queries,resources}=fakeGL(),reports=[],layer=await prepareStars(gl,reports);
  gl.results=[true];layer.render(gl);assert.equal(queries.size,1);
  layer.setScene(starFrame('b'));assert.equal(queries.size,0);assert.equal(reports.at(-1).planKey,'b');
  gl.results=[false];layer.render(gl);layer.invalidate();assert.equal(queries.size,0);
  const count=gl.draws.length;layer.render(gl);assert.ok(gl.draws.length>count);assert.equal(queries.size,0);assert.equal(reports.at(-1).ready,false);
  let clock=1000;t.mock.method(Date,'now',()=>clock);
  layer.setScene(starFrame('c'));gl.results=[true];layer.render(gl);clock+=6000;layer.render(gl);
  assert.match(reports.at(-1).message,/超时/);assert.equal(queries.size,0);layer.onRemove();assert.equal(resources.size,0);
  const broken=new StarfieldLayer(s=>reports.push(s));gl.compile=false;
  broken.onAdd({triggerRepaint(){}},gl);assert.match(reports.at(-1).message,/无法启动/);broken.onRemove();assert.equal(resources.size,0);
});

test('白昼透明星点仍独立测试几何遮挡，下一帧恢复正常明暗',async()=>{
  const {gl,queries,resources}=fakeGL(),reports=[],layer=await prepareStars(gl,reports);
  const frame=starFrame('day');frame.plan.instant='2026-07-02T03:00:00Z';
  const target=skyReference(frame.plan).points.find(p=>p.name==='北极星');
  frame.plan.azimuth=target.azimuth;frame.plan.pitch=target.elevation;
  layer.setScene(frame);layer.setContrast(200);layer.camera={azimuth:frame.plan.azimuth,pitch:frame.plan.pitch};layer.matrix=photoCameraMatrix(frame.plan);
  gl.results=[true];layer.render(gl);
  const points=gl.uploads.find(data=>data.length===928*9);
  assert.ok(points);for(let i=8;i<927*9;i+=9)assert.equal(points[i],0,'daytime visual stars must be transparent');
  assert.equal(points[928*9-1],1,'core remains a direction ring');
  assert.ok(gl.draws.some(draw=>draw.count===928&&draw.probe===0));
  assert.ok(gl.draws.some(draw=>draw.count===1&&draw.probe===1));assert.equal(queries.size,1);
  assert.ok(!gl.draws.some(draw=>draw.mode===gl.TRIANGLES),'maximum display contrast cannot reveal the daytime galaxy');
  gl.complete();layer.render(gl);assert.equal(reports.at(-1).states[target.id],'clear');
  assert.equal(gl.draws.at(-1).probe,0);layer.onRemove();assert.equal(resources.size,0);
});

test('银河对比度只更新显示 uniform，不重传纹理/网格或作废遮挡查询',async()=>{
  const {gl,queries,resources}=fakeGL(),reports=[],layer=await prepareStars(gl,reports);
  gl.results=[true];layer.render(gl);gl.complete();layer.render(gl);
  const base=gl.draws.filter(d=>d.mode===gl.TRIANGLES).at(-1).strength;
  const uploads=gl.uploads.length,textureUploads=gl.textureUploads,reportCount=reports.length;
  for (const percent of [25,100,200,100]) {
    layer.setContrast(percent);layer.render(gl);
    close(gl.draws.filter(d=>d.mode===gl.TRIANGLES).at(-1).strength,base*percent/100);
    assert.equal(gl.uploads.length,uploads);assert.equal(gl.textureUploads,textureUploads);
    assert.equal(queries.size,0);assert.equal(reports.length,reportCount);
  }
  for (const percent of [NaN,Infinity,-1,0,24,201]) assert.throws(()=>layer.setContrast(percent),RangeError);
  layer.onRemove();assert.equal(resources.size,0);
});

test('星座单独开启绘制球面连线并查询名称遮挡，关闭清空，卸载释放新增资源',async()=>{
  const {gl,queries,resources,state}=fakeGL(),reports=[],before=new Map(state),layer=await prepareStars(gl,reports);
  const frame=starFrame('constellations');frame.plan={...frame.plan,instant:'2026-11-08T16:00:00Z',focalLength:35,layers:{sun:false,moon:false,stars:false,milkyWay:false,constellations:true}};
  const figure=constellationScene(frame.plan),orion=figure.anchors.find(p=>p.name==='猎户座');
  frame.plan.azimuth=orion.azimuth;frame.plan.pitch=orion.elevation;
  const visible=figure.anchors.filter(p=>skyPointView(frame.plan,p).state==='画面内');assert.ok(visible.length>0);
  layer.setScene(frame);layer.camera={azimuth:frame.plan.azimuth,pitch:frame.plan.pitch};layer.matrix=photoCameraMatrix(frame.plan);
  gl.results=visible.map(()=>true);layer.render(gl);
  assert.ok(gl.draws.some(d=>d.mode===gl.LINES&&d.count===figure.vertices.length/3&&d.depth===gl.LEQUAL&&!d.write));
  assert.equal(queries.size,visible.length);assert.deepEqual(state,before);
  gl.complete();layer.render(gl);assert.equal(reports.at(-1).states[orion.id],'clear');
  const draws=gl.draws.length;
  layer.setScene({...frame,key:'off',plan:{...frame.plan,layers:{...frame.plan.layers,constellations:false}}});layer.render(gl);assert.equal(gl.draws.length,draws);
  layer.onRemove();assert.equal(resources.size,0);assert.equal(queries.size,0);
});

test('银河按需加载，关闭后的迟到图片释放；纹理复用并恢复宿主纹理、采样器及解包状态',async()=>{
  const {gl,resources,state}=fakeGL(), reports=[], requests=[];
  const layer=new StarfieldLayer(s=>reports.push(s),(signal,maxSize)=>new Promise((resolve,reject)=>requests.push({signal,maxSize,resolve,reject})));
  layer.onAdd({triggerRepaint(){},getContainer:()=>({clientWidth:600,clientHeight:400}),getCanvas:()=>({width:600})},gl);
  const frame=starFrame('off');frame.plan.layers={...frame.plan.layers,milkyWay:false};
  layer.setScene(frame);assert.equal(requests.length,0);assert.equal(reports.at(-1).milkyWay.phase,'off');
  const active={...frame,key:'on',plan:{...frame.plan,layers:{...frame.plan.layers,milkyWay:true}}};
  layer.setScene(active);assert.equal(requests.length,1);assert.equal(requests[0].maxSize,2048);assert.equal(reports.at(-1).milkyWay.phase,'loading');
  layer.camera={azimuth:active.plan.azimuth,pitch:active.plan.pitch};layer.matrix=photoCameraMatrix(active.plan);
  layer.render(gl);assert.ok(!gl.draws.some(d=>d.mode===gl.TRIANGLES));assert.equal(gl.textureUploads,0);
  layer.setScene({...frame,key:'cancel'});assert.equal(requests[0].signal.aborted,true);
  let closed=0;requests[0].resolve({width:2048,height:256,close(){closed++;}});await Promise.resolve();assert.equal(closed,1);assert.equal(gl.textureUploads,0);
  layer.setScene({...active,key:'retry'});assert.equal(requests.length,2);
  requests[1].resolve({width:2048,height:256,close(){closed++;}});await Promise.resolve();
  const before=new Map(state);layer.render(gl);
  assert.equal(reports.at(-1).milkyWay.phase,'ready');assert.equal(closed,2);assert.equal(gl.textureUploads,1);
  assert.ok(gl.draws.some(d=>d.mode===gl.TRIANGLES&&d.count===103680));assert.deepEqual(state,before);
  layer.setScene({...frame,key:'hide'});layer.setScene({...active,key:'show'});layer.render(gl);
  assert.equal(requests.length,2);assert.equal(gl.textureUploads,1);
  layer.onRemove();assert.equal(resources.size,0);
});

test('银河下载/上传失败单独反馈，星点继续绘制；关闭重开可恢复，卸载不接收迟到资源',async()=>{
  const {gl,resources}=fakeGL(),reports=[];let attempts=0,closed=0;
  const layer=new StarfieldLayer(s=>reports.push(s),async()=>{attempts++;if(attempts===1)throw new Error('decode');return {width:2048,height:256,close(){closed++;}};});
  layer.onAdd({triggerRepaint(){},getContainer:()=>({clientWidth:600,clientHeight:400}),getCanvas:()=>({width:600})},gl);
  const active=starFrame('failure');layer.setScene(active);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reports.at(-1).milkyWay.phase,'error');assert.match(reports.at(-1).milkyWay.message,/加载失败/);assert.equal(reports.at(-1).message,undefined);
  layer.camera={azimuth:active.plan.azimuth,pitch:active.plan.pitch};layer.matrix=photoCameraMatrix(active.plan);layer.render(gl);
  assert.ok(gl.draws.some(d=>d.mode===gl.POINTS&&d.count===928));
  const off={...active,key:'off',plan:{...active.plan,layers:{...active.plan.layers,milkyWay:false}}};
  layer.setScene(off);layer.setScene({...active,key:'upload'});await Promise.resolve();gl.textureFailure=true;layer.render(gl);
  assert.equal(reports.at(-1).milkyWay.phase,'error');assert.match(reports.at(-1).milkyWay.message,/无法上传/);assert.equal(reports.at(-1).message,undefined);
  layer.setScene({...off,key:'off2'});layer.setScene({...active,key:'recovered'});await Promise.resolve();gl.textureFailure=false;layer.render(gl);
  assert.equal(reports.at(-1).milkyWay.phase,'ready');assert.equal(attempts,3);assert.equal(closed,2);
  layer.onRemove();assert.equal(resources.size,0);
  const later=[],after=[];const pending=new StarfieldLayer(s=>after.push(s),(signal)=>new Promise(resolve=>later.push({signal,resolve})));
  pending.onAdd({triggerRepaint(){}},gl);pending.setScene(active);pending.onRemove();const count=after.length;
  assert.equal(later[0].signal.aborted,true);later[0].resolve({width:2048,height:256,close(){closed++;}});await Promise.resolve();
  assert.equal(closed,3);assert.equal(after.length,count);assert.equal(resources.size,0);
});

test('银河加载有明确超时，迟到结果不上传或覆盖错误状态',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {gl,resources}=fakeGL(),reports=[];let finish,signal,closed=0;
  const layer=new StarfieldLayer(s=>reports.push(s),(s)=>{signal=s;return new Promise(resolve=>finish=resolve);});
  layer.onAdd({triggerRepaint(){}},gl);layer.setScene(starFrame('timeout'));
  t.mock.timers.tick(12000);assert.equal(signal.aborted,true);assert.match(reports.at(-1).milkyWay.message,/超时/);
  finish({width:2048,height:256,close(){closed++;}});await Promise.resolve();assert.equal(closed,1);assert.equal(gl.textureUploads,0);
  assert.equal(reports.at(-1).milkyWay.phase,'error');layer.onRemove();assert.equal(resources.size,0);
});

async function prepareDeep(gl,reports,load=async()=>({width:2048,height:1024,close(){}})){
  const layer=new StarfieldLayer(s=>reports.push(s),async()=>({width:2048,height:256,close(){}}),load);
  layer.onAdd({triggerRepaint(){},getContainer:()=>({clientWidth:900,clientHeight:600}),getCanvas:()=>({width:900})},gl);
  const plan={...initialPlan,instant:'2026-11-08T16:00:00Z',refraction:'none',focalLength:1000,layers:{...initialPlan.layers,sun:false,moon:false,stars:false,milkyWay:false,constellations:false,deepSky:true}};
  const target=deepSkyScene(plan).objects.find(p=>p.entry.catalogId==='NGC1976');plan.azimuth=target.azimuth;plan.pitch=target.elevation;
  layer.setScene({key:'deep',planKey:'deep',ready:true,plan});layer.camera={azimuth:plan.azimuth,pitch:plan.pitch};layer.matrix=photoCameraMatrix(plan);
  // Requests now start from the actual rendered view, rather than layer enable.
  layer.render(gl);await new Promise(resolve=>setImmediate(resolve));
  const saved=layer.frame;layer.invalidate();layer.setScene(saved);
  return {layer,target};
}

test('深空轮廓分别查询清晰和被遮挡像素，中心名称独立查询；GL 状态与资源恢复',async()=>{
  for(const [clear,blocked,expected] of [[true,false,'clear'],[true,true,'partial'],[false,true,'blocked'],[false,false,'subpixel']]){
    const {gl,state,enabled,queries,resources}=fakeGL(),reports=[],before=new Map(state),previousEnabled=new Set(enabled);
    const {layer,target}=await prepareDeep(gl,reports);gl.results=[false,clear,blocked,false,false];layer.render(gl);
    assert.equal(queries.size,7);assert.ok(gl.draws.some(d=>d.mode===gl.TRIANGLES&&d.depth===gl.GREATER&&d.probe===1));
    assert.deepEqual(state,before);assert.deepEqual(enabled,previousEnabled);gl.complete();layer.render(gl);
    assert.equal(reports.at(-1).states[target.id],expected);assert.equal(reports.at(-1).states[target.id+':label'],'blocked');
    assert.equal(reports.at(-1).deepSky.phase,'ready');layer.onRemove();assert.equal(resources.size,0);assert.equal(queries.size,0);
  }
});

test('改机仅更新 Hα uniform，不重建几何、纹理或遮挡；深空失败不关闭其他图层',async()=>{
  const {gl,queries,resources}=fakeGL(),reports=[];let requests=0;
  const {layer}=await prepareDeep(gl,reports,async()=>{requests++;return {width:2048,height:1024,close(){}};});
  const initialRequests=requests;assert.equal(initialRequests,3,'M42 view intersects IC434 and the wider Barnard reference footprint');
  gl.results=[true,true,false];layer.render(gl);gl.complete();layer.render(gl);
  const uploads=gl.uploads.length,textureUploads=gl.textureUploads,count=reports.length;
  for(const [response,gain] of [['ha-modified',1],['stock',0]]){
    layer.setCameraResponse(response);layer.render(gl);
    assert.equal(gl.draws.filter(d=>d.mode===gl.TRIANGLES&&d.probe===0).at(-1).haGain,gain);
    assert.deepEqual(gl.draws.filter(d=>d.mode===gl.TRIANGLES&&d.probe===0).at(-1).colorMask,[true,true,true,true]);
    assert.equal(gl.uploads.length,uploads);assert.equal(gl.textureUploads,textureUploads);assert.equal(reports.length,count);assert.equal(queries.size,0);assert.equal(requests,initialRequests);
  }
  const frame=layer.frame;
  layer.invalidate();layer.setScene(frame);gl.results=[true,true,false];layer.render(gl);
  assert.equal(queries.size,7,'an invalidated cached frame must resume queries even with the same key');
  gl.complete();layer.render(gl);assert.equal(reports.at(-1).ready,true);
  assert.throws(()=>layer.setCameraResponse('full-spectrum'),RangeError);layer.onRemove();assert.equal(resources.size,0);
  const failedReports=[];const failed=await prepareDeep(gl,failedReports,async()=>{throw new Error('atlas unavailable');});
  assert.equal(failedReports.at(-1).deepSky.phase,'error');assert.equal(failedReports.at(-1).message,undefined);
  gl.results=[true];failed.layer.render(gl);assert.ok(gl.draws.some(d=>d.mode===gl.POINTS));failed.layer.onRemove();assert.equal(resources.size,0);
});

test('同视场单目标失败隔离，暗区在银河后和星表前合成，关闭重开释放纹理并重试',async()=>{
  const {gl,resources}=fakeGL(),reports=[];let broken=true,requests=0;
  const {layer}=await prepareDeep(gl,reports,async(_signal,maxSize,entry)=>{
    requests++;if(broken&&entry.catalogId==='NGC1976')throw new Error('one missing asset');
    return {width:maxSize,height:maxSize,close(){}};
  });
  gl.results=[true,true,false];layer.render(gl);gl.complete();layer.render(gl);
  assert.equal(reports.at(-1).deepSkyTargets['dso-ngc1976'].phase,'error');
  assert.equal(reports.at(-1).deepSkyTargets['dso-ic0434'].phase,'ready');
  assert.equal(reports.at(-1).message,undefined);
  const darkIndex=gl.draws.findIndex(d=>d.mode===gl.TRIANGLES&&d.probe===0&&d.dark===1);
  assert.ok(darkIndex>=0);assert.ok(gl.draws.slice(darkIndex+1).some(d=>d.mode===gl.POINTS&&d.probe===0));
  const frame=layer.frame;layer.setScene({...frame,key:'off',plan:{...frame.plan,layers:{...frame.plan.layers,deepSky:false}}});
  assert.deepEqual(reports.at(-1).deepSkyTargets,{});
  broken=false;layer.setScene({...frame,key:'retry'});layer.render(gl);await new Promise(resolve=>setImmediate(resolve));layer.render(gl);
  assert.equal(reports.at(-1).deepSkyTargets['dso-ngc1976'].phase,'ready');
  assert.equal(reports.at(-1).deepSkyTargets['dso-ic0434'].phase,'ready');assert.equal(requests,6);
  layer.onRemove();assert.equal(resources.size,0);
});

test('按视场资源请求移出或关闭即取消，迟到图片释放且不占 GPU',async()=>{
  const {gl,resources}=fakeGL(),pending=[];let closed=0;
  const pool=new DeepSkyTextures(()=>{},(signal,maxSize,entry)=>new Promise(resolve=>pending.push({signal,maxSize,entry,resolve})));
  const plan={...initialPlan,instant:'2026-11-08T16:00:00Z',refraction:'none',focalLength:1000,layers:{...initialPlan.layers,deepSky:true}};
  const objects=deepSkyScene(plan).objects,target=objects.find(o=>o.entry.catalogId==='Mel022');
  pool.update({...plan,azimuth:target.azimuth,pitch:target.elevation},objects,gl,900,600);assert.ok(pending.length>0);
  const first=pending.length;
  pool.update({...plan,layers:{...plan.layers,deepSky:false}},objects,gl,900,600);
  assert.ok(pending.every(r=>r.signal.aborted));
  for(const request of pending)request.resolve({width:1024,height:1024,close(){closed++;}});
  await new Promise(resolve=>setImmediate(resolve));pool.upload(gl);
  assert.equal(closed,first);assert.equal(gl.textureUploads,0);assert.deepEqual(pool.states,{});assert.equal(resources.size,0);
  pool.dispose(gl);
});

test('马头和火树共享一次解码与可见绘制，局部遮挡及资源失败分别反馈',async()=>{
  const {gl,resources}=fakeGL(),reports=[],requests=[];
  let broken=false;
  const layer=new StarfieldLayer(snapshot=>reports.push(snapshot),async()=>({close(){}}),async(_signal,maxSize,entry)=>{
    requests.push(entry.catalogId);
    if(broken)throw new Error('shared field unavailable');
    return {width:maxSize,height:maxSize,close(){}};
  });
  layer.onAdd({triggerRepaint(){},getContainer:()=>({clientWidth:900,clientHeight:600}),getCanvas:()=>({width:900})},gl);
  const plan={...initialPlan,instant:'2026-11-08T16:00:00Z',refraction:'none',focalLength:1000,
    layers:{sun:false,moon:false,stars:false,milkyWay:false,constellations:false,deepSky:true}};
  const objects=deepSkyScene(plan).objects;
  const flame=objects.find(object=>object.entry.catalogId==='NGC2024');
  const horsehead=objects.find(object=>object.entry.catalogId==='IC0434');
  plan.azimuth=flame.azimuth;plan.pitch=flame.elevation;
  const frame={key:'shared',planKey:'shared',ready:true,plan};
  layer.setScene(frame);layer.camera={azimuth:plan.azimuth,pitch:plan.pitch};layer.matrix=photoCameraMatrix(plan);
  layer.render(gl);await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(requests,['IC0434','Sh2-276']);
  gl.draws=[];
  // Label queries first, then separate clear/blocked probes in catalogue order.
  gl.results=[true,true,true,true,true,false];
  layer.render(gl);
  const visible=gl.draws.filter(draw=>draw.mode===gl.TRIANGLES&&draw.probe===0);
  assert.equal(visible.length,2);assert.equal(visible.filter(draw=>draw.count===horsehead.count).length,1);
  assert.ok(gl.draws.some(draw=>draw.mode===gl.TRIANGLES&&draw.probe===1&&draw.count===flame.count));
  assert.equal(gl.textureUploads,2);
  gl.complete();layer.render(gl);
  assert.equal(reports.at(-1).states[horsehead.id],'partial');
  assert.equal(reports.at(-1).states[flame.id],'clear');
  assert.equal(reports.at(-1).deepSkyTargets[horsehead.id].phase,'ready');
  assert.equal(reports.at(-1).deepSkyTargets[flame.id].phase,'ready');
  const off={...frame,key:'shared-off',plan:{...plan,layers:{...plan.layers,deepSky:false}}};
  layer.setScene(off);broken=true;layer.setScene({...frame,key:'shared-failure'});
  layer.render(gl);await new Promise(resolve=>setImmediate(resolve));layer.render(gl);
  assert.equal(reports.at(-1).deepSkyTargets[horsehead.id].phase,'error');
  assert.equal(reports.at(-1).deepSkyTargets[flame.id].phase,'error');
  layer.setScene(off);broken=false;layer.setScene({...frame,key:'shared-retry'});
  layer.render(gl);await new Promise(resolve=>setImmediate(resolve));layer.render(gl);
  assert.equal(reports.at(-1).deepSkyTargets[flame.id].phase,'ready');
  assert.deepEqual(requests,['IC0434','Sh2-276','IC0434','Sh2-276','IC0434','Sh2-276']);
  layer.onRemove();assert.equal(resources.size,0);
});


test('光污染改变星空显示强度，天体位置、星座与深空几何保持一致', async () => {
  const { gl, resources } = fakeGL(), reports = [];
  const layer = await prepareStars(gl, reports);
  layer.setScene(starFrame('pollution-base'));
  const before = Array.from(layer.pointData), band = Array.from(layer.band.vertices), strength = layer.strength;
  const polluted = starFrame('pollution-on'); polluted.artificialMcd = 6.5;
  layer.setScene(polluted);
  assert.ok(layer.strength < strength);
  const after = Array.from(layer.pointData);
  assert.equal(after.length, before.length);
  let changed = false;
  for (let i = 0; i < after.length; i++) {
    if (i % 9 === 8) { assert.ok(after[i] <= before[i]); changed ||= after[i] < before[i]; }
    else assert.equal(after[i], before[i]);
  }
  assert.equal(changed, true); assert.deepEqual(Array.from(layer.band.vertices), band);
  layer.onRemove(); assert.equal(resources.size, 0);
});

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
  gl.drawArrays=(mode,_,count)=>gl.draws.push({mode,count,probe:uniforms.get('u_probe'),depth:state.get(gl.DEPTH_FUNC),write:state.get(gl.DEPTH_WRITEMASK)});
  gl.drawElements=(mode,count)=>gl.draws.push({mode,count,depth:state.get(gl.DEPTH_FUNC),write:state.get(gl.DEPTH_WRITEMASK)});
  gl.getQueryParameter=(query,key)=>key===gl.QUERY_RESULT_AVAILABLE?query.available:query.result;
  gl.complete=()=>queries.forEach(query=>query.available=true);
  return {gl,queries,resources,state,enabled};
}
const polygon = [{x:-0.2,y:-0.2},{x:0.2,y:-0.2},{x:0.2,y:0.2},{x:-0.2,y:0.2}];
const frame = (key, ready=true) => ({key,planKey:key,ready,bodies:[{id:'sun',outline:polygon,illuminated:polygon}]});

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
test('星空查询在计划/地形失效后废弃，失败明确反馈并释放资源',async t=>{
  const {gl,queries,resources}=fakeGL(),reports=[],layer=await prepareStars(gl,reports);
  gl.results=[true];layer.render(gl);assert.equal(queries.size,1);
  layer.setScene(starFrame('b'));assert.equal(queries.size,0);assert.equal(reports.at(-1).planKey,'b');
  gl.results=[false];layer.render(gl);layer.invalidate();assert.equal(queries.size,0);
  const count=gl.draws.length;layer.render(gl);assert.equal(gl.draws.length,count);
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
  layer.setScene(frame);layer.camera={azimuth:frame.plan.azimuth,pitch:frame.plan.pitch};layer.matrix=photoCameraMatrix(frame.plan);
  gl.results=[true];layer.render(gl);
  const points=gl.uploads.find(data=>data.length===928*9);
  assert.ok(points);for(let i=8;i<927*9;i+=9)assert.equal(points[i],0,'daytime visual stars must be transparent');
  assert.equal(points[928*9-1],1,'core remains a direction ring');
  assert.ok(gl.draws.some(draw=>draw.count===928&&draw.probe===0));
  assert.ok(gl.draws.some(draw=>draw.count===1&&draw.probe===1));assert.equal(queries.size,1);
  gl.complete();layer.render(gl);assert.equal(reports.at(-1).states[target.id],'clear');
  assert.equal(gl.draws.at(-1).probe,0);layer.onRemove();assert.equal(resources.size,0);
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

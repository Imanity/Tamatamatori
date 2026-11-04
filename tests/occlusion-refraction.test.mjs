import test from "node:test";
import assert from "node:assert/strict";
import { apparentElevation, refractDirection } from "../src/domain/refraction.ts";
import { bodyPolygons } from "../src/domain/celestial-projection.ts";
import { direction } from "../src/domain/ephemeris.ts";
import { initialPlan } from "../src/domain/plan.ts";
import { CelestialLayer, triangulate } from "../src/preview/celestial-layer.ts";

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
  const state = new Map([[gl.CURRENT_PROGRAM,{}],[gl.VERTEX_ARRAY_BINDING,{}],[gl.ARRAY_BUFFER_BINDING,{}],[gl.DEPTH_FUNC,gl.LESS],[gl.DEPTH_RANGE,[0,0.8]],[gl.DEPTH_WRITEMASK,true],[gl.COLOR_WRITEMASK,[false,true,false,true]],...['BLEND_SRC_RGB','BLEND_DST_RGB','BLEND_SRC_ALPHA','BLEND_DST_ALPHA'].map(name=>[gl[name],gl.ONE])]);
  const enabled = new Set([gl.CULL_FACE, gl.STENCIL_TEST]);
  const queries = new Set(), resources = new Set();
  gl.results = []; gl.draws = []; gl.compile = true;
  const allocate = () => { const object={}; resources.add(object); return object; };
  for (const type of ['Shader','Program','Buffer','VertexArray']) { gl[`create${type}`]=allocate; gl[`delete${type}`]=(object)=>resources.delete(object); }
  for (const name of ['shaderSource','compileShader','attachShader','linkProgram','enableVertexAttribArray','vertexAttribPointer','uniform4fv','bufferData']) gl[name]=()=>{};
  gl.getShaderParameter=()=>gl.compile; gl.getProgramParameter=()=>true; gl.getUniformLocation=()=>({});
  gl.isContextLost=()=>false; gl.getParameter=(key)=>state.get(key); gl.isEnabled=(cap)=>enabled.has(cap);
  gl.enable=(cap)=>enabled.add(cap); gl.disable=(cap)=>enabled.delete(cap);
  gl.useProgram=(value)=>state.set(gl.CURRENT_PROGRAM,value); gl.bindVertexArray=(value)=>state.set(gl.VERTEX_ARRAY_BINDING,value);
  gl.bindBuffer=(_,value)=>state.set(gl.ARRAY_BUFFER_BINDING,value); gl.depthFunc=(value)=>state.set(gl.DEPTH_FUNC,value);
  gl.depthRange=(...value)=>state.set(gl.DEPTH_RANGE,value); gl.depthMask=(value)=>state.set(gl.DEPTH_WRITEMASK,value);
  gl.colorMask=(...value)=>state.set(gl.COLOR_WRITEMASK,value);
  gl.blendFunc=(src,dst)=>gl.blendFuncSeparate(src,dst,src,dst);
  gl.blendFuncSeparate=(...values)=>['BLEND_SRC_RGB','BLEND_DST_RGB','BLEND_SRC_ALPHA','BLEND_DST_ALPHA'].forEach((name,i)=>state.set(gl[name],values[i]));
  gl.createQuery=()=>{const query={available:false}; queries.add(query);return query;};gl.deleteQuery=(query)=>queries.delete(query);
  gl.beginQuery=(_,query)=>{query.result=gl.results.shift();};gl.endQuery=()=>{};
  gl.drawArrays=(mode,_,count)=>gl.draws.push({mode,count,depth:state.get(gl.DEPTH_FUNC),write:state.get(gl.DEPTH_WRITEMASK)});
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

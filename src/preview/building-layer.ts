import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import type { ShootingPlan } from "../domain/plan.ts";
import { buildingKey, emptyBuildings } from "../domain/buildings.ts";
import { landmarkFrame } from "../domain/landmarks.ts";
import type { BuildingStatus, BuildingMesh } from "../domain/buildings.ts";
import { loadBuildings, clearBuildingCache } from "./buildings.ts";
import { photoCameraMatrix, photoTileFrame } from "./terrain-perspective-math.ts";
import { renderedCamera } from "./rendered-camera.ts";
import { celestialPlanKey } from "../domain/visibility.ts";
import type { environmentForSky } from "./environment.ts";
import projection from "./terrain-projection.glsl?raw";
import depth from "./terrain-depth.glsl?raw";

const vertex=`#version 300 es
precision highp float;
${projection}
layout(location=0) in vec3 a_position;
layout(location=1) in vec3 a_normal;
out highp vec2 v_tile;
out vec3 v_normal;
out vec3 v_view;
uniform float u_local;
void main(){
 // Landmark vertices are in the observer ENU frame with the eye at the origin.
 if(u_local>0.5){v_view=u_photo_base+u_photo_basis*a_position;gl_Position=u_photo_camera*vec4(v_view,1.0);v_photo_depth=gl_Position.w;v_tile=vec2(4096);}
 else{gl_Position=photoProject(a_position.xy,a_position.z);v_tile=a_position.xy;v_view=vec3(0);}
 v_normal=u_photo_basis*a_normal;
}`;
const fragment=`#version 300 es
precision highp float;
${depth}
in highp vec2 v_tile;
in vec3 v_normal;
in vec3 v_view;
uniform vec3 u_surface;uniform vec3 u_fog;uniform vec3 u_sun;uniform float u_density;
out vec4 color;
void main(){
 if(any(lessThan(v_tile,vec2(0)))||any(greaterThanEqual(v_tile,vec2(8192))))discard;
 gl_FragDepth=photoFragmentDepth(v_photo_depth);
 // Two-sided landmark lighting: open shells and coincident double-sided exports
 // are lit on the side facing the observer. Ordinary blocks keep v_view at zero.
 vec3 normal=normalize(v_normal);if(dot(normal,v_view)>0.0)normal=-normal;
 float light=0.68+0.32*max(0.0,dot(normal,u_sun));
 float fog=clamp(1.0-exp(-max(0.0,v_photo_depth)*u_density),0.0,0.92);
 color=vec4(mix(u_surface*light,u_fog,fog),1.0);
}`;
type GpuMesh={tile:BuildingMesh["tile"];anchor?:BuildingMesh["anchor"];vao:WebGLVertexArrayObject;buffer:WebGLBuffer;index?:WebGLBuffer;count:number};
const rgb=(value:string)=>[1,3,5].map(i=>parseInt(value.slice(i,i+2),16)/255);

/** Finite geometry shares the DEM's camera and logarithmic main depth. */
export class BuildingLayer implements CustomLayerInterface {
  id="preview-buildings";type="custom" as const;renderingMode="3d" as const;
  private map?:MapLibreMap;private gl?:WebGL2RenderingContext;private program?:WebGLProgram;
  private plan?:ShootingPlan;private environment?:ReturnType<typeof environmentForSky>;
  private sun=[0,0,1];private density=1/30000;
  private meshes:GpuMesh[]=[];private pending?:BuildingMesh[];
  private controller?:AbortController;private requestKey="";private disposed=false;private failed=false;
  private retry=0;
  private status:BuildingStatus=emptyBuildings;
  private visible=true;
  private frames=new Map<string,ReturnType<typeof photoTileFrame>>();
  private eyeKey="";
  private uniforms=new Map<string,WebGLUniformLocation|null>();
  constructor(private report:(status:BuildingStatus)=>void,private url:string,private demUrl:string,
    private loader=loadBuildings) {}
  onAdd(map:MapLibreMap,gl:WebGL2RenderingContext){this.map=map;this.gl=gl;this.disposed=false;}
  setVisible(visible:boolean){this.visible=visible;}
  setScene(plan:ShootingPlan,environment:ReturnType<typeof environmentForSky>,sun:number[],visibility?:number|null,retry=0) {
    this.plan=plan;this.environment=environment;this.sun=sun;this.density=visibility==null?1/30000:2/Math.max(500,visibility);
    const key=`${!!plan.layers.buildings}/${buildingKey(plan)}/${retry}`;
    if(key===this.requestKey)return;
    this.requestKey=key;this.failed=false;this.controller?.abort();this.pending=[];this.releaseMeshes();this.frames.clear();
    if(retry!==this.retry){clearBuildingCache();this.retry=retry;}
    const controller=new AbortController();this.controller=controller;
    this.publish({...emptyBuildings,key:buildingKey(plan),phase:plan.layers.buildings?"loading":"off"});
    this.map?.triggerRepaint();
    if(!plan.layers.buildings)return;
    void this.loader(plan,this.url,this.demUrl,controller.signal).then(result=>{
      if(this.disposed||controller.signal.aborted||this.requestKey!==key)return;
      this.pending=result.meshes;this.publish(result.status);this.map?.triggerRepaint();
    }).catch((error:unknown)=>{
      if(this.disposed||controller.signal.aborted||this.requestKey!==key)return;
      this.pending=[];this.publish({...emptyBuildings,key:buildingKey(plan),phase:"error",
        message:error instanceof Error&&error.name==="TimeoutError"?"建筑数据读取超时，请重试。":
          error instanceof Error&&/建筑|地形|高程|覆盖/.test(error.message)?error.message:"建筑数据不可用，请检查网络后重试。"});this.map?.triggerRepaint();
    });
  }
  private publish(status:BuildingStatus){this.status=status;this.report(status);}
  private uniform(name:string){if(!this.uniforms.has(name))this.uniforms.set(name,this.gl!.getUniformLocation(this.program!,name));return this.uniforms.get(name)!;}
  private compile(gl:WebGL2RenderingContext) {
    const shaders:WebGLShader[]=[];const p=gl.createProgram();if(!p)throw new Error("建筑程序分配失败");
    try {
      for(const [type,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]] as const){
        const s=gl.createShader(type);if(!s)throw new Error("建筑着色器分配失败");shaders.push(s);
        gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s)??"建筑着色器编译失败");gl.attachShader(p,s);
      }
      gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p)??"建筑着色器链接失败");return p;
    }catch(error){gl.deleteProgram(p);throw error;}finally{shaders.forEach(s=>gl.deleteShader(s));}
  }
  private releaseMeshes(){for(const m of this.meshes){this.gl?.deleteVertexArray(m.vao);this.gl?.deleteBuffer(m.buffer);if(m.index)this.gl?.deleteBuffer(m.index);}this.meshes=[];}
  render(gl:WebGL2RenderingContext,input:CustomRenderMethodInput) {
    if(this.disposed||this.failed||!this.map||!this.plan||!this.environment)return;
    if(!this.plan.layers.buildings){if(this.pending){this.releaseMeshes();this.pending=undefined;}return;}
    if(!this.visible){if(this.pending?.length===0){this.releaseMeshes();this.pending=undefined;}return;}
    if(!this.meshes.length&&!this.pending?.length)return;
    const old={program:gl.getParameter(gl.CURRENT_PROGRAM),vao:gl.getParameter(gl.VERTEX_ARRAY_BINDING),buffer:gl.getParameter(gl.ARRAY_BUFFER_BINDING),
      depth:gl.isEnabled(gl.DEPTH_TEST),cull:gl.isEnabled(gl.CULL_FACE),blend:gl.isEnabled(gl.BLEND),stencil:gl.isEnabled(gl.STENCIL_TEST),
      depthFunc:gl.getParameter(gl.DEPTH_FUNC),depthRange:gl.getParameter(gl.DEPTH_RANGE),depthMask:gl.getParameter(gl.DEPTH_WRITEMASK),colorMask:gl.getParameter(gl.COLOR_WRITEMASK)};
    try {
      this.program??=this.compile(gl);gl.useProgram(this.program);
      if(this.pending){
        this.releaseMeshes();
        for(const m of this.pending){const buffer=gl.createBuffer(),vao=gl.createVertexArray();
          if(!buffer||!vao){gl.deleteBuffer(buffer);gl.deleteVertexArray(vao);throw new Error("建筑网格分配失败");}
          const gpu:GpuMesh={tile:m.tile,anchor:m.anchor,buffer,vao,count:m.indices?.length??m.vertices.length/6};this.meshes.push(gpu);
          gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,m.vertices,gl.STATIC_DRAW);
          gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,24,0);
          gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,3,gl.FLOAT,false,24,12);
          if(m.indices){const index=gl.createBuffer();if(!index)throw new Error("地标索引分配失败");gpu.index=index;
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,index);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,m.indices,gl.STATIC_DRAW);}
        }this.pending=undefined;
      }
      const camera=renderedCamera(this.map,input.modelViewProjectionMatrix,celestialPlanKey(this.plan));
      const eyeKey=`${camera.longitude}/${camera.latitude}/${camera.altitude}`;
      if(eyeKey!==this.eyeKey){this.frames.clear();this.eyeKey=eyeKey;}
      const matrix=photoCameraMatrix({...this.plan,azimuth:camera.azimuth,pitch:camera.pitch});
      gl.uniformMatrix4fv(this.uniform("u_photo_camera"),false,matrix);
      gl.uniform3fv(this.uniform("u_surface"),rgb(this.environment.building));
      gl.uniform3fv(this.uniform("u_fog"),rgb(this.environment.sky["fog-color"]));
      gl.uniform3fv(this.uniform("u_sun"),this.sun);gl.uniform1f(this.uniform("u_density"),this.density);
      gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.depthRange(0,1);gl.depthMask(true);gl.colorMask(true,true,true,true);
      gl.disable(gl.CULL_FACE);gl.disable(gl.BLEND);gl.disable(gl.STENCIL_TEST);
      for(const m of this.meshes){const key=m.anchor?`local/${m.anchor.longitude}/${m.anchor.latitude}/${m.anchor.ellipsoidalHeight}`:`${m.tile.z}/${m.tile.x}/${m.tile.y}`;
        let f=this.frames.get(key);if(!f){const eye={...camera,ellipsoidalHeight:camera.altitude};f=m.anchor?{...landmarkFrame(eye,m.anchor),tile:[0,0,0,0]}:photoTileFrame(eye,m.tile);this.frames.set(key,f);}
        gl.uniform4fv(this.uniform("u_photo_tile"),f.tile);gl.uniform3fv(this.uniform("u_photo_base"),f.base);gl.uniformMatrix3fv(this.uniform("u_photo_basis"),false,f.basis);
        gl.uniform1f(this.uniform("u_local"),m.anchor?1:0);
        gl.bindVertexArray(m.vao);if(m.index)gl.drawElements(gl.TRIANGLES,m.count,gl.UNSIGNED_INT,0);else gl.drawArrays(gl.TRIANGLES,0,m.count);
      }
    }catch{
      this.failed=true;this.pending=undefined;this.releaseMeshes();
      this.publish({...this.status,phase:"error",message:"建筑绘制失败，请单独重试建筑。"});
    }finally{
      for(const [cap,enabled] of [[gl.DEPTH_TEST,old.depth],[gl.CULL_FACE,old.cull],[gl.BLEND,old.blend],[gl.STENCIL_TEST,old.stencil]] as const)enabled?gl.enable(cap):gl.disable(cap);
      gl.depthFunc(old.depthFunc);gl.depthRange(old.depthRange[0],old.depthRange[1]);gl.depthMask(old.depthMask);gl.colorMask(...old.colorMask as [boolean,boolean,boolean,boolean]);
      gl.bindVertexArray(old.vao);gl.bindBuffer(gl.ARRAY_BUFFER,old.buffer);gl.useProgram(old.program);
    }
  }
  onRemove(){this.disposed=true;this.controller?.abort();this.pending=undefined;this.releaseMeshes();this.gl?.deleteProgram(this.program??null);this.program=undefined;this.uniforms.clear();this.frames.clear();this.map=undefined;this.gl=undefined;}
}

import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import type { ShootingPlan } from "../../domain/core/plan.ts";
import { fieldOfView } from "../../domain/core/plan.ts";
import { celestialPlanKey } from "../../domain/core/visibility.ts";
import { renderedCamera } from "./rendered-camera.ts";
import type { RenderedCamera } from "./rendered-camera.ts";
import { photoCameraMatrix, photoTileFrame } from "../../domain/core/terrain-perspective-math.ts";
import type { PhotoTile } from "../../domain/core/terrain-perspective-math.ts";
import projectionGlsl from "./terrain-projection.glsl?raw";

const bridgeKey = Symbol.for("tamatamatori.terrain-enu.v1");
type Bridge = (gl: WebGL2RenderingContext, program: WebGLProgram, tile: PhotoTile, wrap: number) => void;
type BridgeContext = WebGL2RenderingContext & { [bridgeKey]?: Bridge };
type Point = { latitude: number; longitude: number; altitude: number };
type Uniforms = { enabled: WebGLUniformLocation | null; tile: WebGLUniformLocation | null; base: WebGLUniformLocation | null; basis: WebGLUniformLocation | null; camera: WebGLUniformLocation | null };
const locations = (gl: WebGL2RenderingContext, p: WebGLProgram): Uniforms => ({
  enabled: gl.getUniformLocation(p,"u_photo_enabled"), tile: gl.getUniformLocation(p,"u_photo_tile"),
  base: gl.getUniformLocation(p,"u_photo_base"), basis: gl.getUniformLocation(p,"u_photo_basis"), camera: gl.getUniformLocation(p,"u_photo_camera"),
});

/** Local, versioned SDK bridge. App code only receives public GL handles and tile IDs. */
export class TerrainPerspective implements CustomLayerInterface {
  id = "preview-terrain-enu";
  type = "custom" as const;
  renderingMode = "3d" as const;
  private map?: MapLibreMap;
  private gl?: BridgeContext;
  private plan?: ShootingPlan;
  private camera?: RenderedCamera;
  private matrix = new Float32Array(16);
  private eyeKey = "";
  private frames = new Map<string,ReturnType<typeof photoTileFrame>>();
  private programs = new Map<WebGLProgram,Uniforms>();
  private probe?: { program: WebGLProgram; vao: WebGLVertexArrayObject; feedback: WebGLTransformFeedback; buffer: WebGLBuffer; uniforms: Uniforms };
  private probeKey = "";
  private probeResult: { x: number; y: number; ray: number[] } | null = null;
  private failed = false;
  private calls = 0;
  constructor(private reportError: (message: string) => void) {}

  setView(plan: ShootingPlan) { this.plan = plan; }
  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    this.map = map; this.gl = gl;
    if ((gl as BridgeContext)[bridgeKey]) throw new Error("摄影地形坐标桥接重复安装");
    (gl as BridgeContext)[bridgeKey] = this.bridge;
  }
  prerender(_gl: WebGL2RenderingContext, input: CustomRenderMethodInput) {
    if (!this.map || !this.plan || this.failed) return;
    try {
      this.camera = renderedCamera(this.map,input.modelViewProjectionMatrix,celestialPlanKey(this.plan));
      const key = [this.camera.longitude.toFixed(10),this.camera.latitude.toFixed(10),this.camera.altitude.toFixed(6)].join("/");
      if (key !== this.eyeKey) { this.frames.clear(); this.eyeKey = key; }
      this.matrix = photoCameraMatrix({ ...this.plan, azimuth: this.camera.azimuth, pitch: this.camera.pitch });
    } catch { this.fail(); }
  }
  render() {
    // A cold view aimed wholly at the sky can legitimately draw no terrain.
    const expectsGround = this.plan && this.camera && this.camera.pitch - fieldOfView(this.plan).vertical / 2 < -0.1;
    if (expectsGround && !this.failed && this.map?.areTilesLoaded() && !this.calls)
      this.fail("当前 SDK 缺少地形坐标桥接，请重新安装依赖。");
  }
  private fail(message = "地形空间投影不可用，请重试预览。") {
    if (!this.failed) { this.failed = true; this.reportError(message); }
  }
  private frame(tile: PhotoTile, wrap: number) {
    const key = `${tile.z}/${tile.x}/${tile.y}/${wrap}`;
    let frame = this.frames.get(key);
    if (!frame) {
      if (!this.camera) throw new Error("摄影眼点尚未就绪");
      frame = photoTileFrame({ ...this.camera, ellipsoidalHeight: this.camera.altitude },tile,wrap);
      this.frames.set(key,frame);
      if (this.frames.size > 256) this.frames.delete(this.frames.keys().next().value!);
    }
    return frame;
  }
  private upload(gl: WebGL2RenderingContext, u: Uniforms, tile: PhotoTile, wrap: number) {
    const f = this.frame(tile,wrap);
    gl.uniform4fv(u.tile,f.tile); gl.uniform3fv(u.base,f.base);
    gl.uniformMatrix3fv(u.basis,false,f.basis); gl.uniformMatrix4fv(u.camera,false,this.matrix);
  }
  private bridge: Bridge = (gl,program,tile,wrap) => {
    let u = this.programs.get(program);
    if (!u) { u = locations(gl,program); this.programs.set(program,u); }
    gl.uniform1f(u.enabled,0);
    if (!this.camera || !this.plan || this.failed) return;
    try {
      if (!u.enabled || !u.tile || !u.base || !u.basis || !u.camera) throw new Error("SDK shader bridge missing");
      this.upload(gl,u,tile,wrap); gl.uniform1f(u.enabled,1); this.calls++;
    } catch { this.fail(); }
  };

  /** Development-only transform feedback: same vertex function as the actual mesh. */
  projectProbe(point: Point, width: number, height: number) {
    const gl = this.gl;
    if (!gl || !this.camera || this.failed || !this.calls) return null;
    const key = JSON.stringify([point,width,height,...this.matrix,this.eyeKey]);
    if (this.probeKey === key) return this.probeResult;
    const previous = { program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      feedback: gl.getParameter(gl.TRANSFORM_FEEDBACK_BINDING), buffer: gl.getParameter(gl.TRANSFORM_FEEDBACK_BUFFER_BINDING),
      discard: gl.isEnabled(gl.RASTERIZER_DISCARD) };
    try {
      this.probe ??= this.createProbe(gl);
      const p=this.probe, z=14, n=2**z;
      const x=(point.longitude+180)/360*n, y=(1-Math.asinh(Math.tan(point.latitude*Math.PI/180))/Math.PI)/2*n;
      const tile={z,x:Math.floor(x),y:Math.floor(y)};
      gl.useProgram(p.program); this.upload(gl,p.uniforms,tile,0);
      gl.uniform3f(gl.getUniformLocation(p.program,"u_test"),(x-tile.x)*8192,(y-tile.y)*8192,point.altitude);
      gl.bindVertexArray(p.vao); gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK,p.feedback);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER,0,p.buffer); gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS,0,1); gl.endTransformFeedback();
      const result=new Float32Array(7); gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER,0,result);
      this.probeResult=result[3]>0 ? {x:(result[0]/result[3]+1)*width/2,y:(1-result[1]/result[3])*height/2,ray:Array.from(result.slice(4))}:null;
      this.probeKey=key;
      return this.probeResult;
    } finally {
      previous.discard ? gl.enable(gl.RASTERIZER_DISCARD):gl.disable(gl.RASTERIZER_DISCARD);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK,previous.feedback); gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER,previous.buffer);
      gl.bindVertexArray(previous.vao); gl.useProgram(previous.program);
    }
  }
  private createProbe(gl: WebGL2RenderingContext) {
    const shaders: WebGLShader[]=[];
    const program=gl.createProgram(),vao=gl.createVertexArray(),feedback=gl.createTransformFeedback(),buffer=gl.createBuffer();
    try {
      if (!program || !vao || !feedback || !buffer) throw new Error("GPU probe allocation");
      for(const [type,source] of [[gl.VERTEX_SHADER,`#version 300 es\nprecision highp float;\n${projectionGlsl}\nuniform vec3 u_test; out vec4 result; out vec3 ray; void main(){ray=photoRay(u_test.xy,u_test.z);result=photoProject(u_test.xy,u_test.z);gl_Position=result;}`],
        [gl.FRAGMENT_SHADER,"#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(0);}"]] as const) {
        const shader=gl.createShader(type); if(!shader)throw new Error("GPU probe shader allocation");shaders.push(shader);
        gl.shaderSource(shader,source);gl.compileShader(shader);gl.attachShader(program,shader);
      }
      gl.transformFeedbackVaryings(program,["result","ray"],gl.INTERLEAVED_ATTRIBS);gl.linkProgram(program);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)??"GPU probe link");
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER,buffer);gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER,28,gl.STREAM_READ);
      return {program,vao,feedback,buffer,uniforms:locations(gl,program)};
    } catch(error){gl.deleteProgram(program);gl.deleteVertexArray(vao);gl.deleteTransformFeedback(feedback);gl.deleteBuffer(buffer);throw error;}
    finally{shaders.forEach(shader=>gl.deleteShader(shader));}
  }
  onRemove() {
    const gl=this.gl;
    if(gl){
      const previous=gl.getParameter(gl.CURRENT_PROGRAM);
      for(const [program,u] of this.programs){gl.useProgram(program);gl.uniform1f(u.enabled,0);}
      gl.useProgram(previous);
      if(gl[bridgeKey]===this.bridge)delete gl[bridgeKey];
      if(this.probe){gl.deleteProgram(this.probe.program);gl.deleteBuffer(this.probe.buffer);gl.deleteVertexArray(this.probe.vao);gl.deleteTransformFeedback(this.probe.feedback);}
    }
    this.frames.clear();this.programs.clear();this.probe=undefined;this.map=undefined;this.gl=undefined;
  }
}

import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import type { ShootingPlan } from "../domain/plan.ts";
import {
  milkyWayMesh,
  skyPointSize,
  skyPointView,
  skyReference,
} from "../domain/starfield.ts";
import type { SkyPoint, SkyVisibility } from "../domain/starfield.ts";
import { refractDirection } from "../domain/refraction.ts";
import { renderedCamera } from "./rendered-camera.ts";
import type { RenderedCamera } from "./rendered-camera.ts";
import { photoCameraMatrix } from "./terrain-perspective-math.ts";
import { skyAppearance, starOpacity } from "../domain/sky-appearance.ts";
import { constellationScene } from "../domain/constellations.ts";
import { loadMilkyWayImage } from "./milky-way-texture.ts";
import { loadDeepSkyImage } from "./deep-sky-texture.ts";
import { SkyTexture } from "./sky-texture.ts";
import { deepSkyScene, deepSkyView } from "../domain/deep-sky.ts";
import type { DeepSkyTarget } from "../domain/deep-sky.ts";
import { classifyOcclusion } from "../domain/visibility.ts";

interface Frame {
  key: string;
  planKey: string;
  ready: boolean;
  plan: ShootingPlan;
}
type Pending = { id: string; query: WebGLQuery; blocked?: WebGLQuery };
const pointVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_ray;
layout(location=1) in vec2 a_symbol;
layout(location=2) in vec4 a_color;
uniform mat4 u_camera; uniform float u_pixel_ratio;
out vec4 v_color; out float v_kind; out float v_height;
void main(){gl_Position=u_camera*vec4(a_ray,0.0);gl_Position.z=gl_Position.w;
gl_PointSize=a_symbol.x*u_pixel_ratio;v_color=a_color;v_kind=a_symbol.y;v_height=a_ray.z;}`;
const pointFragment = `#version 300 es
precision highp float;
in vec4 v_color; in float v_kind; in float v_height; uniform float u_probe; out vec4 color;
void main(){if(v_height<=0.0)discard;float d=length(gl_PointCoord-0.5);
float coverage=v_kind>0.5?(1.0-smoothstep(0.40,0.5,d))*smoothstep(0.26,0.36,d):exp(-d*d*13.0)*(1.0-smoothstep(0.35,0.5,d));
float a=coverage*mix(v_color.a,1.0,u_probe);if(a<0.01)discard;color=vec4(v_color.rgb*a,a);}`;
const bandVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_ray;layout(location=1) in vec2 a_gal;
uniform mat4 u_camera;out vec2 v_gal;out float v_height;
void main(){gl_Position=u_camera*vec4(a_ray,0.0);gl_Position.z=gl_Position.w;v_gal=a_gal;v_height=a_ray.z;}`;
const bandFragment = `#version 300 es
precision highp float;
in vec2 v_gal;in float v_height;uniform float u_strength;uniform sampler2D u_atlas;out vec4 color;
void main(){if(v_height<=0.0)discard;
// ESO panorama: Galactic north at the top, l increases to the left.
// Keep longitude unwrapped so mip gradients remain continuous at l=180.
vec2 uv=vec2(0.5-v_gal.x/6.28318530718,0.5-degrees(v_gal.y)/45.0);
vec3 diffuse=texture(u_atlas,uv).rgb;
float luminance=dot(diffuse,vec3(0.2126,0.7152,0.0722));
float edge=1.0-smoothstep(17.0,22.5,abs(degrees(v_gal.y)));
float horizon=smoothstep(0.0,0.10,v_height);
float a=clamp(pow(luminance,1.2)*1.1*u_strength,0.0,0.7)*edge*horizon;
vec3 tint=mix(vec3(0.70,0.75,0.86),diffuse/max(luminance,0.02)*0.78,0.65);
color=vec4(tint*a,a);}`;
const lineVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_ray;uniform mat4 u_camera;out float v_height;
void main(){gl_Position=u_camera*vec4(a_ray,0.0);gl_Position.z=gl_Position.w;v_height=a_ray.z;}`;
const lineFragment = `#version 300 es
precision highp float;in float v_height;out vec4 color;
void main(){if(v_height<=0.0)discard;float a=0.55;color=vec4(vec3(0.88,0.82,0.62)*a,a);}`;
const deepVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_ray;layout(location=1) in vec2 a_uv;layout(location=2) in vec3 a_tint;
uniform mat4 u_camera;out vec2 v_uv;out vec3 v_tint;out float v_height;
void main(){gl_Position=u_camera*vec4(a_ray,0.0);gl_Position.z=gl_Position.w;v_uv=a_uv;v_tint=a_tint;v_height=a_ray.z;}`;
const deepFragment = `#version 300 es
precision highp float;
in vec2 v_uv;in vec3 v_tint;in float v_height;
uniform sampler2D u_atlas;uniform float u_strength;uniform float u_ha_gain;uniform float u_probe;out vec4 color;
void main(){if(v_height<=0.0)discard;vec3 components=texture(u_atlas,v_uv).rgb;
if(max(components.r,max(components.g,components.b))<0.012)discard;
if(u_probe>0.5){color=vec4(1.0);return;}
vec3 signal=components.r*v_tint+components.g*u_ha_gain*vec3(1.0,0.10,0.18)+components.b*vec3(0.12,0.75,0.85);
float peak=max(signal.r,max(signal.g,signal.b));
float a=(1.0-exp(-2.1*peak))*u_strength*smoothstep(0.0,0.04,v_height);
if(a<0.004)discard;color=vec4(signal/max(peak,0.001)*a,a);}`;

function program(gl: WebGL2RenderingContext, vertex: string, fragment: string) {
  const shaders: WebGLShader[] = [];
  const p = gl.createProgram();
  try {
    if (!p) throw new Error("program allocation");
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const s = gl.createShader(type);
      if (!s) throw new Error("shader allocation");
      shaders.push(s);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(s) ?? "compile");
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(p) ?? "link");
    return p;
  } catch (error) {
    gl.deleteProgram(p);
    throw error;
  } finally {
    shaders.forEach((s) => gl.deleteShader(s));
  }
}

/** Current star/galaxy renderer; public custom-layer and GL APIs only. */
export class StarfieldLayer implements CustomLayerInterface {
  id = "preview-starfield";
  type = "custom" as const;
  renderingMode = "3d" as const;
  private map?: MapLibreMap;
  private gl?: WebGL2RenderingContext;
  private frame?: Frame;
  private pointsProgram?: WebGLProgram;
  private bandProgram?: WebGLProgram;
  private lineProgram?: WebGLProgram;
  private pointsVao?: WebGLVertexArrayObject;
  private bandVao?: WebGLVertexArrayObject;
  private lineVao?: WebGLVertexArrayObject;
  private pointsBuffer?: WebGLBuffer;
  private bandBuffer?: WebGLBuffer;
  private indicesBuffer?: WebGLBuffer;
  private lineBuffer?: WebGLBuffer;
  private lineData: Float32Array = new Float32Array();
  private camera?: RenderedCamera;
  private matrix = new Float32Array(16);
  private points: SkyPoint[] = [];
  private offsets = new Map<string, number>();
  private targets: SkyPoint[] = [];
  private dataKey = "";
  private dirty = false;
  private pointData = new Float32Array();
  private band?: ReturnType<typeof milkyWayMesh>;
  private strength = 1;
  private contrast = 1;
  private milky: SkyTexture;
  private deep: SkyTexture;
  private deepProgram?: WebGLProgram;
  private deepVao?: WebGLVertexArrayObject;
  private deepBuffer?: WebGLBuffer;
  private deepData: Float32Array = new Float32Array();
  private deepObjects: DeepSkyTarget[] = [];
  private haGain = 0.25;
  private snapshot?: SkyVisibility;
  private pending: Pending[] = [];
  private pendingKey = "";
  private pendingAt = 0;
  private resolvedKey = "";
  private failed = false;
  private report: (snapshot: SkyVisibility) => void;
  constructor(
    report: (snapshot: SkyVisibility) => void,
    loadImage = loadMilkyWayImage,
    loadDeep = loadDeepSkyImage,
  ) {
    this.report = report;
    this.milky = new SkyTexture("银河纹理", "银河", true, loadImage, () =>
      this.textureChanged(),
    );
    this.deep = new SkyTexture("深空结构", "深空天体", false, loadDeep, () =>
      this.textureChanged(),
    );
  }
  private publish(snapshot: SkyVisibility) {
    this.snapshot = snapshot;
    this.report({
      ...snapshot,
      milkyWay: this.frame?.plan.layers.milkyWay
        ? this.milky.state
        : { phase: "off" },
      deepSky: this.frame?.plan.layers.deepSky
        ? this.deep.state
        : { phase: "off" },
    });
  }
  private textureChanged() {
    if (this.snapshot) this.publish(this.snapshot);
    this.map?.triggerRepaint();
  }
  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;
    try {
      this.pointsProgram = program(gl, pointVertex, pointFragment);
      this.bandProgram = program(gl, bandVertex, bandFragment);
      this.lineProgram = program(gl, lineVertex, lineFragment);
      this.deepProgram = program(gl, deepVertex, deepFragment);
      this.pointsVao = gl.createVertexArray() ?? undefined;
      this.bandVao = gl.createVertexArray() ?? undefined;
      this.lineVao = gl.createVertexArray() ?? undefined;
      this.deepVao = gl.createVertexArray() ?? undefined;
      this.pointsBuffer = gl.createBuffer() ?? undefined;
      this.bandBuffer = gl.createBuffer() ?? undefined;
      this.indicesBuffer = gl.createBuffer() ?? undefined;
      this.lineBuffer = gl.createBuffer() ?? undefined;
      this.deepBuffer = gl.createBuffer() ?? undefined;
      if (
        !this.pointsVao ||
        !this.bandVao ||
        !this.pointsBuffer ||
        !this.bandBuffer ||
        !this.indicesBuffer ||
        !this.lineVao ||
        !this.lineBuffer ||
        !this.deepVao ||
        !this.deepBuffer
      )
        throw new Error("allocation");
    } catch {
      this.fail("星空与银河图形环境无法启动，请重试预览。");
    }
  }
  setContrast(percent = 100) {
    if (!Number.isFinite(percent) || percent < 25 || percent > 200)
      throw new RangeError("银河显示对比度需在 25%—200% 之间");
    const contrast = percent / 100;
    if (this.contrast === contrast) return;
    this.contrast = contrast;
    this.map?.triggerRepaint();
  }
  setCameraResponse(response: ShootingPlan["cameraResponse"] = "stock") {
    if (response !== "stock" && response !== "ha-modified")
      throw new RangeError("未知深空相机响应");
    const gain = response === "ha-modified" ? 1 : 0.25;
    if (this.haGain === gain) return;
    this.haGain = gain;
    this.map?.triggerRepaint();
  }
  setScene(frame: Frame) {
    if (this.frame?.key === frame.key && this.frame.ready === frame.ready) return;
    this.clearQueries();
    this.frame = frame;
    this.resolvedKey = "";
    this.milky.setEnabled(!!frame.plan.layers.milkyWay, this.gl);
    this.deep.setEnabled(!!frame.plan.layers.deepSky, this.gl);
    this.waiting();
    const p = frame.plan,
      key = [
        p.latitude,
        p.longitude,
        p.instant,
        p.refraction,
        !!p.layers.stars,
        !!p.layers.milkyWay,
        !!p.layers.constellations,
        !!p.layers.deepSky,
      ].join("/");
    if (key !== this.dataKey) {
      this.dataKey = key;
      this.dirty = true;
      const active =
          p.layers.stars ||
          p.layers.milkyWay ||
          p.layers.constellations ||
          p.layers.deepSky,
        sky = active ? skyReference(p) : null;
      const appearance = sky ? skyAppearance(sky.sunElevation, sky.moon) : null;
      const figure = p.layers.constellations ? constellationScene(p) : null;
      this.lineData = figure?.vertices ?? new Float32Array();
      const deep = p.layers.deepSky ? deepSkyScene(p) : null;
      this.deepObjects = deep?.objects ?? [];
      this.deepData = deep?.vertices ?? new Float32Array();
      this.points = [
        ...(p.layers.stars ? sky!.points : []),
        ...(p.layers.milkyWay ? [sky!.core] : []),
        ...(figure?.anchors ?? []),
        ...this.deepObjects,
        ...(!p.layers.stars ? (deep?.clusterStars ?? []) : []),
      ];
      this.targets = this.points.filter((point) => !!point.name);
      this.offsets.clear();
      const data: number[] = [];
      this.points.forEach((point, i) => {
        this.offsets.set(point.id, i);
        const ray = refractDirection(point.direction, p.refraction);
        const anchor =
          point.id.startsWith("constellation-") || point.id.startsWith("dso-");
        const alpha = anchor ? 0 : starOpacity(point, appearance!);
        data.push(
          ...ray,
          anchor ? 4 : skyPointSize(point),
          point.id === "galactic-center" ? 1 : 0,
          ...point.color,
          alpha,
        );
      });
      this.pointData = new Float32Array(data);
      this.band = p.layers.milkyWay ? milkyWayMesh(p) : undefined;
      this.strength = appearance?.galaxyStrength ?? 0;
    }
    this.map?.triggerRepaint();
  }
  invalidate() {
    this.clearQueries();
    this.resolvedKey = "";
    if (this.frame) {
      this.frame = { ...this.frame, ready: false };
      this.waiting();
    }
  }
  private waiting() {
    if (this.frame)
      this.publish({
        planKey: this.frame.planKey,
        ready: false,
        view: null,
        states: {},
      });
  }
  private clearQueries() {
    for (const p of this.pending) {
      this.gl?.deleteQuery(p.query);
      if (p.blocked) this.gl?.deleteQuery(p.blocked);
    }
    this.pending = [];
    this.pendingKey = "";
  }
  private fail(message: string) {
    if (this.failed) return;
    this.failed = true;
    this.clearQueries();
    this.publish({
      planKey: this.frame?.planKey ?? "",
      ready: false,
      view: null,
      states: {},
      message,
    });
  }
  prerender(_gl: WebGL2RenderingContext, input: CustomRenderMethodInput) {
    if (!this.frame || !this.map || this.failed) return;
    try {
      this.camera = renderedCamera(
        this.map,
        input.modelViewProjectionMatrix,
        this.frame.planKey,
      );
      this.matrix = photoCameraMatrix({
        ...this.frame.plan,
        azimuth: this.camera.azimuth,
        pitch: this.camera.pitch,
      });
    } catch {
      this.fail("无法读取星空摄影视角，请重试预览。");
    }
  }
  render(gl: WebGL2RenderingContext) {
    const f = this.frame,
      c = this.camera,
      p = this.pointsProgram,
      b = this.bandProgram;
    if (
      this.failed ||
      !f ||
      !c ||
      !p ||
      !b ||
      !f.ready ||
      (!f.plan.layers.stars &&
        !f.plan.layers.milkyWay &&
        !f.plan.layers.constellations &&
        !f.plan.layers.deepSky)
    )
      return;
    if (gl.isContextLost()) {
      this.fail("星空图形环境已中断，请重试预览。");
      return;
    }
    const queryKey = [
      f.key,
      c.azimuth,
      c.pitch,
      this.map?.getContainer().clientWidth,
      this.map?.getContainer().clientHeight,
    ].join("/");
    if (this.pending.length && this.pendingKey !== queryKey) {
      this.clearQueries();
      this.waiting();
    }
    if (this.pending.length) {
      if (
        this.pending.every(
          (x) =>
            gl.getQueryParameter(x.query, gl.QUERY_RESULT_AVAILABLE) &&
            (!x.blocked ||
              gl.getQueryParameter(x.blocked, gl.QUERY_RESULT_AVAILABLE)),
        )
      ) {
        const states: SkyVisibility["states"] = {};
        for (const x of this.pending) {
          const clear = !!gl.getQueryParameter(x.query, gl.QUERY_RESULT);
          states[x.id] = x.blocked
            ? classifyOcclusion(
                clear,
                !!gl.getQueryParameter(x.blocked, gl.QUERY_RESULT),
              )
            : clear
              ? "clear"
              : "blocked";
        }
        this.clearQueries();
        this.resolvedKey = queryKey;
        this.publish({
          planKey: f.planKey,
          ready: true,
          view: { azimuth: c.azimuth, pitch: c.pitch },
          states,
        });
      } else if (Date.now() - this.pendingAt > 5000) {
        this.fail("星空遮挡查询超时，请重试预览。");
        return;
      }
    }
    const previous = {
      program: gl.getParameter(gl.CURRENT_PROGRAM),
      vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      buffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
      depth: gl.isEnabled(gl.DEPTH_TEST),
      cull: gl.isEnabled(gl.CULL_FACE),
      blend: gl.isEnabled(gl.BLEND),
      stencil: gl.isEnabled(gl.STENCIL_TEST),
      depthFunc: gl.getParameter(gl.DEPTH_FUNC),
      depthRange: gl.getParameter(gl.DEPTH_RANGE),
      depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
      colorMask: gl.getParameter(gl.COLOR_WRITEMASK),
      srcRGB: gl.getParameter(gl.BLEND_SRC_RGB),
      dstRGB: gl.getParameter(gl.BLEND_DST_RGB),
      srcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA),
      dstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
      activeTexture: gl.getParameter(gl.ACTIVE_TEXTURE),
      unpack: [
        gl.UNPACK_FLIP_Y_WEBGL,
        gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
        gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,
        gl.UNPACK_ALIGNMENT,
      ].map((key) => [key, gl.getParameter(key)] as const),
    };
    gl.activeTexture(gl.TEXTURE0);
    const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const previousSampler = gl.getParameter(gl.SAMPLER_BINDING);
    try {
      gl.bindSampler(0, null);
      if (f.plan.layers.milkyWay) this.milky.upload(gl);
      if (f.plan.layers.deepSky && this.deep.upload(gl)) {
        this.clearQueries();
        this.resolvedKey = "";
      }
      gl.enable(gl.DEPTH_TEST);
      gl.depthRange(0, 1);
      gl.depthMask(false);
      gl.depthFunc(gl.LEQUAL);
      gl.colorMask(true, true, true, true);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.STENCIL_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.pointsVao!);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointsBuffer!);
      if (this.dirty) {
        gl.bufferData(gl.ARRAY_BUFFER, this.pointData, gl.STATIC_DRAW);
        for (const [index, size, offset] of [
          [0, 3, 0],
          [1, 2, 12],
          [2, 4, 20],
        ]) {
          gl.enableVertexAttribArray(index);
          gl.vertexAttribPointer(index, size, gl.FLOAT, false, 36, offset);
        }
        if (this.band) {
          gl.bindVertexArray(this.bandVao!);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.bandBuffer!);
          gl.bufferData(gl.ARRAY_BUFFER, this.band.vertices, gl.STATIC_DRAW);
          gl.enableVertexAttribArray(0);
          gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
          gl.enableVertexAttribArray(1);
          gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indicesBuffer!);
          gl.bufferData(
            gl.ELEMENT_ARRAY_BUFFER,
            this.band.indices,
            gl.STATIC_DRAW,
          );
        }
        if (this.lineData.length) {
          gl.bindVertexArray(this.lineVao!);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer!);
          gl.bufferData(gl.ARRAY_BUFFER, this.lineData, gl.STATIC_DRAW);
          gl.enableVertexAttribArray(0);
          gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
        }
        if (this.deepData.length) {
          gl.bindVertexArray(this.deepVao!);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.deepBuffer!);
          gl.bufferData(gl.ARRAY_BUFFER, this.deepData, gl.STATIC_DRAW);
          for (const [index, size, offset] of [
            [0, 3, 0],
            [1, 2, 12],
            [2, 3, 20],
          ]) {
            gl.enableVertexAttribArray(index);
            gl.vertexAttribPointer(index, size, gl.FLOAT, false, 32, offset);
          }
        }
        this.dirty = false;
      }
      if (this.band && this.milky.texture && this.strength > 0) {
        gl.useProgram(b);
        gl.bindTexture(gl.TEXTURE_2D, this.milky.texture!);
        gl.uniform1i(gl.getUniformLocation(b, "u_atlas"), 0);
        gl.uniformMatrix4fv(
          gl.getUniformLocation(b, "u_camera"),
          false,
          this.matrix,
        );
        gl.uniform1f(
          gl.getUniformLocation(b, "u_strength"),
          this.strength * this.contrast,
        );
        gl.bindVertexArray(this.bandVao!);
        gl.drawElements(
          gl.TRIANGLES,
          this.band.indices.length,
          gl.UNSIGNED_SHORT,
          0,
        );
      }
      if (this.lineData.length && this.lineProgram) {
        gl.useProgram(this.lineProgram);
        gl.uniformMatrix4fv(
          gl.getUniformLocation(this.lineProgram, "u_camera"),
          false,
          this.matrix,
        );
        gl.bindVertexArray(this.lineVao!);
        gl.drawArrays(gl.LINES, 0, this.lineData.length / 3);
      }
      if (this.deep.texture && this.deepData.length && this.deepProgram) {
        gl.useProgram(this.deepProgram);
        gl.bindTexture(gl.TEXTURE_2D, this.deep.texture);
        gl.uniformMatrix4fv(
          gl.getUniformLocation(this.deepProgram, "u_camera"),
          false,
          this.matrix,
        );
        gl.uniform1i(gl.getUniformLocation(this.deepProgram, "u_atlas"), 0);
        gl.uniform1f(
          gl.getUniformLocation(this.deepProgram, "u_strength"),
          this.strength,
        );
        gl.uniform1f(
          gl.getUniformLocation(this.deepProgram, "u_ha_gain"),
          this.haGain,
        );
        gl.uniform1f(gl.getUniformLocation(this.deepProgram, "u_probe"), 0);
        gl.bindVertexArray(this.deepVao!);
        gl.drawArrays(gl.TRIANGLES, 0, this.deepData.length / 8);
      }
      gl.useProgram(p);
      gl.uniformMatrix4fv(
        gl.getUniformLocation(p, "u_camera"),
        false,
        this.matrix,
      );
      const host = this.map!.getContainer(),
        canvas = this.map!.getCanvas();
      gl.uniform1f(
        gl.getUniformLocation(p, "u_pixel_ratio"),
        canvas.width / Math.max(1, host.clientWidth),
      );
      gl.bindVertexArray(this.pointsVao!);
      gl.uniform1f(gl.getUniformLocation(p, "u_probe"), 0);
      gl.drawArrays(gl.POINTS, 0, this.points.length);
      if (!this.pending.length && this.resolvedKey !== queryKey) {
        const view = { ...f.plan, azimuth: c.azimuth, pitch: c.pitch };
        this.pendingKey = queryKey;
        this.pendingAt = Date.now();
        gl.colorMask(false, false, false, false);
        // Brightness is not geometry: invisible daytime stars must still test
        // against terrain, or an empty alpha mask would look like a mountain.
        gl.uniform1f(gl.getUniformLocation(p, "u_probe"), 1);
        for (const point of this.targets) {
          if (skyPointView(view, point).state !== "画面内") continue;
          const query = gl.createQuery();
          if (!query) throw new Error("query allocation");
          this.pending.push({
            id: point.id.startsWith("dso-") ? `${point.id}:label` : point.id,
            query,
          });
          gl.beginQuery(gl.ANY_SAMPLES_PASSED, query);
          try {
            gl.drawArrays(gl.POINTS, this.offsets.get(point.id)!, 1);
          } finally {
            gl.endQuery(gl.ANY_SAMPLES_PASSED);
          }
        }
        if (this.deep.texture && this.deepProgram) {
          gl.useProgram(this.deepProgram);
          gl.bindTexture(gl.TEXTURE_2D, this.deep.texture);
          gl.bindVertexArray(this.deepVao!);
          gl.uniform1f(gl.getUniformLocation(this.deepProgram, "u_probe"), 1);
          for (const object of this.deepObjects) {
            if (deepSkyView(view, object).state !== "画面内") continue;
            const clear = gl.createQuery(),
              blocked = gl.createQuery();
            if (!clear || !blocked) {
              if (clear) gl.deleteQuery(clear);
              if (blocked) gl.deleteQuery(blocked);
              throw new Error("deep sky query allocation");
            }
            this.pending.push({ id: object.id, query: clear, blocked });
            for (const [query, depth] of [
              [clear, gl.LEQUAL],
              [blocked, gl.GREATER],
            ] as const) {
              gl.depthFunc(depth);
              gl.beginQuery(gl.ANY_SAMPLES_PASSED, query);
              try {
                gl.drawArrays(gl.TRIANGLES, object.offset, object.count);
              } finally {
                gl.endQuery(gl.ANY_SAMPLES_PASSED);
              }
            }
          }
          gl.depthFunc(gl.LEQUAL);
        }
        if (!this.pending.length) {
          this.resolvedKey = queryKey;
          this.publish({
            planKey: f.planKey,
            ready: true,
            view: { azimuth: c.azimuth, pitch: c.pitch },
            states: {},
          });
        }
      }
    } catch {
      this.fail("星空与银河绘制失败，请重试预览。");
    } finally {
      for (const [cap, on] of [
        [gl.DEPTH_TEST, previous.depth],
        [gl.CULL_FACE, previous.cull],
        [gl.BLEND, previous.blend],
        [gl.STENCIL_TEST, previous.stencil],
      ] as const)
        on ? gl.enable(cap) : gl.disable(cap);
      gl.depthFunc(previous.depthFunc);
      gl.depthRange(previous.depthRange[0], previous.depthRange[1]);
      gl.depthMask(previous.depthMask);
      gl.colorMask(
        ...(previous.colorMask as [boolean, boolean, boolean, boolean]),
      );
      gl.blendFuncSeparate(
        previous.srcRGB,
        previous.dstRGB,
        previous.srcAlpha,
        previous.dstAlpha,
      );
      gl.bindVertexArray(previous.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, previous.buffer);
      gl.useProgram(previous.program);
      gl.bindTexture(gl.TEXTURE_2D, previousTexture);
      gl.bindSampler(0, previousSampler);
      gl.activeTexture(previous.activeTexture);
      for (const [key, value] of previous.unpack) gl.pixelStorei(key, value);
    }
    if (this.pending.length) this.map?.triggerRepaint();
  }
  onRemove() {
    this.milky.dispose(this.gl);
    this.deep.dispose(this.gl);
    this.clearQueries();
    const gl = this.gl;
    if (gl) {
      gl.deleteProgram(this.pointsProgram ?? null);
      gl.deleteProgram(this.bandProgram ?? null);
      gl.deleteProgram(this.lineProgram ?? null);
      gl.deleteProgram(this.deepProgram ?? null);
      gl.deleteBuffer(this.deepBuffer ?? null);
      gl.deleteVertexArray(this.deepVao ?? null);
      gl.deleteBuffer(this.pointsBuffer ?? null);
      gl.deleteBuffer(this.bandBuffer ?? null);
      gl.deleteBuffer(this.indicesBuffer ?? null);
      gl.deleteBuffer(this.lineBuffer ?? null);
      gl.deleteVertexArray(this.pointsVao ?? null);
      gl.deleteVertexArray(this.bandVao ?? null);
      gl.deleteVertexArray(this.lineVao ?? null);
    }
    this.map = undefined;
    this.gl = undefined;
    this.pointsProgram = undefined;
    this.bandProgram = undefined;
    this.lineProgram = undefined;
    this.deepProgram = undefined;
  }
}

import earcut from "earcut";
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import { classifyOcclusion, skyLabelKey } from "../domain/visibility.ts";
import type { VisibilitySnapshot } from "../domain/visibility.ts";
import { renderedCamera } from "./rendered-camera.ts";
import type { RenderedCamera } from "./rendered-camera.ts";
import type { ShootingPlan } from "../domain/plan.ts";
import { fieldOfView } from "../domain/plan.ts";
import type { WeatherSample } from "../domain/weather.ts";
import { weatherClouds } from "../domain/weather-appearance.ts";
import { celestialBodies } from "../domain/ephemeris.ts";
import { skyAppearance } from "../domain/sky-appearance.ts";
import { weatherVertex, weatherFragment } from "./weather-shaders.ts";

type Point = { x: number; y: number };
export interface CelestialFrame {
  key: string;
  planKey: string;
  ready: boolean;
  bodies: { id: "sun" | "moon"; outline: Point[]; illuminated: Point[] }[];
  plan?: ShootingPlan;
  weather?: WeatherSample;
  artificialMcd?: number;
}
type Mesh = { id: "sun" | "moon"; outline: Float32Array; fill: Float32Array; silhouette: Float32Array };
type Pending = { id: "sun" | "moon"; clear: WebGLQuery; blocked: WebGLQuery };
const weatherQuad = new Float32Array([-1,-1, 1,-1, 1,1, -1,-1, 1,1, -1,1]);

export function triangulate(points: Point[]) {
  const coordinates = points.flatMap((point) => [point.x, point.y]);
  return new Float32Array(earcut(coordinates).flatMap((index) => [coordinates[index * 2], coordinates[index * 2 + 1]]));
}

function makeProgram(gl: WebGL2RenderingContext, vertex?: string, fragment?: string) {
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex ?? "#version 300 es\nlayout(location=0) in vec2 a_pos; void main(){gl_Position=vec4(a_pos.x,-a_pos.y,1.0,1.0);}"],
      [gl.FRAGMENT_SHADER, fragment ?? "#version 300 es\nprecision highp float; uniform vec4 u_color; out vec4 color; void main(){color=u_color;}"],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("shader allocation");
      shaders.push(shader);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("shader compilation");
    }
    program = gl.createProgram();
    if (!program) throw new Error("program allocation");
    shaders.forEach((shader) => gl.attachShader(program!, shader));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("program link");
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally { shaders.forEach((shader) => gl.deleteShader(shader)); }
}

/** Public MapLibre custom-layer API only; no internal depth textures or picking APIs. */
export class CelestialLayer implements CustomLayerInterface {
  id = "preview-celestial-depth";
  type = "custom" as const;
  renderingMode = "3d" as const;
  private map?: MapLibreMap;
  private gl?: WebGL2RenderingContext;
  private program?: WebGLProgram;
  private weatherProgram?: WebGLProgram;
  private rendered?: RenderedCamera;
  private buffer?: WebGLBuffer;
  private vao?: WebGLVertexArrayObject;
  private color: WebGLUniformLocation | null = null;
  private frame?: CelestialFrame;
  private meshes: Mesh[] = [];
  private pending: Pending[] = [];
  private pendingAt = 0;
  private resolvedKey = "";
  private failed = false;
  private cameraKey = "";
  private onCamera?: (camera: RenderedCamera) => void;
  private labelKey = "";
  private labelStates: VisibilitySnapshot["labelStates"] = {};
  private weatherDisplay?: { clouds: ReturnType<typeof weatherClouds>; color: number[]; rain: number; snow: number };
  private visible = true;
  private motion?: MediaQueryList;
  private animationTime = 0;
  private animationAt?: number;
  private animationTimer?: ReturnType<typeof setTimeout>;

  private report: (snapshot: VisibilitySnapshot) => void;
  constructor(report: (snapshot: VisibilitySnapshot) => void, onCamera?: (camera: RenderedCamera) => void) { this.report = report; this.onCamera = onCamera; }

  private publish(snapshot: VisibilitySnapshot) {
    const labelKey = this.frame?.plan ? skyLabelKey(this.frame.plan) : "";
    if (labelKey !== this.labelKey || snapshot.message) this.labelStates = {};
    this.labelKey = labelKey;
    for (const id of ["sun", "moon"] as const)
      if (snapshot.states[id] !== "waiting") this.labelStates = { ...this.labelStates, [id]: snapshot.states[id] };
    this.report({ ...snapshot, labelKey, labelStates: this.labelStates });
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    this.map = map; this.gl = gl;
    if (typeof window !== "undefined") {
      this.motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
      this.motion?.addEventListener("change", this.refreshAnimation);
    }
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.refreshAnimation);
    try {
      this.program = makeProgram(gl);
      this.buffer = gl.createBuffer() ?? undefined;
      this.vao = gl.createVertexArray() ?? undefined;
      if (!this.buffer || !this.vao) throw new Error("GPU allocation");
      this.color = gl.getUniformLocation(this.program, "u_color");
    } catch { this.fail(); }
  }

  setScene(frame: CelestialFrame) {
    if (this.frame?.key === frame.key && this.frame.ready === frame.ready) return;
    this.clearQueries();
    this.frame = frame;
    this.weatherDisplay = undefined;
    if (frame.weather && frame.plan) {
      const bodies = celestialBodies(frame.plan);
      const appearance = skyAppearance(bodies.sun.elevation, bodies.moon, frame.artificialMcd);
      const day = Math.max(0, Math.min(1, (bodies.sun.elevation + 6) / 14));
      const lift = appearance.moonlight * 0.08 + appearance.pollutionGlow * 0.18;
      this.weatherDisplay = {
        clouds: weatherClouds(frame.weather, frame.plan),
        color: [0.06 + day * 0.66 + lift, 0.08 + day * 0.67 + lift, 0.12 + day * 0.66 + lift],
        rain: frame.weather.rain + frame.weather.showers,
        snow: frame.weather.snow,
      };
    }
    this.refreshAnimation();
    this.resolvedKey = "";
    this.meshes = frame.bodies.map((body) => ({
      id: body.id, outline: new Float32Array(body.outline.flatMap((p) => [p.x, p.y])),
      fill: triangulate(body.illuminated), silhouette: triangulate(body.outline),
    }));
    this.publish({ planKey: frame.planKey, states: { sun: this.failed ? "error" : "waiting", moon: this.failed ? "error" : "waiting" } });
    this.map?.triggerRepaint();
  }

  invalidate() {
    if (this.failed) return;
    this.clearQueries(); this.resolvedKey = "";
    if (this.frame) {
      this.frame = { ...this.frame, ready: false };
      this.publish({ planKey: this.frame.planKey, states: { sun: "waiting", moon: "waiting" } });
    }
  }

  private clearQueries() {
    for (const query of this.pending) {
      this.gl?.deleteQuery(query.clear); this.gl?.deleteQuery(query.blocked);
    }
    this.pending = [];
    this.pendingAt = 0;
  }

  private fail(message = "日月深度渲染不可用，请重试预览。") {
    this.failed = true;
    this.refreshAnimation();
    this.clearQueries();
    this.publish({ planKey: this.frame?.planKey ?? "", states: { sun: "error", moon: "error" }, message });
  }

  private readQueries(gl: WebGL2RenderingContext) {
    if (!this.pending.length || !this.frame) return;
    if (!this.pending.every((query) => gl.getQueryParameter(query.clear, gl.QUERY_RESULT_AVAILABLE) && gl.getQueryParameter(query.blocked, gl.QUERY_RESULT_AVAILABLE))) {
      if (Date.now() - this.pendingAt > 5000) this.fail("日月遮挡查询超时，请重试预览。");
      return;
    }
    const snapshot: VisibilitySnapshot = { planKey: this.frame.planKey, states: { sun: "waiting", moon: "waiting" } };
    for (const query of this.pending) snapshot.states[query.id] = classifyOcclusion(
      !!gl.getQueryParameter(query.clear, gl.QUERY_RESULT), !!gl.getQueryParameter(query.blocked, gl.QUERY_RESULT));
    this.clearQueries(); this.resolvedKey = this.frame.key;
    this.publish(snapshot);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.refreshAnimation();
  }

  private canAnimate() {
    return !this.failed && this.visible && !!this.map && !!this.weatherDisplay &&
      this.weatherDisplay.rain + this.weatherDisplay.snow > 0 && !this.motion?.matches &&
      (typeof document === "undefined" || !document.hidden);
  }

  private refreshAnimation = () => {
    clearTimeout(this.animationTimer);
    this.animationTimer = undefined;
    if (!this.canAnimate()) this.animationAt = undefined;
    this.map?.triggerRepaint();
  };

  render(gl: WebGL2RenderingContext, input?: CustomRenderMethodInput) {
    if (this.failed || !this.frame || !this.program || !this.buffer || !this.vao) return;
    if (gl.isContextLost()) { this.fail(); return; }
    if (input && this.map && this.onCamera) {
      try {
        const camera = renderedCamera(this.map, input.modelViewProjectionMatrix, this.frame.planKey);
        this.rendered = camera;
        const key = JSON.stringify(camera, (_key, value) => typeof value === "number" ? +value.toFixed(7) : value);
        if (key !== this.cameraKey) { this.cameraKey = key; this.onCamera(camera); }
      } catch { this.fail("无法读取实际拍摄相机，请重试预览。"); return; }
    }
    try { this.readQueries(gl); } catch { this.fail(); return; }
    if (this.failed) return;
    // Custom layers share the context. Restore every state changed here; never clear buffers.
    const previous = {
      program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      buffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING), depth: gl.isEnabled(gl.DEPTH_TEST),
      cull: gl.isEnabled(gl.CULL_FACE), blend: gl.isEnabled(gl.BLEND), stencil: gl.isEnabled(gl.STENCIL_TEST),
      depthFunc: gl.getParameter(gl.DEPTH_FUNC), depthRange: gl.getParameter(gl.DEPTH_RANGE),
      depthMask: gl.getParameter(gl.DEPTH_WRITEMASK), colorMask: gl.getParameter(gl.COLOR_WRITEMASK),
      srcRGB: gl.getParameter(gl.BLEND_SRC_RGB), dstRGB: gl.getParameter(gl.BLEND_DST_RGB),
      srcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA), dstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
    };
    try {
      gl.useProgram(this.program); gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.enable(gl.DEPTH_TEST); gl.depthRange(0, 1); gl.depthMask(false);
      gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST); gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const draw = (vertices: Float32Array, mode: number) => {
        if (!vertices.length) return;
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STREAM_DRAW); gl.drawArrays(mode, 0, vertices.length / 2);
      };
      const queryNeeded = this.frame.ready && this.frame.key !== this.resolvedKey && !this.pending.length;
      if (queryNeeded) this.pendingAt = Date.now();
      for (const mesh of this.meshes) {
        if (queryNeeded) {
          const clear = gl.createQuery(), blocked = gl.createQuery();
          if (!clear || !blocked) {
            if (clear) gl.deleteQuery(clear); if (blocked) gl.deleteQuery(blocked);
            throw new Error("query allocation");
          }
          this.pending.push({ id: mesh.id, clear, blocked });
          gl.colorMask(false, false, false, false);
          for (const [query, func] of [[clear, gl.LEQUAL], [blocked, gl.GREATER]] as const) {
            gl.depthFunc(func); gl.beginQuery(gl.ANY_SAMPLES_PASSED, query);
            try { draw(mesh.silhouette, gl.TRIANGLES); } finally { gl.endQuery(gl.ANY_SAMPLES_PASSED); }
          }
        }
        gl.colorMask(true, true, true, true); gl.depthFunc(gl.LEQUAL);
        gl.uniform4fv(this.color, mesh.id === "sun" ? [1, 0.95, 0.737, 1] : [0.933, 0.918, 0.871, 1]);
        draw(mesh.fill, gl.TRIANGLES);
        gl.uniform4fv(this.color, mesh.id === "sun" ? [0.86, 0.71, 0.36, 0.9] : [0.435, 0.435, 0.43, 0.5]);
        draw(mesh.outline, gl.LINE_LOOP);
      }
      if (this.frame.weather && this.frame.plan && this.weatherDisplay) {
        this.weatherProgram ??= makeProgram(gl, weatherVertex, weatherFragment);
        const p = this.weatherProgram, plan = this.frame.plan, weather = this.frame.weather;
        const camera = this.rendered ?? plan, fov = fieldOfView(plan);
        const az = camera.azimuth * Math.PI / 180, pitch = camera.pitch * Math.PI / 180;
        const horizontal = Math.tan(fov.horizontal * Math.PI / 360), vertical = Math.tan(fov.vertical * Math.PI / 360);
        const display = this.weatherDisplay;
        gl.useProgram(p);
        gl.uniform3fv(gl.getUniformLocation(p, "u_forward"), [Math.sin(az) * Math.cos(pitch), Math.cos(az) * Math.cos(pitch), Math.sin(pitch)]);
        gl.uniform3fv(gl.getUniformLocation(p, "u_right"), [Math.cos(az) * horizontal, -Math.sin(az) * horizontal, 0]);
        gl.uniform3fv(gl.getUniformLocation(p, "u_up"), [-Math.sin(az) * Math.sin(pitch) * vertical, -Math.cos(az) * Math.sin(pitch) * vertical, Math.cos(pitch) * vertical]);
        gl.uniform3fv(gl.getUniformLocation(p, "u_layers"), display.clouds.layers);
        gl.uniform2fv(gl.getUniformLocation(p, "u_drift"), display.clouds.drift);
        gl.uniform3fv(gl.getUniformLocation(p, "u_color"), display.color);
        gl.colorMask(true, true, true, true); gl.depthFunc(gl.LEQUAL);
        gl.uniform1f(gl.getUniformLocation(p, "u_mode"), 0);
        draw(weatherQuad, gl.TRIANGLES);
        if (display.rain + display.snow > 0) {
          gl.disable(gl.DEPTH_TEST);
          gl.uniform1f(gl.getUniformLocation(p, "u_mode"), 1);
          gl.uniform2fv(gl.getUniformLocation(p, "u_precipitation"), [display.rain, display.snow]);
          const now = performance.now() / 1000;
          if (this.canAnimate()) {
            if (this.animationAt !== undefined) this.animationTime += Math.max(0, Math.min(0.1, now - this.animationAt));
            this.animationAt = now;
          } else this.animationAt = undefined;
          gl.uniform1f(gl.getUniformLocation(p, "u_time"), this.animationTime);
          // Near-surface wind gives the precipitation illustration a screen
          // direction. Cloud advection retains its separate display model.
          gl.uniform1f(gl.getUniformLocation(p, "u_slant"), Math.max(-0.45, Math.min(0.45,
            Math.sin(weather.windDirection * Math.PI / 180 - az) * weather.windSpeed / 40)));
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      }
    } catch { this.fail(); }
    finally {
      for (const [cap, enabled] of [[gl.DEPTH_TEST, previous.depth], [gl.CULL_FACE, previous.cull], [gl.BLEND, previous.blend], [gl.STENCIL_TEST, previous.stencil]] as const)
        enabled ? gl.enable(cap) : gl.disable(cap);
      gl.depthFunc(previous.depthFunc); gl.depthRange(previous.depthRange[0], previous.depthRange[1]);
      gl.depthMask(previous.depthMask); gl.colorMask(...previous.colorMask as [boolean, boolean, boolean, boolean]);
      gl.blendFuncSeparate(previous.srcRGB, previous.dstRGB, previous.srcAlpha, previous.dstAlpha);
      gl.bindVertexArray(previous.vao); gl.bindBuffer(gl.ARRAY_BUFFER, previous.buffer); gl.useProgram(previous.program);
    }
    if (this.pending.length) this.map?.triggerRepaint();
    if (this.canAnimate() && this.animationTimer === undefined) {
      this.animationTimer = setTimeout(() => {
        this.animationTimer = undefined;
        if (this.canAnimate()) this.map?.triggerRepaint();
      }, 1000 / 30);
    }
  }

  onRemove() {
    clearTimeout(this.animationTimer);
    this.animationTimer = undefined;
    this.animationAt = undefined;
    this.motion?.removeEventListener("change", this.refreshAnimation);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.refreshAnimation);
    this.weatherDisplay = undefined;
    this.labelStates = {};
    this.labelKey = "";
    this.clearQueries();
    if (this.program) this.gl?.deleteProgram(this.program);
    if (this.weatherProgram) this.gl?.deleteProgram(this.weatherProgram);
    if (this.buffer) this.gl?.deleteBuffer(this.buffer);
    if (this.vao) this.gl?.deleteVertexArray(this.vao);
    this.program = undefined; this.buffer = undefined; this.vao = undefined;
    this.weatherProgram = undefined; this.rendered = undefined;
    this.map = undefined; this.gl = undefined;
  }
}

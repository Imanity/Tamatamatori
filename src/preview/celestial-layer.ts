import earcut from "earcut";
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import { classifyOcclusion } from "../domain/visibility.ts";
import type { VisibilitySnapshot } from "../domain/visibility.ts";
import { renderedCamera } from "./rendered-camera.ts";
import type { RenderedCamera } from "./rendered-camera.ts";

type Point = { x: number; y: number };
export interface CelestialFrame {
  key: string;
  planKey: string;
  ready: boolean;
  bodies: { id: "sun" | "moon"; outline: Point[]; illuminated: Point[] }[];
}
type Mesh = { id: "sun" | "moon"; outline: Float32Array; fill: Float32Array; silhouette: Float32Array };
type Pending = { id: "sun" | "moon"; clear: WebGLQuery; blocked: WebGLQuery };

export function triangulate(points: Point[]) {
  const coordinates = points.flatMap((point) => [point.x, point.y]);
  return new Float32Array(earcut(coordinates).flatMap((index) => [coordinates[index * 2], coordinates[index * 2 + 1]]));
}

function makeProgram(gl: WebGL2RenderingContext) {
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, "#version 300 es\nlayout(location=0) in vec2 a_pos; void main(){gl_Position=vec4(a_pos.x,-a_pos.y,1.0,1.0);}"],
      [gl.FRAGMENT_SHADER, "#version 300 es\nprecision highp float; uniform vec4 u_color; out vec4 color; void main(){color=u_color;}"],
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

  private report: (snapshot: VisibilitySnapshot) => void;
  constructor(report: (snapshot: VisibilitySnapshot) => void, onCamera?: (camera: RenderedCamera) => void) { this.report = report; this.onCamera = onCamera; }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    this.map = map; this.gl = gl;
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
    this.resolvedKey = "";
    this.meshes = frame.bodies.map((body) => ({
      id: body.id, outline: new Float32Array(body.outline.flatMap((p) => [p.x, p.y])),
      fill: triangulate(body.illuminated), silhouette: triangulate(body.outline),
    }));
    this.report({ planKey: frame.planKey, states: { sun: this.failed ? "error" : "waiting", moon: this.failed ? "error" : "waiting" } });
    this.map?.triggerRepaint();
  }

  invalidate() {
    if (this.failed) return;
    this.clearQueries(); this.resolvedKey = "";
    if (this.frame) {
      this.frame = { ...this.frame, ready: false };
      this.report({ planKey: this.frame.planKey, states: { sun: "waiting", moon: "waiting" } });
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
    this.clearQueries();
    this.report({ planKey: this.frame?.planKey ?? "", states: { sun: "error", moon: "error" }, message });
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
    this.report(snapshot);
  }

  render(gl: WebGL2RenderingContext, input?: CustomRenderMethodInput) {
    if (this.failed || !this.frame || !this.program || !this.buffer || !this.vao) return;
    if (gl.isContextLost()) { this.fail(); return; }
    if (input && this.map && this.onCamera) {
      try {
        const camera = renderedCamera(this.map, input.modelViewProjectionMatrix, this.frame.planKey);
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
  }

  onRemove() {
    this.clearQueries();
    if (this.program) this.gl?.deleteProgram(this.program);
    if (this.buffer) this.gl?.deleteBuffer(this.buffer);
    if (this.vao) this.gl?.deleteVertexArray(this.vao);
    this.program = undefined; this.buffer = undefined; this.vao = undefined;
    this.map = undefined; this.gl = undefined;
  }
}

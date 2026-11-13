import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import type { ShootingPlan } from "../../domain/core/plan.ts";
import { sensorKey } from "../../domain/core/plan.ts";
import {
  milkyWayMesh,
  skyPointSize,
  skyPointView,
  skyReference,
} from "../../domain/sky/starfield.ts";
import type { SkyPoint, SkyVisibility } from "../../domain/sky/starfield.ts";
import { refractDirection } from "../../domain/core/refraction.ts";
import { renderedCamera } from "../scene/rendered-camera.ts";
import type { RenderedCamera } from "../scene/rendered-camera.ts";
import { photoCameraMatrix } from "../../domain/core/terrain-perspective-math.ts";
import { skyAppearance, starOpacity } from "../../domain/sky/sky-appearance.ts";
import { constellationScene } from "../../domain/sky/constellations.ts";
import { loadMilkyWayImage } from "./milky-way-texture.ts";
import { loadDeepSkyImage } from "./deep-sky-texture.ts";
import { SkyTexture } from "./sky-texture.ts";
import { DeepSkyTextures } from "./deep-sky-textures.ts";
import { deepSkyScene, deepSkyView, deepSkyImageEntry } from "../../domain/sky/deep-sky.ts";
import type { DeepSkyTarget } from "../../domain/sky/deep-sky.ts";
import type { StationScene } from "../../domain/stations/stations.ts";
import { classifyOcclusion, skyLabelKey } from "../../domain/core/visibility.ts";
import { activeShowers, meteorSample } from "../../domain/sky/meteor-showers.ts";
import { meteorFragment, meteorMesh, meteorVertex, METEOR_ATTRIBUTES, METEOR_STRIDE } from "./meteor-streaks.ts";
import type { CometScene } from "../../domain/comets/comets.ts";
import { cometFragment, cometMesh, cometVertex, COMET_ATTRIBUTES, COMET_STRIDE } from "./comet-tails.ts";
import { pointVertex, pointFragment, bandVertex, bandFragment, lineVertex, lineFragment, deepVertex, deepFragment, program } from "./starfield-shaders.ts";

interface Frame {
  key: string;
  planKey: string;
  ready: boolean;
  plan: ShootingPlan;
  stations?: StationScene;
  /** Comets at the instant; drawn while the comet layer is on. */
  comets?: CometScene;
  artificialMcd?: number;
  /** Direction the preview camera actually shows; the plan's when absent. */
  view?: { azimuth: number; pitch: number };
}
type Pending = { id: string; query: WebGLQuery; blocked?: WebGLQuery };

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
  private deep: DeepSkyTextures;
  private deepProgram?: WebGLProgram;
  private meteorProgram?: WebGLProgram;
  private meteorVao?: WebGLVertexArrayObject;
  private meteorBuffer?: WebGLBuffer;
  private meteorData: Float32Array = new Float32Array();
  private meteorKey = "";
  private meteorDirty = false;
  private cometProgram?: WebGLProgram;
  private cometVao?: WebGLVertexArrayObject;
  private cometBuffer?: WebGLBuffer;
  private cometData: Float32Array = new Float32Array();
  private cometKey = "";
  private cometDirty = false;
  private deepVao?: WebGLVertexArrayObject;
  private deepBuffer?: WebGLBuffer;
  private deepData: Float32Array = new Float32Array();
  private deepObjects: DeepSkyTarget[] = [];
  private haGain = 0;
  private snapshot?: SkyVisibility;
  private labelKey = "";
  private labelStates: SkyVisibility["states"] = {};
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
    this.deep = new DeepSkyTextures(() => this.textureChanged(), loadDeep);
  }
  private publish(snapshot: SkyVisibility) {
    const labelKey = this.frame ? skyLabelKey(this.frame.plan) : "";
    const contextKey = `${labelKey}/${this.frame?.stations?.key ?? ""}`;
    if (this.labelKey !== contextKey || snapshot.message) this.labelStates = {};
    this.labelKey = contextKey;
    if (snapshot.ready) this.labelStates = { ...this.labelStates, ...snapshot.states };
    this.snapshot = snapshot;
    this.report({
      ...snapshot,
      labelKey,
      labelStates: this.labelStates,
      orbitKey: this.frame?.stations?.key,
      milkyWay: this.frame?.plan.layers.milkyWay
        ? this.milky.state
        : { phase: "off" },
      deepSky: this.frame?.plan.layers.deepSky
        ? this.deep.state
        : { phase: "off" },
      deepSkyTargets: this.deep.states,
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
      this.meteorProgram = program(gl, meteorVertex, meteorFragment);
      this.meteorVao = gl.createVertexArray() ?? undefined;
      this.meteorBuffer = gl.createBuffer() ?? undefined;
      this.cometProgram = program(gl, cometVertex, cometFragment);
      this.cometVao = gl.createVertexArray() ?? undefined;
      this.cometBuffer = gl.createBuffer() ?? undefined;
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
        !this.deepBuffer ||
        !this.meteorVao ||
        !this.meteorBuffer ||
        !this.cometVao ||
        !this.cometBuffer
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
    const gain = response === "ha-modified" ? 1 : 0;
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
    if (!frame.plan.layers.deepSky) this.deep.dispose(this.gl);
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
        frame.stations?.key,
        frame.artificialMcd ?? 0,
        !!p.layers.meteors,
        !!p.layers.comets,
        frame.comets?.key,
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
      const appearance = sky ? skyAppearance(sky.sunElevation, sky.moon, frame.artificialMcd) : null;
      const figure = p.layers.constellations ? constellationScene(p) : null;
      this.lineData = figure?.vertices ?? new Float32Array();
      const deep = p.layers.deepSky ? deepSkyScene(p) : null;
      const radiants = p.layers.meteors ? activeShowers(p).map((active) => active.point) : [];
      // Comet heads are drawn with their tails; the points only carry the terrain test for the labels.
      const heads = p.layers.comets ? (frame.comets?.views ?? []).map((view) => view.point) : [];
      this.deepObjects = deep?.objects ?? [];
      this.deepData = deep?.vertices ?? new Float32Array();
      this.points = [
        ...(p.layers.stars ? sky!.points : []),
        ...(p.layers.milkyWay ? [sky!.core] : []),
        ...(figure?.anchors ?? []),
        ...this.deepObjects,
        ...(!p.layers.stars ? (deep?.clusterStars ?? []) : []),
        ...(p.layers.stations ? (frame.stations?.points ?? []).filter((point) => point.elevation > 0) : []),
        ...(p.layers.stations ? (frame.stations?.trail ?? []).filter((point) => point.elevation > 0) : []),
        ...radiants,
        ...heads,
      ];
      this.targets = this.points.filter((point) => !!point.name);
      this.offsets.clear();
      const data: number[] = [];
      this.points.forEach((point, i) => {
        this.offsets.set(point.id, i);
        const ray = refractDirection(point.direction, p.refraction);
        const anchor =
          point.id.startsWith("constellation-") || point.id.startsWith("dso-") || point.id.startsWith("comet-");
        const station = point.id.startsWith("station-");
        const radiant = point.id.startsWith("meteor-");
        const trail = station && point.id.includes("-trail-");
        const alpha = radiant ? 0.95 : station ? (trail ? 0.45 : 0.95) : anchor ? 0 : starOpacity(point, appearance!);
        data.push(
          ...ray,
          radiant ? 26 : station ? (trail ? 2 : 9) : anchor ? 4 : skyPointSize(point),
          radiant ? 2 : (station && !trail) || point.id === "galactic-center" ? 1 : 0,
          ...point.color,
          alpha,
        );
      });
      this.pointData = new Float32Array(data);
      this.band = p.layers.milkyWay ? milkyWayMesh(p) : undefined;
      this.strength = appearance?.galaxyStrength ?? 0;
    }
    // Tails are sky directions, so turning or zooming the camera keeps the mesh.
    const comets = p.layers.comets ? frame.comets : undefined;
    const cometKey = comets ? [comets.key, p.refraction].join("/") : "";
    if (cometKey !== this.cometKey) {
      this.cometKey = cometKey;
      this.cometDirty = true;
      this.cometData = comets ? cometMesh(comets.views, p.refraction, comets.skyFade) : new Float32Array();
    }
    // The stack depends on the fixed camera, so turning it rebuilds only the meteors.
    const camera = { ...p, ...frame.view };
    const meteorKey = p.layers.meteors && p.layers.meteorDensity
      ? [p.latitude, p.longitude, p.instant, p.refraction, frame.artificialMcd ?? 0,
        camera.azimuth, camera.pitch, p.focalLength, sensorKey(p), p.aspectRatio, p.orientation].join("/")
      : "";
    if (meteorKey !== this.meteorKey) {
      this.meteorKey = meteorKey;
      this.meteorDirty = true;
      this.meteorData = meteorKey
        ? meteorMesh(meteorSample(camera, frame.artificialMcd ?? 0).streaks, p.refraction)
        : new Float32Array();
    }
    this.map?.triggerRepaint();
  }
  invalidate(resetLabels = false) {
    if (resetLabels) { this.labelStates = {}; this.labelKey = ""; }
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
      (!f.plan.layers.stars &&
        !f.plan.layers.milkyWay &&
        !f.plan.layers.constellations &&
        !f.plan.layers.deepSky &&
        !f.plan.layers.stations &&
        !f.plan.layers.meteors &&
        !f.plan.layers.comets)
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
      this.deep.update({ ...f.plan, azimuth: c.azimuth, pitch: c.pitch }, this.deepObjects, gl,
        this.map!.getContainer().clientWidth, this.map!.getContainer().clientHeight);
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
      if (this.meteorDirty) {
        if (this.meteorData.length) {
          gl.bindVertexArray(this.meteorVao!);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.meteorBuffer!);
          gl.bufferData(gl.ARRAY_BUFFER, this.meteorData, gl.STATIC_DRAW);
          for (const [index, size, offset] of METEOR_ATTRIBUTES) {
            gl.enableVertexAttribArray(index);
            gl.vertexAttribPointer(index, size, gl.FLOAT, false, METEOR_STRIDE * 4, offset);
          }
        }
        this.meteorDirty = false;
      }
      if (this.cometDirty) {
        if (this.cometData.length) {
          gl.bindVertexArray(this.cometVao!);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.cometBuffer!);
          gl.bufferData(gl.ARRAY_BUFFER, this.cometData, gl.STATIC_DRAW);
          for (const [index, size, offset] of COMET_ATTRIBUTES) {
            gl.enableVertexAttribArray(index);
            gl.vertexAttribPointer(index, size, gl.FLOAT, false, COMET_STRIDE * 4, offset);
          }
        }
        this.cometDirty = false;
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
      if (this.deepData.length && this.deepProgram) {
        gl.useProgram(this.deepProgram);
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
        for (const object of this.deepObjects) {
          if (object.entry.imageReference) continue;
          const texture = this.deep.texture(object.id);
          if (!texture) continue;
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.uniform1f(gl.getUniformLocation(this.deepProgram, "u_dark"), object.entry.model === "dark" ? 1 : 0);
          gl.drawArrays(gl.TRIANGLES, object.offset, object.count);
        }
      }
      const host = this.map!.getContainer(),
        canvas = this.map!.getCanvas();
      if (this.cometData.length && this.cometProgram) {
        // Comets sit under the stars; additive glow keeps overlapping tails smooth.
        const m = this.cometProgram;
        gl.useProgram(m);
        gl.uniformMatrix4fv(gl.getUniformLocation(m, "u_camera"), false, this.matrix);
        gl.uniform2fv(gl.getUniformLocation(m, "u_viewport"), [canvas.width, canvas.height]);
        gl.uniform1f(gl.getUniformLocation(m, "u_pixel_ratio"), canvas.width / Math.max(1, host.clientWidth));
        gl.bindVertexArray(this.cometVao!);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.drawArrays(gl.TRIANGLES, 0, this.cometData.length / COMET_STRIDE);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
      if (this.meteorData.length && this.meteorProgram) {
        // Illustrative meteors sit under the radiant symbols and star points.
        const m = this.meteorProgram;
        gl.useProgram(m);
        gl.uniformMatrix4fv(gl.getUniformLocation(m, "u_camera"), false, this.matrix);
        gl.uniform2fv(gl.getUniformLocation(m, "u_viewport"), [canvas.width, canvas.height]);
        gl.uniform1f(gl.getUniformLocation(m, "u_pixel_ratio"), canvas.width / Math.max(1, host.clientWidth));
        gl.bindVertexArray(this.meteorVao!);
        gl.drawArrays(gl.TRIANGLES, 0, this.meteorData.length / METEOR_STRIDE);
      }
      gl.useProgram(p);
      gl.uniformMatrix4fv(
        gl.getUniformLocation(p, "u_camera"),
        false,
        this.matrix,
      );
      gl.uniform1f(
        gl.getUniformLocation(p, "u_pixel_ratio"),
        canvas.width / Math.max(1, host.clientWidth),
      );
      gl.bindVertexArray(this.pointsVao!);
      gl.uniform1f(gl.getUniformLocation(p, "u_probe"), 0);
      gl.drawArrays(gl.POINTS, 0, this.points.length);
      // Keep drawing against current depth while replacement tiles arrive.
      // Only settled terrain can resolve the visibility readout.
      if (f.ready && !this.pending.length && this.resolvedKey !== queryKey) {
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
        if (this.deepProgram) {
          gl.useProgram(this.deepProgram);
          gl.bindVertexArray(this.deepVao!);
          gl.uniform1f(gl.getUniformLocation(this.deepProgram, "u_probe"), 1);
          for (const object of this.deepObjects) {
            const texture = this.deep.texture(object.id);
            if (!texture) continue;
            if (deepSkyView(view, object).state !== "画面内") continue;
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.uniform1f(gl.getUniformLocation(this.deepProgram, "u_dark"), deepSkyImageEntry(object.entry).model === "dark" ? 1 : 0);
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
    this.labelStates = {};
    this.labelKey = "";
    this.milky.dispose(this.gl);
    this.deep.dispose(this.gl);
    this.clearQueries();
    const gl = this.gl;
    if (gl) {
      gl.deleteProgram(this.pointsProgram ?? null);
      gl.deleteProgram(this.bandProgram ?? null);
      gl.deleteProgram(this.lineProgram ?? null);
      gl.deleteProgram(this.deepProgram ?? null);
      gl.deleteProgram(this.meteorProgram ?? null);
      gl.deleteBuffer(this.meteorBuffer ?? null);
      gl.deleteVertexArray(this.meteorVao ?? null);
      gl.deleteProgram(this.cometProgram ?? null);
      gl.deleteBuffer(this.cometBuffer ?? null);
      gl.deleteVertexArray(this.cometVao ?? null);
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
    this.meteorProgram = undefined;
    this.cometProgram = undefined;
  }
}

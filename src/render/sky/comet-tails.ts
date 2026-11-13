import type { CometView, TailSample } from "../../domain/comets/comets.ts";
import { TAIL_FADE_MAGNITUDES } from "../../domain/comets/comets.ts";
import type { ShootingPlan } from "../../domain/core/plan.ts";
import { refractDirection } from "../../domain/core/refraction.ts";
import { DARK_SKY_MAGNITUDE } from "../../domain/sky/sky-appearance.ts";
import type { Vector3 } from "../../domain/core/ephemeris.ts";

/**
 * Comet heads and tails as ribbons of sky directions on the far plane, so the
 * terrain hides them like the rest of the sky and their size follows the
 * focal length. Each vertex carries the direction of its axis point and of
 * the ribbon edge; the vertex stage widens ribbons narrower than about a
 * device pixel and lowers their opacity in proportion, so thin ion tails at
 * short focal lengths fade instead of flickering.
 */
export const cometVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_center;layout(location=1) in vec3 a_edge;layout(location=2) in vec2 a_local;layout(location=3) in vec2 a_style;
uniform mat4 u_camera;uniform vec2 u_viewport;uniform float u_pixel_ratio;
out vec2 v_local;out float v_alpha;flat out int v_kind;out float v_height;
void main(){vec4 p=u_camera*vec4(a_center,0.0),q=u_camera*vec4(a_edge,0.0);
v_local=a_local;v_kind=int(a_style.y+0.5);v_height=a_center.z;v_alpha=a_style.x;
if(p.w<=1e-6||q.w<=1e-6){gl_Position=vec4(0.0,0.0,2.0,1.0);return;}
vec2 a=p.xy/p.w,b=q.xy/q.w;float span=length((b-a)*u_viewport*0.5);
bool head=v_kind==2;float least=(head?2.5:1.2)*u_pixel_ratio,grow=span>1e-6&&span<least?least/span:1.0;
v_alpha/=head?grow*grow:grow;
gl_Position=vec4(a+(b-a)*grow,1.0,1.0);}`;
export const cometFragment = `#version 300 es
precision highp float;
in vec2 v_local;in float v_alpha;flat in int v_kind;in float v_height;out vec4 color;
void main(){if(v_height<=0.0)discard;
float shape=v_kind==2?exp(-4.5*dot(v_local,v_local)):exp(-3.0*v_local.x*v_local.x);
vec3 tint=v_kind==0?vec3(0.62,0.8,1.0):v_kind==1?vec3(1.0,0.93,0.8):vec3(0.84,1.0,0.9);
float a=v_alpha*shape;if(a<0.003)discard;color=vec4(tint*a,a);}`;

/** Floats per vertex: axis direction (3), edge direction (3), across/along (2), alpha and kind (2). */
export const COMET_STRIDE = 10;
/** Attribute location, component count and byte offset. */
export const COMET_ATTRIBUTES = [[0, 3, 0], [1, 3, 12], [2, 2, 24], [3, 2, 32]] as const;
const ION = 0, DUST = 1, HEAD = 2;
/** Relative peak opacity of each tail; ion tails are fainter but longer. */
const TAIL_GAIN = { [ION]: 0.55, [DUST]: 1 } as const;

const normalized = (v: Vector3): Vector3 => { const n = Math.hypot(v[0], v[1], v[2]); return [v[0] / n, v[1] / n, v[2] / n]; };
const cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const offset = (center: Vector3, side: Vector3, amount: number): Vector3 =>
  normalized([center[0] + side[0] * amount, center[1] + side[1] * amount, center[2] + side[2] * amount]);

/** Opacity of a tail at a share of its length: brightness above the sky, faded over the last 1.5 magnitudes. */
export function tailOpacity(peak: number, at: number, skyFade: number) {
  const margin = TAIL_FADE_MAGNITUDES * (1 - at) - skyFade;
  const t = Math.max(0, Math.min(1, margin / 1.5));
  return peak * t * t * (3 - 2 * t);
}
/** Peak opacity of a comet's tails from its total magnitude; display only. */
export const tailPeak = (magnitude: number) => Math.max(0.1, Math.min(0.7, 0.2 + 0.1 * (7 - magnitude)));
/** Head opacity: long exposures reach about three magnitudes below the display limit of the sky. */
export function headOpacity(magnitude: number, skyFade: number) {
  const limit = DARK_SKY_MAGNITUDE + 3 - skyFade;
  const t = Math.max(0, Math.min(1, (limit + 0.5 - magnitude) / 3));
  return 0.9 * t * t * (3 - 2 * t);
}

export function cometMesh(views: readonly CometView[], refraction: ShootingPlan["refraction"], skyFade: number) {
  const data: number[] = [];
  const vertex = (center: Vector3, edge: Vector3, across: number, along: number, alpha: number, kind: number) =>
    data.push(...refractDirection(center, refraction), ...refractDirection(edge, refraction), across, along, alpha, kind);
  const ribbon = (samples: TailSample[], kind: typeof ION | typeof DUST, peak: number) => {
    const rows = samples.map((sample, i) => {
      const before = samples[Math.max(0, i - 1)].ray, after = samples[Math.min(samples.length - 1, i + 1)].ray;
      const along: Vector3 = [after[0] - before[0], after[1] - before[1], after[2] - before[2]];
      if (Math.hypot(...along) < 1e-12) return null;
      const side = normalized(cross(sample.ray, along)), width = Math.tan(sample.halfWidth);
      return { sample, left: offset(sample.ray, side, -width), right: offset(sample.ray, side, width), alpha: tailOpacity(peak * TAIL_GAIN[kind], sample.at, skyFade) };
    });
    for (let i = 0; i + 1 < rows.length; i++) {
      const a = rows[i], b = rows[i + 1];
      if (!a || !b || (a.alpha <= 0 && b.alpha <= 0)) continue;
      vertex(a.sample.ray, a.left, -1, a.sample.at, a.alpha, kind);
      vertex(a.sample.ray, a.right, 1, a.sample.at, a.alpha, kind);
      vertex(b.sample.ray, b.left, -1, b.sample.at, b.alpha, kind);
      vertex(a.sample.ray, a.right, 1, a.sample.at, a.alpha, kind);
      vertex(b.sample.ray, b.right, 1, b.sample.at, b.alpha, kind);
      vertex(b.sample.ray, b.left, -1, b.sample.at, b.alpha, kind);
    }
  };
  for (const view of views) {
    const peak = tailPeak(view.magnitude);
    ribbon(view.ion, ION, peak);
    ribbon(view.dust, DUST, peak);
    const alpha = headOpacity(view.magnitude, skyFade);
    if (alpha <= 0) continue;
    // Head: a soft disc twice the visual coma radius across its corners.
    const center = view.point.direction;
    const up: Vector3 = Math.abs(center[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1];
    const east = normalized(cross(up, center)), north = normalized(cross(center, east));
    const r = Math.tan(Math.max(view.comaRadius, 1e-4) * (Math.PI / 180)) * 1.4;
    const corner = (x: number, y: number) =>
      vertex(center, normalized([center[0] + (east[0] * x + north[0] * y) * r, center[1] + (east[1] * x + north[1] * y) * r, center[2] + (east[2] * x + north[2] * y) * r]), x, y, alpha, HEAD);
    corner(-1, -1); corner(1, -1); corner(-1, 1);
    corner(1, -1); corner(1, 1); corner(-1, 1);
  }
  return new Float32Array(data);
}

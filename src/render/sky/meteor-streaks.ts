import type { MeteorStreak } from "../../domain/sky/meteor-showers.ts";
import type { ShootingPlan } from "../../domain/core/plan.ts";
import { refractDirection } from "../../domain/core/refraction.ts";

/**
 * Illustrative meteors as screen-space quads between two sky directions, on
 * the far plane like the rest of the sky so terrain hides them. Streaks are
 * already cut to the frame, so both ends lie in front of the camera; a streak
 * with an end behind it (another viewport) is dropped.
 *
 * Without multisampling a thin quad lands on pixel centres by chance, which
 * reads as jagged edges and makes short streaks blink while the view moves.
 * The quad therefore reaches past the line and its caps, and the fragment
 * stage shades by the distance in device pixels. The profile is about a
 * pixel wider than the line, and its opacity is scaled so the brightness
 * summed across the streak stays that of the line (1.3 half widths), so
 * thin streaks turn fainter and wider instead of blinking.
 */
export const meteorVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_ray;layout(location=1) in vec3 a_other;layout(location=2) in vec2 a_shape;
layout(location=3) in vec2 a_along;layout(location=4) in vec2 a_style;
uniform mat4 u_camera;uniform vec2 u_viewport;uniform float u_pixel_ratio;
out vec2 v_px;out float v_len;out float v_half;out vec2 v_range;out float v_alpha;out float v_height;
void main(){vec4 p=u_camera*vec4(a_ray,0.0),q=u_camera*vec4(a_other,0.0);
bool atEnd=a_shape.y>0.5;
v_alpha=a_style.y;v_height=a_ray.z;v_half=a_style.x*u_pixel_ratio;v_range=atEnd?a_along.yx:a_along.xy;
if(p.w<=1e-6||q.w<=1e-6){gl_Position=vec4(0.0,0.0,2.0,1.0);return;}
vec2 a=p.xy/p.w,b=q.xy/q.w,d=(b-a)*u_viewport*0.5;float len=length(d);
vec2 toOther=len>1e-6?d/len:vec2(atEnd?-1.0:1.0,0.0),forward=atEnd?-toOther:toOther,n=vec2(-forward.y,forward.x);
float reach=max(v_half,0.6)+1.5,cap=1.5;
v_len=len;v_px=vec2(a_shape.x*reach,atEnd?len+cap:-cap);
gl_Position=vec4(a+(n*a_shape.x*reach-toOther*cap)*2.0/u_viewport,1.0,1.0);}`;
export const meteorFragment = `#version 300 es
precision highp float;
in vec2 v_px;in float v_len;in float v_half;in vec2 v_range;in float v_alpha;in float v_height;out vec4 color;
void main(){if(v_height<=0.0)discard;
float w=max(v_half,0.6);
float across=1.0-smoothstep(0.3*w,w+1.0,abs(v_px.x));
float caps=smoothstep(-1.0,1.0,v_px.y)*smoothstep(-1.0,1.0,v_len-v_px.y);
float t=mix(v_range.x,v_range.y,clamp(v_px.y/max(v_len,1e-3),0.0,1.0));
float along=smoothstep(0.0,0.6,t)*(1.0-0.6*smoothstep(0.85,1.0,t));
float a=v_alpha*(1.3*v_half)/(1.3*w+1.0)*across*caps*along;if(a<0.004)discard;color=vec4(vec3(0.93,0.97,1.0)*a,a);}`;

/**
 * Floats per vertex: this end (3), other end (3), side and end flag (2),
 * position along the whole streak at this and the other end (2), half width
 * in CSS px and alpha (2).
 */
export const METEOR_STRIDE = 12;
/** Attribute location, component count and byte offset. */
export const METEOR_ATTRIBUTES = [[0, 3, 0], [1, 3, 12], [2, 2, 24], [3, 2, 32], [4, 2, 40]] as const;

export function meteorMesh(streaks: readonly MeteorStreak[], refraction: ShootingPlan["refraction"]) {
  const data = new Float32Array(streaks.length * 6 * METEOR_STRIDE);
  let offset = 0;
  for (const streak of streaks) {
    const start = refractDirection(streak.start, refraction), end = refractDirection(streak.end, refraction);
    const brightness = 2 - streak.magnitude;
    const half = Math.max(0.6, Math.min(1.8, 0.6 + 0.25 * brightness));
    const alpha = Math.max(0.35, Math.min(1, 0.35 + 0.18 * brightness));
    // Sides are measured against the start-to-end direction at both ends.
    const vertex = (atEnd: boolean, side: number) => {
      data.set([
        ...(atEnd ? end : start), ...(atEnd ? start : end), side, atEnd ? 1 : 0,
        streak.along[atEnd ? 1 : 0], streak.along[atEnd ? 0 : 1], half, alpha,
      ], offset);
      offset += METEOR_STRIDE;
    };
    vertex(false, -1); vertex(false, 1); vertex(true, -1);
    vertex(false, 1); vertex(true, 1); vertex(true, -1);
  }
  return data;
}

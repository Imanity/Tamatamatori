// GLSL for the starfield layer (stars, Milky Way band, constellation lines,
// deep-sky textures) and the program compiler.
import { deepSkyRedEnhancementColor } from "../../domain/sky/deep-sky.ts";

export const pointVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_ray;
layout(location=1) in vec2 a_symbol;
layout(location=2) in vec4 a_color;
uniform mat4 u_camera; uniform float u_pixel_ratio;
out vec4 v_color; out float v_kind; out float v_height; out float v_size;
void main(){gl_Position=u_camera*vec4(a_ray,0.0);gl_Position.z=gl_Position.w;
gl_PointSize=a_symbol.x*u_pixel_ratio;v_size=gl_PointSize;v_color=a_color;v_kind=a_symbol.y;v_height=a_ray.z;}`;
// The meteor radiant (kind 2) is a ring with eight half-CSS-pixel spokes,
// shaded by distance in device pixels so they stay steady while the view
// moves; a spoke narrower than a device pixel is drawn one pixel wide and
// correspondingly fainter.
export const pointFragment = `#version 300 es
precision highp float;
in vec4 v_color; in float v_kind; in float v_height; in float v_size; uniform float u_probe; uniform float u_pixel_ratio; out vec4 color;
float band(float distance,float width){return 1.0-smoothstep(width-0.6,width+0.6,distance);}
void main(){if(v_height<=0.0)discard;float d=length(gl_PointCoord-0.5);
float coverage;
if(v_kind>1.5){vec2 c=(gl_PointCoord-0.5)*v_size;float r=length(c),s=v_size,sector=0.78539816;
float angle=atan(c.y,c.x),offset=angle-sector*floor(angle/sector+0.5);
float ring=band(abs(r-0.155*s),max(0.035*s,0.5));
float spokeHalf=max(0.25*u_pixel_ratio,0.5);
float spoke=band(r*abs(sin(offset)),spokeHalf)*0.25*u_pixel_ratio/spokeHalf*smoothstep(0.26*s-0.6,0.26*s+0.6,r)*band(r,0.47*s);
coverage=max(ring,spoke);}
else coverage=v_kind>0.5?(1.0-smoothstep(0.40,0.5,d))*smoothstep(0.26,0.36,d):exp(-d*d*13.0)*(1.0-smoothstep(0.35,0.5,d));
float a=coverage*mix(v_color.a,1.0,u_probe);if(a<0.01)discard;color=vec4(v_color.rgb*a,a);}`;
export const bandVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_ray;layout(location=1) in vec2 a_gal;
uniform mat4 u_camera;out vec2 v_gal;out float v_height;
void main(){gl_Position=u_camera*vec4(a_ray,0.0);gl_Position.z=gl_Position.w;v_gal=a_gal;v_height=a_ray.z;}`;
export const bandFragment = `#version 300 es
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
export const lineVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_ray;uniform mat4 u_camera;out float v_height;
void main(){gl_Position=u_camera*vec4(a_ray,0.0);gl_Position.z=gl_Position.w;v_height=a_ray.z;}`;
export const lineFragment = `#version 300 es
precision highp float;in float v_height;out vec4 color;
void main(){if(v_height<=0.0)discard;float a=0.55;color=vec4(vec3(0.88,0.82,0.62)*a,a);}`;
export const deepVertex = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_ray;layout(location=1) in vec2 a_uv;layout(location=2) in vec3 a_tint;
uniform mat4 u_camera;out vec2 v_uv;out vec3 v_tint;out float v_height;
void main(){gl_Position=u_camera*vec4(a_ray,0.0);gl_Position.z=gl_Position.w;v_uv=a_uv;v_tint=a_tint;v_height=a_ray.z;}`;
export const deepFragment = `#version 300 es
precision highp float;
in vec2 v_uv;in vec3 v_tint;in float v_height;
uniform sampler2D u_atlas;uniform float u_strength;uniform float u_ha_gain;uniform float u_probe;uniform float u_dark;out vec4 color;
void main(){if(v_height<=0.0)discard;vec4 components=texture(u_atlas,v_uv);
float extra=1.0-components.a;
if(u_probe>0.5){if(max(max(components.r,components.g),max(components.b,extra))<0.008)discard;color=vec4(1.0);return;}
float dark=u_dark>0.5?extra:0.0;
if(u_dark>0.5)extra=max(components.r-(components.g+components.b)*0.5,0.0)*0.6;
vec3 signal=components.rgb*v_tint+extra*u_ha_gain*vec3(${deepSkyRedEnhancementColor.map(c => c.toFixed(2)).join(",")});
float peak=max(signal.r,max(signal.g,signal.b));
float a=(1.0-exp(-2.1*peak))*u_strength*smoothstep(0.0,0.04,v_height);
float opacity=a+(1.0-a)*dark*u_strength*smoothstep(0.0,0.04,v_height);
if(opacity<0.0005)discard;color=vec4(signal/max(peak,0.0001)*a,opacity);}`;
export function program(gl: WebGL2RenderingContext, vertex: string, fragment: string) {
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

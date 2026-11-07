import { CLOUD_HORIZON_HEIGHT, CLOUD_LAYERS } from "../domain/weather-appearance.ts";

export const weatherVertex = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
uniform vec3 u_forward; uniform vec3 u_right; uniform vec3 u_up;
out vec3 v_ray;
void main(){gl_Position=vec4(a_pos,1.0,1.0);v_ray=u_forward+a_pos.x*u_right+a_pos.y*u_up;}`;

export const weatherFragment = `#version 300 es
precision highp float;
precision highp int;
in vec3 v_ray;
uniform vec3 u_layers; uniform vec2 u_drift; uniform vec3 u_color;
uniform vec2 u_precipitation; uniform float u_mode; uniform float u_time; uniform float u_slant;
out vec4 color;
float hash(ivec2 p,uint seed){uint h=uint(p.x)*374761393u^uint(p.y)*668265263u^seed;
h=(h^(h>>13))*1274126177u;return float(h^(h>>16))/4294967295.0;}
float noise(vec2 p,uint seed){ivec2 i=ivec2(floor(p));vec2 f=fract(p);f=f*f*(3.0-2.0*f);
return mix(mix(hash(i,seed),hash(i+ivec2(1,0),seed),f.x),mix(hash(i+ivec2(0,1),seed),hash(i+ivec2(1,1),seed),f.x),f.y);}
const vec4 layerGeometry[3]=vec4[3](${CLOUD_LAYERS.map(layer => `vec4(${[layer.height, layer.size, ...layer.stretch].map(value => value.toFixed(8)).join(",")})`).join(",")});
const vec3 layerOptics[3]=vec3[3](${CLOUD_LAYERS.map(layer => `vec3(${[layer.fine, layer.edge, layer.opacity].map(value => value.toFixed(8)).join(",")})`).join(",")});
const vec3 layerTint[3]=vec3[3](${CLOUD_LAYERS.map(layer => `vec3(${layer.tint.map(value => value.toFixed(8)).join(",")})`).join(",")});
void main(){
if(u_mode>0.5){
  vec2 rainPosition=gl_FragCoord.xy+vec2(-u_slant*260.0,260.0)*u_time;
  vec2 snowPosition=gl_FragCoord.xy+vec2(-u_slant*65.0,42.0)*u_time;
  snowPosition.x+=sin(snowPosition.y*0.012+u_time*0.8)*5.0;
  vec2 rainGrid=rainPosition/vec2(19.0,31.0),snowGrid=snowPosition/67.5;
  vec2 f=fract(rainGrid),s=fract(snowGrid);
  float rainShape=(1.0-smoothstep(0.015,0.045,abs(f.x-0.5-f.y*u_slant)))*smoothstep(0.1,0.25,f.y)*(1.0-smoothstep(0.65,0.9,f.y));
  float rain=step(1.0-clamp(u_precipitation.x/7.0,0.0,0.75),hash(ivec2(floor(rainGrid)),71u))*rainShape*min(1.0,u_precipitation.x);
  float snow=step(1.0-clamp(u_precipitation.y*0.4,0.0,0.75),hash(ivec2(floor(snowGrid)),73u))*(1.0-smoothstep(0.025,0.075,length(s-0.5)))*min(1.0,u_precipitation.y*10.0);
  float a=(1.0-(1.0-rain)*(1.0-snow))*0.32;color=vec4(vec3(0.78,0.85,0.91)*a,a);return;
}
vec3 ray=normalize(v_ray);
float height=max(0.0,ray.z),horizon=${CLOUD_HORIZON_HEIGHT.toFixed(8)};
float detail=smoothstep(0.0,horizon,height);
vec4 composite=vec4(0.0);
for(int k=2;k>=0;k--){
  vec4 geometry=layerGeometry[k];vec3 optics=layerOptics[k];
  float distance=2.0*geometry.x/(height+sqrt(height*height+2.0*geometry.x/6371.0));
  vec2 p=(ray.xy*distance/geometry.y+u_drift+vec2(float(k)*19.0,float(k)*31.0))*geometry.zw;
  float cover=u_layers[k];
  float value=noise(p,uint(k+1))*(1.0-optics.x)+noise(p*2.1,uint(k+11))*optics.x;
  float pattern=cover<=0.0?0.0:cover>=1.0?1.0:smoothstep(1.0-cover-optics.y,1.0-cover+optics.y,value);
  float amount=mix(cover,pattern,detail);
  float alpha=amount*optics.z;
  vec3 tint=u_color*layerTint[k]*(0.88+0.12*mix(0.5,value,detail));
  composite=vec4(tint*alpha,alpha)+composite*(1.0-alpha);
}
color=composite;
}`;

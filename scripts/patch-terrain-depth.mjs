import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const root=dirname(require.resolve("maplibre-gl/package.json"));
if(JSON.parse(readFileSync(join(root,"package.json"),"utf8")).version!=="6.16.0")throw new Error("摄影地形深度需要重新验证 SDK");
const marker="TAMATAMATORI_TERRAIN_DEPTH_V1";
const prefix=`// ${marker}\n${readFileSync(new URL("../src/preview/terrain-depth.glsl",import.meta.url),"utf8")}\n`;
const paths=["src/shaders/glsl/terrain.fragment.glsl","src/shaders/glsl/terrain.fragment.glsl.g.ts","dist/maplibre-gl.mjs"];
const contents=paths.map(path=>readFileSync(join(root,path),"utf8").replaceAll("\r\n","\n"));
const once=(text,before,after)=>{if(text.split(before).length!==2)throw new Error("摄影地形深度补丁签名不匹配");return text.replace(before,after);};
const withFog = body => {
  const assignment = "float photo_fog_depth=photoFogDepth(v_fog_depth);";
  if (body.split(assignment).length === 2) return body;
  const offset = body.indexOf("void main() {");
  const main = body.slice(offset);
  if (offset < 0 || main.split("v_fog_depth").length !== 4) throw new Error("摄影地形雾坐标片元签名不匹配");
  return body.slice(0,offset) + once(main.replaceAll("v_fog_depth","photo_fog_depth"),"void main() {","void main() {"+assignment);
};
if(contents.every(text=>text.includes(marker))){
  const oldShader=JSON.parse(contents[1].slice(contents[1].indexOf("export default ")+15).trim().replace(/;$/,""));
  const offset=oldShader.indexOf("uniform sampler2D u_texture;"),rawOffset=contents[0].indexOf("uniform sampler2D u_texture;");
  if(offset<0||rawOffset<0||contents[2].split(JSON.stringify(oldShader)).length!==2)throw new Error("摄影地形深度已安装签名不匹配");
  const shader=prefix+withFog(oldShader.slice(offset));
  if(shader!==oldShader){
    const esm=once(contents[2],JSON.stringify(oldShader),JSON.stringify(shader));
    writeFileSync(join(root,paths[0]),prefix+withFog(contents[0].slice(rawOffset)));
    writeFileSync(join(root,paths[1]),`// ${marker}\nexport default ${JSON.stringify(shader)};\n`);
    writeFileSync(join(root,paths[2]),esm);
  }
  console.log("MapLibre：摄影地形对数深度已安装");
}else{
  if(contents.some(text=>text.includes(marker)))throw new Error("摄影地形深度补丁不完整");
  const original=contents[1].match(/export default '([^\n]*)';/)[1];
  const shader=prefix+withFog(once(original,"void main() {","void main() {gl_FragDepth=u_photo_enabled>0.5?photoFragmentDepth(v_photo_depth):gl_FragCoord.z;"));
  const raw=prefix+withFog(once(contents[0],"void main() {","void main() {\n    gl_FragDepth = u_photo_enabled > 0.5 ? photoFragmentDepth(v_photo_depth) : gl_FragCoord.z;"));
  const esm=once(contents[2],`\`${original}\``,JSON.stringify(shader));
  [raw,`// ${marker}\nexport default ${JSON.stringify(shader)};\n`,esm].forEach((text,i)=>writeFileSync(join(root,paths[i]),text));
  console.log("MapLibre：已安装摄影地形对数深度");
}

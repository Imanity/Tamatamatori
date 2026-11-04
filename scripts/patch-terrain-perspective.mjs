import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("maplibre-gl/package.json"));
if (JSON.parse(readFileSync(join(root,"package.json"),"utf8")).version !== "6.16.0")
  throw new Error("摄影地形桥接需要重新验证 MapLibre 版本");
const marker = "TAMATAMATORI_TERRAIN_ENU_V1";
const hook = "tamatamatori.terrain-enu.v1";
const glsl = `// ${marker}\n${readFileSync(new URL("../src/preview/terrain-projection.glsl",import.meta.url),"utf8")}\n`;
const files = ["src/shaders/glsl/terrain.vertex.glsl","src/shaders/glsl/terrain.vertex.glsl.g.ts","src/webgl/draw/draw_terrain.ts","dist/maplibre-gl.mjs"];
const contents = files.map(file => readFileSync(join(root,file),"utf8").replaceAll("\r\n","\n"));
const sourceDepth = "const depthMode = frameRenderContext.getDepthModeFor3D();";
const fixedSourceDepth = `const depthMode = (gl as any)[Symbol.for('${hook}')] ? {...frameRenderContext.getDepthModeFor3D(), range: [0, 1] as [number, number]} : frameRenderContext.getDepthModeFor3D();`;
const esmDepth = "l=r.getDepthModeFor3D(),u=r.useProgram(`terrain`)";
const fixedEsmDepth = `l=o[Symbol.for('${hook}')]?{...r.getDepthModeFor3D(),range:[0,1]}:r.getDepthModeFor3D(),u=r.useProgram(\`terrain\`)`;
if (contents.every(text => text.includes(marker))) {
  const oldShader = JSON.parse(contents[1].slice(contents[1].indexOf("export default ")+15).trim().replace(/;$/,""));
  const offset = oldShader.indexOf("layout(location=0)");
  if (offset < 0 || contents[3].split(JSON.stringify(oldShader)).length !== 2)
    throw new Error("摄影地形已安装补丁的签名不匹配");
  const shader = glsl + oldShader.slice(offset);
  let draw = contents[2], esm = contents[3];
  if(draw.includes(sourceDepth))draw=draw.replace(sourceDepth,fixedSourceDepth);
  else if(!draw.includes(fixedSourceDepth))throw new Error("摄影地形深度桥接源码不匹配");
  if(esm.includes(esmDepth))esm=esm.replace(esmDepth,fixedEsmDepth);
  else if(!esm.includes(fixedEsmDepth))throw new Error("摄影地形深度桥接 ESM 不匹配");
  esm=esm.replace(JSON.stringify(oldShader),JSON.stringify(shader));
  if (shader !== oldShader) {
    const rawOffset = contents[0].indexOf("layout(location = 0)");
    if(rawOffset<0)throw new Error("摄影地形源着色器签名不匹配");
    writeFileSync(join(root,files[0]),glsl+contents[0].slice(rawOffset));
    writeFileSync(join(root,files[1]),`// ${marker}: generated for the fixed SDK.\nexport default ${JSON.stringify(shader)};\n`);
  }
  if(draw!==contents[2])writeFileSync(join(root,files[2]),draw);
  if(esm!==contents[3])writeFileSync(join(root,files[3]),esm);
  console.log("MapLibre：摄影地形 ENU 桥接已安装");
} else {
  if (contents.some(text => text.includes(marker))) throw new Error("摄影地形补丁不完整，请重新安装依赖");
  const once = (text,before,after,file) => {
    if (text.split(before).length !== 2) throw new Error(`摄影地形补丁签名不匹配：${file}`);
    return text.replace(before,after);
  };
  const original = contents[1].match(/export default '([^\n]*)';/)[1];
  const projected = once(original,"gl_Position=projectTileFor3D(a_pos3d.xy,ele-ele_delta);",
    "gl_Position=u_photo_enabled>0.5?photoProject(a_pos3d.xy,ele-ele_delta):projectTileFor3D(a_pos3d.xy,ele-ele_delta);",files[1]);
  const shader = glsl + projected;
  const raw = glsl + once(contents[0],"gl_Position = projectTileFor3D(a_pos3d.xy, ele - ele_delta);",
    "gl_Position = u_photo_enabled > 0.5 ? photoProject(a_pos3d.xy, ele - ele_delta) : projectTileFor3D(a_pos3d.xy, ele - ele_delta);",files[0]);
  const sourceAnchor = "        const projectionData = frameRenderContext.getProjectionDataForTile(tile.tileID, {applyTerrainMatrix: false});\n";
  const sourceHook = `        // ${marker}: application-owned, per-context bridge; no SDK runtime fields exposed.\n` +
    `        context.program.set(program.program);\n        const photoHook = (gl as any)[Symbol.for('${hook}')];\n` +
    `        if (photoHook) photoHook(gl, program.program, tile.tileID.canonical, tile.tileID.wrap);\n` +
    `        else gl.uniform1f(gl.getUniformLocation(program.program, 'u_photo_enabled'), 0);\n`;
  const draw = once(once(contents[2],sourceAnchor,sourceAnchor+sourceHook,files[2]),sourceDepth,fixedSourceDepth,files[2]);
  let esm = once(contents[3],`\`${original}\``,JSON.stringify(shader),files[3]);
  const esmAnchor = "u.draw(a,o.TRIANGLES,l,kM.disabled,c,MM.backCCW,g,p,_,`terrain`,n.vertexBuffer,n.indexBuffer,n.segments)";
  const esmHook = `a.program.set(u.program);const photoHook=o[Symbol.for('${hook}')];if(photoHook)photoHook(o,u.program,d.tileID.canonical,d.tileID.wrap);else o.uniform1f(o.getUniformLocation(u.program,'u_photo_enabled'),0);`;
  esm = once(esm,esmAnchor,esmHook+esmAnchor,files[3]);
  esm = once(esm,esmDepth,fixedEsmDepth,files[3]);
  const outputs = [raw,`// ${marker}: generated for the fixed SDK.\nexport default ${JSON.stringify(shader)};\n`,draw,esm.replace(/\/\/# sourceMappingURL=.*$/m,"")];
  // Validate all signatures first; a failed match never leaves a partial patch.
  outputs.forEach((text,i)=>writeFileSync(join(root,files[i]),text));
  console.log("MapLibre：已安装摄影地形 ENU 桥接（源码与 ESM）");
}

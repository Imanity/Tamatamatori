import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { MercatorCoordinate } from "maplibre-gl";
import { terrainCamera, terrainRenderOptions } from "../../src/preview/camera.ts";
import { signedAngle } from "../../src/domain/plan.ts";
import { terrainScenes } from "../fixtures/terrain-scenes.mjs";
import { projectDirection } from "../../src/domain/celestial-projection.ts";
import { direction } from "../../src/domain/ephemeris.ts";
import { compareEarthModels, matrixPixel, mercatorXY, mercatorMeter, referencePixel, referenceRay, rayAngles } from "../../src/preview/calibration-math.ts";
import { ellipsoidalRay, geodeticEcef } from "../../src/domain/geodesy.ts";
import { matrixEye } from "../../src/preview/rendered-camera.ts";
import { terrainTileZoom, TERRAIN_MAX_MESH_ZOOM, LANDMARK_TERRAIN_RANGE, terrainCoverageRange } from "../../src/preview/terrain-detail.ts";
import { skytree } from "../../src/domain/landmarks.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { TERRAIN_VISUAL_TILE_SIZE } from "../../src/domain/terrain.ts";
import { readFileSync } from "node:fs";
import { photoCameraMatrix, photoFragmentDepth, photoFogDepth, photoTileFrame, photoTileRay } from "../../src/preview/terrain-perspective-math.ts";

// Exercise the installed SDK's real CPU camera/transform, not the interaction
// test double. No browser, GL context, image decoder or real DEM is simulated.
let server, Camera, coveringTiles, TerrainTileManager, TerrainPerspective;
before(async () => {
  server = await createServer({
    configFile: false,
    cacheDir: "node_modules/.vite-camera-validation",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
    appType: "custom",
    ssr: { noExternal: ["maplibre-gl", "@maplibre/mlt"] },
    // Match the SDK build's assignment semantics: its derived event classes
    // narrow `type` without initializing it. Emitting an undefined field would
    // erase the parent constructor's event type and break moveend cleanup.
    oxc: {
      assumptions: { setPublicClassFields: true },
      typescript: { removeClassFieldsWithoutInitializer: true },
    },
  });
  ({ Camera } = await server.ssrLoadModule("/node_modules/maplibre-gl/src/ui/camera.ts"));
  ({ coveringTiles } = await server.ssrLoadModule("/node_modules/maplibre-gl/src/geo/projection/covering_tiles.ts"));
  ({ TerrainTileManager } = await server.ssrLoadModule("/node_modules/maplibre-gl/src/tile/terrain_tile_manager.ts"));
  ({ TerrainPerspective } = await server.ssrLoadModule("/src/preview/terrain-perspective.ts"));
});
after(async () => { await server?.close(); });

function close(actual, expected, tolerance, message) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} vs ${expected} (tolerance ${tolerance})`);
}

function flatTerrain(height) {
  return {
    exaggeration: 1,
    getCoverageIndex: () => null,
    getMinMaxElevation: () => ({ minElevation: 0, maxElevation: 4000 }),
    getMinTileElevationForLngLatZoom: () => height,
    getElevationForLngLat: () => height,
    getElevationAndDEMStateForLngLat: () => ({ elevation: height, demState: "loaded" }),
  };
}

function createCamera(width, height, ground) {
  const camera = new Camera({
    minZoom: 0, maxZoom: terrainRenderOptions.maxZoom, minPitch: 0, maxPitch: 180,
    bearingSnap: 0, zoomSnap: 0, terrain: null,
    centerClampedToGround: false, transformConstrain: null,
    requestRenderFrame: () => 0, cancelRenderFrame: () => {},
    transformCameraUpdate: null,
  });
  camera.transform.resize(width, height, true);
  camera.setTerrain(flatTerrain(ground));
  return camera;
}

function apply(camera, plan, ground) {
  const pose = terrainCamera(plan, ground);
  camera.setVerticalFieldOfView(pose.verticalFov);
  const options = camera.transform.calculateCameraOptionsFromTo(
    pose.eye, pose.altitude, pose.target, pose.targetAltitude,
  );
  camera.jumpTo({ ...options, bearing: pose.bearing, pitch: pose.pitch, roll: 0 });
  assert.equal(camera._requestedCameraState, undefined, "SDK moveend must release the proposed transform");
  return pose;
}

function assertEye(camera, plan, ground) {
  const requested = MercatorCoordinate.fromLngLat([plan.longitude, plan.latitude], ground + plan.cameraHeight);
  const actual = MercatorCoordinate.fromLngLat(camera.transform.getCameraLngLat(), camera.transform.getCameraAltitude());
  const meters = requested.meterInMercatorCoordinateUnits();
  close(Math.hypot(actual.x - requested.x, actual.y - requested.y) / meters, 0, 0.02, "final eye ground position / m");
  close(camera.transform.getCameraAltitude(), ground + plan.cameraHeight, 0.02, `final eye altitude / m (${plan.azimuth}/${plan.pitch}/${plan.focalLength}/${plan.orientation})`);
  close(signedAngle(camera.getBearing() - plan.azimuth), 0, 1e-6, "final bearing / degree");
  close(camera.getPitch(), 90 + plan.pitch, 1e-6, "final pitch / degree");
}

// Independent pinhole baseline: build a ray from full-frame sensor dimensions,
// focal length and ENU basis. The point must project to the requested pixel.
function rayPoint(plan, ground, nx, ny, distance = 1000) {
  const heading = plan.azimuth * Math.PI / 180, pitch = plan.pitch * Math.PI / 180;
  const sensorWidth = plan.orientation === "portrait" ? 24 : 36;
  const sensorHeight = plan.orientation === "portrait" ? 36 : 24;
  const right = nx * sensorWidth / (2 * plan.focalLength);
  const up = -ny * sensorHeight / (2 * plan.focalLength);
  const east = Math.sin(heading) * Math.cos(pitch) + right * Math.cos(heading) - up * Math.sin(heading) * Math.sin(pitch);
  const north = Math.cos(heading) * Math.cos(pitch) - right * Math.sin(heading) - up * Math.cos(heading) * Math.sin(pitch);
  const vertical = Math.sin(pitch) + up * Math.cos(pitch);
  const eye = MercatorCoordinate.fromLngLat([plan.longitude, plan.latitude], ground + plan.cameraHeight);
  const scale = distance * eye.meterInMercatorCoordinateUnits();
  const point = new MercatorCoordinate(eye.x + east * scale, eye.y - north * scale);
  // MapLibre's planar terrain matrix scales elevations in meters at the
  // center latitude; keep the independent ray in that local vertical system.
  return { point: point.toLngLat(), altitude: ground + plan.cameraHeight + distance * vertical };
}

for (const scene of terrainScenes) {
  test(`真实 SDK 相机校准：${scene.name}，广角至长焦与横竖幅`, () => {
    for (const focalLength of [8, 35, 200, 1000])
      for (const orientation of ["landscape", "portrait"])
        for (const cameraHeight of [0.1, 1.6, 10]) {
          const plan = { ...scene.plan, focalLength, orientation, cameraHeight };
          const [width, height] = orientation === "portrait" ? [400, 600] : [600, 400];
          const camera = createCamera(width, height, scene.syntheticGround);
          apply(camera, plan, scene.syntheticGround);
          assertEye(camera, plan, scene.syntheticGround);
          for (const [nx, ny] of [[0, 0], [-0.6, -0.5], [0.6, 0.5]]) {
            const reference = rayPoint(plan, scene.syntheticGround, nx, ny);
            const pixel = camera.transform.locationToScreenPoint(reference.point, flatTerrain(reference.altitude));
            close(pixel.x, width * (1 + nx) / 2, 0.1, "pinhole projection x / CSS px");
            close(pixel.y, height * (1 + ny) / 2, 0.1, "pinhole projection y / CSS px");
          }
        }
  });
}

test("真实 SDK 在尺寸调整、旋转和向上/下观察后仍保持机位", () => {
  const { plan, syntheticGround } = terrainScenes[0];
  const camera = createCamera(600, 400, syntheticGround);
  for (const [width, height] of [[600, 400], [960, 640], [300, 450]])
    for (const pitch of [-90, -45, 0, 35, 90])
      for (const azimuth of [0, 90, 247, 359.9]) {
        const next = { ...plan, pitch, azimuth, orientation: width < height ? "portrait" : "landscape" };
        camera.transform.resize(width, height, true);
        apply(camera, next, syntheticGround);
        assertEye(camera, next, syntheticGround);
        const reference = rayPoint(next, syntheticGround, 0.6, -0.5);
        const pixel = camera.transform.locationToScreenPoint(reference.point, flatTerrain(reference.altitude));
        close(pixel.x, width * 0.8, 0.1, "resized projection x / CSS px");
        close(pixel.y, height * 0.25, 0.1, "resized projection y / CSS px");
      }
});

test("真实 SDK 水平与长焦视角的瓦片覆盖保持有效", () => {
  const { plan, syntheticGround } = terrainScenes[0];
  for (const focalLength of [8, 35, 200, 1000])
    for (const pitch of [-4, 0, 4]) {
      const next = { ...plan, focalLength, pitch };
      const camera = createCamera(1205, 803, syntheticGround);
      apply(camera, next, syntheticGround);
      // Match the installed TileManager's vector-source coverage policy. The
      // real coverage traversal constructs the same canonical IDs as rendering.
      const sourceMaxZoom = 14;
      const maxzoom = terrainRenderOptions.zoomLevelsToOverscale === undefined
        ? sourceMaxZoom
        : Math.max(sourceMaxZoom, camera.transform.maxZoom - terrainRenderOptions.zoomLevelsToOverscale);
      const tiles = coveringTiles(camera.transform, {
        minzoom: 0, maxzoom, tileSize: 512, reparseOverscaled: true,
        terrain: flatTerrain(syntheticGround),
      });
      assert.ok(tiles.length > 0);
      assert.ok(tiles.every((tile) => tile.canonical.z <= sourceMaxZoom));
      assertEye(camera, next, syntheticGround);
    }
});

test("日月方向投影与真实 SDK 相机在广角、长焦、竖幅及天顶一致", () => {
  const { plan, syntheticGround } = terrainScenes[0];
  let probes = 0;
  for (const focalLength of [8, 35, 200, 1000])
    for (const orientation of ["landscape", "portrait"])
      for (const pitch of [0, 35, 90])
        for (const azimuth of [0, 247, 359.8]) {
          const next = { ...plan, focalLength, orientation, pitch, azimuth };
          const [width, height] = orientation === "portrait" ? [400, 600] : [600, 400];
          const camera = createCamera(width, height, syntheticGround);
          apply(camera, next, syntheticGround);
          const eye = MercatorCoordinate.fromLngLat([next.longitude, next.latitude], syntheticGround + next.cameraHeight);
          for (const ray of [direction(azimuth, pitch), direction(azimuth + 0.2, Math.min(89.9, pitch + 0.2)), direction(0, 20), direction(247, 4)]) {
            const projected = projectDirection(next, ray);
            if (!projected || Math.max(Math.abs(projected.x), Math.abs(projected.y)) > 3) continue;
            const distance = 1000, scale = distance * eye.meterInMercatorCoordinateUnits();
            const point = new MercatorCoordinate(eye.x + ray[0] * scale, eye.y - ray[1] * scale).toLngLat();
            const pixel = camera.transform.locationToScreenPoint(point, flatTerrain(syntheticGround + next.cameraHeight + ray[2] * distance));
            close(pixel.x, (projected.x + 1) * width / 2, 0.1, "celestial x / CSS px");
            close(pixel.y, (projected.y + 1) * height / 2, 0.1, "celestial y / CSS px");
            probes++;
          }
        }
  assert.ok(probes >= 144);
});

test("公开绘制矩阵反算眼点，并与独立山峰投影及 SDK 投影一致", () => {
  const scene = terrainScenes[0];
  for (const focalLength of [8, 35, 200, 1000])
    for (const cameraHeight of [0.1, 1.6, 10])
      for (const orientation of ["landscape", "portrait"]) {
        const plan = { ...scene.plan, focalLength, cameraHeight, orientation, pitch: 10 };
        const [width, height] = orientation === "portrait" ? [400, 600] : [600, 400];
        const camera = createCamera(width, height, scene.syntheticGround);
        apply(camera, plan, scene.syntheticGround);
        // Exactly the matrix supplied through CustomRenderMethodInput.
        const matrix = camera.transform.modelViewProjectionMatrix, worldSize = 512 * 2 ** camera.getZoom();
        const actual = matrixEye(matrix), xy = mercatorXY(plan), scale = mercatorMeter(plan.latitude);
        close(Math.hypot(actual.x / worldSize - xy[0], actual.y / worldSize - xy[1]) / scale, 0, 0.02, "matrix eye horizontal / m");
        close(actual.altitude, scene.syntheticGround + cameraHeight, 0.02, "matrix eye altitude / m");
        const a = matrixPixel(matrix, scene.target, worldSize, width, height);
        const b = referencePixel(plan, scene.syntheticGround, scene.target, width, height, false, camera.getCenter().lat);
        const location = MercatorCoordinate.fromLngLat([scene.target.longitude, scene.target.latitude]).toLngLat();
        const c = camera.transform.locationToScreenPoint(location, flatTerrain(scene.target.altitude));
        for (const axis of ["x", "y"]) {
          close(a[axis], b[axis], 0.1, `independent peak ${axis} / CSS px`);
          close(a[axis], c[axis], 0.1, `SDK peak ${axis} / CSS px`);
        }
      }
  assert.throws(() => matrixEye(new Float64Array(16)));
});

test("平面与球面对照分离曲率影响，并正确处理日期变更线", () => {
  const eye = { latitude: 0, longitude: 0, altitude: 0 };
  const target = { latitude: 0, longitude: 1, altitude: 0 };
  const planar = rayAngles(referenceRay(eye, target));
  const spherical = rayAngles(referenceRay(eye, target, true));
  close(planar.pitch, 0, 1e-9, "flat ground horizon");
  close(spherical.pitch, -0.5, 1e-9, "sphere chord depression");
  close(spherical.azimuth, 90, 1e-9, "east");
  const across = referenceRay({ ...eye, longitude: 179.9 }, { ...target, longitude: -179.9 });
  close(Math.hypot(...across), 22239.0160467, 0.001, "nearest antimeridian world copy / m");
});

const geodeticFixtures = JSON.parse(readFileSync(new URL("../fixtures/geodetic-reference.json", import.meta.url), "utf8"));

test("地形顶点稳定局部计算与独立 ECEF/ENU 样本一致，跨世界副本不偏移", () => {
  for(const fixture of geodeticFixtures.cases) for(const z of [4,9,12,14]) {
    const p=mercatorXY(fixture.target),n=2**z,tile={z,x:Math.floor(p[0]*n),y:Math.floor(p[1]*n)};
    const position=[(p[0]*n-tile.x)*8192,(p[1]*n-tile.y)*8192];
    for(const wrap of [-1,0,1]) {
      const ray=photoTileRay(photoTileFrame(fixture.eye,tile,wrap),position,fixture.target.ellipsoidalHeight);
      for(let i=0;i<3;i++)close(ray[i],fixture.enu[i],2e-6,`${fixture.name} z${z} wrap${wrap} ENU ${i}`);
    }
  }
  const tile={z:14,x:16383,y:8192},p=[8000,100];
  const base=photoTileRay(photoTileFrame({latitude:0,longitude:-179.99999999,ellipsoidalHeight:2},tile),p,0);
  const wrapped=photoTileRay(photoTileFrame({latitude:0,longitude:180.00000001,ellipsoidalHeight:2},tile),p,0);
  for(let i=0;i<3;i++)close(base[i],wrapped[i],1e-7,'actual camera near antimeridian');
});

test("实际地形相机矩阵与日月针孔投影在镜头、画幅和上下观察中一致", () => {
  for(const focalLength of [8,35,200,1000]) for(const orientation of ['landscape','portrait'])
    for(const pitch of [-45,0,10,90]) for(const sensor of ['full-frame','aps-c','micro-four-thirds']) {
      const plan={...terrainScenes[0].plan,focalLength,orientation,pitch,sensor};
      const matrix=photoCameraMatrix(plan);
      for(const ray of [direction(plan.azimuth,pitch),direction(plan.azimuth+0.2,Math.min(90,pitch+0.2))]) {
        const expected=projectDirection(plan,ray),v=[...ray.map(x=>x*15000),1];
        const clip=[0,1,2,3].map(r=>v.reduce((s,x,c)=>s+x*matrix[c*4+r],0));
        close(clip[0]/clip[3],expected.x,1e-4,'terrain/sky clip x');
        close(-clip[1]/clip[3],expected.y,1e-4,'terrain/sky clip y');
        assert.ok(clip[2]/clip[3]<1,'finite terrain is before celestial background');
      }
    }
});

test("远山对数深度在近裁剪很小时仍能区分相距一米的表面，天空保留在最远处",()=>{
  assert.equal(Math.fround(1-0.025/15000),Math.fround(1-0.025/15001),'ordinary low-near depth loses the metre');
  for(const distance of [0.005,1,100,15000,100000,200000]){
    const a=Math.fround(photoFragmentDepth(distance)),b=Math.fround(photoFragmentDepth(distance+1));
    assert.ok(a<b&&b<1,`logarithmic range at ${distance} m`);
  }
});

test("跨近裁剪面的面片在片元阶段计算雾深度，不把相机后顶点的雾混入近景",()=>{
  // Fog uses a different near distance from geometry. Clip an edge from behind
  // the eye to 10 m in front at the photographic near plane (0.4 m).
  const fogNear=100,fogFar=10000,near=0.4;
  const clip = w => [(fogFar+fogNear)/(fogFar-fogNear)*w-2*fogFar*fogNear/(fogFar-fogNear),w];
  const a=clip(-1),b=clip(10),t=(near-a[1])/(b[1]-a[1]);
  const lerp = (a,b,t) => a+(b-a)*t;
  const clipped=a.map((v,i)=>lerp(v,b[i],t));
  const legacyVertex=p=>p[0]/p[1]*0.5+0.5;
  const contaminated=lerp(legacyVertex(a),legacyVertex(b),t);
  assert.ok(contaminated>80,'legacy division before clipping produces unbounded fog');
  for(const weight of [0,0.1,0.5,0.9,1]){
    const divisor=(1-weight)/clipped[1]+weight/b[1];
    const fragment=clipped.map((v,i)=>((1-weight)*v/clipped[1]+weight*b[i]/b[1])/divisor);
    const expected=clip(1/divisor);
    for(let i=0;i<2;i++)close(fragment[i],expected[i],1e-10,'homogeneous interpolation');
    assert.equal(photoFogDepth(...fragment),0,'near surface must keep its colour');
  }
  for(const distance of [0.005,1,100,500,10000,100000,1e7]) {
    const depth=photoFogDepth(...clip(distance));
    assert.ok(Number.isFinite(depth)&&depth>=0&&depth<=1,'blend weight stays bounded');
    if(distance>=fogNear&&distance<=fogFar)close(depth,legacyVertex(clip(distance)),1e-12,'fog range preserved');
  }
  assert.equal(photoFogDepth(1,0),0);assert.equal(photoFogDepth(1,-1),0);
});

test("摄影地形桥接按上下文安装、使用公开眼点并完整卸载，缺补丁明确失败", () => {
  const scene=terrainScenes[0],camera=createCamera(600,400,scene.syntheticGround);
  apply(camera,scene.plan,scene.syntheticGround);
  const map={getZoom:()=>camera.getZoom(),getBearing:()=>camera.getBearing(),getPitch:()=>camera.getPitch(),areTilesLoaded:()=>true};
  const calls=[],errors=[],gl={CURRENT_PROGRAM:1,getParameter:()=>null,useProgram:p=>calls.push(['program',p]),
    getUniformLocation:(_p,name)=>name,uniform1f:(u,v)=>calls.push([u,v]),uniform3fv(){},uniform4fv(){},uniformMatrix3fv(){},uniformMatrix4fv(){}};
  const bridgeKey=Symbol.for('tamatamatori.terrain-enu.v1'),layer=new TerrainPerspective(e=>errors.push(e));
  layer.onAdd(map,gl);layer.setView(scene.plan);layer.prerender(gl,{modelViewProjectionMatrix:camera.transform.modelViewProjectionMatrix});
  assert.equal(typeof gl[bridgeKey],'function');assert.equal({}[bridgeKey],undefined,'unrelated map context has no bridge');
  assert.throws(()=>new TerrainPerspective(()=>{}).onAdd(map,gl));
  gl[bridgeKey](gl,{}, {z:14,x:14510,y:6465},0);layer.render();
  assert.deepEqual(errors,[]);assert.ok(calls.some(([u,v])=>u==='u_photo_enabled'&&v===1));
  layer.onRemove();assert.equal(gl[bridgeKey],undefined);assert.ok(calls.some(([u,v])=>u==='u_photo_enabled'&&v===0));
  const missing=new TerrainPerspective(e=>errors.push(e));missing.onAdd(map,gl);missing.setView(scene.plan);
  missing.prerender(gl,{modelViewProjectionMatrix:camera.transform.modelViewProjectionMatrix});missing.render();
  assert.match(errors[0],/缺少地形坐标桥接/);missing.onRemove();
  const skyErrors=[],skyPlan={...scene.plan,pitch:90},sky=new TerrainPerspective(e=>skyErrors.push(e));
  apply(camera,skyPlan,scene.syntheticGround);sky.onAdd(map,gl);sky.setView(skyPlan);
  sky.prerender(gl,{modelViewProjectionMatrix:camera.transform.modelViewProjectionMatrix});sky.render();
  assert.deepEqual(skyErrors,[],'cold all-sky frame needs no terrain draw');sky.onRemove();
});

test("实际地形源码、生成着色器与 ESM 均安装同版本 ENU 桥接", () => {
  for(const file of ['src/shaders/glsl/terrain.vertex.glsl','src/shaders/glsl/terrain.vertex.glsl.g.ts','src/webgl/draw/draw_terrain.ts','dist/maplibre-gl.mjs']) {
    const text=readFileSync(new URL(`../../node_modules/maplibre-gl/${file}`,import.meta.url),'utf8');
    assert.ok(text.includes('TAMATAMATORI_TERRAIN_ENU_V1'),file);
    assert.ok(text.includes(file.includes('draw_terrain')?'tamatamatori.terrain-enu.v1':'photoProject'),file);
  }
  for(const stage of ['vertex','fragment']){
    const source=readFileSync(new URL(`../../node_modules/maplibre-gl/src/shaders/glsl/terrain.${stage}.glsl`,import.meta.url),'utf8');
    assert.match(source,/uniform highp float u_photo_enabled;/,`${stage} uniform precision must match`);
    assert.match(source,new RegExp(`${stage==='vertex'?'out':'in'} highp float v_photo_depth;`));
    assert.match(source,new RegExp(`${stage==='vertex'?'out':'in'} highp vec2 v_photo_fog;`));
    const generated=readFileSync(new URL(`../../node_modules/maplibre-gl/src/shaders/glsl/terrain.${stage}.glsl.g.ts`,import.meta.url),'utf8');
    const shared=readFileSync(new URL(`../../src/preview/terrain-${stage==='vertex'?'projection':'depth'}.glsl`,import.meta.url),'utf8').replaceAll('\r\n','\n');
    const shader=JSON.parse(generated.slice(generated.indexOf('export default ')+15).trim().replace(/;$/,''));
    assert.ok(shader.includes(shared),'generated module contains the current shared kernel');
    const esm=readFileSync(new URL('../../node_modules/maplibre-gl/dist/maplibre-gl.mjs',import.meta.url),'utf8');
    assert.ok(esm.includes(JSON.stringify(shader)),'ESM contains exactly the generated shader');
    if(stage==='vertex')assert.match(shader,/v_photo_fog=pos.zw;/);
    else {
      assert.match(shader,/float photo_fog_depth=photoFogDepth\(v_fog_depth\);/);
      assert.equal(shader.slice(shader.indexOf('void main()')).split('v_fog_depth').length-1,1,'old varying is only a fallback, never blended directly');
    }
  }
});

test("WGS84 ECEF 与局部 ENU 对照独立 PROJ 固定样本", () => {
  for (const fixture of geodeticFixtures.cases) {
    const ecef = geodeticEcef(fixture.target), enu = ellipsoidalRay(fixture.eye, fixture.target);
    for (let axis = 0; axis < 3; axis++) {
      close(ecef[axis], fixture.ecef[axis], 1e-6, `${fixture.name} ECEF ${axis} / m`);
      close(enu[axis], fixture.enu[axis], 1e-6, `${fixture.name} ENU ${axis} / m`);
    }
  }
  const example = geodeticFixtures.cases.find(f => f.name === "proj-documentation");
  for (const [axis, expected] of [-189013.869, -128642.040, -4220.171].entries())
    close(ellipsoidalRay(example.eye, example.target)[axis], expected, 0.001, "PROJ published example / m");
});

test("椭球轴、极点、垂直方向和无效坐标的边界", () => {
  const point = { latitude: 0, longitude: 0, ellipsoidalHeight: 0 };
  assert.deepEqual(geodeticEcef(point), [6378137, 0, 0]);
  close(geodeticEcef({ ...point, latitude: 90 })[2], 6356752.314245179, 1e-8, "WGS84 polar radius");
  for (const latitude of [-90, -43, 0, 35, 85, 90]) {
    const eye = { ...point, latitude, longitude: -179.9 };
    const ray = ellipsoidalRay(eye, { ...eye, ellipsoidalHeight: 10 });
    close(ray[0], 0, 1e-8, "vertical east");
    close(ray[1], 0, 1e-8, "vertical north");
    close(ray[2], 10, 1e-8, "vertical up");
    close(Math.hypot(...ellipsoidalRay(eye, eye)), 0, 0, "coincident points");
  }
  for (const invalid of [{ latitude: 91 }, { longitude: 181 }, { ellipsoidalHeight: NaN }, { latitude: Infinity }])
    assert.throws(() => ellipsoidalRay(point, { ...point, ...invalid }), RangeError);
});

test("近中远同高点的曲率分量独立于 Mercator 水平差异", () => {
  const plan = { ...terrainScenes[0].plan, focalLength: 1000, azimuth: 247, pitch: 0 };
  let previous = 0;
  for (const fixture of geodeticFixtures.cases.filter(f => f.name.startsWith("same-height"))) {
    const eye = { ...fixture.eye, altitude: fixture.eye.ellipsoidalHeight };
    const target = { ...fixture.target, altitude: fixture.target.ellipsoidalHeight };
    const models = compareEarthModels(plan, eye, target, 1152, 768);
    close(models.tangentControl.pitch, 0, 1e-10, "same-height tangent control");
    close(models.tangentControl.azimuth, models.ellipsoid.azimuth, 1e-10, "same horizontal components");
    assert.ok(models.verticalDrop > previous);
    previous = models.verticalDrop;
    assert.ok(models.ellipsoid.pitch < 0 && models.ellipsoid.pixel.y > models.tangentControl.pixel.y);
  }
});

test("同一眼点下的模型像素比较随焦距和横竖幅正确变化", () => {
  const fixture = geodeticFixtures.cases.find(f => f.name === "fuji-conditional-heights");
  const eye = { ...fixture.eye, altitude: fixture.eye.ellipsoidalHeight };
  const target = { ...fixture.target, altitude: fixture.target.ellipsoidalHeight };
  const angles = rayAngles(referenceRay(eye, target));
  const plan = { ...terrainScenes[0].plan, azimuth: angles.azimuth, pitch: angles.pitch };
  const compare = (focalLength, orientation = "landscape") => compareEarthModels(
    { ...plan, focalLength, orientation }, eye, target, ...(orientation === "portrait" ? [512, 768] : [1152, 768]));
  const wide = compare(200), tele = compare(1000), portrait = compare(1000, "portrait");
  const delta = m => m.ellipsoid.pixel.y - m.mercator.pixel.y;
  close(delta(tele), delta(wide) * 5, 1e-8, "pixel difference scales with focal length");
  close(delta(portrait), delta(tele) * 2 / 3, 1e-8, "vertical sensor dimension changes pixel scale");
  assert.equal(compareEarthModels({ ...plan, azimuth: plan.azimuth + 180 }, eye, target, 1152, 768).ellipsoid.pixel, null);
});

test("固定 SDK 的 ESM 与源代码都包含地形 LOD 兼容修正", () => {
  const esm = readFileSync(new URL('../../node_modules/maplibre-gl/dist/maplibre-gl.mjs', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../../node_modules/maplibre-gl/src/tile/terrain_tile_manager.ts', import.meta.url), 'utf8');
  assert.equal(esm.split('calculateTileZoom:this.getSource().calculateTileZoom').length, 2);
  assert.equal(source.split('calculateTileZoom: this.getSource().calculateTileZoom').length, 2);
});

test("地形细节随实际视场、尺寸与距离变化，并受原生 DEM 网格上限约束", () => {
  const calculate=terrainTileZoom(768);
  assert.ok(calculate(20,0.01,0.001,1,3)>calculate(20,0.01,0.001,1,35));
  assert.ok(calculate(20,0.01,0.001,1,35)>calculate(20,0.1,0.001,1,35));
  assert.ok(terrainTileZoom(1536)(20,0.01,0.001,1,35)>calculate(20,0.01,0.001,1,35));
  assert.equal(calculate(20,0,0,1,3),TERRAIN_MAX_MESH_ZOOM);
  assert.throws(()=>terrainTileZoom(0),RangeError);
});

test("真实 SDK 地形网格采用公共 LOD 策略，长焦参考点使用 z12 DEM 且覆盖有界", (t) => {
  const scene = terrainScenes[0], reference = MercatorCoordinate.fromLngLat([scene.target.longitude,scene.target.latitude]);
  let maxMeshes=0,maxDem=0;
  for (const focalLength of [8,35,200,600,1000])
    for (const orientation of ['landscape','portrait'])
      for (const pitch of [0,4,10.768041897334445]) {
        const plan={...scene.plan,focalLength,orientation,pitch,azimuth:244.5677557247937};
        const camera=createCamera(...(orientation==='portrait'?[512,768]:[1152,768]),scene.syntheticGround);
        apply(camera,plan,scene.syntheticGround);
        const calculateTileZoom=terrainTileZoom(768);
        const source={tileSize:TERRAIN_VISUAL_TILE_SIZE,minzoom:0,maxzoom:12,calculateTileZoom};
        let requestedSource;
        // Only I/O is replaced. Coverage traversal, mesh manager and tile IDs
        // below are the installed SDK implementations, not component doubles.
        const tiles={_source:source,usedForTerrain:false,update(){},getTileByID(key){requestedSource=key;return {key};}};
        const manager=new TerrainTileManager(tiles);
        manager.update(camera.transform,flatTerrain(scene.syntheticGround));
        const meshes=manager.getRenderableTiles().map(tile=>tile.tileID);
        const dem=coveringTiles(camera.transform,{tileSize:manager.tileSize,minzoom:0,maxzoom:12,terrain:flatTerrain(scene.syntheticGround),calculateTileZoom});
        maxMeshes=Math.max(maxMeshes,meshes.length);maxDem=Math.max(maxDem,dem.length);
        assert.ok(meshes.every(tile=>tile.canonical.z<=14));
        assert.ok(dem.every(tile=>tile.canonical.z<=12));
        assert.ok(meshes.length<128,`mesh budget ${focalLength}/${orientation}/${pitch}: ${meshes.length}`);
        assert.ok(dem.length<64,`DEM budget: ${dem.length}`);
        if(focalLength>=200&&pitch===10.768041897334445){
          const tile=meshes.find(tile=>{const c=tile.canonical;return c.x===Math.floor(reference.x*2**c.z)&&c.y===Math.floor(reference.y*2**c.z);});
          assert.ok(tile,'reference peak must have a mesh');
          assert.ok(tile.canonical.z>=13,'reference mesh must use the native DEM');
          manager.getSourceTile(tile);
          assert.equal(requestedSource,tile.scaledTo(12).key);
        }
        assertEye(camera,plan,scene.syntheticGround);
      }
  t.diagnostic(`30 组覆盖，最大 ${maxMeshes} 个网格、${maxDem} 个理想 DEM 瓦片（不含加载父瓦片）`);
});

test('远景地标覆盖扩展复用真实SDK，包含塔址DEM且不修改实际相机/普通地图',t=>{
  const reference=MercatorCoordinate.fromLngLat([skytree.longitude,skytree.latitude]),records=[];
  for(const [latitude,focalLength,pitch,ground] of [[35.80013517252544,200,1,3],[35.98031535270562,600,.3,7.6],[36.159594631984895,1000,.1,19]]){
    const plan={...terrainScenes[0].plan,longitude:skytree.longitude,latitude,azimuth:180,pitch,focalLength,cameraHeight:100,layers:{...terrainScenes[0].plan.layers,buildings:true}};
    const camera=createCamera(1238.5,825.65625,ground);apply(camera,plan,ground);
    const terrain={...flatTerrain(ground),getMinMaxElevation:()=>({minElevation:0,maxElevation:30})};
    const source={tileSize:TERRAIN_VISUAL_TILE_SIZE,minzoom:0,maxzoom:12,calculateTileZoom:terrainTileZoom(825.65625)};
    const tiles={_source:source,usedForTerrain:false,map:{painter:{}},update(){},getTileByID(key){return {key};}},manager=new TerrainTileManager(tiles);
    const cover=()=>{manager.update(camera.transform,terrain);return manager.getRenderableTiles().map(t=>t.tileID);};
    const atTower=ts=>ts.some(t=>t.canonical.x===Math.floor(reference.x*2**t.canonical.z)&&t.canonical.y===Math.floor(reference.y*2**t.canonical.z));
    const native=cover(),matrix=Array.from(camera.transform.modelViewProjectionMatrix),far=camera.transform.farZ;
    if(focalLength>=600)assert.ok(!atTower(native),'native range reproduces missing ground');
    source.calculateTileZoom=terrainTileZoom(825.65625,terrainCoverageRange(plan));
    const extended=cover();assert.ok(atTower(extended),'extended coverage includes tower ground');assert.ok(extended.length<96);
    const dem=coveringTiles(camera.transform,{tileSize:manager.tileSize,minzoom:0,maxzoom:12,terrain,calculateTileZoom:source.calculateTileZoom});assert.ok(atTower(dem));assert.ok(dem.length<64);
    assert.deepEqual(Array.from(camera.transform.modelViewProjectionMatrix),matrix);assert.equal(camera.transform.farZ,far);assert.equal(camera.transform.nearFarZOverride,null);
    assertEye(camera,plan,ground);source.calculateTileZoom=terrainTileZoom(825.65625);assert.deepEqual(cover().map(t=>t.key),native.map(t=>t.key));
    records.push({focalLength,meshes:extended.length,dem:dem.length});
  }
  t.diagnostic(JSON.stringify(records));
  const near={...terrainScenes[0].plan,...skytree,layers:{...terrainScenes[0].plan.layers,buildings:true}};
  assert.equal(terrainCoverageRange(near),LANDMARK_TERRAIN_RANGE);assert.equal(terrainCoverageRange({...near,longitude:130}),0);assert.equal(terrainCoverageRange({...near,latitude:35.98}),LANDMARK_TERRAIN_RANGE);assert.equal(terrainCoverageRange({...near,latitude:35.98,layers:{...near.layers,buildings:false}}),0);
  assert.throws(()=>terrainTileZoom(768,100000),RangeError);
});

test('远距覆盖补丁同时校验源码/ESM并保持重复安装幂等',()=>{
  const files=['src/geo/projection/covering_tiles.ts','dist/maplibre-gl.mjs'].map(p=>new URL('../../node_modules/maplibre-gl/'+p,import.meta.url));
  const digest=()=>files.map(p=>createHash('sha256').update(readFileSync(p)).digest('hex'));
  for(const p of files){const s=readFileSync(p,'utf8');assert.equal(s.split('TAMATAMATORI_TERRAIN_RANGE_V1').length,2);assert.ok(s.includes('tamatamatori.terrain-range.v1'));}
  const before=digest();execFileSync(process.execPath,['scripts/patch-terrain-range.mjs'],{stdio:'pipe'});assert.deepEqual(digest(),before);
});

test('远距覆盖在广角/长焦及横竖幅下保持有界，普通覆盖不带扩展标记',t=>{
  let maxMesh=0,maxDem=0;const records=[];
  for(const focalLength of [8,35,200,1000])for(const orientation of ['landscape','portrait']){
    const plan={...terrainScenes[0].plan,longitude:skytree.longitude,latitude:35.98,cameraHeight:100,azimuth:180,pitch:.3,focalLength,orientation,layers:{...terrainScenes[0].plan.layers,buildings:true}};
    const camera=createCamera(...(orientation==='portrait'?[512,768]:[1152,768]),7.6);apply(camera,plan,7.6);
    const terrain={...flatTerrain(7.6),getMinMaxElevation:()=>({minElevation:0,maxElevation:30})},calculateTileZoom=terrainTileZoom(768,terrainCoverageRange(plan));
    const source={tileSize:TERRAIN_VISUAL_TILE_SIZE,minzoom:0,maxzoom:12,calculateTileZoom};
    const manager=new TerrainTileManager({_source:source,usedForTerrain:false,update(){},getTileByID(k){return {key:k};}});manager.update(camera.transform,terrain);
    const mesh=manager.getRenderableTiles(),dem=coveringTiles(camera.transform,{tileSize:manager.tileSize,minzoom:0,maxzoom:12,terrain,calculateTileZoom});
    assert.ok(mesh.length<160,`${focalLength}/${orientation}: ${mesh.length}`);assert.ok(dem.length<64,`${focalLength}/${orientation}: ${dem.length}`);assert.ok(mesh.every(t=>t.tileID.canonical.z<=14));
    maxMesh=Math.max(maxMesh,mesh.length);maxDem=Math.max(maxDem,dem.length);records.push({focalLength,orientation,meshes:mesh.length,dem:dem.length});
  }
  t.diagnostic(JSON.stringify({maxMesh,maxDem,records}));
});

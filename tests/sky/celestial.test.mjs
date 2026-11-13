import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { celestialBodies, direction, moonPhaseLabel, sunPosition } from "../../src/domain/ephemeris.ts";
import { bodyPolygons, projectDirection, frameEdgeDirection } from "../../src/domain/celestial-projection.ts";
import { initialPlan as defaultPlan, fieldOfView, signedAngle } from "../../src/domain/plan.ts";
const initialPlan = { ...defaultPlan, refraction: "none" };

const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);
const area = (points) => Math.abs(points.reduce((sum, a, index) => {
  const b = points[(index + 1) % points.length]; return sum + a.x * b.y - a.y * b.x;
}, 0) / 2);
const disc = (azimuth, elevation, angularRadius = 0.25) => ({ id: "sun", azimuth, elevation, angularRadius, direction: direction(azimuth, elevation), distanceKm: 1.5e8 });

test("日月测站位置、距离、角直径及月面比例符合离线 JPL 基准", () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/sun-moon-reference.json', import.meta.url), 'utf8'));
  assert.equal(fixture.records.length, 8);
  for (const reference of fixture.records) {
    const body = celestialBodies(reference)[reference.id];
    close(signedAngle(body.azimuth - reference.azimuth), 0, 0.05);
    close(body.elevation, reference.elevation, 0.05);
    close(body.angularRadius * 2, reference.angularDiameter, 0.002);
    close(body.distanceKm / reference.distanceKm, 1, 0.001);
    if (body.id === "moon") close(body.illuminatedFraction, reference.illuminatedFraction, 0.003);
  }
});

test("日月共享太阳坐标、保持 UTC 与时区不变性，角直径处于合理范围", () => {
  const bodies = celestialBodies(initialPlan);
  assert.deepEqual(sunPosition(initialPlan), { azimuth: bodies.sun.azimuth, elevation: bodies.sun.elevation });
  assert.deepEqual(celestialBodies({ ...initialPlan, timeZone: "UTC" }), bodies);
  assert.deepEqual(celestialBodies({ ...initialPlan, instant: "2026-11-04T17:00:00+09:00" }), bodies);
  for (const instant of ["2026-01-01T00:00Z", "2026-07-01T00:00Z"])
    for (const body of Object.values(celestialBodies({ ...initialPlan, instant }))) {
      assert.ok(body.angularRadius * 2 > 0.45 && body.angularRadius * 2 < 0.6);
      assert.ok(body.azimuth >= 0 && body.azimuth < 360);
    }
});

test("USNO 公开月相时刻对应新月、满月和上下弦，测站亮面比例合理", () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/moon-phases-reference.json', import.meta.url), 'utf8'));
  for (const reference of fixture.records) {
    const moon = celestialBodies({ ...initialPlan, instant: reference.instant }).moon;
    close(signedAngle(moon.phaseAngle - reference.phase), 0, 0.1);
    assert.equal(moonPhaseLabel(moon.phaseAngle), reference.label);
    close(moon.illuminatedFraction, reference.fraction, 0.015);
  }
});

test("日月在日期变更线相接，极点有限，非法输入明确失败", () => {
  const a = celestialBodies({ ...initialPlan, longitude: -180 }), b = celestialBodies({ ...initialPlan, longitude: 180 });
  for (const id of ["sun", "moon"]) {
    close(a[id].azimuth, b[id].azimuth);
    close(a[id].elevation, b[id].elevation);
  }
  for (const latitude of [-90, 90]) for (const body of Object.values(celestialBodies({ ...initialPlan, latitude })))
    assert.ok(Number.isFinite(body.elevation) && Number.isFinite(body.azimuth));
  assert.throws(() => celestialBodies({ ...initialPlan, latitude: NaN }));
  assert.throws(() => celestialBodies({ ...initialPlan, instant: "2026-11-04T12:00" }));
});

test("针孔投影处理正前方、真北接缝、背面与天顶，不分离计算水平垂直偏移", () => {
  for (const pitch of [-45, 0, 35, 90]) {
    const plan = { ...initialPlan, azimuth: 359, pitch };
    const centre = projectDirection(plan, direction(359, pitch));
    close(centre.x, 0); close(centre.y, 0);
  }
  const plan = { ...initialPlan, azimuth: 359, pitch: 20 };
  assert.ok(projectDirection(plan, direction(1, 20)).x > 0);
  assert.equal(projectDirection(plan, direction(179, -20)), null);
  const tilted = projectDirection({ ...plan, pitch: 70 }, direction(30, 70));
  assert.ok(tilted.y < 0, "same geographic altitude is not a straight image row at large pitch");
});

test("画外方向覆盖四边与后方，经过相机侧面不反向，精确反向保持确定",()=>{
  const plan={...initialPlan,azimuth:0,pitch:0};
  const right=frameEdgeDirection(plan,direction(60,10)),left=frameEdgeDirection(plan,direction(300,10));
  assert.equal(right.x,1);assert.ok(right.y<0);assert.equal(left.x,-1);assert.ok(left.y<0);
  const up=frameEdgeDirection({...plan,pitch:45},direction(0,85));
  const down=frameEdgeDirection({...plan,pitch:45},direction(0,5));
  close(up.x,0);assert.equal(up.y,-1);close(down.x,0);assert.equal(down.y,1);
  for(const azimuth of [89.99,90,90.01,130]){
    const edge=frameEdgeDirection(plan,direction(azimuth,10));
    assert.ok(edge.x>0,'target stays on the right after passing camera plane');
    assert.equal(edge.behind,azimuth>90);
    close(Math.max(Math.abs(edge.x),Math.abs(edge.y)),1);
  }
  const antipode=frameEdgeDirection(plan,direction(180,0));
  assert.equal(antipode.x,1);assert.equal(antipode.y,0);assert.equal(antipode.label,'后方');assert.equal(antipode.behind,true);
  assert.equal(frameEdgeDirection(plan,[0,0,0]),null);assert.equal(frameEdgeDirection(plan,[NaN,0,1]),null);
});

test("画外箭头在横竖幅与焦距变化中保持相机平面角度，跨真北和天顶有效",()=>{
  const angle=Math.atan2(-Math.sin(Math.PI/3),Math.sin(Math.PI/3)*Math.cos(Math.PI/3))*180/Math.PI;
  for(const orientation of ['landscape','portrait'])for(const focalLength of [8,35,200,1000]){
    const plan={...initialPlan,azimuth:0,pitch:0,orientation,focalLength};
    const edge=frameEdgeDirection(plan,direction(60,60));
    close(edge.angle,angle);assert.ok(edge.x>0&&edge.y<0);
    const fov=fieldOfView(plan);
    const physical=Math.atan2(edge.y*Math.tan(fov.vertical*Math.PI/360),edge.x*Math.tan(fov.horizontal*Math.PI/360))*180/Math.PI;
    close(physical,angle);
  }
  assert.ok(frameEdgeDirection({...initialPlan,azimuth:359,pitch:20},direction(1,20)).x>0);
  for(const pitch of [-90,90]){
    const edge=frameEdgeDirection({...initialPlan,pitch},direction(20,50));
    assert.ok([edge.x,edge.y,edge.angle].every(Number.isFinite));
  }
});

test("仅完全出画且地平线上圆盘提供方向，部分入画与参考折射沿用原判据",()=>{
  const plan={...initialPlan,azimuth:0,pitch:0};
  const edge=fieldOfView(plan).horizontal/2;
  assert.equal(bodyPolygons(plan,disc(edge+0.1,2)).indicator,null);
  assert.ok(bodyPolygons(plan,disc(edge+1,2)).indicator);
  assert.equal(bodyPolygons(plan,disc(180,-2)).indicator,null);
  const below=disc(180,-0.4);
  assert.equal(bodyPolygons(plan,below).state,'地平线下');
  const refracted=bodyPolygons({...plan,refraction:'standard'},below);
  assert.equal(refracted.state,'视场外');assert.equal(refracted.indicator.behind,true);
});

test("圆盘角尺寸随焦距和画幅投影，像素圆盘不被最小显示尺寸放大", () => {
  const body = disc(247, 20);
  for (const orientation of ["landscape", "portrait"])
    for (const focalLength of [8, 35, 200, 1000]) {
      const plan = { ...initialPlan, pitch: 20, orientation, focalLength };
      const { outline, state } = bodyPolygons(plan, body);
      assert.equal(state, "画面内");
      const radius = Math.max(...outline.map((point) => point.x));
      close(radius, Math.tan(body.angularRadius * Math.PI / 180) / Math.tan(fieldOfView(plan).horizontal * Math.PI / 360), 1e-7);
      const width = orientation === "portrait" ? 400 : 600, height = orientation === "portrait" ? 600 : 400;
      close(radius * width, Math.max(...outline.map((point) => point.y)) * height, 1e-7);
    }
});

test("圆盘跨视场边缘仍显示，跨几何地平线只绘制地平线上方部分", () => {
  const plan = { ...initialPlan, azimuth: 0, pitch: 0 };
  const edge = fieldOfView(plan).horizontal / 2;
  const partial = bodyPolygons(plan, disc(edge + 0.1, 2));
  assert.equal(partial.state, "画面内");
  assert.ok(partial.centre.x > 1);
  assert.equal(bodyPolygons(plan, disc(edge + 1, 2)).state, "视场外");
  const horizon = bodyPolygons(plan, disc(0, -0.1));
  assert.equal(horizon.state, "画面内");
  assert.ok(horizon.outline.every((point) => point.y <= 1e-8));
  assert.equal(bodyPolygons(plan, disc(0, -1)).state, "地平线下");
});

test("月相亮区面积符合比例，亮侧朝实际光源而非固定屏幕方向", () => {
  const plan = { ...initialPlan, azimuth: 0, pitch: 0, focalLength: 200 };
  // Geographic horizon clipping would cut half the disc; use elevation 30°.
  plan.pitch = 30;
  const base = { ...disc(0, 30), id: "moon", phaseAngle: 90, illuminatedFraction: 0.5 };
  const centre = base.direction;
  for (const cosine of [-1, 0, 0.8, 1]) {
    const lightDirection = [Math.sqrt(1 - cosine * cosine), centre[1] * cosine, centre[2] * cosine];
    const polygons = bodyPolygons(plan, { ...base, lightDirection });
    close(area(polygons.illuminated) / area(polygons.outline), (1 - cosine) / 2, 0.002);
  }
  const right = bodyPolygons(plan, { ...base, lightDirection: [1, 0, 0] }).illuminated;
  const left = bodyPolygons(plan, { ...base, lightDirection: [-1, 0, 0] }).illuminated;
  assert.ok(right.reduce((sum, point) => sum + point.x, 0) > 0);
  assert.ok(left.reduce((sum, point) => sum + point.x, 0) < 0);
  assert.deepEqual([0, 90, 180, 270].map(moonPhaseLabel), ["新月附近", "上弦附近", "满月附近", "下弦附近"]);
});

test("食时圆面：日面减去月面（月牙、光环、全食无日面），月面按本影分成亮区与地影区", async () => {
  const { celestialBodies } = await import("../../src/domain/ephemeris.ts");
  const { discOverlap } = await import("../../src/domain/eclipse-geometry.ts");
  const sumArea = (loops) => loops.reduce((sum, loop) => sum + area(loop), 0);
  const view = (body) => ({ ...initialPlan, azimuth: body.azimuth, pitch: body.elevation, focalLength: 1200, refraction: "none" });
  // Madrid, partial: the lit area is the uncovered share of the disc.
  const partial = celestialBodies({ latitude: 40.4, longitude: -3.7, instant: "2027-08-02T08:51:00Z" });
  const cut = bodyPolygons(view(partial.sun), partial.sun, partial.moon);
  close(sumArea(cut.eclipse.lit) / area(cut.outline), 1 - partial.sun.obscuration, 0.01);
  assert.equal(cut.eclipse.lit.length, 1);
  // Without the Moon argument or outside an eclipse nothing is cut.
  assert.equal(bodyPolygons(view(partial.sun), partial.sun).eclipse, undefined);
  const plain = celestialBodies({ latitude: 40.4, longitude: -3.7, instant: "2027-08-03T08:51:00Z" });
  assert.equal(bodyPolygons(view(plain.sun), plain.sun, plain.moon).eclipse, undefined);
  // Totality leaves no solar disc; annularity leaves a ring in two pieces.
  const total = celestialBodies({ latitude: 25.687, longitude: 32.64, instant: "2027-08-02T10:05:07Z" });
  assert.deepEqual(bodyPolygons(view(total.sun), total.sun, total.moon).eclipse.lit, []);
  const ring = celestialBodies({ latitude: -31.2133, longitude: -48.365, instant: "2027-02-06T15:59:33Z" });
  const annular = bodyPolygons(view(ring.sun), ring.sun, ring.moon).eclipse;
  assert.equal(annular.lit.length, 2);
  close(sumArea(annular.lit) / area(bodyPolygons(view(ring.sun), ring.sun).outline), 1 - ring.sun.obscuration, 0.01);
  // Lunar eclipse: the shadowed part matches the umbra overlap, the rest is dimmed.
  const lunar = celestialBodies({ latitude: 35.68, longitude: 139.77, instant: "2028-07-06T18:19:38Z" });
  const moon = bodyPolygons(view(lunar.moon), lunar.moon);
  const separation = Math.acos(lunar.moon.direction.reduce((s, v, i) => s + v * lunar.moon.shadow.direction[i], 0)) * 180 / Math.PI;
  const inside = discOverlap(lunar.moon.angularRadius, lunar.moon.shadow.umbra, separation);
  close(sumArea(moon.eclipse.shadowed) / area(moon.outline), inside, 0.01);
  close(sumArea(moon.eclipse.lit) / area(moon.outline), 1 - inside, 0.01);
  // The lit part stays brighter than the umbra but dimmer than an uneclipsed Moon.
  assert.ok(moon.eclipse.level > 0.45 && moon.eclipse.level < 0.8, `${moon.eclipse.level}`);
});

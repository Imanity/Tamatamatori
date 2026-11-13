import test from "node:test";
import assert from "node:assert/strict";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { solarPosition, daylightPhase } from "../../src/domain/sun-moon/solar.ts";
import { celestialBodies } from "../../src/domain/core/ephemeris.ts";
import { initialPlan, instantFromLocal } from "../../src/domain/core/plan.ts";
import { terrainStyle } from "../../src/domain/core/terrain.ts";
import { environmentForSky, applyEnvironment } from "../../src/render/scene/environment.ts";

const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} vs ${expected}`);
const rgb = (color) => [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16));
const moonless = { elevation: -20, illuminatedFraction: 1 };
const luminance = color => rgb(color).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);

test("太阳位置与 NREL SPA 公开样例的角度一致到本轮 0.1 度容差", () => {
  // https://www.nlr.gov/docs/fy08osti/34302.pdf, Table A5.1.
  // SPA's zenith includes refraction; ours is geometric and differs by ~0.016°.
  const sun = solarPosition({ latitude: 39.742476, longitude: -105.1786, instant: "2003-10-17T19:30:30Z" });
  close(sun.azimuth, 194.340241, 0.1);
  close(sun.elevation, 90 - 50.111622, 0.1);
});

test("太阳按机位与 UTC 计算，显示时区和等价时刻不改变位置", () => {
  const instant = instantFromLocal("2026-11-04T12:00", "Asia/Tokyo");
  const sun = solarPosition({ ...initialPlan, instant });
  assert.deepEqual(solarPosition({ ...initialPlan, instant, timeZone: "America/New_York" }), sun);
  assert.deepEqual(solarPosition({ ...initialPlan, instant: "2026-11-04T12:00:00+09:00" }), sun);
  assert.ok(sun.elevation > 30);
  assert.ok(solarPosition({ ...initialPlan, instant: "2026-11-03T15:00:00Z" }).elevation < -18);
  assert.ok(solarPosition({ ...initialPlan, longitude: -41.1271, instant }).elevation < -18);
});

test("日期变更线相接、跨 UTC 午夜连续，负时间戳与日期边界有效", () => {
  const at = (longitude, instant = "2026-11-04T00:00:00Z") => solarPosition({ latitude: 15, longitude, instant });
  close(at(-180).azimuth, at(180).azimuth);
  close(at(-180).elevation, at(180).elevation);
  const before = at(0, "2026-11-03T23:59:59Z"), after = at(0, "2026-11-04T00:00:01Z");
  close(before.elevation, after.elevation, 0.02);
  close(before.azimuth, after.azimuth, 0.02);
  for (const instant of ["1900-01-01T00:00:00Z", "2000-02-29T12:00:00Z", "2100-12-31T23:59:59Z",
    instantFromLocal("1900-01-01T00:00", "Asia/Tokyo"),
    instantFromLocal("2100-12-31T23:59", "America/New_York"),
  ])
    assert.ok(Number.isFinite(at(0, instant).elevation));
});

test("南北半球季节与极昼极夜由太阳高度决定，极点结果有限", () => {
  for (const hour of [0, 6, 12, 18]) {
    const time = `${String(hour).padStart(2, "0")}:00:00Z`;
    for (const latitude of [70, 90]) {
      const northSummer = solarPosition({ latitude, longitude: 0, instant: `2026-06-21T${time}` });
      const northWinter = solarPosition({ latitude, longitude: 0, instant: `2026-12-21T${time}` });
      assert.ok(northSummer.elevation > 0);
      assert.ok(northWinter.elevation < 0);
      assert.ok(Number.isFinite(northSummer.azimuth));
      assert.ok(solarPosition({ latitude: -latitude, longitude: 0, instant: `2026-06-21T${time}` }).elevation < 0);
      assert.ok(solarPosition({ latitude: -latitude, longitude: 0, instant: `2026-12-21T${time}` }).elevation > 0);
    }
  }
});

test("无效坐标、无时区时间和模型日期范围被拒绝", () => {
  for (const patch of [
    { latitude: 91 }, { longitude: NaN }, { longitude: 181 },
    { instant: "invalid" }, { instant: "2026-11-04T12:00:00" },
    { instant: "1898-12-31T23:59:59Z" }, { instant: "2102-01-01T00:00:00Z" },
  ]) assert.throws(() => solarPosition({ ...initialPlan, ...patch }));
});

test("昼夜文字和配色连续，地平线下关闭直射，夜间保留构图明度", () => {
  const phases = [-20, -15, -9, -3, 3, 30].map(daylightPhase);
  assert.deepEqual(phases, ["夜间", "天文暮光", "航海暮光", "民用暮光", "低角度日照", "白昼"]);
  const environment = (elevation) => environmentForSky({ elevation, azimuth: 190 },moonless);
  const night = environment(-30), dusk = environment(-3), day = environment(40);
  assert.ok(rgb(night.ground).every((value) => value >= 30),'moonless terrain retains a composition floor');
  assert.ok(luminance(night.sky['horizon-color'])-luminance(night.ground)>20,'silhouette and horizon stay distinct');
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(rgb(night.ground)[channel] < rgb(dusk.ground)[channel]);
    assert.ok(rgb(dusk.ground)[channel] < rgb(day.ground)[channel]);
  }
  for (const elevation of [-30, -6, 0]) assert.equal(environment(elevation).shading["hillshade-exaggeration"], 0);
  for (const elevation of [-18, -12, -6, 0, 6, 25])
    for (const property of ["sky-color", "horizon-color", "fog-color"]) {
      const before = rgb(environment(elevation - 0.001).sky[property]);
      const after = rgb(environment(elevation + 0.001).sky[property]);
      before.forEach((value, channel) => close(value, after[channel], 1));
    }
});

test("夜空与地表随月亮亮面及高度提亮，地平线下和白昼不叠加月光",()=>{
  const sun={elevation:-40,azimuth:190};
  const environment=(fraction,elevation)=>environmentForSky(sun,{elevation,illuminatedFraction:fraction});
  const dark=environment(0,60);
  assert.deepEqual(environment(1,-30),dark);
  assert.deepEqual(environment(1,0),dark);
  for(const property of ['sky-color','horizon-color','fog-color']){
    const phases=[0,0.25,0.5,0.75,1].map(f=>luminance(environment(f,60).sky[property]));
    const altitudes=[0,5,20,45,90].map(h=>luminance(environment(1,h).sky[property]));
    for(const values of [phases,altitudes])for(let i=1;i<values.length;i++)assert.ok(values[i]>values[i-1],property);
  }
  assert.ok(luminance(environment(1,60).ground)>luminance(environment(0.5,60).ground));
  assert.ok(luminance(environment(0.5,60).water)>luminance(dark.water));
  for(const elevation of [-6,0,25,90])assert.deepEqual(
    environmentForSky({...sun,elevation},{elevation:90,illuminatedFraction:1}),
    environmentForSky({...sun,elevation},moonless),'day and civil twilight are unchanged by moonlight');
});

test("月升月落及暮光淡入连续，非法月光参数明确拒绝",()=>{
  const at=(sunElevation,moonElevation)=>environmentForSky({elevation:sunElevation,azimuth:190},{elevation:moonElevation,illuminatedFraction:1});
  for(const boundary of [-18,-12,-6])for(const property of ['sky-color','horizon-color','fog-color']){
    const a=rgb(at(boundary-0.001,60).sky[property]),b=rgb(at(boundary+0.001,60).sky[property]);
    a.forEach((v,i)=>close(v,b[i],1));
  }
  const before=at(-40,-0.001),after=at(-40,0.001);
  for(const property of ['sky-color','horizon-color','fog-color'])rgb(before.sky[property]).forEach((v,i)=>close(v,rgb(after.sky[property])[i],1));
  // Holding Moon phase/height fixed isolates the solar fade: sunrise must not
  // dim the scene merely because its moonlight contribution is fading away.
  let previous=at(-20,90);
  for(let elevation=-19.9;elevation<=0;elevation+=0.1){
    const current=at(elevation,90);
    for(const property of ['sky-color','horizon-color','fog-color'])
      assert.ok(luminance(current.sky[property])>=luminance(previous.sky[property])-1e-10,'sunrise palette must not dim');
    assert.ok(luminance(current.ground)>=luminance(previous.ground)-1e-10);
    previous=current;
  }
  for(const moon of [{elevation:NaN,illuminatedFraction:1},{elevation:91,illuminatedFraction:1},
    {elevation:30,illuminatedFraction:-0.1},{elevation:30,illuminatedFraction:1.1},{elevation:30,illuminatedFraction:NaN}])
    assert.throws(()=>environmentForSky({elevation:-40,azimuth:190},moon));
});

test("固定真实夜景的新月、上弦与满月环境由现有星历驱动，与时区和圆盘开关无关",()=>{
  const at=local=>{
    const plan={...initialPlan,instant:instantFromLocal(local,'Asia/Tokyo')};
    const bodies=celestialBodies(plan);
    return {plan,bodies,environment:environmentForSky(bodies.sun,bodies.moon)};
  };
  const dark=at('2026-11-09T00:00'),quarter=at('2026-11-17T19:00'),full=at('2026-11-25T00:00');
  for(const scene of [dark,quarter,full])assert.ok(scene.bodies.sun.elevation < -18);
  assert.ok(dark.bodies.moon.elevation<0);
  assert.ok(quarter.bodies.moon.illuminatedFraction>0.45&&quarter.bodies.moon.illuminatedFraction<0.55);
  assert.ok(full.bodies.moon.illuminatedFraction>0.99&&full.bodies.moon.elevation>70);
  assert.ok(luminance(dark.environment.sky['sky-color'])<luminance(quarter.environment.sky['sky-color']));
  assert.ok(luminance(quarter.environment.sky['sky-color'])<luminance(full.environment.sky['sky-color']));
  const changed=celestialBodies({...full.plan,timeZone:'UTC',layers:{sun:false,moon:false}});
  assert.deepEqual(environmentForSky(changed.sun,changed.moon),full.environment);
});

test("环境生成的昼夜样式通过真实 SDK 校验，光源锚定真北且参数有效", () => {
  for (const elevation of [-90, -18, -6, 0, 6, 40, 90])
    for (const azimuth of [0, 190, 359.99]) {
      const style = terrainStyle();
      const environment = environmentForSky({ elevation, azimuth },{elevation:60,illuminatedFraction:1});
      applyEnvironment({
        setSky(sky) { style.sky = sky; },
        setPaintProperty(id, property, value) { style.layers.find((layer) => layer.id === id).paint[property] = value; },
      }, environment);
      assert.deepEqual(validateStyleMin(style).map((error) => error.message), []);
      assert.equal(environment.shading["hillshade-illumination-anchor"], "map");
      assert.ok(environment.shading["hillshade-illumination-altitude"] >= 0);
    }
});

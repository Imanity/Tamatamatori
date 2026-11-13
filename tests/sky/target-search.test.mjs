import test from "node:test";
import assert from "node:assert/strict";
import { searchTargets } from "../../src/domain/target-search.ts";
import { initialPlan } from "../../src/domain/plan.ts";
const plan = { ...initialPlan, instant: "2026-11-08T16:00:00Z" };
test("目标搜索匹配中文、英文别名、HIP、星座缩写及全角输入", () => {
  for (const q of ["织女星", "vega", " VEGA ", "HIP91262", "hip 91262"])
    assert.equal(searchTargets(plan, q)[0].name, "织女星");
  for (const q of ["猎户座", "Ori", "ＯＲＩ", "Orion", "猎户 Ori"])
    assert.equal(searchTargets(plan, q)[0].name, "猎户座");
  assert.equal(searchTargets(plan, "参宿 五")[0].name, "参宿五");
  assert.equal(searchTargets(plan, "Sun")[0].name, "太阳");
  assert.equal(searchTargets(plan, "月球")[0].name, "月亮");
  assert.equal(searchTargets(plan, "Milky Way")[0].name, "银心");
  assert.equal(searchTargets(plan, "Jupiter")[0].name, "木星");
});
test("查询独立于图层开关，不修改计划，无匹配和空查询明确为空", () => {
  const before = structuredClone(plan);
  assert.equal(searchTargets(plan, "亮星").length, 90);
  assert.equal(searchTargets(plan, "星座").length, 89);
  assert.equal(searchTargets(plan, "Serpens").length, 2);
  for (const q of ["", "   ", "不存在的目标_zzzz"])
    assert.deepEqual(searchTargets(plan, q), []);
  assert.deepEqual(plan, before);
});
test("搜索方向随 UTC 更新，时区、焦距和图层开关不改变同一时刻位置", () => {
  const a = searchTargets(plan, "Vega")[0],
    b = searchTargets(
      {
        ...plan,
        timeZone: "UTC",
        focalLength: 1000,
        layers: { ...plan.layers, stars: true },
      },
      "Vega",
    )[0];
  assert.deepEqual(a.direction, b.direction);
  assert.equal(a.layer, "stars");
  const later = searchTargets(
    { ...plan, instant: "2026-11-08T17:00:00Z" },
    "Vega",
  )[0];
  assert.notDeepEqual(a.direction, later.direction);
  const figure = searchTargets(plan, "Ori")[0];
  assert.equal(figure.layer, "constellations");
  assert.ok(figure.elevation > 0);
});
test("有匹配目标时，非法机位或无时区时刻明确失败", () => {
  assert.throws(() => searchTargets({ ...plan, latitude: NaN }, "Vega"));
  assert.throws(() =>
    searchTargets({ ...plan, instant: "2026-11-09T01:00" }, "Ori"),
  );
});

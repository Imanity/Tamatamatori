import test from "node:test";
import assert from "node:assert/strict";
import { initialPlan } from "../../src/domain/core/plan.ts";
import {
  parseShot, parseShotText, planFromShot, shotFromPlan, shareCode, shotJson, planSignature, shotSignature, validTimeZone,
  SHARE_PREFIX, SHOT_TEXT_LIMIT,
} from "../../src/domain/shots/shot.ts";
import {
  readLibrary, writeLibrary, readSession, writeSession, SHOT_LIBRARY_KEY, SHOT_SESSION_KEY,
} from "../../src/domain/shots/shot-library.ts";
import { searchTimeZones, zoneOffset, allTimeZones } from "../../src/domain/time/time-zones.ts";

// Every field differs from the defaults so a dropped mapping cannot hide.
const varied = {
  latitude: -33.8568, longitude: 151.2153, azimuth: 123.456789, pitch: -7.25, cameraHeight: 42.5, focalLength: 600.3,
  sensor: "aps-c", customSensor: null, aspectRatio: "16:9", orientation: "portrait", instant: "2026-12-14T09:31:12Z", timeZone: "Australia/Sydney", followLocalZone: true,
  layers: { buildings: true, sun: false, sunPath: false, moon: false, moonPath: false, stars: true, milkyWay: true, constellations: true, deepSky: true, stations: true, meteors: true, meteorDensity: true, comets: true, tides: true, aurora: false },
  refraction: "none", milkyWayContrast: 135, cameraResponse: "ha-modified", lightPollution: true, weather: true, weatherModel: "ecmwf_ifs",
};
const minimal = (extra = {}) => ({ format: "tamatamatori.shot", version: 1, position: { latitude: 35, longitude: 139 }, view: { azimuth: 90 }, time: { instant: "2026-11-04T08:00:00Z" }, ...extra });
const errorsOf = (value) => { const result = typeof value === "string" ? parseShotText(value) : parseShot(value); assert.equal(result.ok, false); return result.errors.join("\n"); };

test("机位覆盖全部拍摄计划字段，JSON、分享码与链接往返无损且不舍入", () => {
  assert.deepEqual(Object.keys(planFromShot(shotFromPlan(varied))).sort(), Object.keys(varied).sort());
  for (const key of Object.keys(initialPlan)) assert.ok(key in varied, key);
  const shot = shotFromPlan(varied, "悉尼 · 歌剧院 🌌", "备注");
  assert.equal(shot.time.local, "2026-12-14T20:31:12");
  for (const text of [shotJson(shot), JSON.stringify(shot), shareCode(shot), `看这个 ${shareCode(shot)}`.slice(4),
    `${shareCode(shot).slice(0, 30)}\n  ${shareCode(shot).slice(30)}`, "```json\n" + shotJson(shot) + "\n```",
    `https://imanity.github.io/Tamatamatori/#shot=${shareCode(shot)}`,
    `https://imanity.github.io/Tamatamatori/#shot=json:${encodeURIComponent(JSON.stringify(shot))}`]) {
    const parsed = parseShotText(text);
    assert.equal(parsed.ok, true, parsed.errors?.join());
    assert.deepEqual(parsed.plan, varied);
    assert.equal(parsed.shot.name, "悉尼 · 歌剧院 🌌");
    assert.deepEqual(parsed.defaults, []);
  }
  assert.ok(shareCode(shot).startsWith(SHARE_PREFIX)); assert.match(shareCode(shot), /^tmt1:[A-Za-z0-9_-]+$/);
  assert.ok(shareCode(shot).length < 1500);
  assert.equal(planSignature(varied), shotSignature(shot), "name and note do not count as picture changes");
  assert.notEqual(planSignature({ ...varied, azimuth: 123.45679 }), planSignature(varied));
  // Paths depend on their bodies, so they vary in a plan of their own.
  const paths = { ...varied, layers: { ...varied.layers, sun: true, sunPath: true, moon: true, moonPath: true } };
  assert.deepEqual(parseShotText(shareCode(shotFromPlan(paths))).plan, paths);
  assert.notEqual(planSignature(paths), planSignature({ ...paths, layers: { ...paths.layers, moonPath: false } }));
  // Shots saved before the path switches existed open with both paths off.
  const older = shotFromPlan(initialPlan);
  delete older.layers.sunPath; delete older.layers.moonPath;
  const reopened = parseShot(older);
  assert.deepEqual([reopened.plan.layers.sunPath, reopened.plan.layers.moonPath], [false, false]);
  assert.deepEqual(reopened.defaults, ["layers.sunPath", "layers.moonPath"]);
  // Likewise the meteor layer and its estimate switch.
  const beforeMeteors = shotFromPlan(initialPlan);
  delete beforeMeteors.layers.meteors; delete beforeMeteors.layers.meteorDensity;
  const meteorDefaults = parseShot(beforeMeteors);
  assert.deepEqual(meteorDefaults.defaults, ["layers.meteors", "layers.meteorDensity"]);
  assert.deepEqual([meteorDefaults.plan.layers.meteors, meteorDefaults.plan.layers.meteorDensity], [false, false]);
  // And the comet layer, added after the meteors.
  const beforeComets = shotFromPlan(varied);
  delete beforeComets.layers.comets;
  const cometDefaults = parseShot(beforeComets);
  assert.deepEqual([cometDefaults.defaults, cometDefaults.plan.layers.comets], [["layers.comets"], false]);
  // The shooting duration of an unreleased development build is read and ignored, never written.
  assert.deepEqual(Object.keys(shotFromPlan(varied).sky), ["milkyWayContrast"]);
  const devBuild = parseShot({ ...shotFromPlan(varied), sky: { milkyWayContrast: 135, meteorHours: 7.5 } });
  assert.equal(devBuild.ok, true, devBuild.errors?.join());
  assert.deepEqual([devBuild.plan, devBuild.defaults], [varied, []]);
  // The initial plan has no stored model; it round-trips as the default model.
  assert.deepEqual(planFromShot(shotFromPlan(initialPlan)), { ...initialPlan, weatherModel: "best_match" });
});

test("机位校验一次列出全部问题并带字段路径，未知字段和更新版本被拒绝", () => {
  const text = errorsOf({
    format: "tamatamatori.shot", version: 1, azimut: 3,
    position: { latitude: 95, longitude: "东经" }, view: { azimuth: 10, pitch: 91, roll: 0 },
    camera: { focalLength: 4, sensor: "medium-format", orientation: "square" },
    time: { instant: "2026-11-04 08:00", timeZone: "Mars/Olympus" },
    layers: { stars: false, constellations: true, rainbow: true }, sky: { milkyWayContrast: 300 },
    environment: { weather: "yes", weatherModel: "gfs" }, name: "x".repeat(41),
  });
  for (const path of ["azimut：未知字段", "position.latitude：应在 -90～90", "position.longitude：应为数字", "view.pitch：应在", "view.roll：未知字段",
    "camera.focalLength：应在 8～1000", "camera.sensor：应为", "camera.orientation", "time.instant：应为带 Z", "time.timeZone：应为有效的 IANA",
    "layers.rainbow：未知字段", "layers.constellations：需要同时开启", "sky.milkyWayContrast", "environment.weather：应为 true 或 false",
    "environment.weatherModel", "name：最多 40 字"])
    assert.ok(text.includes(path), `${path}\n${text}`);
  const orphanPaths = errorsOf(minimal({ layers: { sun: false, sunPath: true, moon: false, moonPath: true } }));
  assert.match(orphanPaths, /layers\.sunPath：需要同时开启 layers\.sun/);
  assert.match(orphanPaths, /layers\.moonPath：需要同时开启 layers\.moon/);
  const meteors = errorsOf(minimal({ layers: { meteors: false, meteorDensity: true }, sky: { meteorHours: 2, meteorMinutes: 5 } }));
  assert.match(meteors, /layers\.meteorDensity：需要同时开启 layers\.meteors/);
  assert.match(meteors, /sky\.meteorMinutes：未知字段/);
  assert.doesNotMatch(meteors, /meteorHours/);
  assert.match(errorsOf({ ...minimal(), version: 2 }), /更新版本/);
  assert.match(errorsOf({ ...minimal(), format: "other" }), /format：应为 "tamatamatori.shot"/);
  assert.match(errorsOf({ format: "tamatamatori.shot", version: 1 }), /position：缺少该字段[\s\S]*view：缺少该字段[\s\S]*time：缺少该字段/);
  assert.match(errorsOf("tmt1:%%%"), /分享码已损坏/);
  assert.match(errorsOf("tmt1:" + btoa("not json")), /JSON 格式错误/);
  assert.match(errorsOf("hello"), /无法识别/);
  assert.match(errorsOf("{ broken"), /JSON 格式错误/);
  assert.match(errorsOf(" ".repeat(SHOT_TEXT_LIMIT + 1)), /超过 16 KB/);
  assert.match(errorsOf("[]"), /无法识别/);
});

test("省略字段补默认值并列出，方位与经度取模归一，时区规范化", () => {
  const parsed = parseShot(minimal({ view: { azimuth: -10 }, position: { latitude: 35, longitude: 190 } }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan.azimuth, 350); assert.equal(parsed.plan.longitude, -170);
  assert.equal(parsed.plan.timeZone, "UTC"); assert.equal(parsed.plan.focalLength, initialPlan.focalLength);
  assert.deepEqual(parsed.plan.layers, { ...initialPlan.layers });
  for (const path of ["view.pitch", "position.heightAboveGround", "camera.focalLength", "camera.sensor", "time.timeZone", "time.refraction", "layers.stars", "environment.weatherModel"])
    assert.ok(parsed.defaults.includes(path), path);
  assert.equal(parseShot(minimal({ view: { azimuth: 370 } })).plan.azimuth, 10);
  assert.equal(validTimeZone("asia/tokyo"), "Asia/Tokyo"); assert.equal(validTimeZone("Mars/Base"), null);
  assert.equal(parseShot(minimal({ time: { instant: "2026-11-04T08:00:00Z", timeZone: "europe/paris" } })).plan.timeZone, "Europe/Paris");
});

test("当地时区标记：旧机位缺省为固定时区，跟随时可省略时区并按坐标求出，记录的时区照样复现，类型错误被拒绝", () => {
  const old = parseShot(minimal({ time: { instant: "2026-11-04T08:00:00Z", timeZone: "Asia/Tokyo" } }));
  assert.equal(old.plan.followLocalZone, false);
  assert.equal(old.defaults.includes("time.followLocalZone"), false);
  const follow = parseShot(minimal({ time: { instant: "2026-11-04T08:00:00Z", followLocalZone: true } }));
  assert.equal(follow.ok, true);
  assert.equal(follow.plan.timeZone, "Asia/Tokyo");
  assert.equal(follow.plan.followLocalZone, true);
  assert.equal(follow.defaults.includes("time.timeZone"), false);
  const local = parseShot(minimal({ position: { latitude: 48.8584, longitude: 2.2945 }, time: { local: "2026-07-14T22:30", followLocalZone: true } }));
  assert.equal(local.ok, true);
  assert.equal(local.plan.timeZone, "Europe/Paris");
  assert.equal(local.plan.instant, "2026-07-14T20:30:00Z");
  const recorded = parseShot(minimal({ time: { instant: "2026-11-04T08:00:00Z", timeZone: "UTC", followLocalZone: true } }));
  assert.equal(recorded.plan.timeZone, "UTC");
  assert.match(errorsOf(minimal({ time: { instant: "2026-11-04T08:00:00Z", followLocalZone: "yes" } })), /time\.followLocalZone/);
  assert.match(errorsOf(minimal({ time: { local: "2026-07-14T22:30" } })), /followLocalZone/);
  assert.equal(shotFromPlan({ ...initialPlan, followLocalZone: true }).time.followLocalZone, true);
  // ECMWF IFS 9 km replaced the 0.25° grid: older shots that chose it read as the 9 km model.
  for (const model of ["ecmwf_ifs", "ecmwf_ifs025"]) {
    const parsed = parseShot(minimal({ environment: { weatherModel: model } }));
    assert.equal(parsed.ok, true, model);
    assert.equal(parsed.plan.weatherModel, "ecmwf_ifs");
    assert.equal(parsed.shot.environment.weatherModel, "ecmwf_ifs");
  }
  assert.match(errorsOf(minimal({ environment: { weatherModel: "ecmwf_aifs" } })), /environment\.weatherModel/);
  assert.equal(shotFromPlan({ ...initialPlan, followLocalZone: undefined }).time.followLocalZone, false);
});

test("自定义传感器写入 sensorSize 并往返无损，预设不写尺寸，缺尺寸、越界或配错时报错", () => {
  const custom = { ...varied, sensor: "custom", customSensor: { width: 43.8, height: 32.9 } };
  const shot = shotFromPlan(custom);
  assert.deepEqual(shot.camera.sensorSize, { width: 43.8, height: 32.9 });
  assert.deepEqual(Object.keys(shot.camera), ["focalLength", "sensor", "sensorSize", "aspectRatio", "orientation", "response"]);
  const parsed = parseShot(JSON.parse(shotJson(shot)));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.plan, custom);
  assert.equal("sensorSize" in shotFromPlan(varied).camera, false);
  assert.equal(planFromShot(shotFromPlan(varied)).customSensor, null);
  const camera = (extra) => minimal({ camera: { sensor: "custom", ...extra } });
  assert.match(errorsOf(camera({})), /camera\.sensorSize：自定义传感器需要宽和高/);
  assert.match(errorsOf(camera({ sensorSize: { width: 0.5, height: 24 } })), /camera\.sensorSize\.width：应为 1—100 毫米/);
  assert.match(errorsOf(camera({ sensorSize: { width: 36, height: 24, depth: 1 } })), /camera\.sensorSize：应为/);
  assert.match(errorsOf(minimal({ camera: { sensor: "aps-c", sensorSize: { width: 36, height: 24 } } })), /只在 camera\.sensor 为 "custom" 时使用/);
});

test("当地时间加时区换算 UTC，夏令时跳过与重复的钟点和不一致的双写被拒绝", () => {
  const local = parseShot(minimal({ time: { local: "2026-12-15T02:30", timeZone: "Asia/Tokyo" } }));
  assert.equal(local.ok, true); assert.equal(local.plan.instant, "2026-12-14T17:30:00Z");
  assert.equal(local.shot.time.local, "2026-12-15T02:30:00");
  const both = parseShot(minimal({ time: { instant: "2026-12-14T17:30:12Z", local: "2026-12-15T02:30", timeZone: "Asia/Tokyo" } }));
  assert.equal(both.ok, true, "minute-precision local time agrees with the instant");
  assert.equal(both.plan.instant, "2026-12-14T17:30:12Z");
  assert.match(errorsOf(minimal({ time: { instant: "2026-12-14T17:30:00Z", local: "2026-12-15T03:30", timeZone: "Asia/Tokyo" } })), /与 time.instant 不一致/);
  assert.match(errorsOf(minimal({ time: { local: "2026-03-08T02:30", timeZone: "America/New_York" } })), /夏令时/);
  assert.match(errorsOf(minimal({ time: { local: "2026-11-01T01:30", timeZone: "America/New_York" } })), /夏令时/);
  assert.match(errorsOf(minimal({ time: { local: "2026-12-15T02:30" } })), /time.timeZone：使用 time.local 时必须/);
  assert.match(errorsOf(minimal({ time: { local: "2026-12-15T02:30Z", timeZone: "UTC" } })), /time.local：应为当地日期时间/);
  assert.match(errorsOf(minimal({ time: { instant: "2200-01-01T00:00:00Z" } })), /1900—2100/);
  assert.match(errorsOf(minimal({ time: { timeZone: "UTC" } })), /time：需要 instant/);
});

function memoryStorage(options = {}) {
  const data = new Map();
  return {
    data,
    getItem(key) { if (options.readFails) throw new Error("blocked"); return data.has(key) ? data.get(key) : null; },
    setItem(key, value) {
      if (options.quota) { const error = new Error("exceeded"); error.name = "QuotaExceededError"; throw error; }
      data.set(key, String(value));
    },
    removeItem(key) { data.delete(key); },
  };
}

test("本地机位库：不可用、配额不足、整体损坏与单条损坏分别处理，损坏条目原样保留", () => {
  assert.equal(readLibrary(null).phase, "unavailable");
  assert.equal(readLibrary(memoryStorage({ readFails: true })).phase, "unavailable");
  const storage = memoryStorage(), entry = { id: "a", createdAt: "2026-11-08T00:00:00Z", updatedAt: "2026-11-08T00:00:00Z", shot: shotFromPlan(varied, "悉尼") };
  assert.deepEqual(readLibrary(storage), { phase: "ready", shots: [], broken: [] });
  writeLibrary(storage, { phase: "ready", shots: [entry], broken: [] });
  assert.deepEqual(readLibrary(storage).shots, [entry]);
  const damaged = { id: "b", createdAt: "x", updatedAt: "x", shot: { format: "tamatamatori.shot", version: 1 } };
  storage.setItem(SHOT_LIBRARY_KEY, JSON.stringify({ version: 1, shots: [entry, damaged, 42] }));
  const library = readLibrary(storage);
  assert.equal(library.shots.length, 1); assert.equal(library.broken.length, 2);
  assert.match(library.broken[0].reason, /position/);
  writeLibrary(storage, library);
  assert.deepEqual(JSON.parse(storage.getItem(SHOT_LIBRARY_KEY)).shots.slice(1), [damaged, 42], "unreadable entries survive a rewrite");
  storage.setItem(SHOT_LIBRARY_KEY, "{oops");
  const corrupt = readLibrary(storage);
  assert.equal(corrupt.phase, "corrupt");
  assert.throws(() => writeLibrary(storage, corrupt), /暂停保存/);
  assert.equal(storage.getItem(SHOT_LIBRARY_KEY), "{oops", "corrupt data is not overwritten");
  assert.throws(() => writeLibrary(memoryStorage({ quota: true }), { phase: "ready", shots: [entry], broken: [] }), /空间不足/);
  assert.throws(() => writeLibrary(null, { phase: "unavailable", shots: [], broken: [] }), /无法使用本地存储/);
});

test("会话恢复往返当前计划与关联机位，损坏或缺失时安静回退", () => {
  const storage = memoryStorage();
  assert.equal(readSession(storage), null); assert.equal(readSession(null), null);
  assert.equal(writeSession(storage, varied, "a"), true);
  assert.deepEqual(readSession(storage), { plan: varied, activeId: "a" });
  writeSession(storage, initialPlan, null);
  assert.deepEqual(readSession(storage), { plan: { ...initialPlan, weatherModel: "best_match" }, activeId: null });
  storage.setItem(SHOT_SESSION_KEY, JSON.stringify({ version: 1, shot: { format: "tamatamatori.shot" } }));
  assert.equal(readSession(storage), null);
  storage.setItem(SHOT_SESSION_KEY, "{");
  assert.equal(readSession(storage), null);
  assert.equal(writeSession(memoryStorage({ quota: true }), varied, null), false);
});

test("时区列表覆盖常用城市，中文城市、英文、IANA 与 UTC 偏移均可搜索，偏移按拍摄时刻计算夏令时", () => {
  const zones = allTimeZones();
  for (const zone of ["UTC", "Asia/Shanghai", "Asia/Kolkata", "Europe/Kyiv", "Europe/Paris", "America/Argentina/Buenos_Aires"]) assert.ok(zones.includes(zone), zone);
  assert.ok(!zones.includes("Asia/Calcutta"), "renamed ids are listed once under the current name");
  assert.ok(zones.every((zone) => validTimeZone(zone)));
  const summer = "2026-07-01T00:00:00Z", winter = "2026-01-15T00:00:00Z";
  assert.equal(searchTimeZones("巴黎", summer)[0], "Europe/Paris");
  assert.equal(searchTimeZones("北京", summer)[0], "Asia/Shanghai");
  assert.equal(searchTimeZones("new york", summer)[0], "America/New_York");
  assert.equal(searchTimeZones("kolkata", summer)[0], "Asia/Kolkata");
  assert.ok(searchTimeZones("utc+5:30", summer).includes("Asia/Kolkata"));
  assert.ok(searchTimeZones("+9", summer).includes("Asia/Tokyo"));
  assert.ok(searchTimeZones("GMT-4", summer).includes("America/New_York"));
  assert.ok(!searchTimeZones("GMT-4", winter).includes("America/New_York"));
  assert.equal(zoneOffset("America/New_York", summer), "UTC−4"); assert.equal(zoneOffset("America/New_York", winter), "UTC−5");
  assert.equal(zoneOffset("UTC", summer), "UTC+0"); assert.equal(zoneOffset("Asia/Kathmandu", summer), "UTC+5:45");
  assert.deepEqual(searchTimeZones("zzzz", summer), []);
});

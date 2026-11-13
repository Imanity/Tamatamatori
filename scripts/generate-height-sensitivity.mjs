// Offline replay of the recorded camera; no DEM/geoid requests or app changes.
import { readFile, writeFile } from "node:fs/promises";
import { compareEarthModels } from "../src/render/scene/calibration-math.ts";

const source = "docs/plan/curvature-evidence/measurements.json";
const document = JSON.parse(await readFile(source, "utf8"));
const record = document.records.find(r => r.name === "fuji-1000-landscape");
if (!record?.ready || record.target.renderedDem === null) throw new Error("Stable source measurement is required");
const eye = { longitude: record.eye.longitude, latitude: record.eye.latitude, altitude: record.eye.altitude };
const target = { longitude: record.target.longitude, latitude: record.target.latitude, altitude: record.target.renderedDem };
const plan = { ...record.plan, azimuth: (record.eye.bearing % 360 + 360) % 360, pitch: record.eye.pitch };
const cases = [
  { name: "基准条件", eyeOffset: 0, targetOffset: 0 },
  { name: "两端同加 40 m（合成）", eyeOffset: 40, targetOffset: 40 },
  { name: "仅目标加 1 m（合成）", eyeOffset: 0, targetOffset: 1 },
  { name: "仅眼点加 1 m（合成）", eyeOffset: 1, targetOffset: 0 },
].map(c => ({ ...c, comparison: compareEarthModels(plan,
  { ...eye, altitude: eye.altitude + c.eyeOffset }, { ...target, altitude: target.altitude + c.targetOffset },
  record.width, record.height) }));
const baseline = cases[0].comparison.ellipsoid;
const records = cases.map(c => ({ ...c, deltaFromBaseline: {
  pitch: c.comparison.ellipsoid.pitch - baseline.pitch,
  x: c.comparison.ellipsoid.pixel.x - baseline.pixel.x,
  y: c.comparison.ellipsoid.pixel.y - baseline.pixel.y,
} }));
await writeFile("docs/plan/elevation-datum-evidence/height-sensitivity.json", JSON.stringify({
  source: `${source} / ${record.name}`,
  heightAssumption: "全部偏移均为合成输入；40 m 不是实测 geoid 值，也未用于修正正式 DEM。",
  eye, target, plan, width: record.width, height: record.height, cases: records,
}, null, 2) + "\n");
console.log("Saved 4 synthetic height cases; no real geoid conversion applied");

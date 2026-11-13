import { json2satrec, propagate, gstime, eciToEcf, ecfToLookAngles, eciToGeodetic, sunPos, shadowFraction, jday } from "satellite.js";
import type { OMMJsonObject } from "satellite.js";
import type { ShootingPlan } from "../core/plan.ts";
import type { SkyPoint } from "../sky/starfield.ts";
import { degrees, direction } from "../core/ephemeris.ts";
import { orbitEpoch, orbitWindow, stationCatalog } from "./orbit-data.ts";
import type { OrbitSnapshot } from "./orbit-data.ts";

export interface StationPoint extends SkyPoint {
  noradId: number;
  epoch: string;
  rangeKm: number;
  latitude: number;
  longitude: number;
  heightKm: number;
  shadow: number;
}
export interface StationScene {
  key: string;
  points: StationPoint[];
  trail: SkyPoint[];
  rows: { id: string; name: string; epoch?: string; message: string; point?: StationPoint }[];
}

export function stationPosition(plan: ShootingPlan, element: OMMJsonObject, altitude = plan.cameraHeight): StationPoint {
  const date = new Date(plan.instant);
  if (![plan.latitude, plan.longitude, altitude, date.getTime()].every(Number.isFinite) ||
      Math.abs(plan.latitude) > 90 || Math.abs(plan.longitude) > 180)
    throw new Error("空间站观察点或时间无效");
  const satellite = json2satrec(element);
  const result = propagate(satellite, date);
  if (!result || satellite.error || !result.position) throw new Error("轨道传播失败");
  const sidereal = gstime(date), ecf = eciToEcf(result.position, sidereal);
  const observer = { latitude: plan.latitude * degrees, longitude: plan.longitude * degrees, height: altitude / 1000 };
  const look = ecfToLookAngles(observer, ecf);
  const subpoint = eciToGeodetic(result.position, sidereal);
  const station = stationCatalog.find((entry) => entry.noradId === element.NORAD_CAT_ID);
  if (!station || ![look.azimuth, look.elevation, look.rangeSat, subpoint.height].every(Number.isFinite))
    throw new Error("空间站坐标无效");
  const azimuth = (look.azimuth / degrees + 360) % 360, elevation = look.elevation / degrees;
  return {
    id: station.id, noradId: station.noradId, name: station.name, epoch: element.EPOCH,
    azimuth, elevation, direction: direction(azimuth, elevation), magnitude: 0,
    color: station.noradId === 25544 ? [0.68, 0.93, 1] : [1, 0.81, 0.47],
    rangeKm: look.rangeSat, latitude: subpoint.latitude / degrees, longitude: subpoint.longitude / degrees,
    heightKm: subpoint.height, shadow: shadowFraction(sunPos(jday(date)).rsun, result.position),
  };
}

export function stationScene(plan: ShootingPlan, snapshot: OrbitSnapshot | null, altitude?: number): StationScene {
  const key = JSON.stringify([plan.latitude, plan.longitude, plan.instant, altitude ?? plan.cameraHeight, snapshot?.objects]);
  const points: StationPoint[] = [], trail: SkyPoint[] = [];
  const rows = stationCatalog.map((station) => {
    const element = snapshot?.objects.find((entry) => entry.NORAD_CAT_ID === station.noradId);
    if (!element) return { ...station, message: "缺少轨道数据" };
    const window = orbitWindow(element.EPOCH, plan.instant);
    if (window.state === "expired") return { ...station, epoch: element.EPOCH, message: "轨道数据超过 72 小时，已停止绘制" };
    try {
      const point = stationPosition(plan, element, altitude);
      points.push(point);
      for (let seconds = -180; seconds <= 180; seconds += 10) {
        if (seconds === 0) continue;
        const instant = new Date(Date.parse(plan.instant) + seconds * 1000).toISOString();
        if (Math.abs(Date.parse(instant) - orbitEpoch(element.EPOCH)) > 72 * 3_600_000) continue;
        const sample = stationPosition({ ...plan, instant }, element, altitude);
        trail.push({ ...sample, name: undefined, id: `${station.id}-trail-${seconds}`, magnitude: 4 });
      }
      return { ...station, point, epoch: element.EPOCH, message: window.state === "warning" ? "轨道数据较旧，位置仅供参考" : "" };
    } catch {
      return { ...station, epoch: element.EPOCH, message: "轨道传播失败，停止绘制" };
    }
  });
  return { key, rows, points, trail };
}

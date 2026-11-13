import type { OMMJsonObject } from "satellite.js";

export const ORBIT_SOURCE = "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json";
export const ORBIT_REFRESH_MS = 2 * 60 * 60 * 1000;
export const stationCatalog = [
  { id: "station-25544", noradId: 25544, name: "国际空间站 ISS", aliases: ["ISS", "国际空间站", "25544", "ZARYA"] },
  { id: "station-48274", noradId: 48274, name: "天宫空间站", aliases: ["天宫", "天和", "Tiangong", "CSS", "48274", "TIANHE"] },
] as const;

export function matchingStations(query: string) {
  const words = query.normalize("NFKC").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return stationCatalog.filter((station) => words.every((word) =>
    [station.name, ...station.aliases].join(" ").toLowerCase().includes(word),
  ));
}

export interface OrbitSnapshot {
  version: 1;
  source: string;
  fetchedAt: string | null;
  attemptedAt: string | null;
  status: "seed" | "ready" | "error";
  error: string | null;
  blocked: boolean;
  /**
   * Stations whose published element was kept because upstream served an older
   * epoch or none; a successful check, not a pause.
   */
  notice?: string | null;
  objects: OMMJsonObject[];
}

/** CelesTrak's omitted time-system field defaults to UTC, never local time. */
export function orbitEpoch(value: string) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z?$/.test(value))
    throw new Error("轨道历元格式无效");
  const time = Date.parse(value.endsWith("Z") ? value : `${value}Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19))
    throw new Error("轨道历元无效");
  return time;
}

export function stationElements(value: unknown): OMMJsonObject[] {
  if (!Array.isArray(value)) throw new Error("轨道数据应为数组");
  const selected: OMMJsonObject[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") throw new Error("轨道条目无效");
    const row = raw as Record<string, unknown>;
    if (!stationCatalog.some((station) => station.noradId === row.NORAD_CAT_ID)) continue;
    if (selected.some((entry) => entry.NORAD_CAT_ID === row.NORAD_CAT_ID))
      throw new Error("空间站目录编号重复");
    if (typeof row.OBJECT_NAME !== "string" || typeof row.OBJECT_ID !== "string" || typeof row.EPOCH !== "string")
      throw new Error("轨道身份或历元缺失");
    orbitEpoch(row.EPOCH);
    for (const key of ["MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT", "REV_AT_EPOCH", "ELEMENT_SET_NO"]) {
      if (typeof row[key] !== "number" || !Number.isFinite(row[key]))
        throw new Error(`轨道数值无效 · ${key}`);
    }
    if (Number(row.MEAN_MOTION) < 10 || Number(row.MEAN_MOTION) > 18 ||
        Number(row.ECCENTRICITY) < 0 || Number(row.ECCENTRICITY) >= 0.1 ||
        Number(row.INCLINATION) < 0 || Number(row.INCLINATION) > 180)
      throw new Error("空间站轨道参数超出范围");
    for (const key of ["RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY"]) {
      if (Number(row[key]) < 0 || Number(row[key]) >= 360) throw new Error("轨道角度超出范围");
    }
    if ((row.CENTER_NAME && row.CENTER_NAME !== "EARTH") ||
        (row.TIME_SYSTEM && row.TIME_SYSTEM !== "UTC") ||
        (row.REF_FRAME && row.REF_FRAME !== "TEME") ||
        (row.MEAN_ELEMENT_THEORY && row.MEAN_ELEMENT_THEORY !== "SGP4") ||
        (row.EPHEMERIS_TYPE !== undefined && row.EPHEMERIS_TYPE !== 0))
      throw new Error("轨道坐标或传播模型不受支持");
    selected.push({ ...row } as unknown as OMMJsonObject);
  }
  return selected;
}

export function validateOrbitSnapshot(value: unknown, now = Date.now()): OrbitSnapshot {
  const data = value as OrbitSnapshot;
  if (!data || data.version !== 1 || data.source !== ORBIT_SOURCE ||
      !["seed", "ready", "error"].includes(data.status) || typeof data.blocked !== "boolean" ||
      !(data.error === null || typeof data.error === "string") ||
      !(data.notice === undefined || data.notice === null || typeof data.notice === "string"))
    throw new Error("轨道快照格式或来源无效");
  for (const stamp of [data.fetchedAt, data.attemptedAt]) {
    if (stamp !== null && (typeof stamp !== "string" || !stamp.endsWith("Z") ||
        !Number.isFinite(Date.parse(stamp)) || Date.parse(stamp) > now + 300_000))
      throw new Error("轨道检查时间无效");
  }
  if (data.status === "ready" && (!data.fetchedAt || !data.attemptedAt))
    throw new Error("上游成功检查时间缺失");
  if ((data.status === "ready" && (data.blocked || data.error !== null)) ||
      (data.status === "error" && (!data.blocked || !data.error || !data.attemptedAt)) ||
      (data.status === "seed" && (data.fetchedAt !== null || data.attemptedAt !== null || data.blocked || data.error !== null)))
    throw new Error("轨道更新状态与时间记录不一致");
  if (data.fetchedAt && data.attemptedAt && Date.parse(data.fetchedAt) > Date.parse(data.attemptedAt))
    throw new Error("轨道检查时间顺序无效");
  return { ...data, objects: stationElements(data.objects) };
}

export function assertOrbitProgress(previous: OrbitSnapshot | null, next: OrbitSnapshot) {
  if (previous?.attemptedAt && (!next.attemptedAt || Date.parse(next.attemptedAt) < Date.parse(previous.attemptedAt)))
    throw new Error("轨道检查记录回退，保留本地快照");
  for (const entry of next.objects) {
    const old = previous?.objects.find((object) => object.NORAD_CAT_ID === entry.NORAD_CAT_ID);
    if (old && orbitEpoch(entry.EPOCH) < orbitEpoch(old.EPOCH))
      throw new Error("轨道历元回退，保留较新的有效快照");
  }
  if (previous?.fetchedAt && (!next.fetchedAt || Date.parse(next.fetchedAt) < Date.parse(previous.fetchedAt)))
    throw new Error("已发布快照回退，保留本地有效数据");
}

export function orbitWindow(epoch: string, instant: string) {
  const hours = Math.abs(Date.parse(instant) - orbitEpoch(epoch)) / 3_600_000;
  if (!Number.isFinite(hours)) throw new Error("拍摄时刻无效");
  return { hours, state: hours > 72 ? "expired" : hours > 24 ? "warning" : "current" } as const;
}

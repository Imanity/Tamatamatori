import { validTimeZone } from "./shot.ts";

/** Chinese city names for common zones; the first name is shown, all are searchable. */
const zoneCities: Record<string, string> = {
  UTC: "协调世界时 UTC GMT",
  "Asia/Shanghai": "北京 上海 中国",
  "Asia/Hong_Kong": "香港",
  "Asia/Taipei": "台北",
  "Asia/Macau": "澳门",
  "Asia/Urumqi": "乌鲁木齐",
  "Asia/Tokyo": "东京 日本",
  "Asia/Seoul": "首尔 韩国",
  "Asia/Singapore": "新加坡",
  "Asia/Bangkok": "曼谷 泰国",
  "Asia/Ho_Chi_Minh": "胡志明市 越南",
  "Asia/Kolkata": "新德里 孟买 印度",
  "Asia/Kathmandu": "加德满都 尼泊尔",
  "Asia/Dubai": "迪拜",
  "Asia/Ulaanbaatar": "乌兰巴托 蒙古",
  "Asia/Jakarta": "雅加达",
  "Asia/Manila": "马尼拉",
  "Europe/London": "伦敦 英国",
  "Europe/Paris": "巴黎 法国",
  "Europe/Berlin": "柏林 德国",
  "Europe/Rome": "罗马 意大利",
  "Europe/Madrid": "马德里 西班牙",
  "Europe/Zurich": "苏黎世 瑞士",
  "Europe/Moscow": "莫斯科 俄罗斯",
  "Europe/Istanbul": "伊斯坦布尔 土耳其",
  "Atlantic/Reykjavik": "雷克雅未克 冰岛",
  "Africa/Cairo": "开罗 埃及",
  "Africa/Johannesburg": "约翰内斯堡 开普敦 南非",
  "Africa/Nairobi": "内罗毕 肯尼亚",
  "America/New_York": "纽约 华盛顿 美东",
  "America/Chicago": "芝加哥 美中",
  "America/Denver": "丹佛 美山地",
  "America/Phoenix": "凤凰城",
  "America/Los_Angeles": "洛杉矶 旧金山 美西",
  "America/Anchorage": "安克雷奇 阿拉斯加",
  "Pacific/Honolulu": "檀香山 夏威夷",
  "America/Toronto": "多伦多",
  "America/Vancouver": "温哥华",
  "America/Mexico_City": "墨西哥城",
  "America/Sao_Paulo": "圣保罗 巴西",
  "America/Argentina/Buenos_Aires": "布宜诺斯艾利斯 阿根廷",
  "America/Santiago": "圣地亚哥 智利",
  "Australia/Sydney": "悉尼 澳大利亚",
  "Australia/Perth": "珀斯",
  "Pacific/Auckland": "奥克兰 新西兰",
};
/** ICU still lists some renamed zones under their old ids. */
const renamed: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
};
export const commonTimeZones = ["Asia/Shanghai", "Asia/Tokyo", "UTC", "Europe/London", "America/New_York"];

let cachedZones: string[] | null = null;
export function allTimeZones() {
  if (cachedZones) return cachedZones;
  let listed: string[] = [];
  try {
    listed = Intl.supportedValuesOf("timeZone");
  } catch {
    /* Older browsers: fall back to the named zones below. */
  }
  const zones = new Set<string>();
  for (const zone of [...listed, ...Object.keys(zoneCities)]) {
    const modern = renamed[zone] && validTimeZone(renamed[zone]) ? renamed[zone] : zone;
    if (validTimeZone(modern)) zones.add(modern);
  }
  cachedZones = [...zones];
  return cachedZones;
}

const offsetFormats = new Map<string, Intl.DateTimeFormat>();
const genericFormats = new Map<string, Intl.DateTimeFormat>();
const part = (format: Intl.DateTimeFormat, date: Date) =>
  format.formatToParts(date).find((item) => item.type === "timeZoneName")?.value ?? "";

/** UTC offset in force at the given instant, e.g. "UTC+9", "UTC+5:30", "UTC−3". */
export function zoneOffset(zone: string, instant: string) {
  let format = offsetFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" });
    offsetFormats.set(zone, format);
  }
  const value = part(format, new Date(instant)).replace(/^GMT/, "");
  return `UTC${value ? value.replace("-", "−") : "+0"}`;
}
/** Minutes east of UTC at the instant, for sorting. */
export function zoneOffsetMinutes(zone: string, instant: string) {
  const match = zoneOffset(zone, instant).match(/UTC([+−])(\d+)(?::(\d+))?/);
  if (!match) return 0;
  return (match[1] === "−" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}
/** Localised generic name such as "日本时间"; empty when ICU only has an offset. */
export function zoneGenericName(zone: string, instant: string) {
  let format = genericFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("zh-CN", { timeZone: zone, timeZoneName: "longGeneric" });
    genericFormats.set(zone, format);
  }
  const name = part(format, new Date(instant));
  return /^(GMT|UTC)/.test(name) ? "" : name;
}
export function zoneCity(zone: string) {
  return zoneCities[zone]?.split(" ")[0] ?? zone.split("/").at(-1)!.replace(/_/g, " ");
}

/** Matches city names (Chinese or English), IANA ids, generic names and offsets such as "+9" or "UTC+5:30". */
export function searchTimeZones(query: string, instant: string, zones = allTimeZones()) {
  let needle = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!needle) return zones;
  // Offset queries ("utc-3", "GMT+5:30", "+9") use the display minus sign.
  if (/^(gmt|utc)?\s*[+\-−]\d/.test(needle)) needle = needle.replace(/^gmt/, "utc").replace(/\s/g, "").replace("-", "−");
  const scored: { zone: string; score: number }[] = [];
  for (const zone of zones) {
    const city = zoneCity(zone).toLowerCase(), names = (zoneCities[zone] ?? "").toLowerCase();
    const id = zone.toLowerCase(), spaced = id.replace(/_/g, " ");
    const offset = zoneOffset(zone, instant).toLowerCase();
    const haystack = `${id} ${spaced} ${names} ${zoneGenericName(zone, instant).toLowerCase()} ${offset}`;
    let score = -1;
    if (city.startsWith(needle) || names.split(" ").some((name) => name.startsWith(needle))) score = 0;
    else if (spaced.split("/").some((segment) => segment.startsWith(needle))) score = 1;
    else if (offset === needle || offset === `utc${needle}`) score = 2;
    else if (haystack.includes(needle)) score = 3;
    if (score >= 0) scored.push({ zone, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.zone.localeCompare(b.zone)).map((item) => item.zone);
}

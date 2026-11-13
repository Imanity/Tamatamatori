// One-shot, online comparison of the 推算 solvers with public Diamond Fuji
// records (docs/plan/alignment-validation.md). Reads GSI elevations and DEM
// tiles (cached under .cache/), runs the app's own solvers and writes
// tests/fixtures/alignment-validation.json. Not part of the app or CI.
//   node --experimental-strip-types scripts/alignment-validation.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ellipsoidalRay } from '../src/domain/core/geodesy.ts';
import { bodyTrack, corridor, solvePositions } from '../src/domain/solve/position-alignment.ts';
import { DAY, ZONE, afternoon, dayNumber, dayStart, local, minute, nearestRange, passesOf, round, seasons } from './lib/alignment-validation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = resolve(root, '.cache/alignment-validation');
const EYE = 1.6;
const DEM_ZOOM = 14;
const degrees = Math.PI / 180;
const SUMMIT = { latitude: 35.360625, longitude: 138.727363 }; // 剣ヶ峰（国土地理院）
const SUMMIT_RADIUS = 1400;
// The summit platform: the silhouette no more than this many metres (at the
// target's distance) below its highest point.
const TOP_DROP = 100;

export const sources = {
  photos: { name: '山中湖観光情報「山中湖村・忍野村からのダイヤモンド富士撮影ポイント」', url: 'https://www.yamanakako.info/photo_diamond.php',
    note: '照片 EXIF 拍摄时刻；页面注明不是日落起止时刻、相机时钟可能有误；未写年份，按页面推断为 2025—26 季' },
  mlit: { name: '出典：関東地方整備局ウェブサイト「関東の富士見百景」ダイヤモンド富士', url: 'https://www.ktr.mlit.go.jp/chiiki/chiiki00000111.html',
    note: 'Kashmir 3D 模拟、不计海拔、部分坐标为地图目测；无年份；公共数据利用规约（PDL1.0）。本文件只摘日期，已按对照需要整理' },
  mlitYamanaka: { name: '出典：関東地方整備局ウェブサイト「【118】山中湖村からの富士」', url: 'https://www.ktr.mlit.go.jp/chiiki/fujimi0118.html', note: '同上' },
  skytree: { name: '东京晴空塔城公告（经媒体转载）', url: 'https://www.enjoytokyo.jp/event/2004310/', note: '2026-11-08 约 16:30，天望甲板（350 m）与天望回廊（450 m）' },
  takao: { name: 'Walkerplus 高尾山钻石富士介绍', url: 'https://www.walkerplus.com/article/1303736/', note: '2025-12-17—28，16:00—16:15 左右，山顶与もみじ台' },
  kirara: { name: 'たびねす「山中湖アイスキャンドルフェスティバル」', url: 'https://tabi-mag.jp/yamanaka-icecandle/', note: '2026-02-22 会场きらら，钻石富士约 16:34' },
  osm: { name: 'OpenStreetMap 命名要素（ODbL）', url: 'https://www.openstreetmap.org/' },
  gsi: { name: '国土地理院 地名検索・標高 API・DEM（10 m 文本瓦片）', url: 'https://maps.gsi.go.jp/development/ichiran.html' },
};

// Positions: OSM named features (centres of parks) or GSI place names. `height` is the eye above the ground.
export const places = {
  panorama: { name: 'パノラマ台', latitude: 35.41261, longitude: 138.90948, source: 'OSM node 1668712785 tourism=viewpoint', uncertainty: 150 },
  asahigaoka: { name: '旭日丘湖畔緑地公園', latitude: 35.40833, longitude: 138.87860, source: 'OSM node 12620594155 leisure=park', uncertainty: 300 },
  kirara: { name: '山中湖交流プラザきらら', latitude: 35.41982, longitude: 138.90135, source: 'OSM way 251691762 (きらら) 中心', uncertainty: 400 },
  takazasu: { name: '高指山', latitude: 35.43292, longitude: 138.92638, source: 'OSM node 2008147278 natural=peak', uncertainty: 50 },
  nagaike: { name: '長池親水公園', latitude: 35.42702, longitude: 138.87113, source: 'OSM way 182491499 leisure=park 中心', uncertainty: 250 },
  ohira: { name: '大平山', latitude: 35.43910, longitude: 138.87944, source: 'OSM node 2294516185 natural=peak', uncertainty: 50 },
  ishiwari: { name: '石割山', latitude: 35.45049, longitude: 138.90136, source: 'OSM node 1863871113 natural=peak', uncertainty: 50 },
  hananomiyako: { name: '花の都公園', latitude: 35.43955, longitude: 138.85284, source: 'OSM way 1153654786 leisure=park 中心', uncertainty: 500 },
  nijumagari: { name: '二十曲峠', latitude: 35.45704, longitude: 138.89234, source: 'OSM node 11902780376 tourism=viewpoint', uncertainty: 100 },
  takao: { name: '高尾山', latitude: 35.62523, longitude: 139.24358, source: '国土地理院 地名検索', uncertainty: 100 },
  nokogiri: { name: '鋸山', latitude: 35.16042, longitude: 139.84086, source: '国土地理院 地名検索', uncertainty: 100 },
  ogusu: { name: '大楠山', latitude: 35.25007, longitude: 139.62812, source: '国土地理院 地名検索', uncertainty: 100 },
  shonandaira: { name: '湘南平', latitude: 35.31987, longitude: 139.30874, source: 'OSM（Nominatim）natural=peak', uncertainty: 150 },
  azuma: { name: '吾妻山（二宮町）', latitude: 35.30038, longitude: 139.25063, source: '国土地理院 地名検索（吾妻山公園）', uncertainty: 200 },
  ono: { name: '大野山', latitude: 35.38601, longitude: 139.04879, source: '国土地理院 地名検索', uncertainty: 100 },
  kobo: { name: '弘法山', latitude: 35.37513, longitude: 139.25021, source: '国土地理院 地名検索', uncertainty: 100 },
  osanbashi: { name: '横浜港大さん橋', latitude: 35.45194, longitude: 139.64794, source: 'OSM（Nominatim）ferry_terminal', uncertainty: 250, height: 15, ground: 0 },
  bunkyo: { name: '文京シビックセンター展望ラウンジ', latitude: 35.70801, longitude: 139.75222, source: 'OSM（Nominatim）office', uncertainty: 50, height: 105 },
  minobu: { name: '身延山', latitude: 35.39755, longitude: 138.41627, source: '国土地理院 地名検索', uncertainty: 100 },
  skytree350: { name: '東京スカイツリー天望デッキ', latitude: 35.71005, longitude: 139.81071, source: 'OSM（Nominatim）attraction', uncertainty: 30, height: 350 },
  skytree450: { name: '東京スカイツリー天望回廊', latitude: 35.71005, longitude: 139.81071, source: 'OSM（Nominatim）attraction', uncertainty: 30, height: 450 },
};

// Group A: photo times (date, local time, place); the seasons are inferred as 2025–26.
export const photos = [
  ['2025-10-15', '16:22', 'panorama', 'パノラマ台上'],
  ['2025-10-17', '16:10', 'asahigaoka', '旭日丘湖畔'],
  ['2025-10-24', '16:05', 'kirara', 'きらら前'],
  ['2025-11-01', '16:07', 'takazasu', '高指山'],
  ['2025-11-06', '15:45', 'nagaike', '長池親水公園'],
  ['2025-11-07', '15:42', 'nagaike', '長池親水公園'],
  ['2025-11-19', '15:44', 'ohira', '大平山山頂'],
  ['2025-11-23', '15:47', 'ishiwari', '石割山頂'],
  ['2025-11-30', '15:23', 'hananomiyako', '花の都公園'],
  ['2026-02-04', '16:13', 'nagaike', '長池親水公園'],
  ['2026-02-11', '16:37', 'takazasu', '高指山'],
  ['2026-02-16', '16:34', 'kirara', '山中湖交流プラザきらら'],
  ['2026-02-22', '16:35', 'asahigaoka', '旭日丘湖畔'],
  ['2026-02-24', '16:45', 'panorama', 'パノラマ台上'],
].map(([date, time, place, label]) => ({ date, time, place, label }));

// Group B: MLIT date ranges (no year; compared with 2026). Month-day pairs, inclusive.
export const schedules = [
  ['nagaike', 'mlitYamanaka', 'sunset', [['02-07', '02-08'], ['11-03', '11-04']]],
  ['takazasu', 'mlitYamanaka', 'sunset', [['02-10', '02-11'], ['10-30', '10-31']]],
  ['ohira', 'mlitYamanaka', 'sunset', [['01-28', '01-29'], ['11-13', '11-14']]],
  ['panorama', 'mlitYamanaka', 'sunset', [['02-22', '02-23'], ['10-18', '10-19']]],
  ['asahigaoka', 'mlitYamanaka', 'sunset', [['02-23', '02-24'], ['10-18', '10-19']]],
  ['kirara', 'mlitYamanaka', 'sunset', [['02-14', '02-15'], ['10-26', '10-27']]],
  ['hananomiyako', 'mlitYamanaka', 'sunset', [['12-14', '12-31']]],
  ['nijumagari', 'mlit', 'sunset', [['01-06', '01-08'], ['12-05', '12-07']]],
  ['takao', 'mlit', 'sunset', [['12-17', '12-26']]],
  ['nokogiri', 'mlit', 'sunset', [['04-18', '04-19'], ['08-23', '08-24']]],
  ['ogusu', 'mlit', 'sunset', [['04-11', '04-11'], ['08-31', '09-01']]],
  ['shonandaira', 'mlit', 'sunset', [['04-04', '04-05'], ['09-07', '09-07']]],
  ['azuma', 'mlit', 'sunset', [['04-13', '04-15'], ['09-08', '09-08']]],
  ['ono', 'mlit', 'sunset', [['03-18', '03-19'], ['09-24', '09-25']]],
  ['kobo', 'mlit', 'sunset', [['03-24', '03-24'], ['09-18', '09-18']]],
  ['osanbashi', 'mlit', 'sunset', [['03-09', '03-10'], ['10-03', '10-04']]],
  ['bunkyo', 'mlit', 'sunset', [['02-01', '02-02'], ['11-09', '11-10']]],
  ['minobu', 'mlit', 'sunrise', [['03-13', '03-13'], ['10-02', '10-02']]],
].map(([place, source, event, ranges]) => ({ place, source, event, ranges }));

// Group C: announced times.
export const announcements = [
  { place: 'skytree350', source: 'skytree', date: '2026-11-08', time: '16:30', approximate: true },
  { place: 'skytree450', source: 'skytree', date: '2026-11-08', time: '16:30', approximate: true },
  { place: 'takao', source: 'takao', dates: ['2025-12-17', '2025-12-28'], window: ['16:00', '16:15'] },
  { place: 'kirara', source: 'kirara', date: '2026-02-22', time: '16:34', approximate: true },
];

// ---- GSI access, cached.
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function cached(name, load) {
  const file = resolve(cache, name);
  try {
    return await readFile(file, 'utf8');
  } catch {
    await mkdir(dirname(file), { recursive: true });
    const text = await load();
    await writeFile(file, text);
    await sleep(200);
    return text;
  }
}
async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'tamatamatori-validation/1.0' }, signal: AbortSignal.timeout(20000) });
  if (response.status === 404) return '';
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}
async function groundElevation(place) {
  if (place.ground !== undefined) return { value: place.ground, source: '固定值（码头面近似）' };
  const text = await cached(`elevation/${place.latitude}_${place.longitude}.json`,
    () => fetchText(`https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${place.longitude}&lat=${place.latitude}&outtype=JSON`));
  const json = JSON.parse(text);
  if (typeof json.elevation !== 'number') throw new Error(`no GSI elevation for ${place.name}`);
  return { value: json.elevation, source: `国土地理院標高 API（${json.hsrc}）` };
}
const tiles = new Map();
async function demTile(x, y) {
  const key = `${x}/${y}`;
  if (tiles.has(key)) return tiles.get(key);
  const text = await cached(`dem/${DEM_ZOOM}-${x}-${y}.txt`, () => fetchText(`https://cyberjapandata.gsi.go.jp/xyz/dem/${DEM_ZOOM}/${x}/${y}.txt`));
  const values = new Float64Array(256 * 256).fill(Number.NaN);
  text.trim().split(/\r?\n/).forEach((row, j) => row.split(',').forEach((cell, i) => {
    if (j < 256 && i < 256 && cell !== 'e') values[j * 256 + i] = Number(cell);
  }));
  tiles.set(key, text ? values : null);
  return tiles.get(key);
}
const scale = 256 * 2 ** DEM_ZOOM;
const worldPixel = (latitude, longitude) => ({
  x: ((longitude + 180) / 360) * scale,
  y: ((1 - Math.asinh(Math.tan(latitude * degrees)) / Math.PI) / 2) * scale,
});
const pixelPoint = (x, y) => ({ longitude: (x / scale) * 360 - 180, latitude: Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / scale))) / degrees });
function cell(px, py) {
  const tile = tiles.get(`${Math.floor(px / 256)}/${Math.floor(py / 256)}`);
  if (!tile) return null;
  const value = tile[(py % 256) * 256 + (px % 256)];
  return Number.isFinite(value) ? value : null;
}
/** Bilinear between cell centres over loaded tiles; null outside them. */
function sampler(latitude, longitude) {
  const { x, y } = worldPixel(latitude, longitude);
  const fx = x - 0.5, fy = y - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), u = fx - x0, v = fy - y0;
  const values = [cell(x0, y0), cell(x0 + 1, y0), cell(x0, y0 + 1), cell(x0 + 1, y0 + 1)];
  if (values.some((value) => value === null)) return null;
  return (values[0] * (1 - u) + values[1] * u) * (1 - v) + (values[2] * (1 - u) + values[3] * u) * v;
}
async function loadAround(points) {
  const wanted = new Set();
  for (const point of points) {
    const { x, y } = worldPixel(point.latitude, point.longitude);
    // The tile under the point, and a neighbour only within ~150 m of an edge.
    for (const dx of [-20, 0, 20]) for (const dy of [-20, 0, 20])
      wanted.add(`${Math.floor((x + dx) / 256)}/${Math.floor((y + dy) / 256)}`);
  }
  for (const key of wanted) {
    const [x, y] = key.split('/').map(Number);
    await demTile(x, y);
  }
}

// ---- Geometry.
const metresBetween = (a, b) => {
  const north = (b.latitude - a.latitude) * 111_132, east = (b.longitude - a.longitude) * 111_320 * Math.cos(((a.latitude + b.latitude) / 2) * degrees);
  return { east, north, distance: Math.hypot(east, north) };
};
const direction = (eye, point) => {
  const [east, north, up] = ellipsoidalRay(eye, point);
  return { azimuth: ((Math.atan2(east, north) / degrees) % 360 + 360) % 360, elevation: Math.atan2(up, Math.hypot(east, north)) / degrees };
};
/** The summit platform seen from the eye: its middle azimuth, silhouette height there and the DEM cell that forms it. */
async function summitMark(eye) {
  const centre = worldPixel(SUMMIT.latitude, SUMMIT.longitude);
  const reach = SUMMIT_RADIUS / (40_075_016.7 * Math.cos(SUMMIT.latitude * degrees) / scale);
  for (let tx = Math.floor((centre.x - reach) / 256); tx <= Math.floor((centre.x + reach) / 256); tx++)
    for (let ty = Math.floor((centre.y - reach) / 256); ty <= Math.floor((centre.y + reach) / 256); ty++) await demTile(tx, ty);
  const distance = metresBetween(eye, SUMMIT).distance;
  const bin = Math.max(0.002, (0.6 * 10) / distance / degrees);
  const bins = new Map();
  for (let px = Math.floor(centre.x - reach); px <= Math.ceil(centre.x + reach); px++)
    for (let py = Math.floor(centre.y - reach); py <= Math.ceil(centre.y + reach); py++) {
      const height = cell(px, py);
      if (height === null) continue;
      const point = pixelPoint(px + 0.5, py + 0.5);
      if (metresBetween(SUMMIT, point).distance > SUMMIT_RADIUS) continue;
      const seen = direction(eye, { ...point, ellipsoidalHeight: height });
      const index = Math.round(seen.azimuth / bin);
      const best = bins.get(index);
      if (!best || seen.elevation > best.elevation) bins.set(index, { ...seen, latitude: point.latitude, longitude: point.longitude, height });
    }
  const sorted = [...bins.entries()].sort((a, b) => a[0] - b[0]);
  const peak = sorted.reduce((best, entry) => (entry[1].elevation > best[1].elevation ? entry : best));
  const floor = peak[1].elevation - (TOP_DROP / distance) / degrees;
  let first = sorted.indexOf(peak), last = first;
  while (first > 0 && sorted[first - 1][1].elevation >= floor) first--;
  while (last < sorted.length - 1 && sorted[last + 1][1].elevation >= floor) last++;
  const middleAzimuth = (sorted[first][1].azimuth + sorted[last][1].azimuth) / 2;
  const middleIndex = Math.round(middleAzimuth / bin);
  const near = sorted.filter(([index]) => Math.abs(index - middleIndex) <= 1).map(([, value]) => value);
  const top = near.reduce((best, value) => (value.elevation > best.elevation ? value : best));
  return {
    azimuth: middleAzimuth, elevation: top.elevation,
    topWidth: sorted[last][1].azimuth - sorted[first][1].azimuth,
    peak: { azimuth: peak[1].azimuth, elevation: peak[1].elevation },
    cell: { latitude: top.latitude, longitude: top.longitude, height: top.height },
    distance,
  };
}

async function observerOf(key, heightOverride) {
  const place = places[key];
  const ground = await groundElevation(place);
  const height = heightOverride ?? place.height ?? EYE;
  return { key, place, ground, height, latitude: place.latitude, longitude: place.longitude, ellipsoidalHeight: ground.value + height };
}
const markRecord = (mark) => ({
  azimuth: round(mark.azimuth, 4), elevation: round(mark.elevation, 4), topWidth: round(mark.topWidth, 3), distance: Math.round(mark.distance),
  peak: { azimuth: round(mark.peak.azimuth, 4), elevation: round(mark.peak.elevation, 4) },
  cell: { latitude: round(mark.cell.latitude, 6), longitude: round(mark.cell.longitude, 6), height: round(mark.cell.height, 1) },
});
const observerRecord = (observer) => ({ place: observer.key, latitude: observer.latitude, longitude: observer.longitude, ground: round(observer.ground.value, 1), groundSource: observer.ground.source, height: observer.height });

const records = { photos: [], schedules: [], announcements: [] };
const marks = new Map();
async function markFor(observer) {
  const key = `${observer.key}/${observer.height}`;
  if (!marks.has(key)) marks.set(key, await summitMark(observer));
  return marks.get(key);
}

for (const photo of photos) {
  const observer = await observerOf(photo.place);
  const mark = await markFor(observer);
  const shot = minute(photo.date, photo.time);
  // The pass of that afternoon, and the best day within ±20 days.
  const day = passesOf(observer, mark, dayStart(photo.date) + 12 * 3_600_000, dayStart(photo.date) + DAY, 50);
  const pass = day.reduce((a, b) => (Math.abs(Date.parse(b.instant) - shot) < Math.abs(Date.parse(a.instant) - shot) ? b : a));
  const around = passesOf(observer, mark, dayStart(photo.date) - 20 * DAY, dayStart(photo.date) + 21 * DAY, 1)
    .filter((found) => afternoon(found.instant));
  const best = around.reduce((a, b) => (b.ratio < a.ratio ? b : a), around[0]);
  // 找机位 at the photo minute with the summit cell as the target.
  const input = { body: 'sun', target: { latitude: mark.cell.latitude, longitude: mark.cell.longitude, height: 0 }, start: shot, end: shot + 60_000,
    refraction: 'standard', cameraHeight: observer.height, maxDistance: 30_000 };
  const track = bodyTrack(input);
  await loadAround([...corridor(input, track, 400), observer]);
  const slice = solvePositions(input, track, sampler);
  const nearest = slice.points.map((point) => {
    const offset = metresBetween(observer, point);
    const ray = metresBetween(input.target, point);
    const unit = { east: ray.east / ray.distance, north: ray.north / ray.distance };
    return { point, distance: offset.distance, along: -(offset.east * unit.east + offset.north * unit.north), across: Math.abs(offset.east * unit.north - offset.north * unit.east) };
  }).sort((a, b) => a.distance - b.distance)[0] ?? null;
  records.photos.push({
    ...photo, source: 'photos', observer: observerRecord(observer), mark: markRecord(mark),
    pass: { instant: pass.instant, local: local(Date.parse(pass.instant)), minutes: round((shot - Date.parse(pass.instant)) / 60_000, 2), ratio: round(pass.ratio, 3), offset: pass.offset },
    best: best ? { date: local(Date.parse(best.instant)).slice(0, 10), ratio: round(best.ratio, 3), days: dayNumber(photo.date) - dayNumber(local(Date.parse(best.instant)).slice(0, 10)) } : null,
    line: nearest ? { distance: Math.round(nearest.distance), along: Math.round(nearest.along), across: Math.round(nearest.across), sight: nearest.point.sight,
      latitude: round(nearest.point.latitude, 6), longitude: round(nearest.point.longitude, 6) } : null,
  });
  console.log(`A ${photo.date} ${photo.time} ${photo.label}: pass ${local(Date.parse(pass.instant)).slice(11)} Δ ${round((shot - Date.parse(pass.instant)) / 60_000, 1)} min, ${round(pass.ratio, 2)} D; best ${best?.instant.slice(0, 10)}; line ${nearest ? Math.round(nearest.distance) : '—'} m`);
}

for (const schedule of schedules) {
  const year = 2026;
  const result = {};
  for (const [variant, height] of [['eye', undefined], ['sea', 'sea']]) {
    const base = await observerOf(schedule.place);
    // "sea": the eye at the datum, as a calculation that leaves out the site's elevation.
    const observer = height === 'sea' ? { ...base, ellipsoidalHeight: 0, key: `${schedule.place}@0` } : base;
    const mark = await markFor(observer);
    const passes = passesOf(observer, mark, dayStart(`${year}-01-01`), dayStart(`${year + 1}-01-01`), 1)
      .filter((found) => afternoon(found.instant) === (schedule.event === 'sunset'));
    const found = seasons(passes).map((season) => ({ ...season, ...nearestRange(schedule.ranges, season.best.slice(0, 10)) }));
    result[variant] = { mark: markRecord(mark), seasons: found, observer: observerRecord(base), ellipsoidalHeight: round(observer.ellipsoidalHeight, 1) };
  }
  records.schedules.push({ ...schedule, year, ...result });
  console.log(`B ${places[schedule.place].name}: ${result.eye.seasons.map((s) => `${s.best.slice(5, 10)} (${s.days >= 0 ? '+' : ''}${s.days})`).join(', ')} | sea level ${result.sea.seasons.map((s) => `${s.best.slice(5, 10)} (${s.days >= 0 ? '+' : ''}${s.days})`).join(', ')}`);
}

for (const announcement of announcements) {
  const observer = await observerOf(announcement.place);
  const mark = await markFor(observer);
  const dates = announcement.dates ?? [announcement.date, announcement.date];
  const passes = passesOf(observer, mark, dayStart(dates[0]) + 12 * 3_600_000, dayStart(dates[1]) + DAY, 50)
    .filter((found) => afternoon(found.instant))
    .map((found) => ({ local: local(Date.parse(found.instant)), instant: found.instant, ratio: round(found.ratio, 3), offset: found.offset }));
  const around = passesOf(observer, mark, dayStart(dates[0]) - 20 * DAY, dayStart(dates[1]) + 21 * DAY, 1)
    .filter((found) => afternoon(found.instant));
  const best = around.reduce((a, b) => (b.ratio < a.ratio ? b : a), around[0]);
  records.announcements.push({ ...announcement, observer: observerRecord(observer), mark: markRecord(mark), passes,
    best: best ? { local: local(Date.parse(best.instant)), ratio: round(best.ratio, 3) } : null });
  console.log(`C ${places[announcement.place].name} ${dates.join('…')}: ${passes.map((p) => `${p.local.slice(5)} ${p.ratio}D`).join(', ')}; best ${best && local(Date.parse(best.instant))}`);
}

const output = {
  generated: new Date().toISOString().slice(0, 10),
  method: { summit: SUMMIT, summitRadius: SUMMIT_RADIUS, topDrop: TOP_DROP, demZoom: DEM_ZOOM, eye: EYE, zone: ZONE, refraction: 'standard' },
  sources, places, ...records,
};
await writeFile(resolve(root, 'tests/fixtures/alignment-validation.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(`tiles ${tiles.size}`);

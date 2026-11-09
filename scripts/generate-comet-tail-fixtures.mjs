// One-off: nightly tail-length statistics from COBS visual reports (CC BY-NC-SA 4.0) for
// tests/fixtures/comet-tails.json. Reads the observations cached by `update-comets.mjs --full`; keeps
// only per-night aggregates (count, quantiles, median position angle), no observers.
//
//   node scripts/generate-comet-tail-fixtures.mjs
import { readdir, readFile, writeFile } from 'node:fs/promises';
import catalog from '../public/comets/catalog.json' with { type: 'json' };

const IDS = ['C/1995 O1', 'C/1996 B2', 'C/2006 P1', 'C/2020 F3', 'C/2023 A3', 'C/2025 A6', '12P', 'C/2022 E3', 'C/2021 A1', 'C/2011 L4', 'C/2013 R1', 'C/2014 Q2'];
const MIN_REPORTS = 6;
const cacheDir = new URL('../.cache/comets/cobs/', import.meta.url);
const files = await readdir(cacheDir);
const quantile = (values, p) => { const s = [...values].sort((a, b) => a - b), k = (s.length - 1) * p, lo = Math.floor(k); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (k - lo); };
const round = (value) => Math.round(value * 100) / 100;
const comets = [];
for (const id of IDS) {
  const comet = catalog.comets.find((c) => c.id === id);
  const file = files.find((name) => name.startsWith(id.replace(/[^\w]+/g, '_') + '_'));
  if (!comet || !file) { console.log('跳过', id, comet ? '无缓存' : '未收录'); continue; }
  const rows = JSON.parse(await readFile(new URL(file, cacheDir), 'utf8'));
  const nights = new Map();
  for (const [date, , tail, unit, pa] of rows) {
    if (tail === null || !(tail > 0)) continue;
    const degrees = unit === 'm' ? tail / 60 : tail;
    if (degrees > 120) continue;
    const day = date.slice(0, 10);
    if (!nights.has(day)) nights.set(day, { lengths: [], angles: [] });
    nights.get(day).lengths.push(degrees);
    if (pa !== null && pa >= 0 && pa < 360) nights.get(day).angles.push(pa);
  }
  const kept = [...nights].filter(([, night]) => night.lengths.length >= MIN_REPORTS).sort(([a], [b]) => a.localeCompare(b));
  // Circular median: unwrap around the first report before taking the median.
  const angle = (angles) => {
    if (angles.length < 3) return null;
    const base = angles[0], unwrapped = angles.map((a) => base + ((a - base + 540) % 360) - 180);
    return round(((quantile(unwrapped, 0.5) % 360) + 360) % 360);
  };
  comets.push({ id, nights: kept.map(([day, night]) => ({ day, reports: night.lengths.length,
    median: round(quantile(night.lengths, 0.5)), p75: round(quantile(night.lengths, 0.75)), p90: round(quantile(night.lengths, 0.9)),
    max: round(Math.max(...night.lengths)), positionAngle: angle(night.angles) })) });
  console.log(id, kept.length, '夜');
}
await writeFile(new URL('../tests/fixtures/comet-tails.json', import.meta.url), JSON.stringify({
  source: 'COBS Comet Observation Database, https://cobs.si', license: 'CC BY-NC-SA 4.0',
  changes: `每夜至少 ${MIN_REPORTS} 条目视彗尾长度报告的分位数与位置角中位数（单位：度）；不含观测者与单条观测。`,
  comets,
}, null, 1) + '\n');

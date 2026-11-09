// One-off: JPL Horizons airless topocentric positions of catalogue comets as an independent
// reference for tests/fixtures/comet-reference.json. Horizons integrates the full JPL
// solution (planets, non-gravitational terms); the application propagates two-body elements
// osculating at perihelion, so the differences measure that simplification.
//
//   node --experimental-strip-types scripts/generate-comet-fixtures.mjs
import { writeFile } from 'node:fs/promises';
import catalog from '../public/comets/catalog.json' with { type: 'json' };

const AGENT = 'Tamatamatori comet fixtures (https://github.com/Imanity/Tamatamatori)';
const DAY = 86_400_000;
const sites = { fuji: [35.4172, 138.8729], sydney: [-33.86, 151.21], paris: [48.8566, 2.3522] };
// Offsets from perihelion in days, inside each comet's window.
const plan = [
  ['C/2020 F3', 'fuji', [-90, -20, 0, 12, 60, 110]],
  ['C/2023 A3', 'sydney', [-300, -60, 0, 18, 90]],
  ['12P', 'paris', [-250, -60, 0, 40, 150]],
  ['C/2025 A6', 'fuji', [-80, -10, 30, 150]],
  ['C/1995 O1', 'paris', [-400, -120, 0, 60, 300]],
  ['C/1996 B2', 'fuji', [-40, 0, 30]],
  ['10P', 'sydney', [-100, 0, 120, 400]],
];
const records = [];
for (const [id, site, offsets] of plan) {
  const comet = catalog.comets.find((c) => c.id === id);
  if (!comet) throw new Error(`目录缺少 ${id}`);
  const [latitude, longitude] = sites[site];
  for (const offset of offsets) {
    const instant = new Date(Math.round(((comet.orbit.tp - 2440587.5) * DAY + offset * DAY) / 60000) * 60000);
    if (instant < Date.parse(comet.window.from) || instant > Date.parse(comet.window.to)) throw new Error(`${id} ${offset} 超出窗口`);
    const start = instant.toISOString().slice(0, 16).replace('T', ' ');
    const stop = new Date(instant.getTime() + 60000).toISOString().slice(0, 16).replace('T', ' ');
    const query = new URLSearchParams({ format: 'json', COMMAND: `'DES=${id};CAP;NOFRAG;'`, OBJ_DATA: 'NO', MAKE_EPHEM: 'YES', EPHEM_TYPE: 'OBSERVER',
      CENTER: 'coord@399', COORD_TYPE: 'GEODETIC', SITE_COORD: `'${longitude},${latitude},0'`, START_TIME: `'${start}'`, STOP_TIME: `'${stop}'`,
      STEP_SIZE: "'1 m'", QUANTITIES: "'4,19,20'", APPARENT: 'AIRLESS', CSV_FORMAT: 'YES', ANG_FORMAT: 'DEG', TIME_DIGITS: 'SECONDS', EXTRA_PREC: 'YES' });
    const url = `https://ssd.jpl.nasa.gov/api/horizons.api?${query}`;
    const body = await (await fetch(url, { headers: { 'User-Agent': AGENT } })).json();
    const line = body.result.split('$$SOE')[1]?.trim().split('\n')[0];
    if (!line) throw new Error(body.result.slice(0, 500));
    const cells = line.split(',').map((cell) => cell.trim());
    // Date, solar flag, lunar flag, Azi, Elev, r, rdot, delta, deldot
    const [, , , azimuth, elevation, r, , delta] = cells;
    records.push({ id, site, latitude, longitude, instant: instant.toISOString(), offsetDays: offset,
      azimuth: +azimuth, elevation: +elevation, r: +r, delta: +delta, url });
    console.log(id, site, offset, azimuth, elevation, r, delta);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
await writeFile(new URL('../tests/fixtures/comet-reference.json', import.meta.url),
  JSON.stringify({ retrieved: new Date().toISOString().slice(0, 10), source: 'JPL Horizons API', observerHeightKm: 0, refraction: 'AIRLESS', records }, null, 2) + '\n');

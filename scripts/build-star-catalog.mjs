// Build-time only: bounded, pinned HYG extract. No catalogue network at runtime.
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const commit = "3bf37f4b2d5460e1278286320d1d62fab9b493c1";
const source = `https://raw.githubusercontent.com/astronexus/HYG-Database/${commit}/hyg/CURRENT/hygdata_v41.csv`;
const response = await fetch(source, { signal: AbortSignal.timeout(60000) });
if (!response.ok) throw new Error(`HYG ${response.status}`);
const csv = await response.text();
if (Buffer.byteLength(csv) > 40000000)
  throw new Error("HYG exceeds download bound");
function row(line) {
  const fields = [];
  let value = "",
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      fields.push(value);
      value = "";
    } else value += c;
  }
  if (quoted) throw new Error("HYG CSV quoting");
  fields.push(value);
  return fields;
}
const lines = csv.trimEnd().split(/\r?\n/),
  header = row(lines.shift());
const columns = ["id", "ra", "dec", "dist", "vx", "vy", "vz", "mag", "ci"];
const indexes = columns.map((k) => {
  const i = header.indexOf(k);
  if (i < 0) throw new Error(k);
  return i;
});
const named = {
  Polaris: "北极星",
  Altair: "牛郎星",
  Vega: "织女星",
  Deneb: "天津四",
  Sirius: "天狼星",
  Betelgeuse: "参宿四",
  Rigel: "参宿七",
  Capella: "五车二",
  Arcturus: "大角星",
  Antares: "心宿二",
  Spica: "角宿一",
  Fomalhaut: "北落师门",
  Procyon: "南河三",
  Aldebaran: "毕宿五",
  Pollux: "北河三",
  Canopus: "老人星",
  Achernar: "水委一",
  Regulus: "轩辕十四",
};
const names = {},
  aliases = {},
  stars = [],
  candidates = [],
  hips = new Map();
for (const line of lines) {
  const fields = row(line);
  if (fields.length !== header.length) throw new Error("HYG field count");
  const values = indexes.map((i) =>
    fields[i] === "" ? null : Number(fields[i]),
  );
  if (
    values[0] > 0 &&
    values[7] !== null &&
    values[7] <= 8 &&
    values.slice(0, 8).every(Number.isFinite)
  ) {
    const ra = (values[1] * Math.PI) / 12,
      dec = (values[2] * Math.PI) / 180;
    candidates.push({
      row: values,
      ray: [
        Math.cos(dec) * Math.cos(ra),
        Math.cos(dec) * Math.sin(ra),
        Math.sin(dec),
      ],
    });
  }
  if (values[0] === 0 || values[7] === null || values[7] > 4.5) continue;
  if (values.slice(0, 8).some((x) => x === null || !Number.isFinite(x)))
    throw new Error("HYG missing position");
  const proper = fields[header.indexOf("proper")];
  hips.set(values[0], fields[header.indexOf("hip")]);
  aliases[`hyg-${values[0]}`] = [
    proper,
    fields[header.indexOf("hip")] ? `HIP ${fields[header.indexOf("hip")]}` : "",
  ].filter(Boolean);
  if (named[proper]) names[`hyg-${values[0]}`] = named[proper];
  else if (proper && values[7] <= 2.5) names[`hyg-${values[0]}`] = proper;
  stars.push(values);
}
if (
  !Object.values(named).every((name) => Object.values(names).includes(name)) ||
  stars.length > 1200 ||
  stars.length < 700
)
  throw new Error("HYG subset unexpected");
stars.sort((a, b) => a[7] - b[7] || a[0] - b[0]);
const result = {
  source,
  sourceSha256: createHash("sha256").update(csv).digest("hex"),
  author: "David Nash / Astronexus; HYG Database v4.1",
  license: "CC-BY-SA-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  changes:
    "Sun excluded; V magnitude <= 4.5; selected numeric fields; Chinese labels preferred; catalogue proper names retained for V <= 2.5.",
  epoch: 2000,
  columns,
  names,
  aliases,
  stars,
};
await mkdir(new URL("../src/data/", import.meta.url), { recursive: true });

// Lines and label anchors are reference figures, not IAU constellation borders.
const figureCommit = "7e720a3de062059d4c5400a379146a601d9010e0";
const base = `https://raw.githubusercontent.com/ofrohn/d3-celestial/${figureCommit}/data/`;
async function sourceJson(path, bound = 500000) {
  const response = await fetch(base + path, {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Constellations ${response.status}`);
  const raw = await response.text();
  if (raw.length > bound) throw new Error("Constellation source bound");
  return {
    data: JSON.parse(raw),
    source: base + path,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}
const [figureLines, labels, starNames] = await Promise.all([
  sourceJson("constellations.lines.json"),
  sourceJson("constellations.json"),
  sourceJson("starnames.json", 5000000),
]);
if (
  figureLines.data.features.length !== 89 ||
  labels.data.features.length !== 89
)
  throw new Error("Constellation source count");
const resolved = new Map(),
  support = new Map(),
  brightIds = new Set(stars.map((r) => r[0]));
let maxError = 0;
function match(coordinate) {
  const key = coordinate.join("/");
  if (resolved.has(key)) return resolved.get(key);
  const [lon, lat] = coordinate,
    ra = (lon * Math.PI) / 180,
    dec = (lat * Math.PI) / 180;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90)
    throw new Error("Constellation coordinate");
  const ray = [
    Math.cos(dec) * Math.cos(ra),
    Math.cos(dec) * Math.sin(ra),
    Math.sin(dec),
  ];
  let best = -Infinity,
    nearest;
  for (const candidate of candidates) {
    const d =
      ray[0] * candidate.ray[0] +
      ray[1] * candidate.ray[1] +
      ray[2] * candidate.ray[2];
    if (d > best) {
      best = d;
      nearest = candidate;
    }
  }
  const error = (Math.acos(Math.max(-1, Math.min(1, best))) * 180) / Math.PI;
  if (!nearest || error > 0.015)
    throw new Error(`No HYG match for ${key}: ${error} deg`);
  maxError = Math.max(maxError, error);
  const id = nearest.row[0];
  resolved.set(key, id);
  if (!brightIds.has(id)) support.set(id, nearest.row);
  return id;
}
const traditional =
    "寶鷹壇獵馬鯨魚圓規鴿髮烏鴉鵝劍龍爐雙鶴時鐘長蠍獅貓顯蒼蠅極戶飛鳳繪羅網儀遠鵑處鏡",
  simplified =
    "宝鹰坛猎马鲸鱼圆规鸽发乌鸦鹅剑龙炉双鹤时钟长蝎狮猫显苍蝇极户飞凤绘罗网仪远鹃处镜";
const toSimplified = (text) =>
  [...text]
    .map((char) =>
      traditional.includes(char) ? simplified[traditional.indexOf(char)] : char,
    )
    .join("");
for (const row of stars) {
  if (row[7] > 2.5) continue;
  const id = `hyg-${row[0]}`,
    label = starNames.data[hips.get(row[0])];
  if (!Object.values(named).includes(names[id]) && label?.zh)
    names[id] = toSimplified(label.zh);
}
for (const id of Object.keys(aliases)) if (!names[id]) delete aliases[id];
result.nameSource = {
  url: starNames.source,
  sha256: starNames.sha256,
  author: "Olaf Frohn / d3-celestial",
  license: "BSD-3-Clause",
};
result.changes +=
  " Additional Chinese names for major stars matched by Hipparcos ID from d3-celestial.";
await writeFile(
  new URL("../src/data/bright-stars.json", import.meta.url),
  JSON.stringify(result) + "\n",
);
console.log(
  `HYG: ${stars.length} stars, ${Object.keys(names).length} named references, ${result.sourceSha256}`,
);
const figures = figureLines.data.features.map((feature) => {
  const matching = labels.data.features.filter(
    (label) => label.id === feature.id,
  );
  const center = feature.geometry.coordinates.flat().reduce(
    (v, [lon, lat]) => {
      const a = (lon * Math.PI) / 180,
        b = (lat * Math.PI) / 180;
      return [
        v[0] + Math.cos(b) * Math.cos(a),
        v[1] + Math.cos(b) * Math.sin(a),
        v[2] + Math.sin(b),
      ];
    },
    [0, 0, 0],
  );
  const score = (label) => {
    const [lon, lat] = label.geometry.coordinates,
      a = (lon * Math.PI) / 180,
      b = (lat * Math.PI) / 180;
    return (
      center[0] * Math.cos(b) * Math.cos(a) +
      center[1] * Math.cos(b) * Math.sin(a) +
      center[2] * Math.sin(b)
    );
  };
  const label = matching.sort((a, b) => score(b) - score(a))[0];
  if (!label?.properties.zh || label.geometry.type !== "Point")
    throw new Error(`Constellation label ${feature.id}`);
  const part =
    feature.id === "Ser"
      ? (label.geometry.coordinates[0] + 360) % 360 < 250
        ? "1"
        : "2"
      : "";
  const name =
    toSimplified(label.properties.zh) +
    (part === "1" ? "（蛇头）" : part === "2" ? "（蛇尾）" : "");
  return {
    id: feature.id + part,
    name,
    latin: label.properties.name || label.properties.en || feature.id,
    anchor: label.geometry.coordinates,
    paths: feature.geometry.coordinates.map((path) => path.map(match)),
  };
});
await writeFile(
  new URL("../src/data/constellations.json", import.meta.url),
  JSON.stringify({
    author: "Olaf Frohn / d3-celestial",
    license: "BSD-3-Clause",
    licenseUrl: `https://github.com/ofrohn/d3-celestial/blob/${figureCommit}/LICENSE`,
    sources: [
      { url: figureLines.source, sha256: figureLines.sha256 },
      { url: labels.source, sha256: labels.sha256 },
    ],
    changes:
      "Chinese labels simplified; Serpens split parts identified; J2000 anchors retained; line coordinates matched to HYG v4.1 IDs; figures are not boundaries.",
    matchingMaxDegrees: maxError,
    constellations: figures,
  }) + "\n",
);
await writeFile(
  new URL("../src/data/constellation-stars.json", import.meta.url),
  JSON.stringify({
    ...result,
    names: {},
    aliases: {},
    stars: [...support.values()].sort((a, b) => a[0] - b[0]),
    changes:
      "Additional HYG star positions required by constellation line endpoints; not part of the magnitude-limited bright-star display catalogue.",
  }) + "\n",
);
console.log(
  `Constellations: ${figures.length} figures; ${support.size} extra HYG endpoints; maximum match ${maxError.toFixed(6)} deg`,
);

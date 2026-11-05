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
  stars = [];
for (const line of lines) {
  const fields = row(line);
  if (fields.length !== header.length) throw new Error("HYG field count");
  const values = indexes.map((i) =>
    fields[i] === "" ? null : Number(fields[i]),
  );
  if (values[0] === 0 || values[7] === null || values[7] > 4.5) continue;
  if (values.slice(0, 8).some((x) => x === null || !Number.isFinite(x)))
    throw new Error("HYG missing position");
  const proper = fields[header.indexOf("proper")];
  if (named[proper]) names[`hyg-${values[0]}`] = named[proper];
  stars.push(values);
}
if (
  Object.keys(names).length !== Object.keys(named).length ||
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
    "Sun excluded; V magnitude <= 4.5; selected numeric fields; Chinese labels added.",
  epoch: 2000,
  columns,
  names,
  stars,
};
await mkdir(new URL("../src/data/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../src/data/bright-stars.json", import.meta.url),
  JSON.stringify(result) + "\n",
);
console.log(
  `HYG: ${stars.length} stars, ${Object.keys(names).length} named references, ${result.sourceSha256}`,
);

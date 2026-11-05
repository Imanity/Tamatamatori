import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const commit = 'be3cd6c5498806a2fbb2f7e0452ef802dbb02be0';
const root = `https://raw.githubusercontent.com/mattiaverga/OpenNGC/${commit}/`;
const paths = ['database_files/NGC.csv', 'database_files/addendum.csv', 'outlines/surfaces_catgen.dat'];
const inputs = await Promise.all(paths.map(async path => {
  const response = await fetch(root + path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  return { path, sha256: createHash('sha256').update(data).digest('hex'), text: data.toString('utf8') };
}));
function csv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (c === ';' && !quoted) { row.push(field); field = ''; }
    else if (c === '\n' && !quoted) { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const header = rows.shift();
  return rows.filter(row => row.length > 1).map(row => Object.fromEntries(header.map((key, i) => [key, row[i] ?? ''])));
}
const rows = new Map(inputs.slice(0, 2).flatMap(input => csv(input.text)).map(row => [row.Name, row]));
const selected = [
  ['NGC0224', '仙女座星系', 'galaxy', ['M31','M 31','NGC224','Andromeda Galaxy']],
  ['NGC1976', '猎户座大星云', 'mixed', ['M42','M 42','NGC1976','Orion Nebula','猎户座星云']],
  ['Mel022', '昴星团', 'reflection', ['M45','M 45','Pleiades','七姊妹星团']],
  ['NGC6523', '礁湖星云', 'emission', ['M8','M 8','NGC6523','Lagoon Nebula']],
  ['NGC7000', '北美星云', 'emission', ['NGC7000','North America Nebula']],
  ['NGC1499', '加州星云', 'emission', ['NGC1499','California Nebula']],
  ['IC1805', '心脏星云', 'emission', ['IC1805','Heart Nebula','心形星云']],
  ['IC1848', '灵魂星云', 'emission', ['IC1848','Soul Nebula']],
];
const outlines = new Map(); let polygon;
for (const line of inputs[2].text.split(/\r?\n/)) {
  const columns = line.trim().split(/\s+/);
  if (columns.length < 3) continue;
  if (columns[2] === '0') {
    const key = columns[4]?.split('_')[0];
    polygon = selected.some(([id]) => id === key) ? { level: Number(columns[3]), points: [] } : null;
    if (polygon) { const list = outlines.get(key) ?? []; list.push(polygon); outlines.set(key, list); }
  }
  if (polygon) polygon.points.push([Number(columns[0]), Number(columns[1])]);
  if (columns[2] === '1') polygon = null;
}
const degrees = Math.PI / 180;
const sexagesimal = text => { const [d,m,s] = text.replace(/^[+-]/, '').split(':').map(Number); return (text.startsWith('-') ? -1 : 1) * (d + m / 60 + s / 3600); };
function tangent(ra, dec, ra0, dec0) {
  const a = (ra-ra0)*degrees, d = dec*degrees, d0 = dec0*degrees;
  const z = Math.sin(d0)*Math.sin(d)+Math.cos(d0)*Math.cos(d)*Math.cos(a);
  return [Math.cos(d)*Math.sin(a)/z, (Math.cos(d0)*Math.sin(d)-Math.sin(d0)*Math.cos(d)*Math.cos(a))/z];
}
const objects = selected.map(([id, name, model, aliases], index) => {
  const row = rows.get(id); if (!row) throw new Error(`Missing ${id}`);
  const ra = sexagesimal(row.RA)*15, dec = sexagesimal(row.Dec);
  const major = Number(row.MajAx), minor = Number(row.MinAx) || major;
  const positionAngle = row.PosAng === '' ? null : Number(row.PosAng);
  const rings = outlines.get(id) ?? [];
  let xy;
  if (rings.length) xy = rings.flatMap(ring => ring.points.map(([r,d]) => tangent(r,d,ra,dec)));
  else {
    if (major !== minor && positionAngle === null) throw new Error(`Missing ${id} orientation`);
    const pa = (positionAngle ?? 0)*degrees, a = Math.tan(major/120*degrees), b = Math.tan(minor/120*degrees);
    xy = Array.from({length:128},(_,i)=>{const t=i*Math.PI/64;return [a*Math.cos(t)*Math.sin(pa)+b*Math.sin(t)*Math.cos(pa),a*Math.cos(t)*Math.cos(pa)-b*Math.sin(t)*Math.sin(pa)];});
  }
  let minX=Math.min(...xy.map(p=>p[0])),maxX=Math.max(...xy.map(p=>p[0])),minY=Math.min(...xy.map(p=>p[1])),maxY=Math.max(...xy.map(p=>p[1]));
  const padX=(maxX-minX)*0.12,padY=(maxY-minY)*0.12;
  return {id:`dso-${id.toLowerCase()}`,catalogId:id,name,aliases,model,catalogType:row.Type,ra,dec,majorArcmin:major,minorArcmin:minor,positionAngle,magnitude:row['V-Mag'] ? Number(row['V-Mag']) : row['B-Mag'] ? Number(row['B-Mag']) : null,tile:index,bounds:[minX-padX,minY-padY,maxX+padX,maxY+padY],outlines:rings};
});
const hyg = JSON.parse(await readFile(new URL('../src/data/bright-stars.json', import.meta.url), 'utf8'));
const cluster = objects.find(object=>object.catalogId==='Mel022');
cluster.starIds = hyg.stars.filter(([,r,d])=>{
  const xy=tangent(r*15,d,cluster.ra,cluster.dec);return Math.atan(Math.hypot(...xy))/degrees < cluster.majorArcmin/120;
}).map(([id])=>`hyg-${id}`);
const data = {
  source:`https://github.com/mattiaverga/OpenNGC/tree/${commit}`,commit,
  authors:'Mattia Verga / OpenNGC; outlines traced with Aladin from DSS2 Color',
  license:'CC-BY-SA-4.0',licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/',
  inputs:inputs.map(({path,sha256})=>({path,sha256})),
  fields:'ICRS/J2000 RA/Dec in degrees; major/minor axes are full diameters in arcminutes; position angle north through east, null if absent; bounds are gnomonic east/north coordinates.',
  modifications:'Eight-object subset; Chinese names and search aliases added; original contour levels preserved; tangent bounds padded 12%. Rendering components/classification are qualitative author-created display models, not measured line fluxes.',
  clusterStarSource:{source:hyg.source,license:'CC-BY-SA-4.0',note:'M45 stars use existing HYG catalogue positions and magnitudes at runtime; IDs only are stored here.'},
  imageSources:JSON.parse(await readFile(new URL('./deep-sky-image-sources.json',import.meta.url),'utf8')),
  atlas:{width:4096,height:2048,tileSize:1024,channels:'RGB baseline colour; A = 1 - additive red enhancement. Alpha is data, not display opacity; not spectral fluxes.'},objects
};
await writeFile(new URL('../src/data/deep-sky.json',import.meta.url),JSON.stringify(data)+'\n');
console.log(objects.map(o=>({id:o.catalogId,outlineRings:o.outlines.length,bounds:o.bounds,starIds:o.starIds})));

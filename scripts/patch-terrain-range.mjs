import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
const root=dirname(createRequire(import.meta.url).resolve('maplibre-gl/package.json'));
if(JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version!=='6.16.0')throw Error('摄影地形覆盖需要重新验证 SDK');
const marker='TAMATAMATORI_TERRAIN_RANGE_V1',hook='tamatamatori.terrain-range.v1';
const paths=['src/geo/projection/covering_tiles.ts','dist/maplibre-gl.mjs'];
const before=[
  'export function coveringTiles(transform: IReadonlyTransform, options: CoveringTilesOptionsInternal): OverscaledTileID[] {\n    let frustum = transform.getCameraFrustum();',
  'function KE(e,t){let n=e.getCameraFrustum(),r=e.getClippingPlane();',
];
const after=[
  `export function coveringTiles(transform: IReadonlyTransform, options: CoveringTilesOptionsInternal): OverscaledTileID[] {
    // ${marker}: cloned coverage transform only; actual camera/fog remain intact.
    const photoRange = (options.calculateTileZoom as any)?.[Symbol.for('${hook}')];
    if (options.terrain && photoRange === 75000 && transform.worldCoordinateHelper.name === 'mercator' && transform.farZ < photoRange * transform.pixelsPerMeter) {
        const extended = transform.clone();
        extended.overrideNearFarZ(transform.nearZ, photoRange * transform.pixelsPerMeter);
        transform = extended;
    }
    let frustum = transform.getCameraFrustum();`,
  `function KE(e,t){/*${marker}*/const photoRange=t.calculateTileZoom?.[Symbol.for('${hook}')];if(t.terrain&&photoRange===75000&&e.worldCoordinateHelper.name===\`mercator\`&&e.farZ<photoRange*e.pixelsPerMeter){const original=e;e=e.clone();e.overrideNearFarZ(original.nearZ,photoRange*original.pixelsPerMeter)}let n=e.getCameraFrustum(),r=e.getClippingPlane();`,
];
// Validate source and ESM together; second installation must be a no-op.
const edits=paths.map((path,i)=>{const filename=join(root,path),text=readFileSync(filename,'utf8').replaceAll('\r\n','\n');
  if(text.includes(marker)){if(text.split(after[i]).length!==2||text.includes(before[i]))throw Error(`摄影地形覆盖补丁签名不匹配：${path}`);return null;}
  if(text.split(before[i]).length!==2)throw Error(`摄影地形覆盖原始签名不匹配：${path}`);
  return {filename,text:text.replace(before[i],after[i]).replace(/\/\/# sourceMappingURL=.*$/m,'')};
});
for(const edit of edits)if(edit)writeFileSync(edit.filename,edit.text);
console.log('MapLibre：摄影地形远距覆盖已安装');

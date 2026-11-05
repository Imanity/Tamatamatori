import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {deepSkyScene,deepSkyCatalog,deepSkyView} from '../src/domain/deep-sky.ts';
import {initialPlan,fieldOfView} from '../src/domain/plan.ts';
import {skyPointView} from '../src/domain/starfield.ts';
import {celestialPlanKey} from '../src/domain/visibility.ts';
import {direction} from '../src/domain/ephemeris.ts';
import {searchTargets} from '../src/domain/target-search.ts';
import {loadDeepSkyImage} from '../src/preview/deep-sky-texture.ts';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/deep-sky-reference.json',import.meta.url),'utf8'));
const metadata=JSON.parse(readFileSync(new URL('../src/data/deep-sky.json',import.meta.url),'utf8'));
const plan={...initialPlan,instant:'2026-11-08T16:00:00Z',refraction:'none',focalLength:200,layers:{...initialPlan.layers,deepSky:true}};
const angle=(a,b)=>Math.acos(Math.max(-1,Math.min(1,a.reduce((sum,x,i)=>sum+x*b[i],0))))*180/Math.PI;

test('深空子集保留固定来源、缺失位置角、轮廓与数据许可；分量图完整',()=>{
  assert.equal(deepSkyCatalog.length,8);assert.equal(new Set(deepSkyCatalog.map(p=>p.id)).size,8);
  assert.equal(metadata.commit,'be3cd6c5498806a2fbb2f7e0452ef802dbb02be0');assert.equal(metadata.license,'CC-BY-SA-4.0');
  assert.ok(metadata.inputs.every(source=>/^[0-9a-f]{64}$/.test(source.sha256)));
  const andromeda=deepSkyCatalog.find(p=>p.catalogId==='NGC0224');assert.equal(andromeda.majorArcmin,177.83);assert.equal(andromeda.positionAngle,35);
  assert.equal(deepSkyCatalog.find(p=>p.catalogId==='NGC7000').positionAngle,null);
  for(const object of metadata.objects){assert.ok(object.majorArcmin>=object.minorArcmin);assert.ok(object.bounds.every(Number.isFinite));assert.ok(object.outlines.every(ring=>[1,2,3].includes(ring.level)&&ring.points.length>2&&ring.points.flat().every(Number.isFinite)));}
  for(const object of metadata.objects){if(['galaxy','reflection'].includes(object.model))assert.deepEqual(object.componentMax.slice(1),[0,0]);else assert.ok(object.componentMax[1]>0);}
  const bytes=readFileSync(new URL('../src/data/deep-sky-atlas.png',import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),metadata.atlas.sha256);
  assert.equal(bytes.readUInt32BE(16),4096);assert.equal(bytes.readUInt32BE(20),2048);
  assert.ok(bytes.length<1024*1024,'the shared static atlas stays below 1 MiB');
  assert.equal(metadata.atlas.tileSize,1024);
  assert.deepEqual(metadata.imageSources.map(s=>s.catalogId),['NGC0224','NGC1976']);
  for(const source of metadata.imageSources){assert.equal(source.license,'CC-BY-4.0');assert.equal(source.wcs.CoordsystemProjection,'TAN');assert.ok(source.wcs.Scale[0]<0);assert.ok(source.credit&&source.sha256.length===64);}
});

test('影像结构来源与独立 WCS 注册记录对应当前图集，保留旋转、缩放和覆盖边界',()=>{
  const reference=JSON.parse(readFileSync(new URL('./fixtures/deep-sky-image-registration.json',import.meta.url),'utf8'));
  assert.equal(reference.atlasSha256,metadata.atlas.sha256);
  assert.equal(reference.records.length,2);
  for(const record of reference.records){
    const source=metadata.imageSources.find(s=>s.catalogId===record.catalogId);
    assert.equal(source.sha256,record.sourceSha256);assert.deepEqual(source.wcs,record.wcs);
    assert.equal(record.samples.length,25);assert.ok(record.maxReferencePixelError<1e-7);assert.equal(record.zeroAtlasBorder,true);
    const stats=metadata.atlas.detailStatistics.find(s=>s.catalogId===record.catalogId);
    assert.ok(stats.coveredPixels>0&&stats.coveredPixels<stats.totalPixels,'partial photographic coverage must stay explicit');
    assert.ok(stats.featherFraction>0&&stats.ellipticalFeatherWidth>0);
  }
  assert.ok(metadata.imageSources.find(s=>s.catalogId==='NGC0224').wcs.Rotation<-180);
  assert.notDeepEqual(metadata.imageSources[1].dimensions,metadata.imageSources[1].wcs.ReferenceDimension,'the M42 reference is resized and must scale its AVM coordinates');
});

test('深空细节图按设备纹理上限解码，取消后释放迟到位图',async()=>{
  const previousFetch=globalThis.fetch,previousBitmap=globalThis.createImageBitmap;
  const requests=[],decodes=[];let closed=0,controller;
  try{
    globalThis.fetch=async(url,options)=>{requests.push({url:String(url),signal:options.signal});return{ok:true,blob:async()=>new Blob()};};
    globalThis.createImageBitmap=async(_,options)=>{decodes.push(options);return{close(){closed++;}};};
    for(const maxSize of [8192,2048,1024]){controller=new AbortController();await loadDeepSkyImage(controller.signal,maxSize);assert.equal(decodes.at(-1).resizeWidth,Math.min(4096,maxSize));assert.equal(decodes.at(-1).resizeHeight,Math.min(4096,maxSize)/2);}
    assert.ok(requests.every(r=>r.url.endsWith('/deep-sky-atlas.png')));
    assert.ok(decodes.every(d=>d.colorSpaceConversion==='none'&&d.premultiplyAlpha==='none'));
    controller=new AbortController();globalThis.createImageBitmap=async()=>{controller.abort();return{close(){closed++;}};};
    await assert.rejects(loadDeepSkyImage(controller.signal,2048),{name:'AbortError'});assert.equal(closed,1);
  }finally{globalThis.fetch=previousFetch;globalThis.createImageBitmap=previousBitmap;}
});

test('深空中心对照独立 ERFA：南北半球、日期变更线、2000/2099，方向差小于 0.02°',()=>{
  let maximum=0;
  for(const ref of fixture.records){const point=deepSkyScene({...plan,...ref}).objects.find(p=>p.id===ref.id);const error=angle(point.direction,direction(ref.azimuth,ref.elevation));maximum=Math.max(maximum,error);assert.ok(error<0.02,`${ref.id}: ${error}°`);}
  console.info(`ERFA ${fixture.records.length} deep-sky directions: max ${maximum.toFixed(6)}°`);
});

test('深空球面网格有界且接受折射，相机响应/焦距/时区不重算几何',()=>{
  const scene=deepSkyScene(plan),key=celestialPlanKey(plan);
  assert.ok(scene.vertices.length>0);assert.ok(scene.vertices.every(Number.isFinite));
  for(let i=0;i<scene.vertices.length;i+=8){assert.ok(Math.abs(Math.hypot(...scene.vertices.slice(i,i+3))-1)<1e-5);assert.ok(scene.vertices[i+3]>0&&scene.vertices[i+3]<1&&scene.vertices[i+4]>0&&scene.vertices[i+4]<1);}
  for(const object of scene.objects){assert.ok(object.count>0&&object.offset+object.count<=scene.vertices.length/8);assert.ok(object.boundary.every(p=>p.every(Number.isFinite)));}
  for(const cameraResponse of ['stock','ha-modified']){assert.equal(deepSkyScene({...plan,cameraResponse,focalLength:1000,orientation:'portrait',timeZone:'UTC'}),scene);assert.equal(celestialPlanKey({...plan,cameraResponse}),key);}
  assert.notEqual(deepSkyScene({...plan,refraction:'standard'}),scene);
  assert.equal(new Set(scene.clusterStars.map(p=>p.id)).size,6);
});

test('扩展星云中心在框外时仍能部分入画，长焦不把角尺寸钉死在屏幕像素',()=>{
  const point=deepSkyScene(plan).objects.find(p=>p.entry.catalogId==='NGC1976');
  const aimed={...plan,focalLength:1000,azimuth:point.azimuth+2,pitch:point.elevation};
  assert.equal(skyPointView(aimed,point).state,'视场外');assert.equal(deepSkyView(aimed,point).state,'画面内');assert.equal(deepSkyView(aimed,point).partialFrame,true);
  assert.ok(fieldOfView({...plan,focalLength:1000}).horizontal<fieldOfView(plan).horizontal);
  const hidden={...plan,azimuth:(point.azimuth+180)%360,pitch:-point.elevation};assert.equal(deepSkyView(hidden,point).state,'视场外');
});

test('深空搜索支持中文、目录和英文名，响应选择不改变目标位置',()=>{
  for(const [query,id] of [['M31','dso-ngc0224'],['M 42','dso-ngc1976'],['昴星团','dso-mel022'],['California Nebula','dso-ngc1499'],['IC1805','dso-ic1805']]){
    const target=searchTargets(plan,query)[0];assert.equal(target.id,id);assert.equal(target.layer,'deepSky');assert.ok(target.deep);
    assert.deepEqual(target.direction,searchTargets({...plan,cameraResponse:'ha-modified'},query)[0].direction);
  }
  assert.equal(searchTargets(plan,'深空').length,8);
});

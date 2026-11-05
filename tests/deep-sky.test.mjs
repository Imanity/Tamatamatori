import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {deepSkyScene,deepSkyCatalog,deepSkyView,deepSkyRedEnhancementColor} from '../src/domain/deep-sky.ts';
import {initialPlan,fieldOfView} from '../src/domain/plan.ts';
import {skyPointView} from '../src/domain/starfield.ts';
import {celestialPlanKey} from '../src/domain/visibility.ts';
import {direction} from '../src/domain/ephemeris.ts';
import {searchTargets} from '../src/domain/target-search.ts';
import {loadDeepSkyImage} from '../src/preview/deep-sky-texture.ts';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/deep-sky-reference.json',import.meta.url),'utf8'));
const metadata=JSON.parse(readFileSync(new URL('../src/data/deep-sky.json',import.meta.url),'utf8'));
const atlasBytes=readFileSync(new URL('../src/data/deep-sky-atlas.png',import.meta.url));
function rgbaPng(bytes){
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),chunks=[];
  assert.equal(bytes[24],8);assert.equal(bytes[25],6);assert.equal(bytes[28],0);
  for(let p=8;p<bytes.length;){const length=bytes.readUInt32BE(p);if(bytes.toString('ascii',p+4,p+8)==='IDAT')chunks.push(bytes.subarray(p+8,p+8+length));p+=length+12;}
  const encoded=inflateSync(Buffer.concat(chunks)),stride=width*4,pixels=Buffer.alloc(stride*height);
  for(let y=0;y<height;y++){
    const filter=encoded[y*(stride+1)];assert.ok(filter<=4);
    for(let x=0;x<stride;x++){
      const i=y*stride+x,a=x>=4?pixels[i-4]:0,b=y?pixels[i-stride]:0,c=y&&x>=4?pixels[i-stride-4]:0;
      const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c),paeth=pa<=pb&&pa<=pc?a:pb<=pc?b:c;
      const predictor=[0,a,b,Math.floor((a+b)/2),paeth][filter];pixels[i]=(encoded[y*(stride+1)+1+x]+predictor)&255;
    }
  }
  return{width,height,pixels};
}
let raster;
const actualAtlas=()=>raster??=rgbaPng(atlasBytes);
const plan={...initialPlan,instant:'2026-11-08T16:00:00Z',refraction:'none',focalLength:200,layers:{...initialPlan.layers,deepSky:true}};
const angle=(a,b)=>Math.acos(Math.max(-1,Math.min(1,a.reduce((sum,x,i)=>sum+x*b[i],0))))*180/Math.PI;

test('深空子集保留固定来源、缺失位置角、轮廓与数据许可；分量图完整',()=>{
  assert.equal(deepSkyCatalog.length,8);assert.equal(new Set(deepSkyCatalog.map(p=>p.id)).size,8);
  assert.equal(metadata.commit,'be3cd6c5498806a2fbb2f7e0452ef802dbb02be0');assert.equal(metadata.license,'CC-BY-SA-4.0');
  assert.ok(metadata.inputs.every(source=>/^[0-9a-f]{64}$/.test(source.sha256)));
  const andromeda=deepSkyCatalog.find(p=>p.catalogId==='NGC0224');assert.equal(andromeda.majorArcmin,177.83);assert.equal(andromeda.positionAngle,35);
  assert.equal(deepSkyCatalog.find(p=>p.catalogId==='NGC7000').positionAngle,null);
  for(const object of metadata.objects){assert.ok(object.majorArcmin>=object.minorArcmin);assert.ok(object.bounds.every(Number.isFinite));assert.ok(object.outlines.every(ring=>[1,2,3].includes(ring.level)&&ring.points.length>2&&ring.points.flat().every(Number.isFinite)));}
  for(const object of metadata.objects){if(['galaxy','reflection'].includes(object.model))assert.equal(object.redEnhancementMax,0);else assert.ok(object.redEnhancementMax>0);}
  const bytes=readFileSync(new URL('../src/data/deep-sky-atlas.png',import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),metadata.atlas.sha256);
  assert.equal(bytes.readUInt32BE(16),4096);assert.equal(bytes.readUInt32BE(20),4096);
  assert.ok(bytes.length<14*1024*1024,'native-detail lossless atlas stays within the explicit 14 MiB budget');
  for(const object of metadata.objects){
    const [x,y,w,h]=object.atlasRect;assert.ok(x>=0&&y>=0&&x+w<=4096&&y+h<=4096);
    for(const other of metadata.objects){if(other===object)continue;const [a,b,c,d]=other.atlasRect;assert.ok(x+w<=a||a+c<=x||y+h<=b||b+d<=y,`${object.catalogId} overlaps ${other.catalogId}`);}
    assert.deepEqual([w,h],['NGC7000','NGC1499'].includes(object.catalogId)?[2048,2048]:['Mel022','NGC6523'].includes(object.catalogId)?[2048,1024]:[1024,1024]);
  }
  assert.deepEqual(metadata.imageSources.map(s=>s.catalogId),['NGC0224','NGC1976','Mel022','NGC6523','NGC7000','NGC1499','IC1805','IC1848']);
  for(const source of metadata.imageSources){
    assert.equal(source.wcs.CoordsystemProjection,'TAN');assert.ok(source.credit&&source.sha256.length===64);
    if(source.registrationModel==='stellarium-sky-corners'){
      assert.equal(source.license,'CC0-1.0');assert.ok(source.licenseEvidence.endsWith('/CREDITS.md'));
      assert.equal(source.skyCorners.length,4);assert.ok(source.wcs.CDMatrix[0][0]<0);assert.ok(source.registrationSourceSha256.length===64);
    }else{assert.equal(source.license,'CC-BY-4.0');assert.ok(source.wcs.Scale[0]<0);}
  }
});

test('影像结构来源与独立 WCS 注册记录对应当前图集，保留旋转、缩放和覆盖边界',()=>{
  const reference=JSON.parse(readFileSync(new URL('./fixtures/deep-sky-image-registration.json',import.meta.url),'utf8'));
  assert.equal(reference.atlasSha256,metadata.atlas.sha256);
  assert.equal(reference.records.length,8);
  for(const record of reference.records){
    const source=metadata.imageSources.find(s=>s.catalogId===record.catalogId);
    assert.equal(source.sha256,record.sourceSha256);assert.deepEqual(source.wcs,record.wcs);
    assert.deepEqual(record.atlasRect,metadata.objects.find(o=>o.catalogId===record.catalogId).atlasRect);
    assert.equal(record.samples.length,25);assert.ok(record.maxReferencePixelError<1e-7);assert.equal(record.zeroAtlasBorder,true);assert.equal(record.fullSourceFootprintContained,true);
    assert.equal(record.registrationModel,source.registrationModel??'avm');
    if(record.registrationModel==='stellarium-sky-corners')assert.ok(record.publishedCornerMaxPixelError<0.5,'corner fit is bounded separately from transform accuracy');
    const stats=metadata.atlas.detailStatistics.find(s=>s.catalogId===record.catalogId);
    assert.ok(stats.coveredPixels>0&&stats.coveredPixels<stats.totalPixels,'partial photographic coverage must stay explicit');
    assert.equal(stats.usesEllipticalMask,false);assert.equal(stats.catalogueEnvelopeWeight,0);assert.equal(stats.edgeFadePixels,source.edgeFadePixels??3);
    if(['Mel022','NGC6523','NGC7000'].includes(source.catalogId)){assert.equal(stats.preservesSourceDetail,true);assert.equal(source.detailMode,'source-rgb');assert.ok(source.file.endsWith('.tif'));}
  }
  assert.ok(Math.abs(metadata.imageSources.find(s=>s.catalogId==='NGC0224').wcs.Rotation-1.92)<1e-8);
  assert.notDeepEqual(metadata.imageSources[1].dimensions,metadata.imageSources[1].wcs.ReferenceDimension,'the M42 reference is resized and must scale its AVM coordinates');
  assert.notEqual(Math.abs(metadata.imageSources[1].wcs.Scale[0]),Math.abs(metadata.imageSources[1].wcs.Scale[1]),'reference must retain unequal X/Y scales');
});

test('实际 RGBA 像素保留发射云基础红色、M45 蓝色反射云与零增量；图格边缘不串色',()=>{
  const {width,pixels}=actualAtlas();const totals=new Map();
  for(const object of metadata.objects){
    const [tx,ty,tileWidth,tileHeight]=object.atlasRect;
    const sums={red:0,blue:0,warm:0,bright:0,enhanced:0};
    for(let y=0;y<tileHeight;y++)for(let x=0;x<tileWidth;x++){
      const i=((ty+y)*width+tx+x)*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2],a=pixels[i+3];
      if(!x||!y||x===tileWidth-1||y===tileHeight-1)assert.deepEqual([r,g,b,a],[0,0,0,255]);
      if(['galaxy','reflection'].includes(object.model))assert.equal(a,255);
      if(Math.max(r,g,b)>24){sums.red+=r;sums.blue+=b;sums.bright++;if(r>b*1.1)sums.warm++;if(a<255)sums.enhanced++;}
    }
    totals.set(object.catalogId,sums);
  }
  for(const id of ['NGC1976','NGC6523','NGC7000','NGC1499','IC1805','IC1848']){
    const {red,blue,bright,warm,enhanced}=totals.get(id);
    assert.ok(bright>1000,id);assert.ok(red>blue,`${id}: ordinary mode preserves red`);assert.ok(warm/bright>0.2,id);assert.ok(enhanced>1000,id);
  }
  const cluster=totals.get('Mel022');assert.ok(cluster.bright>1000);assert.ok(cluster.blue>cluster.red);assert.equal(cluster.enhanced,0);
});

test('长焦资料不退回强模糊：固定天球裁区保留细节能量，M31/M42 RGBA 逐像素不变',()=>{
  const reference=JSON.parse(readFileSync(new URL('./fixtures/deep-sky-sharpness.json',import.meta.url),'utf8'));
  const {width,pixels}=actualAtlas(),n=reference.gridSize;
  for(const item of reference.unchangedTiles){
    if(!['NGC0224','NGC1976'].includes(item.catalogId))continue; // The three former catalogue masks are intentionally replaced.
    const [x,y,w,h]=metadata.objects.find(o=>o.catalogId===item.catalogId).atlasRect,bytes=Buffer.alloc(w*h*4);
    for(let row=0;row<h;row++)pixels.copy(bytes,row*w*4,((y+row)*width+x)*4,((y+row)*width+x+w)*4);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),item.rgbaSha256,item.catalogId);
  }
  for(const item of reference.detail){
    const [tx,ty,w,h]=metadata.objects.find(o=>o.catalogId===item.catalogId).atlasRect,luma=new Float64Array(n*n),peak=new Float64Array(n*n);
    for(let y=0;y<n;y++)for(let x=0;x<n;x++){
      const px=x/(n-1)*(w-1),py=y/(n-1)*(h-1),ix=Math.floor(px),iy=Math.floor(py),u=px-ix,v=py-iy;
      const a=((ty+iy)*width+tx+ix)*4,b=((ty+iy)*width+tx+Math.min(ix+1,w-1))*4,c=((ty+Math.min(iy+1,h-1))*width+tx+ix)*4,d=((ty+Math.min(iy+1,h-1))*width+tx+Math.min(ix+1,w-1))*4;
      const rgb=[0,1,2].map(k=>(pixels[a+k]*(1-u)+pixels[b+k]*u)*(1-v)+(pixels[c+k]*(1-u)+pixels[d+k]*u)*v),i=y*n+x;
      luma[i]=rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;peak[i]=Math.max(...rgb);
    }
    let energy=0,signal=0;const [x0,y0,x1,y1]=reference.roi;
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
      const i=y*n+x,c=luma[i];if(c<=3||peak[i]>=180)continue;
      energy+=Math.abs(2*c-luma[i-1]-luma[i+1])+Math.abs(2*c-luma[i-n]-luma[i+n]);signal+=c;
    }
    assert.ok(energy/signal>item.baselineEnergy*reference.minimumRelativeDetailEnergy,`${item.catalogId} lost its source detail`);
  }
});

test('剩余三目标替换目录轮廓，既有五幅影像的 RGBA、角范围和分辨率保持不变',()=>{
  const reference=JSON.parse(readFileSync(new URL('./fixtures/deep-sky-remaining.json',import.meta.url),'utf8'));
  const {width,pixels}=actualAtlas();assert.equal(reference.unchangedImages.length,5);
  for(const item of reference.unchangedImages){
    const object=metadata.objects.find(o=>o.catalogId===item.catalogId);
    assert.deepEqual(object.bounds,item.bounds);assert.deepEqual(object.atlasRect,item.atlasRect);
    const [x,y,w,h]=item.atlasRect,bytes=Buffer.alloc(w*h*4);
    for(let row=0;row<h;row++)pixels.copy(bytes,row*w*4,((y+row)*width+x)*4,((y+row)*width+x+w)*4);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),item.rgbaSha256,item.catalogId);
  }
  for(const id of ['NGC1499','IC1805','IC1848']){
    const source=metadata.imageSources.find(s=>s.catalogId===id),stats=metadata.atlas.detailStatistics.find(s=>s.catalogId===id);
    assert.equal(stats.preservesSourceDetail,true);assert.equal(source.detailMode,'source-rgb');
    if(id==='NGC1499')assert.equal(stats.opacitySupport.model,'diffuse-colour-reconstruction');
    else{assert.equal(source.backgroundModel,'none');assert.equal(stats.opacitySupport,null);assert.match(source.sourceProcessing,/Upstream star-suppressed/);}
  }
});

test('扩散光支持压低照片外围星场，保留主体信号与独立红色增量',()=>{
  const reference=JSON.parse(readFileSync(new URL('./fixtures/deep-sky-boundary.json',import.meta.url),'utf8'));
  const {width,pixels}=actualAtlas(),f=reference.rimFraction;
  for(const item of reference.records){
    const object=metadata.objects.find(o=>o.catalogId===item.catalogId),source=metadata.imageSources.find(s=>s.catalogId===item.catalogId);
    assert.deepEqual(object.atlasRect,item.atlasRect);
    assert.equal(source.opacityModel,'diffuse-colour-reconstruction');
    const stats=metadata.atlas.detailStatistics.find(s=>s.catalogId===item.catalogId).opacitySupport;
    assert.equal(stats.model,source.opacityModel);assert.ok(stats.reconstructionIterations<2048);
    assert.ok(stats.noiseFloor>0&&stats.fullSupport>stats.noiseFloor);
    const [tx,ty,w,h]=object.atlasRect;let rim=0,centre=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=((ty+y)*width+tx+x)*4,sum=pixels[i]+pixels[i+1]+pixels[i+2];
      if(x<w*f||x>=w*(1-f)||y<h*f||y>=h*(1-f))rim+=sum;else centre+=sum;
      if(sum===0)assert.equal(pixels[i+3],255,'red enhancement must fade with baseline support');
    }
    assert.ok(rim/item.baselineRimRgbSum<item.maximumRimRetention,`${item.catalogId}: photo perimeter returned`);
    assert.ok(centre/item.baselineCentreRgbSum>item.minimumCentreRetention,`${item.catalogId}: cloud was erased`);
  }
});

test('改机红光示意不使已红云气偏粉：实际图集的红色占比非减，连续谱目标不变',()=>{
  const {width,pixels}=actualAtlas();
  const [dr,dg,db]=deepSkyRedEnhancementColor;
  for(const object of metadata.objects){
    const [tx,ty,w,h]=object.atlasRect;let enhanced=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=((ty+y)*width+tx+x)*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2],extra=255-pixels[i+3];
      if(!extra)continue;
      const red=r+extra*dr,green=g+extra*dg,blue=b+extra*db;
      assert.equal(green,g);assert.equal(blue,b);
      const baseSum=r+g+b,sum=red+green+blue;
      if(baseSum)assert.ok(red/sum+1e-12>=r/baseSum,`${object.catalogId}: red fraction decreased`);
      if(Math.max(r,g,b)>5)enhanced++;
    }
    if(['galaxy','reflection'].includes(object.model))assert.equal(enhanced,0);else assert.ok(enhanced>1000);
  }
});

test('深空细节图按设备纹理上限解码，取消后释放迟到位图',async()=>{
  const previousFetch=globalThis.fetch,previousBitmap=globalThis.createImageBitmap;
  const requests=[],decodes=[];let closed=0,controller;
  try{
    globalThis.fetch=async(url,options)=>{requests.push({url:String(url),signal:options.signal});return{ok:true,blob:async()=>new Blob()};};
    globalThis.createImageBitmap=async(_,options)=>{decodes.push(options);return{close(){closed++;}};};
    for(const maxSize of [8192,4096,2048,1024]){controller=new AbortController();await loadDeepSkyImage(controller.signal,maxSize);assert.equal(decodes.at(-1).resizeWidth,Math.min(4096,maxSize));assert.equal(decodes.at(-1).resizeHeight,Math.min(4096,maxSize));}
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
  for(const object of scene.objects){
    const [x,y,w,h]=object.entry.atlasRect,uv=[];
    for(let i=object.offset*8;i<(object.offset+object.count)*8;i+=8)uv.push([scene.vertices[i+3],scene.vertices[i+4]]);
    assert.ok(Math.abs(Math.min(...uv.map(p=>p[0]))-(x+.5)/metadata.atlas.width)<1e-7);
    assert.ok(Math.abs(Math.max(...uv.map(p=>p[0]))-(x+w-.5)/metadata.atlas.width)<1e-7);
    assert.ok(Math.abs(Math.min(...uv.map(p=>p[1]))-(y+.5)/metadata.atlas.height)<1e-7);
    assert.ok(Math.abs(Math.max(...uv.map(p=>p[1]))-(y+h-.5)/metadata.atlas.height)<1e-7);
  }
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

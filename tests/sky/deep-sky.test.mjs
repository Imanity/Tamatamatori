import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {deepSkyScene,deepSkyCatalog,deepSkyView,deepSkyRedEnhancementColor,deepSkyTextureRequests,deepSkyTextureBudget,deepSkyImageEntry,deepSkyImageSource} from '../../src/domain/sky/deep-sky.ts';
import {initialPlan,fieldOfView} from '../../src/domain/core/plan.ts';
import {skyPointView} from '../../src/domain/sky/starfield.ts';
import {celestialPlanKey} from '../../src/domain/core/visibility.ts';
import {direction} from '../../src/domain/core/ephemeris.ts';
import {searchTargets} from '../../src/domain/sky/target-search.ts';
import {loadDeepSkyImage,deepSkyImageUrl} from '../../src/render/sky/deep-sky-texture.ts';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/deep-sky-reference.json',import.meta.url),'utf8'));
const metadata=JSON.parse(readFileSync(new URL('../../src/data/deep-sky.json',import.meta.url),'utf8'));
const atlasBytes=readFileSync(new URL('../../src/data/deep-sky-atlas.png',import.meta.url));
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
const legacyObjects=metadata.objects.slice(0,8);
const plan={...initialPlan,instant:'2026-11-08T16:00:00Z',refraction:'none',focalLength:200,layers:{...initialPlan.layers,deepSky:true}};
const angle=(a,b)=>Math.acos(Math.max(-1,Math.min(1,a.reduce((sum,x,i)=>sum+x*b[i],0))))*180/Math.PI;

test('深空子集保留固定来源、缺失位置角、轮廓与数据许可；分量图完整',()=>{
  assert.equal(deepSkyCatalog.length,15);assert.equal(new Set(deepSkyCatalog.map(p=>p.id)).size,15);
  assert.equal(metadata.commit,'be3cd6c5498806a2fbb2f7e0452ef802dbb02be0');assert.equal(metadata.license,'CC-BY-SA-4.0');
  assert.ok(metadata.inputs.every(source=>/^[0-9a-f]{64}$/.test(source.sha256)));
  const andromeda=deepSkyCatalog.find(p=>p.catalogId==='NGC0224');assert.equal(andromeda.majorArcmin,177.83);assert.equal(andromeda.positionAngle,35);
  assert.equal(deepSkyCatalog.find(p=>p.catalogId==='NGC7000').positionAngle,null);
  for(const object of metadata.objects){assert.ok(object.majorArcmin>=object.minorArcmin);assert.ok(object.bounds.every(Number.isFinite));assert.ok(object.outlines.every(ring=>[1,2,3].includes(ring.level)&&ring.points.length>2&&ring.points.flat().every(Number.isFinite)));}
  for(const object of metadata.objects){if(['galaxy','reflection'].includes(object.model))assert.equal(object.redEnhancementMax,0);else if(object.model!=='dark'&&!object.imageReference)assert.ok(object.redEnhancementMax>0);}
  const bytes=readFileSync(new URL('../../src/data/deep-sky-atlas.png',import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),metadata.atlas.sha256);
  assert.equal(bytes.readUInt32BE(16),4096);assert.equal(bytes.readUInt32BE(20),4096);
  assert.ok(bytes.length<14*1024*1024,'native-detail lossless atlas stays within the explicit 14 MiB budget');
  for(const object of legacyObjects){
    const [x,y,w,h]=object.atlasRect;assert.ok(x>=0&&y>=0&&x+w<=4096&&y+h<=4096);
    for(const other of legacyObjects){if(other===object)continue;const [a,b,c,d]=other.atlasRect;assert.ok(x+w<=a||a+c<=x||y+h<=b||b+d<=y,`${object.catalogId} overlaps ${other.catalogId}`);}
    assert.deepEqual([w,h],['NGC7000','NGC1499'].includes(object.catalogId)?[2048,2048]:['Mel022','NGC6523'].includes(object.catalogId)?[2048,1024]:[1024,1024]);
  }
  assert.deepEqual(metadata.imageSources.map(s=>s.catalogId),['NGC0224','NGC1976','Mel022','NGC6523','NGC7000','NGC1499','IC1805','IC1848','NGC6514','NGC0598','NGC2237','IC0434','Sh2-276','RhoOph']);
  for(const source of metadata.imageSources){
    assert.equal(source.wcs.CoordsystemProjection,'TAN');assert.ok(source.credit&&source.sha256.length===64);
    if(source.registrationModel==='published-quad-mosaic'){
      assert.ok(['Public-Domain','CC-BY-4.0'].includes(source.license));
      assert.equal(source.panels.length,4);
      assert.ok(source.panels.every(panel=>panel.sha256.length===64&&panel.skyCorners.length===4));
      assert.match(source.wcs.Quality,/Derived TAN mosaic/);
    }else if(source.registrationModel==='stellarium-sky-corners'){
      assert.ok(['CC0-1.0','CC-BY-4.0','CC-BY-SA-4.0'].includes(source.license));assert.ok(source.licenseEvidence.endsWith('/CREDITS.md'));
      assert.equal(source.skyCorners.length,4);assert.ok(source.wcs.CDMatrix[0][0]<0);assert.ok(source.registrationSourceSha256.length===64);
    }else{assert.equal(source.license,'CC-BY-4.0');assert.ok(source.wcs.Scale[0]<0);}
  }
  assert.match(metadata.imageSources.find(s=>s.catalogId==='NGC2237').sourceNote,/源图已含 Hα增强/);
  assert.match(metadata.imageSources.find(s=>s.catalogId==='IC0434').sourceNote,/暗区对比近似/);
});

test('影像结构来源与独立 WCS 注册记录对应当前图集，保留旋转、缩放和覆盖边界',()=>{
  const reference=JSON.parse(readFileSync(new URL('../fixtures/deep-sky-image-registration.json',import.meta.url),'utf8'));
  assert.equal(reference.atlasSha256,metadata.atlas.sha256);
  assert.equal(reference.records.length,14);
  for(const record of reference.records){
    const source=metadata.imageSources.find(s=>s.catalogId===record.catalogId);
    assert.equal(record.textureSha256,metadata.objects.find(o=>o.catalogId===record.catalogId).texture.sha256);
    assert.equal(source.sha256,record.sourceSha256);assert.deepEqual(source.wcs,record.wcs);
    assert.deepEqual(record.atlasRect,metadata.objects.find(o=>o.catalogId===record.catalogId).atlasRect);
    assert.equal(record.samples.length,25);assert.ok(record.maxReferencePixelError<1e-7);assert.equal(record.zeroAtlasBorder,true);assert.equal(record.fullSourceFootprintContained,true);
    assert.equal(record.registrationModel,source.registrationModel??'avm');
    if(record.registrationModel==='stellarium-sky-corners')assert.ok(record.publishedCornerMaxPixelError<(source.cornerTolerancePixels??0.5),'corner fit is bounded separately from transform accuracy');
    const stats=metadata.textureStatistics.find(s=>s.catalogId===record.catalogId);
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
  for(const object of legacyObjects){
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
  const reference=JSON.parse(readFileSync(new URL('../fixtures/deep-sky-sharpness.json',import.meta.url),'utf8'));
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
  const reference=JSON.parse(readFileSync(new URL('../fixtures/deep-sky-remaining.json',import.meta.url),'utf8'));
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
  const reference=JSON.parse(readFileSync(new URL('../fixtures/deep-sky-boundary.json',import.meta.url),'utf8'));
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
  for(const object of legacyObjects){
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
    const entry=deepSkyCatalog.find(p=>p.catalogId==='Mel022');
    for(const maxSize of [8192,4096,2048,1024,512]){controller=new AbortController();await loadDeepSkyImage(controller.signal,maxSize,entry);assert.equal(decodes.at(-1).resizeWidth,Math.min(2048,maxSize));assert.equal(decodes.at(-1).resizeHeight,Math.min(1024,maxSize/2));}
    assert.ok(requests.every(r=>r.url.endsWith('/deep-sky/mel022.png')));
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
    const {width:w,height:h}=object.entry.texture,uv=[];
    for(let i=object.offset*8;i<(object.offset+object.count)*8;i+=8)uv.push([scene.vertices[i+3],scene.vertices[i+4]]);
    if(object.entry.imageReference){
      assert.ok(uv.every(point=>point.every(value=>value>0&&value<1)));
    }else{
      assert.ok(Math.abs(Math.min(...uv.map(p=>p[0]))-.5/w)<1e-7);
      assert.ok(Math.abs(Math.max(...uv.map(p=>p[0]))-(w-.5)/w)<1e-7);
      assert.ok(Math.abs(Math.min(...uv.map(p=>p[1]))-.5/h)<1e-7);
      assert.ok(Math.abs(Math.max(...uv.map(p=>p[1]))-(h-.5)/h)<1e-7);
    }
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
  for(const [query,id] of [['M31','dso-ngc0224'],['M 42','dso-ngc1976'],['昴星团','dso-mel022'],['California Nebula','dso-ngc1499'],['IC1805','dso-ic1805'],['M20','dso-ngc6514'],['M33','dso-ngc0598'],['玫瑰','dso-ngc2237'],['B33','dso-ic0434'],['马头星云','dso-ic0434']]){
    const target=searchTargets(plan,query)[0];assert.equal(target.id,id);assert.equal(target.layer,'deepSky');assert.ok(target.deep);
    assert.deepEqual(target.direction,searchTargets({...plan,cameraResponse:'ha-modified'},query)[0].direction);
  }
  assert.equal(searchTargets(plan,'深空').length,15);
});

test('独立纹理保留旧八图逐像素数据，新目标保留混合颜色、连续谱与真实暗区对比',()=>{
  const legacy=actualAtlas();
  for(const object of metadata.objects){
    const raw=readFileSync(new URL('../../src/data/deep-sky/'+object.texture.file,import.meta.url));
    assert.equal(object.texture.license,'CC-BY-SA-4.0');
    assert.equal(createHash('sha256').update(raw).digest('hex'),object.texture.sha256);
    const {width,height,pixels}=rgbaPng(raw);assert.equal(width,object.texture.width);assert.equal(height,object.texture.height);
    if(legacyObjects.includes(object)){
      const [x,y,w,h]=object.atlasRect;
      for(let row=0;row<h;row++)assert.deepEqual(pixels.subarray(row*w*4,(row+1)*w*4),legacy.pixels.subarray(((y+row)*legacy.width+x)*4,((y+row)*legacy.width+x+w)*4));
    }else{
      let red=0,blue=0,extra=0,dark=0,faintRed=0;
      for(let i=0;i<pixels.length;i+=4){
        const [r,g,b,a]=pixels.subarray(i,i+4);if(r>24&&r>b*1.2)red++;if(b>24&&b>r*1.2)blue++;if(a<240)extra++;if(a<240&&Math.max(r,g,b)<12)dark++;
        if(r>4&&r>g*1.5&&r>b*1.5)faintRed++;
      }
      if(object.catalogId==='Sh2-276')assert.ok(faintRed>10000,'the upstream faint loop keeps diffuse red support');
      else assert.ok(red+blue>1000,object.catalogId);
      if(object.catalogId==='NGC6514'){assert.ok(red>1000);assert.ok(blue>1000,'M20 blue reflection cloud must survive');assert.ok(extra>1000);}
      if(object.model==='galaxy')assert.equal(extra,0,'M33 must not gain a global red increment');
      if(object.model==='dark')assert.ok(dark>1000,'black silhouette must retain background contrast, not become transparent');
    }
  }
});

test('实际视场的独立纹理按设备与屏幕分辨率选择，全部驻留/待上传尺寸不超过 64 MiB',()=>{
  const objects=deepSkyScene(plan).objects;let stressed=false;
  for(const focalLength of [8,35,200,600,1000])for(const azimuth of [0,60,120,180,240,300]){
    const p={...plan,azimuth,pitch:45,focalLength};
    const selected=deepSkyTextureRequests(p,objects,100000,100000,2048);
    let bytes=0,native=0;
    for(const {object,maxSize} of selected){
      assert.equal(deepSkyView(p,object).state,'画面内');assert.ok(maxSize>0&&maxSize<=2048);
      const t=object.entry.texture,scale=Math.min(1,maxSize/Math.max(t.width,t.height));
      bytes+=Math.floor(t.width*scale)*Math.floor(t.height*scale)*4*4/3;native+=t.width*t.height*4*4/3;
    }
    assert.ok(bytes<=deepSkyTextureBudget);if(native>deepSkyTextureBudget){stressed=true;assert.ok(selected.some(r=>r.maxSize<Math.max(r.object.entry.texture.width,r.object.entry.texture.height)));}
    assert.deepEqual(deepSkyTextureRequests({...p,layers:{...p.layers,deepSky:false}},objects,900,600,2048),[]);
  }
  assert.equal(stressed,true,'fixed real-sky views must exercise the budget fallback');
  const point=objects.find(o=>o.entry.catalogId==='NGC6514'),aimed={...plan,instant:plan.instant,azimuth:point.azimuth,pitch:point.elevation};
  // Geometry and resource policy remain separate: response changes do not reload.
  assert.deepEqual(deepSkyTextureRequests(aimed,objects,900,600,512),deepSkyTextureRequests({...aimed,cameraResponse:'ha-modified'},objects,900,600,512));
});

test('火树独立搜索和朝向，共享马头影像及注册来源，视场只申请一次',()=>{
  const objects=deepSkyScene(plan).objects;
  const flame=objects.find(object=>object.entry.catalogId==='NGC2024');
  const owner=objects.find(object=>object.entry.catalogId==='IC0434');
  for(const query of ['火树','火焰星云','NGC2024','NGC 2024','Flame Nebula']){
    assert.equal(searchTargets(plan,query)[0].id,flame.id);
  }
  assert.notDeepEqual(flame.direction,owner.direction);
  assert.equal(flame.entry.imageReference,'IC0434');
  assert.equal(deepSkyImageEntry(flame.entry),owner.entry);
  assert.equal(deepSkyImageSource('NGC2024'),deepSkyImageSource('IC0434'));
  assert.equal(deepSkyImageUrl('NGC2024').href,deepSkyImageUrl('IC0434').href);
  const aimed={...plan,azimuth:flame.azimuth,pitch:flame.elevation,focalLength:1000};
  assert.equal(deepSkyView(aimed,flame).state,'画面内');
  const requests=deepSkyTextureRequests(aimed,objects,900,600,2048);
  assert.equal(requests.filter(request=>request.object===owner).length,1);
  assert.ok(requests.every(request=>request.object!==flame));
  assert.ok(flame.entry.bounds[2]-flame.entry.bounds[0]<owner.entry.bounds[2]-owner.entry.bounds[0]);
});

test('火树局部网格 UV 对照独立 WCSLIB，共享资料不拉伸到新目录中心',()=>{
  const reference=JSON.parse(readFileSync(new URL('../fixtures/deep-sky-image-registration.json',import.meta.url),'utf8'));
  const scene=deepSkyScene(plan);
  assert.equal(reference.sharedImages.length,1);
  const record=reference.sharedImages[0];
  const target=scene.objects.find(object=>object.entry.catalogId===record.catalogId);
  const vertices=scene.vertices.subarray(target.offset*8,(target.offset+target.count)*8);
  for(const sample of record.samples){
    let nearest=Infinity;
    for(let i=0;i<vertices.length;i+=8){
      nearest=Math.min(nearest,Math.hypot(vertices[i+3]-sample.uv[0],vertices[i+4]-sample.uv[1]));
    }
    assert.ok(nearest<1e-7,`${record.catalogId}: shared-image UV ${nearest}`);
  }
});

test('马头背景压暗有保守上限，RGB 和其他十一幅影像逐像素保持',()=>{
  const reference=JSON.parse(readFileSync(new URL('../fixtures/horsehead-flame.json',import.meta.url),'utf8'));
  for(const item of reference.unchangedImages){
    const file=readFileSync(new URL('../../src/data/deep-sky/'+item.file,import.meta.url));
    assert.equal(createHash('sha256').update(file).digest('hex'),item.sha256);
  }
  const file=readFileSync(new URL('../../src/data/deep-sky/ic0434.png',import.meta.url));
  const {pixels,width,height}=rgbaPng(file);
  const rgb=Buffer.alloc(width*height*3);
  let maximum=0,contrasted=0;
  for(let pixel=0;pixel<width*height;pixel++){
    pixels.copy(rgb,pixel*3,pixel*4,pixel*4+3);
    const opacity=(255-pixels[pixel*4+3])/255;
    maximum=Math.max(maximum,opacity);
    if(opacity>0.02)contrasted++;
  }
  assert.equal(createHash('sha256').update(rgb).digest('hex'),reference.baselineRgbSha256);
  assert.ok(maximum<=reference.maximumBackgroundOpacity+1/255);
  assert.ok(contrasted>1000,'source silhouette keeps limited background contrast');
  const statistics=metadata.textureStatistics.find(item=>item.catalogId==='IC0434');
  assert.equal(statistics.darkContrast.maximumOpacity,reference.maximumBackgroundOpacity);
});

test('大范围星云来源和分片注册可复核，既有十二幅纹理及十三个目标坐标保留',()=>{
  const baseline=JSON.parse(readFileSync(new URL('../fixtures/wide-clouds.json',import.meta.url),'utf8'));
  for(const image of baseline.unchangedImages){
    const bytes=readFileSync(new URL('../../src/data/deep-sky/'+image.file,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),image.sha256);
  }
  for(const expected of baseline.unchangedTargets){
    const actual=deepSkyCatalog.find(object=>object.id===expected.id);
    assert.deepEqual({id:actual.id,ra:actual.ra,dec:actual.dec,bounds:actual.bounds},expected);
  }
  const registration=JSON.parse(readFileSync(new URL('../fixtures/wide-cloud-registration.json',import.meta.url),'utf8'));
  assert.equal(registration.records.length,2);
  for(const object of registration.records){
    const source=metadata.imageSources.find(spec=>spec.catalogId===object.catalogId);
    assert.equal(object.mosaicSha256,source.sha256);
    assert.equal(object.records.length,4);
    for(const panel of object.records){
      assert.equal(panel.sha256,source.panels.find(p=>p.file===panel.file).sha256);
      assert.equal(panel.sampleCount,25);
      assert.ok(panel.maximumMosaicPixelError<1e-7);
      assert.ok(panel.maximumCornerPixelError<1e-7);
      assert.ok(panel.retainedRgbSamples>=20);
    }
  }
  assert.equal(deepSkyImageSource('Sh2-276').license,'Public-Domain');
  assert.equal(deepSkyImageSource('Sh2-276').signalModel,'display-rgb');
  assert.equal(deepSkyCatalog.find(object=>object.catalogId==='Sh2-276').texture.sha256,baseline.barnardDisplaySignal.textureSha256);
  assert.equal(deepSkyImageSource('RhoOph').license,'CC-BY-4.0');
});

test('巴纳德环与蛇夫座复合体支持区域搜索，宽幅网格遵循 0.25° 分段目标',()=>{
  for(const query of ['巴纳德环','巴纳德弧','Barnard Loop',"Barnard's Loop",'Sh2-276','Sh 2-276']){
    assert.equal(searchTargets(plan,query)[0].id,'dso-sh2-276');
  }
  for(const query of ['蛇夫座星云复合体','蛇夫座星云','天蝎调色盘','Rho Oph','Rho Ophiuchi']){
    assert.equal(searchTargets(plan,query)[0].id,'dso-rhooph');
  }
  const object=deepSkyScene(plan).objects.find(target=>target.id==='dso-sh2-276');
  assert.ok(object.count>32*32*6,'the wide field keeps the established angular mesh spacing');
  assert.ok(object.count<=128*128*6);
  assert.equal(deepSkyView({...plan,azimuth:object.azimuth,pitch:object.elevation,focalLength:50},object).state,'画面内');
  const {width,height,pixels}=rgbaPng(readFileSync(new URL('../../src/data/deep-sky/'+object.entry.texture.file,import.meta.url)));
  const angle=object.entry.ra*Math.PI/180,declination=object.entry.dec*Math.PI/180;
  const center=[Math.cos(declination)*Math.cos(angle),Math.cos(declination)*Math.sin(angle),Math.sin(declination)];
  const east=[-Math.sin(angle),Math.cos(angle),0];
  const north=[-Math.sin(declination)*Math.cos(angle),-Math.sin(declination)*Math.sin(angle),Math.cos(declination)];
  const [x0,y0,x1,y1]=object.entry.bounds;
  for(const catalogId of ['NGC1976','IC0434','NGC2024']){
    const target=deepSkyCatalog.find(entry=>entry.catalogId===catalogId);
    const a=target.ra*Math.PI/180,d=target.dec*Math.PI/180;
    const ray=[Math.cos(d)*Math.cos(a),Math.cos(d)*Math.sin(a),Math.sin(d)];
    const z=ray.reduce((sum,value,i)=>sum+value*center[i],0);
    const x=ray.reduce((sum,value,i)=>sum+value*east[i],0)/z;
    const y=ray.reduce((sum,value,i)=>sum+value*north[i],0)/z;
    const px=Math.floor((x-x0)/(x1-x0)*(width-1));
    const py=Math.floor((y1-y)/(y1-y0)*(height-1));
    const index=(py*width+px)*4;
    assert.deepEqual([...pixels.subarray(index,index+4)],[0,0,0,255],`${catalogId}: the loop must not duplicate an existing nebular core`);
  }
});

test('蛇夫座黄色和蓝色反射云没有红光增量，红色结构可增强',()=>{
  const entry=deepSkyCatalog.find(object=>object.catalogId==='RhoOph');
  const {pixels}=rgbaPng(readFileSync(new URL('../../src/data/deep-sky/'+entry.texture.file,import.meta.url)));
  let yellow=0,blue=0,red=0;
  for(let i=0;i<pixels.length;i+=4){
    const [r,g,b,a]=pixels.subarray(i,i+4);
    if(r>12&&g>r*0.65&&g>b*1.4&&r>g){yellow++;assert.equal(a,255);}
    if(b>12&&b>r*1.4){blue++;assert.equal(a,255);}
    if(r>12&&r>g*1.8&&r>b*1.4&&a<255)red++;
  }
  assert.ok(yellow>10000);assert.ok(blue>10000);assert.ok(red>1000);
});

test('M20 连通支持消除外围星场块，中心原始 RGBA 细节逐像素保留',()=>{
  const reference=JSON.parse(readFileSync(new URL('../fixtures/deep-sky-next-four.json',import.meta.url),'utf8'));
  const object=deepSkyCatalog.find(o=>o.catalogId===reference.catalogId);
  const source=metadata.imageSources.find(s=>s.catalogId===reference.catalogId);
  assert.equal(source.supportSeed,'catalogue-centre');
  assert.equal(object.texture.sha256,reference.textureSha256);
  assert.deepEqual(object.bounds,reference.bounds);
  const {width,height,pixels}=rgbaPng(readFileSync(new URL('../../src/data/deep-sky/'+object.texture.file,import.meta.url)));
  const [x0,y0,x1,y1]=object.bounds;
  const coreHash=createHash('sha256');
  let coreSum=0,outerSum=0,corePixels=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const tx=x0+(x1-x0)*x/(width-1),ty=y1-(y1-y0)*y/(height-1);
    const radius=Math.atan(Math.hypot(tx,ty))*180/Math.PI;
    const i=(y*width+x)*4,sum=pixels[i]+pixels[i+1]+pixels[i+2];
    if(radius<reference.coreRadiusDegrees){
      corePixels++;coreSum+=sum;coreHash.update(pixels.subarray(i,i+4));
    }
    if(radius>reference.outerMinimumRadiusDegrees)outerSum+=sum;
  }
  assert.equal(corePixels,reference.corePixels);
  assert.equal(coreHash.digest('hex'),reference.coreRgbaSha256);
  assert.ok(outerSum/coreSum<reference.maximumOuterToCoreRgbRatio,'detached exterior signal reappeared');
});

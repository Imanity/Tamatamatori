import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {Document,NodeIO} from '@gltf-transform/core';
import {gunzipSync} from 'node:zlib';
import {convertModel,inspectModel,validateRecipe,validateAsset,hash,identity} from '../scripts/lib/landmark-model.mjs';
import {run,inside,transaction,placementIdentity} from '../scripts/landmarks.mjs';
import {compareCoverage} from '../scripts/lib/landmark-coverage.mjs';

const io=new NodeIO(),silent=()=>{},json=v=>JSON.stringify(v,null,2)+'\n';
async function source(scale=[1,1,1]){
  const d=new Document(),b=d.createBuffer(),positions=new Float32Array([-1,0,-1,1,0,-1,1,10,-1,-1,10,-1,-1,0,1,1,0,1,1,10,1,-1,10,1]);
  const normals=Float32Array.from(positions,(v,i)=>{const a=i%3;return (a===1?(v===0?-1:1):v)/Math.sqrt(3);});
  const primitive=d.createPrimitive().setAttribute('POSITION',d.createAccessor().setType('VEC3').setArray(positions).setBuffer(b)).setAttribute('NORMAL',d.createAccessor().setType('VEC3').setArray(normals).setBuffer(b)).setIndices(d.createAccessor().setType('SCALAR').setArray(new Uint32Array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5])).setBuffer(b));
  const n=d.createNode('box').setMesh(d.createMesh().addPrimitive(primitive)).setScale(scale);d.createScene().addChild(n);return Buffer.from(await io.writeBinary(d));
}
const bytes=await source();
function recipe(id='fixture-model'){
  return {schemaVersion:1,id,name:'测试模型',version:1,source:{sha256:hash(bytes),filename:'fixture.glb',title:'Fixture',author:'Fixture author',authorPage:'https://example.com/author',page:'https://example.com/model',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',upstreamNotes:'独立合成几何，不是实景资料'},frame:{space:'local',axes:['+x','-z','+y'],center:'base-bounds',height:10,heightReference:'https://example.com/height',yawDegrees:0,requireSharedTransform:true,normalizeNormals:true},processing:{targetTriangles:12,maxErrorMetres:.00001,normalWeight:.01,weld:false},geo:{latitude:10,longitude:10,partRadius:10,parts:[],registration:'合成定位，仅供测试',references:[]},review:{license:true,geometry:true,registration:true}};
}
async function fixture(t,recipes=[recipe()]){
  const root=await mkdtemp(join(tmpdir(),'tamatamatori-landmarks-'));
  t.after(async()=>{assert.equal(dirname(root),resolve(tmpdir()));assert.ok(basename(root).startsWith('tamatamatori-landmarks-'));await rm(root,{recursive:true});});
  for(const dir of ['landmarks/recipes','inbox'])await mkdir(join(root,dir),{recursive:true});
  await writeFile(join(root,'landmarks/registry.json'),json({schemaVersion:1,entries:[]}));
  for(const r of recipes)await writeFile(join(root,`landmarks/recipes/${r.id}.json`),json(r));
  await writeFile(join(root,'inbox/arbitrary-name.glb'),bytes);
  return {root,run:argv=>run(argv,{root,log:silent}),read:p=>readFile(join(root,p),'utf8'),write:(p,v)=>writeFile(join(root,p),typeof v==='string'?v:json(v))};
}

test('批量输入按哈希匹配，与文件名无关；确定性产物及六方向轮廓检查',async t=>{
  const f=await fixture(t),a=await f.run(['batch','--all','--input-dir',join(f.root,'inbox')]);assert.ok(a.ok);
  const before=await f.read('.cache/landmarks/staging/fixture-model/manifest.json');
  const b=await f.run(['batch','--all','--input-dir',join(f.root,'inbox')]);assert.deepEqual(b,a);assert.equal(await f.read('.cache/landmarks/staging/fixture-model/manifest.json'),before);
  assert.ok((await f.run(['check','--all'])).ok);const coverage=JSON.parse(await f.read('.cache/landmarks/staging/fixture-model/coverage.json'));assert.equal(coverage.records.length,6);assert.ok(coverage.records.every(r=>r.intersectionOverUnion===1));
});

test('候选草稿带源哈希与未核查状态，重复执行保留已编辑草稿，不进入批量配方',async t=>{
  const f=await fixture(t);const candidate={name:'候选',modelTitle:'Candidate',author:'Author',authorUrl:'https://example.com/author',url:'https://example.com/model'};
  await f.write('landmarks/downloads.json',{models:[{id:'candidate-model',...candidate},{id:'nc-model',...candidate,license:{slug:'by-nc'}},{id:'nd-model',...candidate,license:{slug:'by-nd'}}]});
  const args=['draft','--id=candidate-model','--input',join(f.root,'inbox/arbitrary-name.glb')],result=await f.run(args);assert.ok(result.ok);assert.equal(result.draft.source.title,'Candidate');assert.equal(result.draft.source.sha256,hash(bytes));assert.equal(result.draft.review.geometry,false);assert.throws(()=>validateRecipe(result.draft));
  // Licence is pre-filled only from an accepted Sketchfab slug; missing or unsupported licences stay blank for manual review.
  assert.equal(result.draft.source.license,null);
  const nc=await f.run(['draft','--id=nc-model','--input',join(f.root,'inbox/arbitrary-name.glb')]);assert.equal(nc.draft.source.license,'CC BY-NC 4.0');assert.equal(nc.draft.source.licenseUrl,'https://creativecommons.org/licenses/by-nc/4.0/');
  const nd=await f.run(['draft','--id=nd-model','--input',join(f.root,'inbox/arbitrary-name.glb')]);assert.equal(nd.draft.source.license,null);assert.equal(nd.draft.source.licenseUrl,null);
  await assert.rejects(f.run(args),/不覆盖/);await assert.rejects(f.run(['batch','--ids=candidate-model','--input-dir',join(f.root,'inbox')]),/未登记/);
  await assert.rejects(f.run(['check','--all','--ids=fixture-model']),/一种/);await assert.rejects(f.run(['check','--ids=fixture-model,fixture-model']),/重复/);
});

test('暂存产物路径和覆盖证明变更被拒绝，不读取指定目录以外的资源',async t=>{
  const f=await fixture(t);await f.run(['batch','--all','--input-dir',join(f.root,'inbox')]);
  const path='.cache/landmarks/staging/fixture-model/manifest.json',m=JSON.parse(await f.read(path));m.asset.file='../escape.ttlm.gz';await f.write(path,m);assert.equal((await f.run(['check','--all'])).ok,false);await assert.rejects(f.run(['integrate','--all','--allow-pending-visual']),/产物与配方/);
  await f.run(['batch','--all','--input-dir',join(f.root,'inbox')]);const coveragePath='.cache/landmarks/staging/fixture-model/coverage.json',coverage=JSON.parse(await f.read(coveragePath));coverage.records[0].intersectionOverUnion=.5;await f.write(coveragePath,coverage);assert.equal((await f.run(['check','--all'])).ok,false);
});

test('批次内一项缺源仍检查其他项，错误汇总退出失败；失败重跑使旧暂存失效',async t=>{
  const missing=recipe('missing-model');missing.source.sha256='0'.repeat(64);const f=await fixture(t,[recipe(),missing]);
  const first=await f.run(['batch','--all','--input-dir',join(f.root,'inbox')]);assert.equal(first.ok,false);assert.ok(first.reports.find(r=>r.id==='fixture-model').ok);assert.match(first.reports.find(r=>r.id==='missing-model').error,/没有找到/);
  await mkdir(join(f.root,'empty'));assert.equal((await f.run(['batch','--ids=fixture-model','--input-dir',join(f.root,'empty')])).ok,false);
  assert.equal((await f.run(['check','--ids=fixture-model'])).ok,false);await assert.rejects(f.run(['integrate','--all','--allow-pending-visual']));assert.equal(await f.read('landmarks/registry.json'),json({schemaVersion:1,entries:[]}));
});

test('集成 dry-run 不改仓库；待验必须显式选择；资源、目录和署名成组生成',async t=>{
  const f=await fixture(t);await f.run(['batch','--all','--input-dir',join(f.root,'inbox')]);
  await assert.rejects(f.run(['integrate','--all']),/画面待验/);
  const before=await f.read('landmarks/registry.json');await f.run(['integrate','--all','--dry-run','--allow-pending-visual']);assert.equal(await f.read('landmarks/registry.json'),before);await assert.rejects(f.read('src/data/landmarks.generated.json'),{code:'ENOENT'});
  await f.run(['integrate','--all','--allow-pending-visual']);const result=await f.run(['verify']);assert.ok(result.ok);assert.equal(result.catalog[0].validation.visual,'pending');assert.match(await f.read('public/landmarks/CREDITS.txt'),/Fixture author/);assert.match(await f.read('public/landmarks/CREDITS.txt'),/待验证/);
});

test('事务中途写入失败时恢复原文件，拒绝越出工作区路径',async t=>{
  const f=await fixture(t);await f.write('old.txt','keep');await f.write('blocked','file');
  await assert.rejects(transaction(f.root,new Map([['old.txt','changed'],['new.txt','new'],['blocked/child.txt','fail']])));
  assert.equal(await f.read('old.txt'),'keep');await assert.rejects(f.read('new.txt'),{code:'ENOENT'});
  assert.throws(()=>inside(f.root,'../escape.json'));assert.throws(()=>inside(f.root,f.root));
});

test('集成前校验整个批次，第二项损坏不会留下第一项的目录或资源',async t=>{
  const f=await fixture(t,[recipe(),recipe('second-model')]);await f.run(['batch','--all','--input-dir',join(f.root,'inbox')]);await f.write('.cache/landmarks/staging/second-model/model.ttlm.gz','bad');
  await assert.rejects(f.run(['integrate','--all','--allow-pending-visual']),/资源身份/);assert.equal(JSON.parse(await f.read('landmarks/registry.json')).entries.length,0);await assert.rejects(f.read('public/landmarks/fixture-model-v1.json'),{code:'ENOENT'});
});

test('已集成文件、来源和生成目录漂移均使离线 verify 失败',async t=>{
  const f=await fixture(t);await f.run(['batch','--all','--input-dir',join(f.root,'inbox')]);await f.run(['integrate','--all','--allow-pending-visual']);
  const manifestPath='public/landmarks/fixture-model-v1.json',original=await f.read(manifestPath),manifest=JSON.parse(original);manifest.source.author='wrong';await f.write(manifestPath,manifest);await assert.rejects(f.run(['verify']),/来源漂移/);
  await f.write(manifestPath,original);await f.write('src/data/landmarks.generated.json','[]\n');await assert.rejects(f.run(['verify']),/生成目录/);
});

test('资源和位置变化须提升版本，画面验收不能随变更沿用',async t=>{
  const f=await fixture(t);await f.run(['batch','--all','--input-dir',join(f.root,'inbox')]);await f.run(['integrate','--all','--allow-pending-visual']);
  const r=recipe();r.geo.longitude+=1;await f.write('landmarks/recipes/fixture-model.json',r);await f.run(['batch','--all','--input-dir',join(f.root,'inbox')]);await assert.rejects(f.run(['integrate','--all','--allow-pending-visual']),/提升版本/);
  r.version=2;await f.write('landmarks/recipes/fixture-model.json',r);await f.run(['batch','--all','--input-dir',join(f.root,'inbox')]);await f.run(['integrate','--all','--allow-pending-visual']);assert.equal((await f.run(['verify'])).catalog[0].validation.visual,'pending');
});

test('画面证据必须与资源和位置绑定；不接受过时或未通过的验收记录',async t=>{
  const f=await fixture(t);await f.run(['batch','--all','--input-dir',join(f.root,'inbox')]);await f.run(['integrate','--all','--allow-pending-visual']);
  const entry=JSON.parse(await f.read('landmarks/registry.json')).entries[0];await f.write('evidence.json',{id:entry.id,assetSha256:entry.assetSha256,placementHash:'0'.repeat(64),gpuPassed:true,screenshots:['synthetic.png']});
  await assert.rejects(f.run(['record-visual','--id=fixture-model','--evidence=evidence.json']),/不对应/);
  // Synthetic fixture tests the bookkeeping only; no product GPU verification is claimed.
  await f.write('synthetic.png','synthetic test fixture');await f.write('evidence.json',{id:entry.id,assetSha256:entry.assetSha256,placementHash:entry.placementHash,gpuPassed:true,screenshots:['synthetic.png']});await f.run(['record-visual','--id=fixture-model','--evidence=evidence.json']);assert.equal((await f.run(['verify'])).catalog[0].validation.visual,'verified');
});

test('配方拒绝漏核查、未知字段、无效坐标轴、重复分部和未支持许可',()=>{
  for(const mutate of [r=>r.review.license=false,r=>r.frame.axes=['+x','-x','+z'],r=>r.geo.latitude=91,r=>r.processing.maxErrorMetres=2,r=>r.source.license='Editorial only',r=>r.unknown=true,r=>r.source.sha256='bad',r=>r.source.filename='../bad.glb',r=>r.geo.parts=[{id:1,height:10,base:0},{id:1,height:10,base:0}]]){const r=recipe();mutate(r);assert.throws(()=>validateRecipe(r));}
  assert.equal(identity({b:2,a:1}),identity({a:1,b:2}));
});

test('非商业许可须配对应链接，限制随目录、About 数据与署名文件生成；其他许可不带限制',async t=>{
  const nc=recipe('noncommercial-model');nc.source.license='CC BY-NC 4.0';nc.source.licenseUrl='https://creativecommons.org/licenses/by-nc/4.0/';validateRecipe(nc);
  for(const [license,licenseUrl] of [['CC BY-NC 4.0','https://creativecommons.org/licenses/by/4.0/'],['CC BY 4.0','https://creativecommons.org/licenses/by-nc/4.0/'],['CC BY-NC-ND 4.0','https://creativecommons.org/licenses/by-nc-nd/4.0/'],['constructor','https://creativecommons.org/licenses/by/4.0/']]){const r=recipe();r.source.license=license;r.source.licenseUrl=licenseUrl;assert.throws(()=>validateRecipe(r),/许可/);}
  const f=await fixture(t,[recipe(),nc]);await f.run(['batch','--all','--input-dir',join(f.root,'inbox')]);await f.run(['integrate','--all','--allow-pending-visual']);
  const catalog=(await f.run(['verify'])).catalog,byId=Object.fromEntries(catalog.map(m=>[m.id,m]));
  assert.equal(byId['noncommercial-model'].credit.use,'仅限非商业使用');assert.equal('use' in byId['fixture-model'].credit,false);
  const credits=await f.read('public/landmarks/CREDITS.txt');assert.match(credits,/CC BY-NC 4\.0 https:\/\/creativecommons\.org\/licenses\/by-nc\/4\.0\/（仅限非商业使用）/);assert.equal(credits.match(/仅限非商业使用/g).length,1);
});

test('静态 GLB 检查输出本地与世界框架，不自动猜测朝向；哈希不符即停止',async()=>{
  const report=await inspectModel(bytes);assert.equal(report.triangles,12);assert.equal(report.nodes.length,1);assert.equal(report.sourceSha256,hash(bytes));
  await assert.rejects(convertModel(bytes,{...recipe(),source:{...recipe().source,sha256:'0'.repeat(64)}}),/SHA-256/);
  await assert.rejects(inspectModel(Buffer.from('not-glb')),/GLB/);
  for(const mutate of [j=>j.animations=[{}],j=>j.buffers[0].uri='https://example.com/mesh.bin',j=>j.extensionsRequired=['KHR_draco_mesh_compression'],j=>j.extensionsUsed=['EXT_mesh_gpu_instancing']]){
    const length=bytes.readUInt32LE(12),j=JSON.parse(bytes.toString('utf8',20,20+length));mutate(j);let text=JSON.stringify(j);text+=' '.repeat((4-text.length%4)%4);const body=Buffer.from(text),rest=bytes.subarray(20+length),bad=Buffer.alloc(20+body.length+rest.length);bytes.copy(bad,0,0,20);bad.writeUInt32LE(bad.length,8);bad.writeUInt32LE(body.length,12);body.copy(bad,20);rest.copy(bad,20+body.length);await assert.rejects(inspectModel(bad));
  }
});

test('世界框架的非均匀缩放用逆转置法线，反射同步翻转三角形绕序',async()=>{
  const b=await source([-2,3,4]),r=recipe();r.source.sha256=hash(b);r.frame.space='world';const c=await convertModel(b,r),v=c.fine.vertices;
  for(let i=0;i<c.fine.indices.length;i+=3){const p=[0,1,2].map(j=>Array.from(v.subarray(c.fine.indices[i+j]*6,c.fine.indices[i+j]*6+3))),a=p[1].map((x,k)=>x-p[0][k]),b=p[2].map((x,k)=>x-p[0][k]),cross=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],n=v.subarray(c.fine.indices[i]*6+3,c.fine.indices[i]*6+6);assert.ok(cross.reduce((s,x,k)=>s+x*n[k],0)>0);}
  const expected=[-.5,.25,-1/3],length=Math.hypot(...expected);let found=false;for(let i=0;i<v.length;i+=6)if(Math.abs(v[i]+2/3)<1e-5&&Math.abs(v[i+1]-4/3)<1e-5&&v[i+2]===0){found=true;for(let k=0;k<3;k++)assert.ok(Math.abs(v[i+3+k]-expected[k]/length)<1e-6);}assert.ok(found);
});

test('源/产物覆盖相同通过，缺失整个面不可用高重合率以外的状态冒充通过',async()=>{
  const c=await convertModel(bytes,recipe()),same=compareCoverage(c.reference,c.fine,10);assert.ok(same.passed);
  const missing={vertices:c.fine.vertices,indices:new Uint32Array()};assert.equal(compareCoverage(c.reference,missing,10).passed,false);
  const bad=Buffer.from(c.compressed);bad[15]^=1;assert.throws(()=>validateAsset(bad,c.manifest),/资源身份/);
  assert.equal(gunzipSync(c.compressed).length,c.manifest.asset.decodedBytes);
});

test('实仓全部资源离线验证，不需要原始下载；既有几何身份保留',async()=>{
  const result=await run(['verify'],{log:silent});assert.ok(result.ok);assert.ok(result.catalog.length>=3);assert.ok(['pending','verified'].includes(result.catalog.find(m=>m.id==='tokyo-tower').validation.visual));
  assert.equal(result.catalog.find(m=>m.id==='tokyo-skytree').asset.sha256,'4ee6a8d802db2ccf0538add4ff7f3b54e21237e4cd36267e7a487852305848cd');
  assert.equal(result.catalog.find(m=>m.id==='shanghai-tower').asset.sha256,'33a86c8ec1d446134e1d09c601ebb736158112559fc7393eeaa384c61d57f2de');
});

async function selectionSource({line=false,duplicate=false}={}){
  const d=new Document(),b=d.createBuffer(),scene=d.createScene();
  const accessor=(type,array)=>d.createAccessor().setType(type).setArray(array).setBuffer(b);
  const quad=(name,positions,normal,material)=>{const p=d.createPrimitive().setAttribute('POSITION',accessor('VEC3',new Float32Array(positions))).setAttribute('NORMAL',accessor('VEC3',new Float32Array(Array(4).fill(normal).flat()))).setIndices(accessor('SCALAR',new Uint32Array([0,1,2,0,2,3])));if(material)p.setMaterial(material);return p;};
  const front=d.createMaterial('Front'),back=d.createMaterial('Back');
  const wall=d.createMesh('wall').addPrimitive(quad('wall',[-1,0,0,1,0,0,1,10,0,-1,10,0],[0,0,1],front));
  if(duplicate)wall.addPrimitive(quad('back',[-1,0,0,-1,10,0,1,10,0,1,0,0],[0,0,-1],back));
  if(line)wall.addPrimitive(d.createPrimitive().setMode(1).setAttribute('POSITION',accessor('VEC3',new Float32Array([-1,0,0,1,10,0]))));
  scene.addChild(d.createNode('tower').setMesh(wall));
  scene.addChild(d.createNode('ground').setMesh(d.createMesh('ground').addPrimitive(quad('ground',[-50,0,-50,50,0,-50,50,0,50,-50,0,50],[0,1,0]))));
  return Buffer.from(await io.writeBinary(d));
}

test('显式排除非建筑节点、忽略线段图元；名称不存在或未登记时拒绝，不静默猜测',async()=>{
  const plain=await selectionSource(),r=recipe();r.source.sha256=hash(plain);r.frame.space='world';
  await assert.rejects(convertModel(plain,{...r,processing:{...r.processing,excludeNodes:['missing']}}),/排除节点不存在/);
  const kept=await convertModel(plain,r);assert.ok(kept.manifest.bounds.horizontal>=50,'ground plane is part of the source until excluded');
  const c=await convertModel(plain,{...r,processing:{...r.processing,excludeNodes:['ground']}});
  assert.equal(c.manifest.selection.excludedNodes,1);assert.equal(c.manifest.selection.excludedTriangles,2);assert.ok(c.manifest.bounds.horizontal<3);assert.equal(c.manifest.asset.triangles,2);
  const lined=await selectionSource({line:true}),l=recipe();l.source.sha256=hash(lined);l.frame.space='world';l.processing.excludeNodes=['ground'];
  await assert.rejects(convertModel(lined,l),/三角网格/);assert.equal((await inspectModel(lined)).nodes.find(n=>n.name==='tower').linePrimitives,1);
  const skipped=await convertModel(lined,{...l,processing:{...l.processing,ignoreLinePrimitives:true}});assert.equal(skipped.manifest.selection.ignoredLinePrimitives,1);assert.equal(skipped.manifest.asset.triangles,2);
  for(const bad of [{excludeNodes:[]},{excludeNodes:['a','a']},{ignoreLinePrimitives:false},{dropDuplicateTriangles:false},{backMaterials:['Back']}])assert.throws(()=>validateRecipe({...r,processing:{...r.processing,...bad}}));
});

test('双面导出的重合反向面无损去重，登记的背面材质让位；目标面数超过输入时不越界',async()=>{
  const bytes=await selectionSource({duplicate:true}),r=recipe();r.source.sha256=hash(bytes);r.frame.space='world';r.processing={...r.processing,targetTriangles:100000,excludeNodes:['ground']};
  assert.equal((await convertModel(bytes,r)).manifest.asset.triangles,4,'without the option both coincident faces stay');
  await assert.rejects(convertModel(bytes,{...r,processing:{...r.processing,dropDuplicateTriangles:true,backMaterials:['Missing']}}),/背面材质不存在/);
  const c=await convertModel(bytes,{...r,processing:{...r.processing,dropDuplicateTriangles:true,backMaterials:['Back']}}),v=c.fine.vertices;
  assert.equal(c.manifest.asset.triangles,2);assert.equal(c.manifest.selection.duplicateTriangles,2);
  for(let i=0;i<v.length;i+=6)assert.ok(v[i+4]<-.99,'front material normal (+z source, -north ENU) is kept');
  assert.ok(compareCoverage(c.reference,c.fine,10).passed);
});

test('轮廓覆盖按文档 1 米容差判定，与栅格精度无关：亚米偏移通过，超过 1 米失败',()=>{
  const box=(dx,top=10)=>{const p=new Float32Array([-1+dx,-.1,0,1+dx,-.1,0,1+dx,-.1,top,-1+dx,-.1,top]);return p;};
  const source={positions:box(0),indices:new Uint32Array([0,1,2,0,2,3])};
  const shifted=(dx,top)=>{const p=box(dx,top),v=new Float32Array(24);for(let i=0;i<4;i++)v.set([...p.subarray(i*3,i*3+3),0,-1,0],i*6);return{vertices:v,indices:new Uint32Array([0,1,2,0,2,3])};};
  const fine=compareCoverage(source,shifted(0,9.9),10);assert.ok(fine.metresPerPixel<.01);assert.ok(fine.records.every(r=>r.maxRasterCoverageDistanceMetres>.09&&r.maxRasterCoverageDistanceMetres<.11));
  assert.ok(fine.passed,'a 0.1 m change spans more than 4 px here and is still within the 1 m tolerance');
  assert.equal(compareCoverage(source,shifted(0,9.6),10).passed,false,'IoU below 0.98 still fails');
  const far=compareCoverage(source,shifted(0,8.5),10);assert.equal(far.passed,false);assert.ok(far.records.some(r=>r.maxRasterCoverageDistanceMetres>1));
});

// Twin-tower fixture for registered shape corrections: two tower boxes, a bridge box and a sloped ramp.
async function twinSource(){
  const d=new Document(),b=d.createBuffer(),scene=d.createScene(),s=Math.SQRT1_2;
  const accessor=(type,array)=>d.createAccessor().setType(type).setArray(array).setBuffer(b);
  const quad=(mesh,corners,normal)=>mesh.addPrimitive(d.createPrimitive().setAttribute('POSITION',accessor('VEC3',new Float32Array(corners.flat()))).setAttribute('NORMAL',accessor('VEC3',new Float32Array(Array(4).fill(normal).flat()))).setIndices(accessor('SCALAR',new Uint32Array([0,1,2,0,2,3]))));
  const box=(name,[x0,y0,z0],[x1,y1,z1])=>{const mesh=d.createMesh(name);
    for(const [n,q] of [[[1,0,0],[[x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[x1,y0,z1]]],[[-1,0,0],[[x0,y0,z1],[x0,y1,z1],[x0,y1,z0],[x0,y0,z0]]],[[0,1,0],[[x0,y1,z0],[x0,y1,z1],[x1,y1,z1],[x1,y1,z0]]],[[0,-1,0],[[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]]],[[0,0,1],[[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]]],[[0,0,-1],[[x0,y0,z0],[x0,y1,z0],[x1,y1,z0],[x1,y0,z0]]]])quad(mesh,q,n);
    scene.addChild(d.createNode(name).setMesh(mesh));};
  box('left',[-6,0,-1],[-2,10,1]);box('right',[2,0,-1],[6,10,1]);box('bridge',[-2,6,-1],[2,7,1]);
  const ramp=d.createMesh('ramp');quad(ramp,[[7,0,-1],[7,0,1],[9,2,1],[9,2,-1]],[-s,s,0]);scene.addChild(d.createNode('ramp').setMesh(ramp));
  return Buffer.from(await io.writeBinary(d));
}
function twinRecipe(source,corrections){
  const r=recipe();r.source.sha256=hash(source);r.frame.space='world';r.frame.requireSharedTransform=false;r.frame.center=[0,0];
  r.processing={targetTriangles:1000,maxErrorMetres:.00001,normalWeight:.01,weld:false};return corrections?{...r,corrections}:r;
}
const fineVertices=c=>{const v=c.fine.vertices,out=[];for(let i=0;i<v.length;i+=6)out.push([...v.subarray(i,i+6)]);return out;};
const near=(a,b,eps=1e-4)=>Math.abs(a-b)<eps;
const axisNormal=p=>near(Math.abs(p[3])+Math.abs(p[4])+Math.abs(p[5]),1);

test('造型修正按节点平移、沿轴分段重映射：两塔外移且不变形，天桥下移并拉长到新立面',async()=>{
  const t=await twinSource();
  const c=await convertModel(t,twinRecipe(t,[{op:'translate',nodes:['bridge'],offset:[0,0,-3],reason:'测试：天桥按参考高度下移'},{op:'remap',axis:'x',points:[[-10,-11],[-1,-2],[1,2],[10,11]],reason:'测试：两塔按参考间距外移'}]));
  const pts=fineVertices(c),xs=list=>[...new Set(list.map(p=>Math.round(p[0]*1000)/1000))].sort((a,b)=>a-b);
  const bridge=pts.filter(p=>p[2]>2.5&&p[2]<4.5),left=pts.filter(p=>p[0]<0&&(near(p[2],0)||near(p[2],10))),right=pts.filter(p=>p[0]>0&&p[0]<7.5&&(near(p[2],0)||near(p[2],10)));
  assert.deepEqual([...new Set(bridge.map(p=>p[2]))].sort(),[3,4],'bridge moved down by its registered offset only');
  assert.deepEqual(xs(bridge),[-3,3],'bridge stretched to the moved inner facades');assert.deepEqual(xs(left),[-7,-3]);assert.deepEqual(xs(right),[3,7]);
  assert.equal(pts.length,76);assert.equal(pts.filter(axisNormal).length,72,'box faces keep axis-aligned normals; only the ramp is sloped');
  assert.deepEqual(c.manifest.correctionStats,[{op:'translate',vertices:24},{op:'remap',vertices:76}]);
  assert.equal(c.manifest.corrections.length,2);assert.ok(c.manifest.limitations.some(x=>x.includes('参考尺寸修正')));
  const plain=await convertModel(t,twinRecipe(t));assert.equal(plain.manifest.corrections,undefined);assert.ok(!plain.manifest.limitations.some(x=>x.includes('修正')));
});

test('缩放与重映射按逆转置变换法线，内部断点取两侧斜率平均；位置随分段比例变化',async()=>{
  const t=await twinSource(),ramp=pts=>pts.filter(p=>!axisNormal(p));
  const scaled=fineVertices(await convertModel(t,twinRecipe(t,[{op:'scale',factors:[.5,1,1],about:[0,0,0],reason:'测试：水平收窄'}])));
  assert.equal(Math.min(...scaled.map(p=>p[0])),-3);assert.equal(ramp(scaled).length,4);
  for(const p of ramp(scaled))assert.ok(near(p[3],-2/Math.sqrt(5))&&near(p[4],0)&&near(p[5],1/Math.sqrt(5)),'x-compressed slope tilts its normal toward x');
  const mapped=fineVertices(await convertModel(t,twinRecipe(t,[{op:'remap',axis:'z',points:[[0,0],[2,1],[10,10]],reason:'测试：竖向分段'}])));
  assert.ok(mapped.some(p=>near(p[2],10))&&mapped.some(p=>near(p[2],5.5))&&mapped.some(p=>near(p[2],1)),'10 m top fixed, 6 m bridge underside → 5.5 m, 2 m → 1 m');
  const r=ramp(mapped),low=r.filter(p=>near(p[2],0)),high=r.filter(p=>near(p[2],1)),k=(.5+9/8)/2,m=Math.hypot(1,1/k);
  assert.equal(low.length,2);assert.equal(high.length,2);
  for(const p of low)assert.ok(near(p[3],-1/Math.sqrt(5))&&near(p[5],2/Math.sqrt(5)),'slope 0.5 doubles the normal z component');
  for(const p of high)assert.ok(near(p[3],-1/m)&&near(p[5],(1/k)/m),'breakpoint uses the mean of both segment slopes');
});

test('造型修正须写明依据、单调且有界；节点必须存在且未排除，结果不得越出 0 至登记总高',async()=>{
  const t=await twinSource(),r=twinRecipe(t),ok={op:'scale',factors:[.9,.9,1],about:[0,0,0],reason:'依据'};
  validateRecipe({...r,corrections:[ok]});
  for(const bad of [[],Array(9).fill(ok),[{...ok,op:'rotate'}],[{...ok,reason:''}],[{...ok,extra:1}],[{...ok,factors:[.4,1,1]}],[{...ok,about:[0,0]}],
    [{op:'remap',axis:'w',points:[[0,0],[1,1]],reason:'x'}],[{op:'remap',axis:'z',points:[[0,0],[0,1]],reason:'x'}],[{op:'remap',axis:'z',points:[[0,0],[1,3]],reason:'x'}],[{op:'remap',axis:'z',points:[[0,0]],reason:'x'}],
    [{op:'translate',offset:[0,0,1],reason:'x'}],[{op:'translate',nodes:['bridge'],offset:[0,0,600],reason:'x'}],[{op:'translate',nodes:['bridge','bridge'],offset:[0,0,1],reason:'x'}]])
    assert.throws(()=>validateRecipe({...r,corrections:bad}),/修正|重映射|缩放|平移/);
  await assert.rejects(convertModel(t,{...r,corrections:[{op:'translate',nodes:['missing'],offset:[0,0,-1],reason:'x'}]}),/修正节点不存在/);
  await assert.rejects(convertModel(t,{...r,processing:{...r.processing,excludeNodes:['ramp']},corrections:[{op:'translate',nodes:['ramp'],offset:[0,0,1],reason:'x'}]}),/已排除/);
  await assert.rejects(convertModel(t,{...r,corrections:[{op:'translate',nodes:['bridge'],offset:[0,0,5],reason:'x'}]}),/超出/);
  await assert.rejects(convertModel(t,{...r,corrections:[{op:'translate',nodes:['bridge'],offset:[0,0,-7],reason:'x'}]}),/超出/);
});

test('修正写入清单与 About 加工说明；产物修正参数被改动时离线 verify 拒绝',async t=>{
  const corrected=recipe();corrected.corrections=[{op:'scale',factors:[.8,.8,1],about:[0,0,0],reason:'按参考宽度收窄至 0.80'}];
  const f=await fixture(t,[corrected]);assert.ok((await f.run(['batch','--all','--input-dir',join(f.root,'inbox')])).ok);assert.ok((await f.run(['check','--all'])).ok);
  await f.run(['integrate','--all','--allow-pending-visual']);const catalog=(await f.run(['verify'])).catalog;
  assert.match(catalog[0].credit.changes,/按参考尺寸修正造型（按参考宽度收窄至 0\.80）/);assert.match(await f.read('public/landmarks/CREDITS.txt'),/按参考宽度收窄至 0\.80/);
  const path='public/landmarks/fixture-model-v1.json',manifest=JSON.parse(await f.read(path));manifest.corrections[0].factors=[.9,.9,1];await f.write(path,manifest);
  await assert.rejects(f.run(['verify']),/造型修正漂移/);
});

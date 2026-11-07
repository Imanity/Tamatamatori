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
  const f=await fixture(t);await f.write('landmarks/downloads.json',{models:[{id:'candidate-model',name:'候选',modelTitle:'Candidate',author:'Author',authorUrl:'https://example.com/author',url:'https://example.com/model'}]});
  const args=['draft','--id=candidate-model','--input',join(f.root,'inbox/arbitrary-name.glb')],result=await f.run(args);assert.ok(result.ok);assert.equal(result.draft.source.title,'Candidate');assert.equal(result.draft.source.sha256,hash(bytes));assert.equal(result.draft.review.geometry,false);assert.throws(()=>validateRecipe(result.draft));
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

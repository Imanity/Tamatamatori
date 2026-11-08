import {readFile,writeFile,mkdir,readdir,stat,rename,unlink} from 'node:fs/promises';
import {resolve,relative,dirname,isAbsolute,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {convertModel,inspectModel,validateRecipe,validateAsset,identity,hash,MAX_SOURCE_BYTES,PIPELINE_VERSION,LICENSES} from './lib/landmark-model.mjs';
import {compareCoverage} from './lib/landmark-coverage.mjs';

const defaultRoot=fileURLToPath(new URL('../',import.meta.url));
const json=value=>JSON.stringify(value,null,2)+'\n';
export const placementIdentity=r=>identity({latitude:r.geo.latitude,longitude:r.geo.longitude,parts:r.geo.parts,partRadius:r.geo.partRadius});
const assetFile=r=>`${r.assetStem??r.id}-v${r.version}.ttlm.gz`;
function manifestMatches(m,r){
  const frame=Object.fromEntries(Object.keys(r.frame).map(k=>[k,k==='center'&&r.frame.center==='base-bounds'?r.frame.center:m.frame?.[k]]));
  if(m.schemaVersion!==1||m.pipelineVersion!==PIPELINE_VERSION||m.id!==r.id||m.name!==r.name||m.version!==r.version||m.recipeHash!==identity(r)||m.asset?.file!==assetFile(r)||identity(m.geo)!==identity(r.geo)||identity(frame)!==identity(r.frame)||m.bounds?.height!==r.frame.height||!Number.isFinite(m.bounds?.horizontal)||m.bounds.horizontal<=0||m.bounds.horizontal>2000)throw Error(`产物与配方不符：${r.id}`);
  for(const [key,value] of Object.entries(r.source))if(m.source?.[key]!==value)throw Error(`产物来源漂移：${r.id}`);
  for(const [key,value] of Object.entries(r.processing))if(m.processing?.[key]===undefined||identity([m.processing[key]])!==identity([value]))throw Error(`产物处理参数漂移：${r.id}`);
  if(identity([m.corrections??null])!==identity([r.corrections??null])||Boolean(m.correctionStats)!==Boolean(r.corrections))throw Error(`产物造型修正漂移：${r.id}`);
}
export function inside(root,path){const full=resolve(root,path),rel=relative(resolve(root),full);if(!rel||rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(rel))throw Error('写入路径不在工作区内');return full;}
export async function transaction(root,files){
  const backups=[],temporary=[];
  try{for(const [path,bytes] of files){const target=inside(root,path);let previous=null;try{previous=await readFile(target);}catch(e){if(e.code!=='ENOENT')throw e;}
    await mkdir(dirname(target),{recursive:true});const temp=target+'.tmp-'+randomUUID();temporary.push(temp);await writeFile(temp,bytes);await rename(temp,target);backups.push({target,previous});}
  }catch(error){for(const {target,previous} of backups.reverse()){if(previous===null)await unlink(target).catch(()=>{});else{const temp=target+'.tmp-'+randomUUID();temporary.push(temp);await writeFile(temp,previous);await rename(temp,target);}}throw error;
  }finally{for(const temp of temporary)await unlink(temp).catch(()=>{});}
}
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
async function recipes(root){
  const result=[];for(const file of (await readdir(inside(root,'landmarks/recipes'))).filter(f=>f.endsWith('.json')).sort()){
    const r=validateRecipe(await readJson(inside(root,'landmarks/recipes/'+file)));if(file!==r.id+'.json'||result.some(x=>x.id===r.id))throw Error('配方文件名或 ID 重复');result.push(r);
  }return result;
}
async function inputs(directory){
  const result=[];for(const name of (await readdir(directory)).filter(n=>n.toLowerCase().endsWith('.glb')).sort()){
    const path=resolve(directory,name),info=await stat(path);if(!info.isFile())continue;
    if(info.size>MAX_SOURCE_BYTES){result.push({name,path,error:'输入超过 200 MiB'});continue;}
    const bytes=await readFile(path);result.push({name,path,sha256:hash(bytes),bytes:bytes.length});
  }return result;
}
export function generateCatalog(items){
  const ids=new Set(),assets=new Set();
  return items.map(({recipe:r,manifest:m,entry})=>{
    if(ids.has(r.id)||assets.has(m.asset.file))throw Error('重复模型或资源文件名');ids.add(r.id);assets.add(m.asset.file);
    const n=2**14,x=Math.floor((r.geo.longitude+180)/360*n)%n,y=Math.floor((1-Math.asinh(Math.tan(r.geo.latitude*Math.PI/180))/Math.PI)/2*n);
    return {id:r.id,name:r.name,latitude:r.geo.latitude,longitude:r.geo.longitude,tile:{z:14,x,y},parts:r.geo.parts,partRadius:r.geo.partRadius,bounds:m.bounds,asset:m.asset,
      credit:{title:r.source.title,author:r.source.author,authorPage:r.source.authorPage,page:r.source.page,license:r.source.license,licenseUrl:r.source.licenseUrl,...(LICENSES[r.source.license].use?{use:LICENSES[r.source.license].use}:{}),changes:`无纹理、不透明共享光照，转换坐标与尺度、近似注册朝向${r.corrections?`，按参考尺寸修正造型（${r.corrections.map(c=>c.reason).join('；')}）`:''}${m.asset.triangles<m.source.triangles?'并减面':''}。`,registration:r.geo.registration,references:r.geo.references},
      validation:{cpu:'passed',visual:entry.visual}};
  }).sort((a,b)=>a.id.localeCompare(b.id));
}
export function generateCredits(catalog){return 'Tamatamatori 地标模型署名（自动生成）\n\n'+catalog.map(m=>`${m.name} / ${m.credit.title}\n作者：${m.credit.author}\n作者页：${m.credit.authorPage}\n来源：${m.credit.page}\n许可：${m.credit.license} ${m.credit.licenseUrl}${m.credit.use?`（${m.credit.use}）`:''}\n加工：${m.credit.changes}\n注册：${m.credit.registration}\n参考：${m.credit.references.map(r=>r.title+' '+r.url).join('；')}\n清单：${m.asset.file.replace('.ttlm.gz','.json')}\n资源 SHA-256：${m.asset.sha256}\n画面：${m.validation.visual==='verified'?'已有独立验收记录':'待验证，CPU 检查不替代画面验收'}\n`).join('\n');}
async function registeredItems(root,registry,known,overrides=new Map()){
  if(registry.schemaVersion!==1||!Array.isArray(registry.entries)||new Set(registry.entries.map(e=>e.id)).size!==registry.entries.length)throw Error('注册表格式或 ID 无效');
  const items=[];
  for(const entry of registry.entries){
    const recipe=known.find(r=>r.id===entry.id);if(!recipe||!['verified','pending'].includes(entry.visual)||entry.version!==recipe.version||entry.recipeHash!==identity(recipe)||entry.placementHash!==placementIdentity(recipe))throw Error(`注册与配方漂移：${entry.id}`);
    const staged=overrides.get(entry.id),manifest=staged?.manifest??await readJson(inside(root,`public/landmarks/${recipe.assetStem??recipe.id}-v${recipe.version}.json`));
    manifestMatches(manifest,recipe);
    if(manifest.asset.sha256!==entry.assetSha256||entry.visual==='verified'&&!entry.visualEvidence)throw Error(`注册资源或画面证据不符：${entry.id}`);
    if(entry.visual==='verified'){
      const evidencePath=inside(root,entry.visualEvidence);await stat(evidencePath);
      if(evidencePath.endsWith('.json')){
        const evidence=await readJson(evidencePath);
        if(evidence.id!==entry.id||evidence.assetSha256!==entry.assetSha256||evidence.placementHash!==entry.placementHash||evidence.gpuPassed!==true||!Array.isArray(evidence.screenshots)||!evidence.screenshots.length)throw Error(`画面记录与当前身份不符：${entry.id}`);
        for(const file of evidence.screenshots)await stat(inside(root,file));
      }
    }
    const bytes=staged?.compressed??await readFile(inside(root,'public/landmarks/'+manifest.asset.file));validateAsset(bytes,manifest);items.push({recipe,manifest,entry});
  }return items;
}

export async function run(argv,{root=defaultRoot,log=console.log}={}){
  const [command,...args]=argv,options={};for(let i=0;i<args.length;i++){const a=args[i];if(!a.startsWith('--'))throw Error('选项必须以 -- 开头');const [key,...rest]=a.slice(2).split('=');options[key]=rest.length?rest.join('='):args[i+1]&&!args[i+1].startsWith('--')?args[++i]:true;}
  const allowed=['ids','all','input-dir','input','dry-run','allow-pending-visual','id','evidence'];if(Object.keys(options).some(k=>!allowed.includes(k)))throw Error('未知命令选项');
  for(const key of ['all','dry-run','allow-pending-visual'])if(options[key]!==undefined&&options[key]!==true)throw Error(`--${key} 是无值开关`);
  if(options.all&&(options.ids||options.id)||options.ids&&options.id)throw Error('模型选择参数只能使用一种');
  if(command==='list'){const list=await readJson(inside(root,'landmarks/downloads.json'));log(json(list.models.map(m=>({id:m.id,name:m.name,url:m.url,file:m.suggestedFile,priority:m.priority}))));return{ok:true};}
  if(command==='inspect'){
    const files=options.input?[{name:basename(options.input),path:resolve(options.input)}]:await inputs(resolve(options['input-dir']??inside(root,'.cache/landmarks/inbox'))),reports=[];
    for(const file of files){try{if(file.error)throw Error(file.error);const info=await stat(file.path);if(info.size>MAX_SOURCE_BYTES)throw Error('输入超过 200 MiB');const report=await inspectModel(await readFile(file.path));const path=inside(root,`.cache/landmarks/inspection/${report.sourceSha256}.json`);await mkdir(dirname(path),{recursive:true});await writeFile(path,json(report));reports.push({file:file.name,ok:true,sha256:report.sourceSha256,vertices:report.vertices,triangles:report.triangles,report:relative(root,path)});}catch(e){reports.push({file:file.name,ok:false,error:e.message});}}
    log(json(reports));return{ok:reports.every(r=>r.ok),reports};
  }
  if(command==='draft'){
    if(typeof options.id!=='string'||typeof options.input!=='string')throw Error('草稿需要 --id 和 --input');
    const candidates=await readJson(inside(root,'landmarks/downloads.json')),candidate=candidates.models.find(m=>m.id===options.id);if(!candidate)throw Error('候选列表没有此 ID');
    const input=resolve(options.input);if((await stat(input)).size>MAX_SOURCE_BYTES)throw Error('输入超过 200 MiB');
    const bytes=await readFile(input),inspection=await inspectModel(bytes);
    // Pre-fill only licences the pipeline accepts, from the candidate's Sketchfab slug; anything else stays blank for manual review.
    const license=({by:'CC BY 4.0','by-nc':'CC BY-NC 4.0',cc0:'CC0 1.0'})[candidate.license?.slug]??null;
    const draft={schemaVersion:1,id:candidate.id,name:candidate.name,version:1,source:{sha256:inspection.sourceSha256,filename:basename(options.input),title:candidate.modelTitle,author:candidate.author,authorPage:candidate.authorUrl,page:candidate.url,license,licenseUrl:license&&LICENSES[license].url,upstreamNotes:'待核查来源声明'},frame:{space:null,axes:null,center:null,height:null,heightReference:null,yawDegrees:null,requireSharedTransform:true,normalizeNormals:true},processing:{targetTriangles:40000,maxErrorMetres:.05,normalWeight:.01,weld:true},geo:{latitude:null,longitude:null,partRadius:null,parts:[],registration:null,references:[]},review:{license:false,geometry:false,registration:false}};
    const path=inside(root,`.cache/landmarks/drafts/${candidate.id}.json`);await mkdir(dirname(path),{recursive:true});try{await writeFile(path,json(draft),{flag:'wx'});}catch(e){if(e.code==='EEXIST')throw Error('草稿已存在，不覆盖已有核查');throw e;}
    log(json({ok:true,draft:relative(root,path),inspection}));return{ok:true,draft};
  }
  const known=await recipes(root),ids=options.ids?String(options.ids).split(','):options.id?[options.id]:options.all?known.map(r=>r.id):[];
  if(['batch','check','integrate'].includes(command)&&!ids.length)throw Error('请使用 --ids=a,b 或 --all 明确选择批次');
  if(new Set(ids).size!==ids.length||ids.some(id=>!known.some(r=>r.id===id)))throw Error('选择包含重复或未登记的模型 ID');
  const selected=known.filter(r=>ids.includes(r.id));
  if(command==='batch'){
    if(options.input&&selected.length!==1)throw Error('--input 只能用于单个明确的 ID；批次请使用 --input-dir');
    const scanned=options.input?[]:await inputs(resolve(options['input-dir']??inside(root,'.cache/landmarks/inbox'))),reports=[];
    for(const recipe of selected){const directory=inside(root,'.cache/landmarks/staging/'+recipe.id);await mkdir(directory,{recursive:true});
      try{const file=options.input?{path:resolve(options.input)}:scanned.find(f=>f.sha256===recipe.source.sha256);if(!file)throw Error('没有找到登记哈希的 GLB，先执行 inspect 或核查下载文件');const info=await stat(file.path);if(info.size>MAX_SOURCE_BYTES)throw Error('输入超过 200 MiB');const converted=await convertModel(await readFile(file.path),recipe),coverage=compareCoverage(converted.reference,converted.fine,recipe.frame.height);if(!coverage.passed)throw Error('六方向轮廓覆盖未通过');
        await writeFile(resolve(directory,'model.ttlm.gz'),converted.compressed);await writeFile(resolve(directory,'manifest.json'),json(converted.manifest));await writeFile(resolve(directory,'coverage.json'),json(coverage));
        await writeFile(resolve(directory,'reference-positions.bin'),new Uint8Array(converted.reference.positions.buffer));await writeFile(resolve(directory,'reference-indices.bin'),new Uint8Array(converted.reference.indices.buffer));
        const report={id:recipe.id,ok:true,recipeHash:identity(recipe),pipelineVersion:PIPELINE_VERSION,sourceSha256:recipe.source.sha256,assetSha256:converted.manifest.asset.sha256,coverageHash:identity(coverage),asset:converted.manifest.asset};await writeFile(resolve(directory,'report.json'),json(report));reports.push(report);
      }catch(e){const report={id:recipe.id,ok:false,recipeHash:identity(recipe),error:e.message};await writeFile(resolve(directory,'report.json'),json(report));reports.push(report);}}
    const summary={ok:reports.every(r=>r.ok),reports};await mkdir(inside(root,'.cache/landmarks'),{recursive:true});await writeFile(inside(root,'.cache/landmarks/last-batch.json'),json(summary));log(json(summary));return summary;
  }
  if(command==='check'){
    const reports=[];for(const recipe of selected){try{const directory=inside(root,'.cache/landmarks/staging/'+recipe.id),report=await readJson(resolve(directory,'report.json')),m=await readJson(resolve(directory,'manifest.json')),coverage=await readJson(resolve(directory,'coverage.json'));if(!report.ok||report.recipeHash!==identity(recipe)||report.pipelineVersion!==PIPELINE_VERSION||report.sourceSha256!==recipe.source.sha256||m.asset.sha256!==report.assetSha256||!coverage.passed||identity(coverage)!==report.coverageHash)throw Error('暂存验证记录漂移');manifestMatches(m,recipe);validateAsset(await readFile(resolve(directory,'model.ttlm.gz')),m);reports.push({id:recipe.id,ok:true});}catch(e){reports.push({id:recipe.id,ok:false,error:e.message});}}log(json(reports));return{ok:reports.every(r=>r.ok),reports};
  }
  const registry=await readJson(inside(root,'landmarks/registry.json'));
  if(command==='integrate'){
    const overrides=new Map(),next=structuredClone(registry),files=new Map();
    for(const recipe of selected){const directory=inside(root,'.cache/landmarks/staging/'+recipe.id),report=await readJson(resolve(directory,'report.json')),manifest=await readJson(resolve(directory,'manifest.json')),coverage=await readJson(resolve(directory,'coverage.json')),compressed=await readFile(resolve(directory,'model.ttlm.gz'));
      if(!report.ok||report.recipeHash!==identity(recipe)||report.pipelineVersion!==PIPELINE_VERSION||report.sourceSha256!==recipe.source.sha256||!coverage.passed||identity(coverage)!==report.coverageHash||manifest.asset.sha256!==report.assetSha256)throw Error(`未通过暂存核查：${recipe.id}`);manifestMatches(manifest,recipe);validateAsset(compressed,manifest);
      const previous=next.entries.find(e=>e.id===recipe.id),same=previous?.assetSha256===manifest.asset.sha256&&previous?.placementHash===placementIdentity(recipe);
      if(previous&&previous.version===recipe.version&&!same)throw Error(`资源或定位变化须提升版本：${recipe.id}`);
      const visual=same?previous.visual:'pending';if(visual!=='verified'&&!options['allow-pending-visual'])throw Error(`画面待验，需明确使用 --allow-pending-visual：${recipe.id}`);
      const entry={id:recipe.id,version:recipe.version,recipeHash:identity(recipe),assetSha256:manifest.asset.sha256,placementHash:placementIdentity(recipe),visual,...(same&&previous.visualEvidence?{visualEvidence:previous.visualEvidence}:{})};
      next.entries=next.entries.filter(e=>e.id!==recipe.id);next.entries.push(entry);overrides.set(recipe.id,{manifest,compressed});files.set('public/landmarks/'+manifest.asset.file,compressed);files.set('public/landmarks/'+manifest.asset.file.replace('.ttlm.gz','.json'),json(manifest));
    }
    next.entries.sort((a,b)=>a.id.localeCompare(b.id));const items=await registeredItems(root,next,known,overrides),catalog=generateCatalog(items);files.set('landmarks/registry.json',json(next));files.set('src/data/landmarks.generated.json',json(catalog));files.set('public/landmarks/CREDITS.txt',generateCredits(catalog));
    const plan={ok:true,dryRun:!!options['dry-run'],models:catalog.map(m=>({id:m.id,visual:m.validation.visual,triangles:m.asset.triangles})),files:[...files.keys()]};
    if(!options['dry-run'])await transaction(root,files);log(json(plan));return plan;
  }
  if(command==='verify'){
    const items=await registeredItems(root,registry,known),catalog=generateCatalog(items);
    if((await readFile(inside(root,'src/data/landmarks.generated.json'),'utf8')).replaceAll('\r\n','\n')!==json(catalog)||(await readFile(inside(root,'public/landmarks/CREDITS.txt'),'utf8')).replaceAll('\r\n','\n')!==generateCredits(catalog))throw Error('生成目录或版权文件漂移，请通过 integrate 更新');
    log(json({ok:true,models:catalog.length,pendingVisual:catalog.filter(m=>m.validation.visual==='pending').map(m=>m.id)}));return{ok:true,catalog};
  }
  if(command==='record-visual'){
    if(ids.length!==1||typeof options.evidence!=='string')throw Error('画面登记需要单个 --id 和 --evidence JSON');
    await registeredItems(root,registry,known);
    const evidence=await readJson(inside(root,options.evidence)),entry=registry.entries.find(e=>e.id===ids[0]);
    if(!entry||evidence.id!==entry.id||evidence.assetSha256!==entry.assetSha256||evidence.placementHash!==entry.placementHash||evidence.gpuPassed!==true||!Array.isArray(evidence.screenshots)||!evidence.screenshots.length)throw Error('画面记录未通过或不对应当前资源/定位');
    for(const screenshot of evidence.screenshots)await stat(inside(root,screenshot));
    entry.visual='verified';entry.visualEvidence=relative(root,inside(root,options.evidence)).replaceAll('\\','/');
    const catalog=generateCatalog(await registeredItems(root,registry,known));
    await transaction(root,new Map([['landmarks/registry.json',json(registry)],['src/data/landmarks.generated.json',json(catalog)],['public/landmarks/CREDITS.txt',generateCredits(catalog)]]));
    log(json({ok:true,id:entry.id,visual:entry.visual}));return{ok:true};
  }
  throw Error('命令：list / inspect / draft / batch / check / integrate / verify / record-visual');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))run(process.argv.slice(2)).then(r=>{if(!r.ok)process.exitCode=1;}).catch(error=>{console.error(error.message);process.exitCode=1;});

import {NodeIO} from '@gltf-transform/core';
import {MeshoptSimplifier} from 'meshoptimizer';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';

export const PIPELINE_VERSION=1;
export const MAX_SOURCE_BYTES=200*1024*1024;
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const identity=value=>hash(JSON.stringify(canonical(value)));
const fail=message=>{throw Error(message);};
const finite=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const idPattern=/^[a-z][a-z0-9-]{1,62}$/;
const shaPattern=/^[a-f0-9]{64}$/;
const text=value=>typeof value==='string'&&value.trim().length>0&&value.length<=4000;
function keys(value,allowed,label){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail(`${label} 包含未知字段或不是对象`);}
function url(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}}
export function validateRecipe(r){
  keys(r,['schemaVersion','id','name','version','assetStem','source','frame','processing','geo','review'], '配方');
  if(r.schemaVersion!==1||!idPattern.test(r.id)||!text(r.name)||!Number.isInteger(r.version)||r.version<1)fail('配方身份无效');
  if(r.assetStem&&!idPattern.test(r.assetStem))fail('资源文件名无效');
  keys(r.source,['sha256','filename','title','author','authorPage','page','license','licenseUrl','upstreamNotes'],'来源');
  if(!shaPattern.test(r.source.sha256)||!text(r.source.filename)||/[\\/]/.test(r.source.filename)||!text(r.source.title)||!text(r.source.author)||!url(r.source.page)||!url(r.source.authorPage)||r.source.licenseUrl!==({'CC BY 4.0':'https://creativecommons.org/licenses/by/4.0/','CC0 1.0':'https://creativecommons.org/publicdomain/zero/1.0/'}[r.source.license])||!text(r.source.upstreamNotes))fail('来源、许可或哈希未完整登记');
  keys(r.frame,['space','axes','center','height','heightReference','yawDegrees','requireSharedTransform','sharedTransformTolerance','normalizeNormals'],'坐标框架');
  if(r.frame.sharedTransformTolerance!==undefined&&!finite(r.frame.sharedTransformTolerance,0,.001))fail('共同变换容差超限');
  if(!['local','world'].includes(r.frame.space)||!Array.isArray(r.frame.axes)||r.frame.axes.length!==3||r.frame.axes.some(a=>!/^[-+][xyz]$/.test(a))||new Set(r.frame.axes.map(a=>a[1])).size!==3||!finite(r.frame.height,.1,2000)||!url(r.frame.heightReference)||!finite(r.frame.yawDegrees,-360,360)||typeof r.frame.requireSharedTransform!=='boolean'||typeof r.frame.normalizeNormals!=='boolean')fail('坐标轴、尺度或朝向未完整登记');
  if(r.frame.center!=='base-bounds'&&(!Array.isArray(r.frame.center)||r.frame.center.length!==2||!r.frame.center.every(v=>finite(v,-1e8,1e8))))fail('局部中心无效');
  keys(r.processing,['targetTriangles','maxErrorMetres','normalWeight','weld','positionMergeTolerance','normalMergeTolerance','permissive'],'减面');
  if(r.processing.permissive!==undefined&&typeof r.processing.permissive!=='boolean')fail('法线接缝减面选项无效');
  if(!finite(r.processing.positionMergeTolerance??0,0,.001)||!finite(r.processing.normalMergeTolerance??0,0,.001))fail('焊接容差超限');
  if(!Number.isInteger(r.processing.targetTriangles)||!finite(r.processing.targetTriangles,1,100000)||!finite(r.processing.maxErrorMetres,.00001,1)||!finite(r.processing.normalWeight,0,1)||typeof r.processing.weld!=='boolean')fail('减面参数超出范围');
  keys(r.geo,['latitude','longitude','partRadius','parts','registration','references'],'定位');
  if(!finite(r.geo.latitude,-85.05112877,85.05112877)||!finite(r.geo.longitude,-180,180)||!finite(r.geo.partRadius,1,2000)||!text(r.geo.registration)||!Array.isArray(r.geo.parts)||!Array.isArray(r.geo.references))fail('WGS84 锚点或注册资料不完整');
  const partIds=new Set(),anchorTile={z:14,x:Math.floor((r.geo.longitude+180)/360*16384)%16384,y:Math.floor((1-Math.asinh(Math.tan(r.geo.latitude*Math.PI/180))/Math.PI)/2*16384)};
  for(const p of r.geo.parts){keys(p,['id','height','base','tile'],'粗分部');if(!Number.isSafeInteger(p.id)||p.id<0||!finite(p.height,.01,2000)||!finite(p.base,0,p.height-.001))fail('粗分部身份/高度无效');if(p.tile&&(!Number.isInteger(p.tile.z)||p.tile.z!==14||!Number.isInteger(p.tile.x)||!finite(p.tile.x,0,16383)||!Number.isInteger(p.tile.y)||!finite(p.tile.y,0,16383)))fail('粗分部瓦片无效');const tile=p.tile??anchorTile,key=`${tile.z}/${tile.x}/${tile.y}/${p.id}`;if(partIds.has(key))fail('重复粗分部');partIds.add(key);}
  for(const ref of r.geo.references)if(!text(ref.title)||!url(ref.url))fail('定位参考链接无效');
  keys(r.review,['license','geometry','registration'],'核查');
  if(!['license','geometry','registration'].every(key=>r.review[key]===true))fail('尚未完成人工来源、几何或定位核查');
  return r;
}

function glbJson(bytes){
  if(bytes.length<20||bytes.length>MAX_SOURCE_BYTES||bytes.toString('utf8',0,4)!=='glTF'||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length||bytes.readUInt32LE(16)!==0x4e4f534a)fail('只支持有界、自包含 GLB 2');
  const end=20+bytes.readUInt32LE(12);if(end>bytes.length)fail('GLB JSON 截断');const json=JSON.parse(bytes.toString('utf8',20,end));
  if([...(json.buffers??[]),...(json.images??[])].some(x=>x.uri&&!x.uri.startsWith('data:')))fail('GLB 含外部文件或远程 URI，请先打包');
  if(json.skins?.length||json.animations?.length||json.meshes?.some(m=>m.primitives?.some(p=>p.targets?.length)))fail('只支持已烘焙的静态模型');
  if((json.extensionsUsed??[]).some(x=>['EXT_mesh_gpu_instancing','EXT_meshopt_compression','KHR_draco_mesh_compression','KHR_mesh_quantization','MSFT_lod'].includes(x)))fail('实例、几何压缩、量化或多级模型须先离线烘焙');
  if((json.extensionsRequired??[]).some(x=>!x.startsWith('KHR_materials_')))fail('几何压缩或量化扩展暂不支持，请先解码为 Float32 GLB');
  return json;
}
const transform=(m,p)=>[0,1,2].map(row=>m[row]*p[0]+m[row+4]*p[1]+m[row+8]*p[2]+m[row+12]);
function determinant(m){return m[0]*(m[5]*m[10]-m[9]*m[6])-m[4]*(m[1]*m[10]-m[9]*m[2])+m[8]*(m[1]*m[6]-m[5]*m[2]);}
function normalTransform(m,n){
  const axes=[m.slice(0,3),m.slice(4,7),m.slice(8,11)],lengths=axes.map(a=>Math.hypot(...a));
  const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
  if(lengths.every(v=>Math.abs(v-lengths[0])<1e-8)&&Math.abs(dot(axes[0],axes[1]))<1e-8&&Math.abs(dot(axes[0],axes[2]))<1e-8&&Math.abs(dot(axes[1],axes[2]))<1e-8)
    return [0,1,2].map(row=>m[row]*n[0]+m[row+4]*n[1]+m[row+8]*n[2]);
  const a=m[0],b=m[4],c=m[8],d=m[1],e=m[5],f=m[9],g=m[2],h=m[6],i=m[10],det=determinant(m);
  if(Math.abs(det)<1e-15)fail('不可逆节点变换');
  return [(e*i-f*h)*n[0]+(f*g-d*i)*n[1]+(d*h-e*g)*n[2],(c*h-b*i)*n[0]+(a*i-c*g)*n[1]+(b*g-a*h)*n[2],(b*f-c*e)*n[0]+(c*d-a*f)*n[1]+(a*e-b*d)*n[2]].map(v=>v/det);
}
const bounds=positions=>{const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(let i=0;i<positions.length;i++){const a=i%3;min[a]=Math.min(min[a],positions[i]);max[a]=Math.max(max[a],positions[i]);}return{min,max};};
async function document(bytes){glbJson(bytes);const io=new NodeIO();io.setLogger({debug(){},info(){},warn(){},error(){}});return io.readBinary(bytes);}
export async function inspectModel(bytes){
  const doc=await document(bytes),root=doc.getRoot(),nodes=[];
  for(const [index,node] of root.listNodes().filter(n=>n.getMesh()).entries()){
    const local=[],world=[];let triangles=0,vertices=0;
    for(const p of node.getMesh().listPrimitives()){
      const a=p.getAttribute('POSITION');if(!a||a.getComponentType()!==5126||p.getMode()!==4||!p.getAttribute('NORMAL'))fail('需要带法线的 Float32 三角网格');
      const data=a.getArray();vertices+=a.getCount();triangles+=(p.getIndices()?.getCount()??a.getCount())/3;
      for(let i=0;i<data.length;i+=3){local.push(...data.subarray(i,i+3));world.push(...transform(node.getWorldMatrix(),data.subarray(i,i+3)));}
    }
    nodes.push({index,name:node.getName(),vertices,triangles,local:bounds(local),world:bounds(world),matrix:node.getWorldMatrix(),determinant:determinant(node.getWorldMatrix())});
  }
  if(!nodes.length)fail('模型没有网格');
  return {sourceSha256:hash(bytes),bytes:bytes.length,scenes:root.listScenes().map(s=>s.getName()),nodes,materials:root.listMaterials().map(m=>({name:m.getName(),alphaMode:m.getAlphaMode()})),textures:root.listTextures().length,vertices:nodes.reduce((s,n)=>s+n.vertices,0),triangles:nodes.reduce((s,n)=>s+n.triangles,0),note:'坐标轴和建筑身份需要人工确认；报告不自动给出地理位置或正确朝向。'};
}

export async function convertModel(bytes,recipe){
  validateRecipe(recipe);if(hash(bytes)!==recipe.source.sha256)fail('源文件 SHA-256 与登记不符');
  const doc=await document(bytes),nodes=doc.getRoot().listNodes().filter(n=>n.getMesh()),positions=[],normals=[],indices=[];
  const scenes=doc.getRoot().listScenes(),active=new Set();
  if(scenes.length!==1)fail('请先整理为单个明确的静态场景');scenes[0].traverse(node=>{if(node.getMesh())active.add(node);});
  if(nodes.some(n=>!active.has(n)))fail('存在未归入场景的网格，请先移除或烘焙');
  if(!nodes.length)fail('模型无网格');
  if(recipe.frame.requireSharedTransform){const first=nodes[0].getWorldMatrix();if(nodes.some(n=>n.getWorldMatrix().some((v,i)=>Math.abs(v-first[i])>(recipe.frame.sharedTransformTolerance??1e-6))))fail('局部框架包含独立节点放置，请选择世界框架或先烘焙');}
  const axes=recipe.frame.axes.map(a=>({axis:'xyz'.indexOf(a[1]),sign:a[0]==='-'?-1:1}));
  const axisMatrix=Array(16).fill(0);axisMatrix[15]=1;for(let row=0;row<3;row++)axisMatrix[axes[row].axis*4+row]=axes[row].sign;
  const orientation=determinant(axisMatrix);let count=0;
  for(const node of nodes){
    const m=node.getWorldMatrix(),world=recipe.frame.space==='world';
    if(world&&Math.abs(determinant(m))<1e-15)fail('不可逆节点变换');
    for(const primitive of node.getMesh().listPrimitives()){
      const accessor=primitive.getAttribute('POSITION'),normal=primitive.getAttribute('NORMAL');
      if(primitive.getMode()!==4||!accessor||accessor.getComponentType()!==5126||!normal||normal.getComponentType()!==5126)fail('需要带法线的 Float32 三角网格');
      const p=accessor.getArray(),n=normal.getArray();if(p.length!==n.length||p.length%3||p.length/3+count>4000000)fail('网格属性或输入预算无效');
      for(let i=0;i<p.length;i+=3){
        const v=world?transform(m,p.subarray(i,i+3)):[...p.subarray(i,i+3)],nn=world?normalTransform(m,n.subarray(i,i+3)):[...n.subarray(i,i+3)];
        const length=recipe.frame.normalizeNormals?Math.hypot(...nn):1;if(!length||![...v,...nn].every(Number.isFinite))fail('坐标或法线无效');
        positions.push(...axes.map(a=>a.sign*v[a.axis]));normals.push(...axes.map(a=>a.sign*nn[a.axis]/length));
      }
      const local=primitive.getIndices()?.getArray()??Array.from({length:p.length/3},(_,i)=>i);
      if(local.length%3||indices.length+local.length>12000000)fail('三角面输入预算无效');
      const reflected=orientation*(world?determinant(m):1)<0;
      for(let i=0;i<local.length;i+=3){if([local[i],local[i+1],local[i+2]].some(v=>!Number.isInteger(v)||v<0||v>=p.length/3))fail('源索引越界');indices.push(local[i]+count,local[i+(reflected?2:1)]+count,local[i+(reflected?1:2)]+count);}
      count+=p.length/3;
    }
  }
  const {min,max}=bounds(positions);if(!finite(max[2]-min[2],1e-8,1e8))fail('选择的竖直轴无高度范围');
  let center=recipe.frame.center;
  if(center==='base-bounds'){
    const low=[Infinity,Infinity],high=[-Infinity,-Infinity];
    for(let i=0;i<positions.length;i+=3)if(positions[i+2]-min[2]<.01)for(let a=0;a<2;a++){low[a]=Math.min(low[a],positions[i+a]);high[a]=Math.max(high[a],positions[i+a]);}
    center=low.map((v,i)=>(v+high[i])/2);
  }
  const scale=recipe.frame.height/(max[2]-min[2]),angle=recipe.frame.yawDegrees*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
  let p=new Float32Array(positions.length),n=new Float32Array(normals.length),ix=new Uint32Array(indices);
  for(let i=0;i<positions.length;i+=3){const e=(positions[i]-center[0])*scale,north=(positions[i+1]-center[1])*scale;p.set([c*e-s*north,s*e+c*north,(positions[i+2]-min[2])*scale],i);n.set([c*normals[i]-s*normals[i+1],s*normals[i]+c*normals[i+1],normals[i+2]],i);}
  const reference={positions:p,indices:ix};
  if(recipe.processing.weld){
    const remap=new Uint32Array(p.length/3),unique=new Map(),pp=[],nn=[];
    for(let i=0;i<remap.length;i++){const key=[...p.subarray(i*3,i*3+3),...n.subarray(i*3,i*3+3)].map((v,j)=>{const tolerance=j<3?recipe.processing.positionMergeTolerance:recipe.processing.normalMergeTolerance;return tolerance?Math.round(v/tolerance):v;}).join('/');let index=unique.get(key);if(index===undefined){index=unique.size;unique.set(key,index);pp.push(...p.subarray(i*3,i*3+3));nn.push(...n.subarray(i*3,i*3+3));}remap[i]=index;}
    ix=Uint32Array.from(ix,i=>remap[i]);p=new Float32Array(pp);n=new Float32Array(nn);
  }
  await MeshoptSimplifier.ready;
  const flags=['ErrorAbsolute','LockBorder'];if(recipe.processing.permissive)flags.push('Permissive');
  const weight=recipe.processing.normalWeight,[reduced,error]=MeshoptSimplifier.simplifyWithAttributes(ix,p,3,n,3,[weight,weight,weight],null,recipe.processing.targetTriangles*3,recipe.processing.maxErrorMetres,flags);
  const [remap,used]=MeshoptSimplifier.compactMesh(reduced),data=new Float32Array(used*6);
  for(let old=0;old<remap.length;old++)if(remap[old]!==0xffffffff){data.set(p.subarray(old*3,old*3+3),remap[old]*6);data.set(n.subarray(old*3,old*3+3),remap[old]*6+3);}
  const output=Buffer.alloc(32+data.byteLength+reduced.byteLength);output.write('TTLM');output.writeUInt32LE(1,4);output.writeUInt32LE(used,8);output.writeUInt32LE(reduced.length,12);output.writeUInt32LE(6,16);Buffer.from(data.buffer).copy(output,32);Buffer.from(reduced.buffer,reduced.byteOffset,reduced.byteLength).copy(output,32+data.byteLength);
  const compressed=gzipSync(output,{level:9});
  if(used>128000||reduced.length>300000||output.length>4*1024*1024||compressed.length>2*1024*1024)fail(`转换超限：${used} 顶点 / ${reduced.length/3} 面 / ${compressed.length} 压缩字节 / ${output.length} 解压字节；上限 128,000 / 100,000 / 2 MiB / 4 MiB`);
  let horizontal=0;for(let i=0;i<data.length;i+=6)horizontal=Math.max(horizontal,Math.abs(data[i]),Math.abs(data[i+1]));
  const manifest={schemaVersion:1,pipelineVersion:PIPELINE_VERSION,id:recipe.id,name:recipe.name,version:recipe.version,recipeHash:identity(recipe),format:'TTLM 1; float32 ENU+normal stride6, uint32 indices; little-endian; gzip',source:{...recipe.source,bytes:bytes.length,vertices:count,triangles:indices.length/3},frame:{...recipe.frame,minimum:min,maximum:max,center,scale},processing:{...recipe.processing,reportedError:error},geo:recipe.geo,bounds:{horizontal:Math.ceil(horizontal+.1),height:recipe.frame.height},asset:{file:`${recipe.assetStem??recipe.id}-v${recipe.version}.ttlm.gz`,sha256:hash(compressed),decodedSha256:hash(output),bytes:compressed.length,decodedBytes:output.length,vertices:used,triangles:reduced.length/3},tools:{'@gltf-transform/core':'4.5.0',meshoptimizer:'1.3.0'},limitations:['社区外观模型，定位与朝向近似，不提供测绘精度。','无纹理、不透明共享光照，不模拟玻璃或夜景灯光。','地面沿用同源 DEM，不套固定高程偏移。']};
  validateAsset(compressed,manifest);return {compressed,manifest,reference,fine:{vertices:data,indices:reduced}};
}

export function validateAsset(compressed,manifest){
  if(compressed.length>2*1024*1024||hash(compressed)!==manifest.asset.sha256)fail('压缩资源身份无效');
  const decoded=gunzipSync(compressed,{maxOutputLength:4*1024*1024});
  if(decoded.length<32||hash(decoded)!==manifest.asset.decodedSha256||decoded.toString('utf8',0,4)!=='TTLM'||decoded.readUInt32LE(4)!==1||decoded.readUInt32LE(16)!==6||[20,24,28].some(i=>decoded.readUInt32LE(i)))fail('解压资源身份或格式无效');
  const vertices=decoded.readUInt32LE(8),length=decoded.readUInt32LE(12);
  if(!vertices||vertices>128000||!length||length%3||length>300000||decoded.length!==32+vertices*24+length*4||vertices!==manifest.asset.vertices||length/3!==manifest.asset.triangles)fail('资源面数、顶点或长度不符');
  if(manifest.asset.bytes!==compressed.length||manifest.asset.decodedBytes!==decoded.length)fail('资源大小登记不符');
  for(let i=0;i<vertices;i++){const at=32+i*24,values=Array.from({length:6},(_,j)=>decoded.readFloatLE(at+j*4));if(!values.every(Number.isFinite)||Math.abs(values[0])>manifest.bounds.horizontal||Math.abs(values[1])>manifest.bounds.horizontal||values[2]<-.01||values[2]>manifest.bounds.height+.01||Math.abs(Math.hypot(...values.slice(3))-1)>.01)fail('资源坐标或法线超限');}
  for(let i=32+vertices*24;i<decoded.length;i+=4)if(decoded.readUInt32LE(i)>=vertices)fail('资源索引越界');
  return true;
}

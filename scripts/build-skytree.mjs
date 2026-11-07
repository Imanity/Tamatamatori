// Official Sketchfab GLB download required; never fetch private viewer assets.
import { NodeIO } from '@gltf-transform/core';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const input=process.argv[2];
if(!input)throw new Error('Usage: node scripts/build-skytree.mjs <official downloaded GLB>');
const sha=b=>createHash('sha256').update(b).digest('hex');
const bytes=await readFile(input);
if(sha(bytes)!=='007cd38f40f114dc2f2d6c2b8b00c216a95fa6401dbfb15b3946b1c8ca6bb150')throw new Error('Unexpected source SHA-256');
const doc=await new NodeIO().readBinary(bytes),root=doc.getRoot();
const nodes=root.listNodes().filter(n=>n.getMesh()),matrix=nodes[0].getWorldMatrix();
// The six nodes share one authoring placement (including a 1.62 degree tilt).
// Use the common local, plumb Y-up frame; reject independently placed nodes.
if(nodes.length!==6||nodes.some(n=>n.getWorldMatrix().some((v,i)=>Math.abs(v-matrix[i])>0.0002)))throw new Error('Source placement changed');
const raw=[],normal=[],indices=[];let offset=0;
for(const node of nodes)for(const p of node.getMesh().listPrimitives()){
  if(p.getMode()!==4)throw new Error('Expected triangles');
  const a=p.getAttribute('POSITION').getArray(),n=p.getAttribute('NORMAL').getArray();
  for(const v of a)raw.push(v);for(const v of n)normal.push(v);
  for(const i of p.getIndices().getArray())indices.push(i+offset);offset+=a.length/3;
}
const minY=raw.reduce((m,v,i)=>i%3===1?Math.min(m,v):m,Infinity),maxY=raw.reduce((m,v,i)=>i%3===1?Math.max(m,v):m,-Infinity);
const scale=634/(maxY-minY),yaw=10.25*Math.PI/180,c=Math.cos(yaw),s=Math.sin(yaw);
const positions=new Float32Array(raw.length),normals=new Float32Array(raw.length);
for(let i=0;i<raw.length;i+=3){
  const x=(raw[i]-2.0669)*scale,y=-(raw[i+2]-7.54065)*scale;
  positions.set([c*x-s*y,s*x+c*y,(raw[i+1]-minY)*scale],i);
  const nx=normal[i],ny=-normal[i+2];normals.set([c*nx-s*ny,s*nx+c*ny,normal[i+1]],i);
}
await MeshoptSimplifier.ready;
const sourceIndices=new Uint32Array(indices);
const [reduced,error]=MeshoptSimplifier.simplifyWithAttributes(sourceIndices,positions,3,normals,3,[0.01,0.01,0.01],null,180000,0.1,['ErrorAbsolute','LockBorder']);
// compactMesh rewrites indices; apply its OLD -> NEW remap to both attributes.
const [remap,count]=MeshoptSimplifier.compactMesh(reduced),vertices=new Float32Array(count*6);
for(let old=0;old<remap.length;old++)if(remap[old]!==0xffffffff){const to=remap[old]*6;
  vertices.set(positions.subarray(old*3,old*3+3),to);vertices.set(normals.subarray(old*3,old*3+3),to+3);
}
const output=Buffer.alloc(32+vertices.byteLength+reduced.byteLength);
output.write('TTLM');output.writeUInt32LE(1,4);output.writeUInt32LE(count,8);output.writeUInt32LE(reduced.length,12);output.writeUInt32LE(6,16);
Buffer.from(vertices.buffer).copy(output,32);Buffer.from(reduced.buffer,reduced.byteOffset,reduced.byteLength).copy(output,32+vertices.byteLength);
const compressed=gzipSync(output,{level:9}),directory='public/landmarks';await mkdir(directory,{recursive:true});
await writeFile(`${directory}/skytree-v1.ttlm.gz`,compressed);
const manifest={id:'tokyo-skytree',name:'东京晴空塔',format:'TTLM 1: 32-byte header, float32 ENU+normal stride6, uint32 indices; little-endian; gzip',
  source:{title:'Tokyo Skytree, Japan',author:'Noah (smiN5214)',page:'https://sketchfab.com/3d-models/tokyo-skytree-japan-b4d347b8703f45f48ea8d5fe45d454b9',authorPage:'https://sketchfab.com/smiN5214',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',bytes:bytes.length,sha256:sha(bytes),triangles:indices.length/3,vertices:offset},
  tools:{'@gltf-transform/core':'4.5.0',meshoptimizer:'1.3.0'},
  changes:{textures:'Removed all images, UVs, tangents and source materials; opaque shared lighting, including deck glass.',frame:'Removed common authoring scene placement; local Y up -> ENU, positive determinant; normals rotated.',centerXZ:[2.0669,7.54065],minY,maxY,scale,height:634,yawCounterclockwiseDegrees:10.25,simplification:{absoluteErrorLimit:0.1,reportedError:error,normalWeights:[0.01,0.01,0.01],lockBorder:true},
    registration:'OSM narrow tip bbox centre; PLATEAU LOD2 horizontal sections at 30/100/200m guide yaw only (approx. 6.48m symmetric outline RMS; 120-degree ambiguity). Not surveyed alignment. DEM supplies ground; no vertical datum offset.'},
  anchor:{longitude:139.81071889400482,latitude:35.71004508243534},
  orientationReference:{credit:'国土交通省 Project PLATEAU · 東京都墨田区 2025 LOD2.1',policy:'https://www.mlit.go.jp/plateau/site-policy/',sha256:'eea0aea8452f4d9dd4e0c287433f85d2e92557c5b13375f5814dcd3c3cc24746'},
  asset:{file:'skytree-v1.ttlm.gz',sha256:sha(compressed),decodedSha256:sha(output),bytes:compressed.length,decodedBytes:output.length,vertices:count,triangles:reduced.length/3},
  limitations:['Community appearance model; author upstream construction provenance not independently authenticated.','Height and north alignment are approximate; no survey or structural accuracy claim.','Opaque untextured decks; no glass transmission, night lighting or interiors.']};
await writeFile(`${directory}/skytree-v1.json`,JSON.stringify(manifest,null,2)+'\n');
await mkdir('.cache/landmark-implementation',{recursive:true});
await writeFile('.cache/landmark-implementation/reference-positions.bin',new Uint8Array(positions.buffer));
await writeFile('.cache/landmark-implementation/reference-indices.bin',new Uint8Array(sourceIndices.buffer));
console.log(JSON.stringify(manifest.asset));

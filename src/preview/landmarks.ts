import { decodeLandmark, skytree } from "../domain/landmarks.ts";
import type { LandmarkGeometry, LandmarkDefinition } from "../domain/landmarks.ts";

const cache=new Map<string,LandmarkGeometry>();
const MAX_CACHE_BYTES=8*1024*1024;
let cachedBytes=0,generation=0;
export const clearLandmarkCache=()=>{cache.clear();cachedBytes=0;generation++;};
async function bounded(stream:ReadableStream<Uint8Array>,signal:AbortSignal) {
  const reader=stream.getReader(),chunks:Uint8Array[]=[];let size=0;
  const cancel=()=>{void reader.cancel(signal.reason).catch(()=>{});};signal.addEventListener("abort",cancel,{once:true});
  try{for(;;){signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;
    size+=value.length;if(size>4*1024*1024)throw new Error("地标文件超出读取预算");chunks.push(value);
  }}finally{signal.removeEventListener("abort",cancel);await reader.cancel().catch(()=>{});reader.releaseLock();}
  signal.throwIfAborted();const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return bytes;
}
export async function loadLandmark(target:LandmarkDefinition,signal:AbortSignal):Promise<LandmarkGeometry> {
  signal.throwIfAborted();const key=`${target.id}/${target.asset.sha256}`,cached=cache.get(key);
  if(cached){cache.delete(key);cache.set(key,cached);return cached;}
  const started=generation;
  const abort=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
  const response=await fetch(`${import.meta.env?.BASE_URL??"/"}landmarks/${target.asset.file}`,{signal:abort});
  if(!response.ok||!response.body)throw new Error(`${target.name}模型读取失败`);
  let bytes=await bounded(response.body,abort);
  const gzip=bytes[0]===31&&bytes[1]===139;
  if(gzip&&bytes.length>2*1024*1024)throw new Error("地标压缩文件超出预算");
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes.buffer))).map(v=>v.toString(16).padStart(2,"0")).join("");
  if(hash!==(gzip?target.asset.sha256:target.asset.decodedSha256))throw new Error(`${target.name}模型校验失败`);
  if(gzip)bytes=await bounded(new Blob([bytes.buffer]).stream().pipeThrough(new DecompressionStream("gzip")),abort);
  const geometry=decodeLandmark(bytes,target);abort.throwIfAborted();
  if(started===generation){
    const size=geometry.vertices.byteLength+geometry.indices.byteLength;
    const previous=cache.get(key);
    if(previous){cachedBytes-=previous.vertices.byteLength+previous.indices.byteLength;cache.delete(key);}
    while(cache.size&&(cache.size>=16||cachedBytes+size>MAX_CACHE_BYTES)){
      const oldest=cache.keys().next().value!,old=cache.get(oldest)!;
      cachedBytes-=old.vertices.byteLength+old.indices.byteLength;cache.delete(oldest);
    }
    cache.set(key,geometry);cachedBytes+=size;
  }
  return geometry;
}
export const loadSkytree=(signal:AbortSignal)=>loadLandmark(skytree,signal);

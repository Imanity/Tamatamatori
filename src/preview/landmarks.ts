import { decodeLandmark } from "../domain/landmarks.ts";
import type { LandmarkGeometry } from "../domain/landmarks.ts";

const asset="landmarks/skytree-v1.ttlm.gz";
const compressedHash="4ee6a8d802db2ccf0538add4ff7f3b54e21237e4cd36267e7a487852305848cd";
const decodedHash="763e09e62f3a4e159a54e5a3df8ae6228529b6deee24fa675c5c31f4b1d868d3";
let cached:LandmarkGeometry|undefined;
export const clearLandmarkCache=()=>{cached=undefined;};
async function bounded(stream:ReadableStream<Uint8Array>,signal:AbortSignal) {
  const reader=stream.getReader(),chunks:Uint8Array[]=[];let size=0;
  const cancel=()=>{void reader.cancel(signal.reason).catch(()=>{});};signal.addEventListener("abort",cancel,{once:true});
  try{for(;;){signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;
    size+=value.length;if(size>4*1024*1024)throw new Error("地标文件超出读取预算");chunks.push(value);
  }}finally{signal.removeEventListener("abort",cancel);await reader.cancel().catch(()=>{});reader.releaseLock();}
  signal.throwIfAborted();const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return bytes;
}
export async function loadSkytree(signal:AbortSignal):Promise<LandmarkGeometry> {
  signal.throwIfAborted();if(cached)return cached;
  const abort=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
  const response=await fetch(`${import.meta.env?.BASE_URL??"/"}${asset}`,{signal:abort});
  if(!response.ok||!response.body)throw new Error("晴空塔模型读取失败");
  let bytes=await bounded(response.body,abort);
  const gzip=bytes[0]===31&&bytes[1]===139;
  if(gzip&&bytes.length>2*1024*1024)throw new Error("地标压缩文件超出预算");
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes.buffer))).map(v=>v.toString(16).padStart(2,"0")).join("");
  if(hash!==(gzip?compressedHash:decodedHash))throw new Error("晴空塔模型校验失败");
  if(gzip)bytes=await bounded(new Blob([bytes.buffer]).stream().pipeThrough(new DecompressionStream("gzip")),abort);
  const geometry=decodeLandmark(bytes);abort.throwIfAborted();cached=geometry;return geometry;
}

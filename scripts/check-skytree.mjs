// Independent CPU triangle coverage: source vs shipped mesh. Not GPU or survey QA.
// Run build-skytree first to write ignored source reference arrays.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {gunzipSync,deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {decodeLandmark} from '../src/domain/landmarks.ts';
const floats=async path=>{const b=await readFile(path);return new Float32Array(new Uint8Array(b).buffer);};
const raw=await readFile('.cache/landmark-implementation/reference-indices.bin');
const source={positions:await floats('.cache/landmark-implementation/reference-positions.bin'),indices:new Uint32Array(new Uint8Array(raw).buffer)};
const compressed=await readFile('public/landmarks/skytree-v1.ttlm.gz'),fine=decodeLandmark(gunzipSync(compressed));
const width=320,height=2048,scale=2000/634;
function mask(positions,indices,stride,azimuth){
  const angle=azimuth*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),p=new Float32Array(positions.length/stride*2),pixels=new Uint8Array(width*height);
  for(let i=0;i<positions.length/stride;i++){p[i*2]=width/2+(positions[i*stride]*c-positions[i*stride+1]*s)*scale;p[i*2+1]=height-24-positions[i*stride+2]*scale;}
  for(let i=0;i<indices.length;i+=3){const a=indices[i]*2,b=indices[i+1]*2,c=indices[i+2]*2,ax=p[a],ay=p[a+1],bx=p[b],by=p[b+1],cx=p[c],cy=p[c+1];
    const area=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);if(Math.abs(area)<1e-10)continue;
    const x0=Math.max(0,Math.ceil(Math.min(ax,bx,cx)-.5)),x1=Math.min(width-1,Math.floor(Math.max(ax,bx,cx)-.5));
    const y0=Math.max(0,Math.ceil(Math.min(ay,by,cy)-.5)),y1=Math.min(height-1,Math.floor(Math.max(ay,by,cy)-.5));
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
      const u=((bx-x-.5)*(cy-y-.5)-(by-y-.5)*(cx-x-.5))/area;
      const v=((cx-x-.5)*(ay-y-.5)-(cy-y-.5)*(ax-x-.5))/area;
      const w=1-u-v;if(u>=-1e-6&&v>=-1e-6&&w>=-1e-6)pixels[y*width+x]=1;
    }
  }return pixels;
}
const records=[],shots=[];
for(const azimuth of [0,60,120,180,240,300]){
  const a=mask(source.positions,source.indices,3,azimuth),b=mask(fine.vertices,fine.indices,6,azimuth);
  let union=0,intersection=0,changed=0,far=0,sky=0,sourceSky=0,band=0,maxBoundaryPixels=0,maxCoverageDistance=0;
  for(let i=0;i<a.length;i++){
    union+=a[i]|b[i];intersection+=a[i]&b[i];
    if(a[i]!==b[i]){changed++;const x=i%width,y=Math.floor(i/width),other=a[i]?b:a;let distance=Infinity;
      for(let dy=-8;dy<=8;dy++)for(let dx=-8;dx<=8;dx++)if(x+dx>=0&&x+dx<width&&y+dy>=0&&y+dy<height&&other[(y+dy)*width+x+dx])distance=Math.min(distance,Math.hypot(dx,dy));
      if(distance>Math.SQRT2)far++;maxCoverageDistance=Math.max(maxCoverageDistance,distance);
    }
    const up=(height-24-Math.floor(i/width))/scale,x=(i%width-width/2)/scale;
    if(up>20&&up<140&&Math.abs(x)>15&&Math.abs(x)<35){band++;if(!b[i])sky++;if(!a[i])sourceSky++;}
  }
  for(let y=0;y<height;y++){const limits=m=>{let min=width,max=-1;for(let x=0;x<width;x++)if(m[y*width+x]){min=Math.min(min,x);max=x;}return[min,max];};const aa=limits(a),bb=limits(b);if(aa[1]>=0&&bb[1]>=0)maxBoundaryPixels=Math.max(maxBoundaryPixels,Math.abs(aa[0]-bb[0]),Math.abs(aa[1]-bb[1]));}
  records.push({azimuth,intersectionOverUnion:intersection/union,changedPixels:changed,changedBeyondOnePixel:far,sourceOrFinePixels:union,maxRasterCoverageDistanceMetres:maxCoverageDistance/scale,maxRowBoundaryDifferenceMetres:maxBoundaryPixels/scale,lowerSideBand:{up:[20,140],absoluteHorizontal:[15,35],sourceOpenFraction:sourceSky/band,reducedOpenFraction:sky/band}});shots.push([a,b]);
}
// PNG contact sheet: each view is source / reduced / red=removed blue=added.
const outWidth=width*6,outHeight=height*3,rgba=Buffer.alloc(outWidth*outHeight*3,245);
for(let view=0;view<6;view++)for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const i=y*width+x,[a,b]=shots[view];for(let row=0;row<3;row++){
    const offset=((row*height+y)*outWidth+view*width+x)*3;
    const color=row===0?(a[i]?[65,75,80]:[245,245,245]):row===1?(b[i]?[65,75,80]:[245,245,245]):a[i]===b[i]?(a[i]?[130,140,145]:[245,245,245]):a[i]?[220,65,40]:[30,90,220];
    rgba.set(color,offset);
  }
}
const crc=data=>{let c=0xffffffff;for(const b of data){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
const chunk=(type,data)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,-4)),b.length-4);return b;};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(outWidth);ihdr.writeUInt32BE(outHeight,4);ihdr[8]=8;ihdr[9]=2;
const scan=Buffer.alloc(outHeight*(outWidth*3+1));for(let y=0;y<outHeight;y++)rgba.copy(scan,y*(outWidth*3+1)+1,y*outWidth*3,(y+1)*outWidth*3);
const directory='docs/plan/skytree-evidence';await mkdir(directory,{recursive:true});
await writeFile(`${directory}/cpu-coverage.png`,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]));
const result={kind:'independent CPU orthographic union coverage, not actual GPU or real-site validation',assetSha256:createHash('sha256').update(compressed).digest('hex'),sourceTriangles:source.indices.length/3,fineTriangles:fine.indices.length/3,metresPerPixel:1/scale,rows:'source, reduced, difference; columns 0/60/120/180/240/300 degrees',records};
await writeFile(`${directory}/cpu-coverage.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(records));
if(records.some(r=>r.intersectionOverUnion<.98||r.maxRasterCoverageDistanceMetres>1||Math.abs(r.lowerSideBand.sourceOpenFraction-r.lowerSideBand.reducedOpenFraction)>.01))throw new Error('Coverage comparison exceeded acceptance tolerance');

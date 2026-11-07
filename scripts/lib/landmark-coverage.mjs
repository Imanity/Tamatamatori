// Independent orthographic triangle-union coverage, not GPU or survey accuracy.
export function compareCoverage(source,fine,heightMetres){
  let radius=0;for(let i=0;i<source.positions.length;i+=3)radius=Math.max(radius,Math.hypot(source.positions[i],source.positions[i+1]));
  const scale=Math.min(2000/heightMetres,2016/Math.max(1,2*radius));
  if(scale<1)throw Error('模型横向范围过大，当前轮廓检查不足一米/像素，需要单独分块');
  const width=Math.ceil(2*radius*scale+32),height=Math.ceil(heightMetres*scale+48);
  function mask(positions,indices,stride,degrees){
    const t=degrees*Math.PI/180,c=Math.cos(t),s=Math.sin(t),p=new Float32Array(positions.length/stride*2),pixels=new Uint8Array(width*height);
    for(let i=0;i<positions.length/stride;i++){p[i*2]=width/2+(positions[i*stride]*c-positions[i*stride+1]*s)*scale;p[i*2+1]=height-24-positions[i*stride+2]*scale;}
    for(let i=0;i<indices.length;i+=3){const a=indices[i]*2,b=indices[i+1]*2,d=indices[i+2]*2,ax=p[a],ay=p[a+1],bx=p[b],by=p[b+1],cx=p[d],cy=p[d+1],area=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);if(Math.abs(area)<1e-10)continue;
      const x0=Math.max(0,Math.ceil(Math.min(ax,bx,cx)-.5)),x1=Math.min(width-1,Math.floor(Math.max(ax,bx,cx)-.5)),y0=Math.max(0,Math.ceil(Math.min(ay,by,cy)-.5)),y1=Math.min(height-1,Math.floor(Math.max(ay,by,cy)-.5));
      for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const u=((bx-x-.5)*(cy-y-.5)-(by-y-.5)*(cx-x-.5))/area,v=((cx-x-.5)*(ay-y-.5)-(cy-y-.5)*(ax-x-.5))/area;if(u>=-1e-6&&v>=-1e-6&&1-u-v>=-1e-6)pixels[y*width+x]=1;}
    }return pixels;
  }
  const records=[];
  for(const azimuth of [0,60,120,180,240,300]){
    const a=mask(source.positions,source.indices,3,azimuth),b=mask(fine.vertices,fine.indices,6,azimuth);let union=0,intersection=0,changed=0,maxDistance=0;
    for(let i=0;i<a.length;i++){union+=a[i]|b[i];intersection+=a[i]&b[i];if(a[i]===b[i])continue;changed++;const x=i%width,y=Math.floor(i/width),other=a[i]?b:a;let distance=Infinity;
      for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++)if(x+dx>=0&&x+dx<width&&y+dy>=0&&y+dy<height&&other[(y+dy)*width+x+dx])distance=Math.min(distance,Math.hypot(dx,dy));maxDistance=Math.max(maxDistance,distance/scale);
    }
    records.push({azimuth,intersectionOverUnion:union?intersection/union:1,changedPixels:changed,maxRasterCoverageDistanceMetres:Number.isFinite(maxDistance)?maxDistance:null,passed:(!union||intersection/union>=.98)&&maxDistance<=1});
  }
  return {kind:'CPU triangle union, not GPU or survey verification',metresPerPixel:1/scale,width,height,sourceTriangles:source.indices.length/3,fineTriangles:fine.indices.length/3,records,passed:records.every(r=>r.passed)};
}

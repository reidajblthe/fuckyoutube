import{writeFile}from'node:fs/promises';import{deflateSync}from'node:zlib';
const root=new URL('../public/icons/',import.meta.url);
const mark='<path d="M32 30h48v13H46v14h27v13H46v25H32Z" fill="url(#red)"/><g stroke="#E5C158" stroke-width="4" stroke-linecap="round"><path d="M85 73v20m-10-10h20m-17-7 14 14m-14 0 14-14"/></g>';
await writeFile(new URL('crown.svg',root),`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><linearGradient id="red" x2="1" y2="1"><stop stop-color="#FF6784"/><stop offset="1" stop-color="#FF2A54"/></linearGradient></defs><rect width="120" height="120" rx="28" fill="#0B0C10"/><rect x="2" y="2" width="116" height="116" rx="26" fill="none" stroke="#2A2D37"/>${mark}</svg>`);
const crc=b=>{let c=0xffffffff;for(const v of b){c^=v;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
const chunk=(type,data)=>{const name=Buffer.from(type),n=Buffer.alloc(4),check=Buffer.alloc(4);n.writeUInt32BE(data.length);check.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([n,name,data,check]);};
function png(size,maskable=false){const raw=Buffer.alloc(size*(size*4+1));
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const a=x/size*120,b=y/size*120,pos=y*(size*4+1)+1+x*4;
  const rounding=Math.hypot(Math.max(0,28-a,a-92),Math.max(0,28-b,b-92))<=28;
  let color=[11,12,16],alpha=maskable||rounding?255:0;
  const glow=Math.max(0,1-Math.hypot(a-92,b-6)/120)*6;color=color.map((v,i)=>Math.round(v+glow*(i===0?1.8:1)));
  const f=(a>=32&&a<=46&&b>=30&&b<=95)||(a>=32&&a<=80&&b>=30&&b<=43)||(a>=32&&a<=73&&b>=57&&b<=70);
  if(f)color=[255,Math.round(70-b/4),Math.round(110-b/4)];
  const dx=a-85,dy=b-83;const star=(Math.abs(dx)<=2&&Math.abs(dy)<=10)||(Math.abs(dy)<=2&&Math.abs(dx)<=10)||(Math.abs(dx-dy)<2.5&&Math.abs(dx)<8&&Math.abs(dy)<8)||(Math.abs(dx+dy)<2.5&&Math.abs(dx)<8&&Math.abs(dy)<8);
  if(star)color=[229,193,88];for(let i=0;i<3;i++)raw[pos+i]=color[i];raw[pos+3]=alpha;
 }
 const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
for(const[file,size,mask]of[['icon-192.png',192],['icon-512.png',512],['apple-touch-icon.png',180],['maskable-512.png',512,true]])await writeFile(new URL(file,root),png(size,mask));

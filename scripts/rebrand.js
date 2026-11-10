import{readFile,writeFile,readdir}from'node:fs/promises';
const root=new URL('../',import.meta.url),read=p=>readFile(new URL(p,root),'utf8'),write=(p,s)=>writeFile(new URL(p,root),s);
function palette(hex){
 let s=hex.slice(1),alpha='';if(s.length===8){alpha=s.slice(6);s=s.slice(0,6);}if(s.length!==6)return hex;
 const[r,g,b]=[0,2,4].map(i=>parseInt(s.slice(i,i+2),16)/255),max=Math.max(r,g,b),min=Math.min(r,g,b),l=(max+min)/2;
 let hue=0;if(max!==min){hue=max===r?((g-b)/(max-min))%6:max===g?(b-r)/(max-min)+2:(r-g)/(max-min)+4;hue=(hue*60+360)%360;}
 const gold=hue>=20&&hue<68&&max-min>.12;
 let color=gold?(l>.65?'#E5C158':l>.32?'#B89643':'#29231C'):l>.82?'#F3F4F6':l>.34?'#9CA3AF':l>.18?'#2A2D37':l>.085?'#16181E':'#0B0C10';
 return color+alpha;
}
const recolor=s=>s.replace(/#[a-f\d]{8}\b|#[a-f\d]{6}\b/gi,palette);
for(const name of ['public/styles.css','public/car-mode.css'])await write(name,recolor(await read(name)));
await write('public/tokens.css',':root{color-scheme:dark;--bg:#0B0C10;--surface:#16181E;--text:#F3F4F6;--muted:#9CA3AF;--accent:#FF2A54;--champagne:#E5C158;--gold:var(--accent);--line:#2A2D37}\n');
for(const file of ['public/index.html','public/app.js','public/account.js','AUTENTICACAO.md','NATIVO_IOS.md']){
 let s=await read(file);s=s.replaceAll('Reidajbl-tube','F*ckyoutube').replaceAll('Reidajbl Studio','Fckyoutube Studio').replaceAll('Reidajbl Sessions','Fckyoutube Sessions');
 if(file==='public/index.html'){
  s=s.replace(/<span>Reidajbl<span class="brand-light">-tube<\/span>/,'<span>F*ck<span class="brand-light">youtube</span>');
  s=s.replace(/(<meta name="theme-color" content=")[^"]+/, '$1#0B0C10');
  s=s.replace('/app-v6.js','/app-v7.js').replace('/styles-v2.css','/styles-v3.css');
  s=s.replace('<link rel="stylesheet" href="/car-mode.css">','<link rel="stylesheet" href="/car-mode.css">\n  <link rel="stylesheet" href="/premium.css">');
  s=s.replace('/icons/apple-touch-icon.png"','/icons/apple-touch-icon.png?v=2"').replace('/icons/crown.svg"','/icons/crown.svg?v=2"');
  s=s.replace(/<symbol id="i-crown"[\s\S]*?<\/symbol>/,'<symbol id="i-crown" viewBox="0 0 24 24"><path d="M5 4h12v3H9v5h7v3H9v6H5Z" fill="currentColor" stroke="none"/><path d="m19 16 1 2 2 .5-2 1-1 2-1-2-2-.5 2-1Z" fill="currentColor" stroke="none"/></symbol>');
 }
 if(file==='public/app.js'){
  s=s.replaceAll('reidajbl-playlists.json','fckyoutube-playlists.json');
  s=s.replace("['MPB', '#665735'], ['Jazz', '#465d51'], ['Lo-fi', '#5d4c65'], ['Soul', '#794e39'], ['Instrumental', '#475a6c'], ['Eletrônica', '#5f6240']","['MPB', '#443125'], ['Jazz', '#322735'], ['Lo-fi', '#302738'], ['Soul', '#42222C'], ['Instrumental', '#272A34'], ['Eletrônica', '#3C2030']");
 }
 await write(file,s);
}
let assets=await read('scripts/assets.js');assets=recolor(assets).replaceAll('REIDAJBL SESSIONS','FCKYOUTUBE SESSIONS');await write('scripts/assets.js',assets);
for(const file of await readdir(new URL('public/covers/',root)))if(file.endsWith('.svg'))await write('public/covers/'+file,recolor(await read('public/covers/'+file)).replaceAll('REIDAJBL SESSIONS','FCKYOUTUBE SESSIONS'));
const manifest=JSON.parse(await read('public/manifest.json'));Object.assign(manifest,{name:'F*ckyoutube',short_name:'F*ckyoutube',theme_color:'#0B0C10',background_color:'#0B0C10'});for(const icon of manifest.icons)icon.src+='?v=2';await write('public/manifest.json',JSON.stringify(manifest,null,2)+'\n');
const config=JSON.parse(await read('capacitor.config.json'));config.appName='F*ckyoutube';config.appId='com.fckyoutube.app';config.ios.backgroundColor='#0B0C10';await write('capacitor.config.json',JSON.stringify(config,null,2)+'\n');
for(const file of ['package.json','package-lock.json']){const p=JSON.parse(await read(file));p.name='fckyoutube';p.version='2.0.0';if(p.packages){p.packages[''].name=p.name;p.packages[''].version=p.version;}await write(file,JSON.stringify(p,null,2)+'\n');}
let server=await read('server.js');server=server.replace("version: '1.6.1'","version: '2.0.0'").replace('Reidajbl-tube: http','Fckyoutube: http');await write('server.js',server);

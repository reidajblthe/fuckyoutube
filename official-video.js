import { Ytdl } from '@distube/ytdl-core';
const normalize = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const cleanTitle = (s) => normalize(String(s).replace(/\([^)]*\)|\[[^\]]*\]/g,' ')).replace(/\b(remastered|remaster|official audio|audio oficial|lyrics|lyric video)\b.*$/,'').trim();
export function selectOfficialVideo(results, track) {
  const title = cleanTitle(track.title).split(' ').filter(Boolean);
  const artists = normalize(track.artist.split(',')[0]).split(' ').filter(w=>w.length>1);
  if (!title.length || !artists.length) return null;
  return results.map(video=>{
    const name=normalize(video.title), channel=normalize(video.author?.name), all=(name+' '+channel).replaceAll(' ','');
    if (video.isLive || video.isUpcoming || !/^[\w-]{11}$/.test(video.id)) return null;
    if (/\b(lyrics?|visualizer|karaoke|reaction|cover|official audio|audio oficial|full album)\b/.test(name) || /\btopic\b/.test(channel)) return null;
    // Ser o primeiro resultado não prova que seja clipe. Exige indicação explícita
    // de vídeo oficial, correspondência da música e artista e canal verificado.
    if (!/\b(official (music )?video|video oficial|clipe oficial|videoclipe oficial)\b/.test(name)) return null;
    const titleMatch=title.filter(w=>name.split(' ').includes(w)).length/title.length;
    const artistMatch=artists.filter(w=>all.includes(w)).length/artists.length;
    if (titleMatch<0.8 || artistMatch<0.8 || !video.author?.verified) return null;
    if (track.duration>0 && video.lengthSeconds>0 && Math.abs(video.lengthSeconds-track.duration)>Math.max(90,track.duration*0.35)) return null;
    return {video,score:titleMatch+artistMatch+(channel.replaceAll(' ','').includes(artists.join(''))?1:0)};
  }).filter(Boolean).sort((a,b)=>b.score-a.score)[0]?.video || null;
}
export function createOfficialVideoSearch({search,now=Date.now}={}) {
  let yt;const cache=new Map(),pending=new Map();
  search ||= (q)=>{yt ||= new Ytdl({country:'BR',timeoutMs:18000});return yt.search(q,{limit:12,signal:AbortSignal.timeout(22000)});};
  return async(track)=>{
    const key=JSON.stringify([track.id,track.title,track.artist,track.duration]);const hit=cache.get(key);
    if(hit?.expires>now())return hit.value;
    if(pending.has(key))return pending.get(key);
    if(pending.size>=4)throw Object.assign(new Error('Busca ocupada. Tente em instantes.'),{status:503});
    const task=(async()=>{
      const results=await search(`${track.title} ${track.artist} Official Video`);
      const match=selectOfficialVideo(results,track);
      const value=match?{available:true,video:{id:match.id,title:match.title,artist:match.author.name,duration:match.lengthSeconds}}:{available:false,message:'Vídeo oficial indisponível para esta faixa'};
      if(cache.size>=200)cache.delete(cache.keys().next().value);
      cache.set(key,{value,expires:now()+(match?3600000:300000)});return value;
    })().finally(()=>pending.delete(key));pending.set(key,task);return task;
  };
}

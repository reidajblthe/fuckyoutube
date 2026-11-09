import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';

// Cache efêmero fora de public/: um arquivo MP4 seekable, com áudio e vídeo.
// Não transcodifica, não expõe links assinados e não altera o caminho só-áudio.
export function createCombinedVideo({ getStream, executable = ffmpegPath, ttl = 10 * 60000 } = {}) {
  let directory;
  const entries = new Map(), pending = new Map();
  const maxBytes = 256 * 1024 * 1024;
  async function cleanup() {
    for (const [id, value] of entries) if (value.expires < Date.now()) {
      entries.delete(id); await rm(value.file, { force: true }).catch(() => {});
    }
  }
  const interval = setInterval(() => cleanup().catch(() => {}), 60000); interval.unref();
  return async function combined(id) {
    await cleanup();
    const hit = entries.get(id);
    if (hit) return hit.source;
    if (pending.has(id)) return pending.get(id);
    if (pending.size >= 2 || entries.size + pending.size >= 4) throw Object.assign(new Error('Vídeos em preparação. Tente em instantes.'), { status: 503 });
    const task = (async () => {
      if (!executable) throw new Error('FFmpeg indisponível no servidor.');
      const [video, audio] = await Promise.all([getStream(id, 'video'), getStream(id, 'audio')]);
      if (!video.read || !audio.read || video.size + audio.size > maxBytes) throw Object.assign(new Error('Vídeo excede o limite de 256 MiB.'), {status:422});
      directory ??= mkdtemp(path.join(tmpdir(), 'reidajbl-video-'));
      const file = path.join(await directory, `${id}-${randomUUID()}.mp4`);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 120000);
      const child = spawn(executable, ['-hide_banner','-loglevel','error','-y',
        '-i','pipe:3','-i','pipe:4','-map','0:v:0','-map','1:a:0',
        '-c','copy','-movflags','+faststart',file], { windowsHide: true, stdio:['ignore','ignore','pipe','pipe','pipe'] });
      const kill = () => child.kill(); abort.signal.addEventListener('abort',kill,{once:true});
      // Drena stderr sem registrar URLs, cookies ou conteúdo do provedor.
      child.stderr.resume();
      const exited = new Promise((resolve,reject) => {
        child.once('error',reject);
        child.once('close',code=>code===0?resolve():reject(new Error('Não foi possível combinar áudio e vídeo.')));
      });
      const reads = [
        pipeline(video.read({signal:abort.signal}),child.stdio[3]),
        pipeline(audio.read({signal:abort.signal}),child.stdio[4]), exited
      ];
      try {
        await Promise.all(reads);
        const { size } = await stat(file);
        if (!size || size > maxBytes) throw new Error('MP4 combinado inválido.');
        const source = { mime:'video/mp4',size,read:({range,signal})=>createReadStream(file,{...range,signal}) };
        entries.set(id,{file,source,expires:Date.now()+ttl});
        return source;
      } catch(error) {
        abort.abort(); await Promise.allSettled(reads);
        await rm(file,{force:true}).catch(()=>{}); throw error;
      } finally { clearTimeout(timer); abort.signal.removeEventListener('abort',kill); }
    })().finally(()=>pending.delete(id));
    pending.set(id,task); return task;
  };
}

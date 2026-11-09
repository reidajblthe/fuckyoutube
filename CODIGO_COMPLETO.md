# Código-fonte — Fckyoutube 2.0.0

App-v7.js e styles-v3.css são cópias geradas pelo build. O player Shaka de terceiros e sua licença ficam em public/vendor.

## server.js

```
import express from 'express';
import { Innertube, Platform, Constants } from 'youtubei.js';
import { mountGoogleAuth } from './auth.js';
import { resolveMedia } from './media.js';
import { createCombinedVideo } from './combined-video.js';
import { createOfficialVideoSearch } from './official-video.js';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const BROWSE_ID = /^(UC|MPR)[A-Za-z0-9_-]{8,180}$/;
const TYPES = { songs: 'song', artists: 'artist', albums: 'album' };
const text = (v) => typeof v === 'string' ? v : v?.toString?.() ?? '';

// Executa apenas o trecho de decipher extraído pela biblioteca, sem expor Node/process/require.
// vm limita tempo; não constitui uma fronteira de segurança para código arbitrário.
export const evaluatePlayer = (data, env = {}) => vm.runInNewContext(`(function(){${data.output}\n})()`, { ...env }, {
  timeout: 1500, contextCodeGeneration: { strings: false, wasm: false }
});
Platform.shim.eval = evaluatePlayer;

export function safeMediaURL(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.port || u.username || u.password ||
      !/^[a-z0-9.-]+\.googlevideo\.com$/i.test(u.hostname)) {
    throw Object.assign(new Error('Destino de áudio rejeitado.'), { status: 502 });
  }
  return u;
}

export function rangeBounds(range, size) {
  if (!Number.isSafeInteger(size) || size <= 0) throw Object.assign(new Error('Tamanho do áudio indisponível.'), { status: 502 });
  if (!range) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) throw Object.assign(new Error('Intervalo inválido.'), { status: 416, size });
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) throw Object.assign(new Error('Intervalo fora do áudio.'), { status: 416, size });
  return { start, end };
}

export function normalizeItem(item) {
  const type = item.item_type;
  const kind = type === 'artist' ? 'artist' : type === 'album' ? 'album' :
    ['song', 'video', 'non_music_track'].includes(type) ? 'song' : null;
  if (!kind || !item.id || (kind === 'song' && !VIDEO_ID.test(item.id))) return null;
  const thumbs = item.thumbnails || (Array.isArray(item.thumbnail) ? item.thumbnail : item.thumbnail?.contents) || [];
  let artwork = [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url ?? '';
  if (/^https:\/\/(lh3|yt3)\.googleusercontent\.com\//.test(artwork)) artwork = artwork.replace(/=w\d+-h\d+[^?]*/, '=w600-h600-l90-rj');
  if (!/^https:\/\//.test(artwork)) artwork = '/covers/nocturne.svg';
  return {
    id: item.id, kind, title: text(item.title || item.name) || 'Sem título',
    artist: item.artists?.map((a) => a.name).join(', ') || item.author?.name || text(item.subtitle) || 'YouTube Music',
    album: item.album?.name ?? '', artwork,
    duration: Number(item.duration?.seconds) || 0, source: 'youtube'
  };
}

export class TTLCache {
  constructor(limit = 150) { this.limit = limit; this.items = new Map(); }
  get(key) {
    const item = this.items.get(key);
    if (!item || item.expires < Date.now()) { this.items.delete(key); return undefined; }
    return item.value;
  }
  set(key, value, ttl = 120000) {
    if (this.items.size >= this.limit) this.items.delete(this.items.keys().next().value);
    this.items.set(key, { value, expires: Date.now() + ttl });
    return value;
  }
  delete(key) { this.items.delete(key); }
}

let session;
const metadata = new TTLCache();
const streams = new TTLCache(80);
const pending = new Map();
const inflightLimit = 6;
async function cached(key, cache, fn, ttl) {
  const hit = cache.get(key);
  if (hit) return hit;
  if (pending.has(key)) return pending.get(key);
  if (pending.size >= inflightLimit) throw Object.assign(new Error('Servidor ocupado. Tente em instantes.'), { status: 503 });
  const task = Promise.resolve().then(fn).then((value) => cache.set(key, value, ttl)).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
async function client() {
  if (!session) session = Innertube.create({
    lang: 'pt', location: 'BR', retrieve_player: true,
    generate_session_locally: true,
    ...(process.env.YOUTUBE_VISITOR_DATA ? { visitor_data: process.env.YOUTUBE_VISITOR_DATA } : {}),
    ...(process.env.YOUTUBE_PO_TOKEN ? { po_token: process.env.YOUTUBE_PO_TOKEN } : {}),
    fetch: innertubeFetch
  }).catch((e) => { session = null; throw e; });
  return session;
}

export function mediaHeaders(clientName = 'IOS') {
  return {
    'User-Agent': Constants.CLIENTS[clientName]?.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    Origin: 'https://www.youtube.com', Referer: 'https://www.youtube.com/',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
  };
}

async function innertubeFetch(input, init = {}) {
  const headers = new Headers(input instanceof Request ? input.headers : {});
  for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
  let name;
  try { name = JSON.parse(init.body)?.context?.client?.clientName; } catch { /* GET e payloads binários. */ }
  const clientName = name === 'iOS' ? 'IOS' : name === 'ANDROID' ? 'ANDROID' : 'WEB';
  const origin = name === 'WEB_REMIX' ? 'https://music.youtube.com' : 'https://www.youtube.com';
  for (const [key, value] of Object.entries(mediaHeaders(clientName))) headers.set(key, value);
  headers.set('Origin', origin); headers.set('Referer', origin + '/');
  return fetch(input, { ...init, headers,
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(18000)]) : AbortSignal.timeout(18000)
  });
}

function listFromShelves(shelves = []) {
  const seen = new Set();
  return Array.from(shelves).flatMap((s) => Array.from(s.contents || [])).map(normalizeItem)
    .filter((i) => i && !seen.has(i.id) && seen.add(i.id)).slice(0, 50);
}

async function resolveStream(id, mode = 'audio') {
  return cached(`stream:${mode}:${id}`, streams, () => resolveMedia(id, mode), 90000);
}

async function fetchAudio(url, headers, signal) {
  let target = safeMediaURL(url);
  for (let redirects = 0; redirects < 4; redirects++) {
    const response = await fetch(target, { headers, signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('Redirecionamento de áudio inválido.');
    target = safeMediaURL(new URL(location, target).href);
  }
  throw new Error('Excesso de redirecionamentos de áudio.');
}

export const STREAM_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Cancela a espera deste cliente sem interromper uma resolução/cache compartilhada.
function waitForSource(source, signal) {
  return new Promise((resolve,reject)=>{
    const aborted=()=>{signal.removeEventListener('abort',aborted);reject(signal.reason);};
    signal.addEventListener('abort',aborted,{once:true});
    Promise.resolve(source).then(value=>{signal.removeEventListener('abort',aborted);resolve(value);},error=>{signal.removeEventListener('abort',aborted);reject(error);});
    if(signal.aborted)aborted();
  });
}

export function createApp({ getClient = client, getStream = resolveStream, audioFetch = fetchAudio, authOptions, getCombinedVideo, findOfficialVideo = createOfficialVideoSearch(), sourceTimeoutMs = 35000, videoTimeoutMs = 150000 } = {}) {
  const app = express();
  const combinedVideo = getCombinedVideo || createCombinedVideo({getStream});
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  const clients = new TTLCache(2000);
  let activeStreams = 0;
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: blob: data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    });
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const key = req.ip || 'unknown';
    const rate = clients.get(key) || { count: 0 };
    if (++rate.count > 150) return res.status(429).json({ error: 'Muitas consultas. Aguarde um minuto.' });
    if (rate.count === 1) clients.set(key, rate, 60000);
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', provider: '@distube/ytdl-core 5.2.1 / YouTube.js', version: '2.0.0' }));
  mountGoogleAuth(app, authOptions);
  app.get('/api/official-video',async(req,res)=>{
    const {id,title,artist}=req.query;const duration=Number(req.query.duration || 0);
    if(typeof id!=='string'||!VIDEO_ID.test(id)||typeof title!=='string'||!title.trim()||title.length>160||typeof artist!=='string'||!artist.trim()||artist.length>200||!Number.isFinite(duration)||duration<0||duration>86400) return res.status(400).json({error:'Informe faixa e artista válidos.'});
    res.json(await findOfficialVideo({id,title:title.trim(),artist:artist.trim(),duration}));
  });
  app.get('/api/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const kind = req.query.type || 'songs';
    if (!q || q.length > 160 || !TYPES[kind]) return res.status(400).json({ error: 'Informe uma busca de até 160 caracteres e um tipo válido.' });
    const data = await cached(`search:${kind}:${q}`, metadata, async () => {
      const yt = await getClient();
      const result = await yt.music.search(q, { type: TYPES[kind] });
      return { items: listFromShelves(result.contents), query: q, type: kind };
    });
    res.json(data);
  });
  app.get('/api/home', async (_req, res) => {
    const data = await cached('home', metadata, async () => {
      const yt = await getClient();
      const feed = await yt.music.getHomeFeed();
      return { sections: Array.from(feed.sections || []).map((s) => ({
        title: text(s.header?.title) || 'Para descobrir', items: listFromShelves([s])
      })).filter((s) => s.items.length).slice(0, 5) };
    }, 300000);
    res.json(data);
  });
  app.get('/api/collection/:id', async (req, res) => {
    const { id } = req.params;
    const kind = req.query.type;
    if (!BROWSE_ID.test(id) || !['album', 'artist'].includes(kind)) return res.status(400).json({ error: 'Coleção inválida.' });
    const data = await cached(`collection:${kind}:${id}`, metadata, async () => {
      const yt = await getClient();
      const collection = kind === 'artist' ? await yt.music.getArtist(id) : await yt.music.getAlbum(id);
      const items = kind === 'artist' ? listFromShelves(collection.sections) :
        Array.from(collection.contents || []).map(normalizeItem).filter(Boolean);
      return { title: text(collection.header?.title) || 'Coleção', items };
    });
    res.json(data);
  });
  app.get('/api/dash/:id', async (req, res) => {
    if (!VIDEO_ID.test(req.params.id)) return res.status(400).json({ error: 'Identificador inválido.' });
    const [a, v] = await Promise.all([getStream(req.params.id, 'audio'), getStream(req.params.id, 'video')]);
    if (![a,v].every((f) => f.dash?.init && f.dash?.index && f.dash?.codecs)) return res.status(422).json({ error: 'Este vídeo não possui índices DASH compatíveis.' });
    const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
    const duration = Math.max(a.dash.duration, v.dash.duration);
    if (!Number.isFinite(duration) || duration <= 0) return res.status(422).json({ error: 'Duração de vídeo indisponível.' });
    const set = (f, mode) => `<AdaptationSet mimeType="${xml(f.mime)}" segmentAlignment="true"><Representation id="${mode}" bandwidth="${Number(f.dash.bitrate) || 128000}" codecs="${xml(f.dash.codecs)}"${mode === 'video' ? ` width="${Number(f.dash.width)}" height="${Number(f.dash.height)}"` : ''}><BaseURL>/api/stream/${req.params.id}?mode=${mode}</BaseURL><SegmentBase indexRange="${f.dash.index.start}-${f.dash.index.end}"><Initialization range="${f.dash.init.start}-${f.dash.init.end}"/></SegmentBase></Representation></AdaptationSet>`;
    res.type('application/dash+xml').send(`<?xml version="1.0" encoding="UTF-8"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" mediaPresentationDuration="PT${duration}S" minBufferTime="PT1.5S"><Period duration="PT${duration}S">${set(a,'audio')}${set(v,'video')}</Period></MPD>`);
  });
  app.get(['/api/stream/:id', '/api/stream'], async (req, res) => {
    const id = req.params.id || req.query.id;
    if (typeof id !== 'string' || !VIDEO_ID.test(id)) return res.status(400).json({ error: 'Identificador de faixa inválido.' });
    if (req.query.type && !['audio','video'].includes(req.query.type)) return res.status(400).json({error:'Tipo de mídia inválido.'});
    const mode = req.query.type || req.query.mode || 'audio';
    if (!['audio', 'video'].includes(mode)) return res.status(400).json({ error: 'Modo de reprodução inválido.' });
    const range = req.headers.range;
    if (range && (!/^bytes=\d*-\d*$/.test(range) || range === 'bytes=-')) return res.status(416).end();
    if (activeStreams >= 12) return res.status(503).end();
    activeStreams++;
    const abort = new AbortController();
    // Timeout de conexão/cabeçalhos; o corpo pode durar mais que uma faixa inteira.
    const timer = setTimeout(() => abort.abort(new DOMException('A origem demorou para responder.','TimeoutError')), req.query.type === 'video' ? videoTimeoutMs : sourceTimeoutMs);
    const close = () => abort.abort();
    res.on('close', close);
    req.on('aborted', close);
    let upstream;
    try {
      const stream = await waitForSource(req.query.type === 'video' ? combinedVideo(id) : getStream(id, mode),abort.signal);
      if (abort.signal.aborted) throw abort.signal.reason;
      if (stream.read) {
        const bounds = rangeBounds(range, stream.size);
        const length = bounds.end - bounds.start + 1;
        res.status(range ? 206 : 200).set({
          'Content-Type': stream.mime, 'Content-Length': String(length), 'Accept-Ranges': 'bytes'
        });
        if (range) res.set('Content-Range', `bytes ${bounds.start}-${bounds.end}/${stream.size}`);
        clearTimeout(timer);
        if (req.method === 'HEAD') return res.end();
        await pipeline(stream.read({ range: bounds, signal: abort.signal }), res);
        return;
      }
      const headers = {
        ...stream.headers,
        'User-Agent': STREAM_USER_AGENT,
        Referer: 'https://www.youtube.com/', Origin: 'https://www.youtube.com',
        'Accept-Encoding': 'identity', ...(range ? { Range: range } : {})
      };
      // Uma requisição do navegador corresponde a uma requisição upstream.
      // Não recorta bytes=0-, não inventa Content-Length e não concatena blocos.
      upstream = await audioFetch(stream.url, headers, abort.signal);
      clearTimeout(timer);
      if (upstream.status === 416) {
        const contentRange = upstream.headers.get('content-range');
        if (contentRange) res.set('Content-Range', contentRange);
        res.set('Accept-Ranges', 'bytes');
        await upstream.body?.cancel(); return res.status(416).end();
      }
      if (![200, 206].includes(upstream.status)) {
        streams.delete(`stream:${mode}:${id}`);
        streams.delete(`player:${process.env.YOUTUBE_PLAYER_CLIENT || 'IOS'}:${id}`);
        const upstreamStatus = upstream.status;
        await upstream.body?.cancel();
        return res.status(502).json({ error: 'O servidor de mídia recusou a conexão.', upstreamStatus });
      }
      if (upstream.status === 206 && !/^bytes \d+-\d+\/\d+$/.test(upstream.headers.get('content-range') || '')) {
        throw new Error('Resposta parcial sem Content-Range válido.');
      }
      const mime = upstream.headers.get('content-type') || stream.mime;
      if (!/^(audio|video)\/(mp4|webm)(;|$)/i.test(mime || '')) throw new Error('Resposta upstream não é áudio/vídeo MP4 ou WebM.');
      res.status(upstream.status);
      res.set('Content-Type', mime);
      res.set('Accept-Ranges', 'bytes');
      for (const name of ['content-length', 'content-range']) {
        const value = upstream.headers.get(name);
        if (value) res.set(name, value);
      }
      if (req.method === 'HEAD') { await upstream.body?.cancel(); return res.end(); }
      if (!upstream.body) throw new Error('Stream de mídia vazio.');
      // pipeline propaga falhas e aplica backpressure; close cancela a origem.
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (e) {
      if(abort.signal.reason?.name==='TimeoutError' && !res.headersSent && !res.destroyed) {
        res.removeHeader('Content-Length');res.removeHeader('Content-Range');
        return res.status(504).json({error:'A origem da mídia demorou para responder. Tente novamente.'});
      }
      if (e.name !== 'AbortError' && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error('[stream]', e.name, String(e.message).slice(0, 220));
        streams.delete(`stream:${mode}:${id}`);
        streams.delete(`player:${process.env.YOUTUBE_PLAYER_CLIENT || 'IOS'}:${id}`);
      }
      if (!abort.signal.aborted && !res.headersSent) {
        res.removeHeader('Content-Length'); res.removeHeader('Content-Range');
        if (e.status === 416) return res.status(416).set({ 'Content-Range': `bytes */${e.size}`, 'Accept-Ranges': 'bytes' }).end();
        res.status(e.status || 502).json({ error: 'Não foi possível abrir o áudio. Tente outra faixa ou um arquivo local.' });
      } else if (!res.destroyed) res.destroy();
    } finally {
      clearTimeout(timer); res.off('close', close); req.off('aborted', close);
      abort.abort();
      if (upstream?.body && !upstream.body.locked) await upstream.body.cancel().catch(() => {});
      activeStreams--;
    }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
  app.use(express.static(path.join(ROOT, 'public'), { setHeaders(res, file) {
    if (file.endsWith('service-worker.js')) res.set('Cache-Control', 'no-cache');
  } }));
  app.use((err, _req, res, _next) => {
    console.error('[provider]', err.name, String(err.message).slice(0, 250));
    if (!res.headersSent) res.status(err.status || 502).json({ error: err.status ? err.message :
      'O YouTube Music não respondeu. Tente novamente em instantes; sua biblioteca local continua disponível.' });
  });
  return app;
}

const app = createApp();
export default app;
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Fckyoutube: http://localhost:${port}`));
}

```

## media.js

```
import { readFileSync } from 'node:fs';
import { Ytdl, Client, chooseFormat, Quality } from '@distube/ytdl-core';

// Uma instância por identidade de rede/conta. A biblioteca mantém VisitorData,
// cabeçalhos/versionamento por cliente e gera PO tokens quando necessários.
export function createMediaProvider({ env = process.env, createYtdl = (options) => new Ytdl(options) } = {}) {
  let instance;
  function client() {
    if (instance) return instance;
    if (env.YOUTUBE_COOKIE && env.YOUTUBE_COOKIE_FILE) throw new Error('Configure somente uma origem de cookies.');
    const cookie = env.YOUTUBE_COOKIE_FILE ? readFileSync(env.YOUTUBE_COOKIE_FILE, 'utf8') : env.YOUTUBE_COOKIE;
    const clients = env.YOUTUBE_CLIENTS?.split(',').map((s) => s.trim()).filter(Boolean);
    if (clients && (!clients.length || clients.some((c) => !Object.values(Client).includes(c)))) {
      throw new Error('YOUTUBE_CLIENTS contém cliente não suportado.');
    }
    instance = createYtdl({ country: 'BR', timeoutMs: 30000, ...(cookie ? { cookie } : {}), ...(clients ? { clients } : {}) });
    return instance;
  }
  return async function resolve(id, mode = 'audio') {
    const yt = client();
    const info = await yt.getInfo(id, { signal: AbortSignal.timeout(90000) });
    const format = chooseFormat(info.formats, {
      quality: mode === 'audio' ? Quality.HighestAudio : Quality.HighestVideo,
      filter: (f) => !f.isLive && Number.isSafeInteger(f.contentLength) && f.contentLength > 0 &&
        f.container === 'mp4' && (mode === 'audio'
          ? f.hasAudio && !f.hasVideo && f.audioCodec?.startsWith('mp4a')
          : f.hasVideo && !f.hasAudio && f.videoCodec?.startsWith('avc1') && f.height <= 360)
    });
    const media = yt.open(info, format);
    return {
      mime: format.mimeType, size: format.contentLength,
      // Media.read preserva o formato e retoma no byte correto após expiração/403.
      // Não devolvemos URLs assinadas nem credenciais ao navegador.
      read: ({ range, signal }) => media.read({ range, signal, chunkSize: 10 * 1024 * 1024, highWaterMark: 1 << 20,
        onRetry: ({ attempt, client }) => console.warn('[media retry]', client, attempt) }),
      dash: { init: format.initRange, index: format.indexRange, codecs: format.codecs,
        bitrate: format.bitrate, width: format.width, height: format.height,
        duration: Number(format.approxDurationMs) / 1000 }
    };
  };
}

export const resolveMedia = createMediaProvider();

```

## combined-video.js

```
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

```

## official-video.js

```
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

```

## auth.js

```
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SCOPES = ['openid', 'profile', 'https://www.googleapis.com/auth/youtube.readonly'];
const SESSION = 'rj_session', STATE = 'rj_oauth';
const b64 = (bytes) => bytes.toString('base64url');
const cookieValue = (req, name) => (req.headers.cookie || '').split(';').map((v) => v.trim()).find((v) => v.startsWith(name + '='))?.slice(name.length + 1);

export function createSessionCodec(secret) {
  const key = createHash('sha256').update(secret).digest();
  return {
    seal(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return [b64(iv), b64(cipher.getAuthTag()), b64(encrypted)].join('.');
    },
    open(value) {
      try {
        if (typeof value !== 'string' || value.length > 5000) return null;
        const [iv, tag, encrypted] = value.split('.').map((v) => Buffer.from(v, 'base64url'));
        const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
        const data = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
        return data.exp > Date.now() ? data : null;
      } catch { return null; }
    }
  };
}
function duration(iso = '') {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : 0;
}
function cover(s) { return s?.thumbnails?.high?.url || s?.thumbnails?.medium?.url || s?.thumbnails?.default?.url || '/covers/nocturne.svg'; }
export function googleTrack(item) {
  const s = item.snippet || {}, id = s.resourceId?.videoId || item.contentDetails?.videoId || item.id;
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  return { id, title: s.title || 'Sem título', artist: s.videoOwnerChannelTitle || s.channelTitle || 'YouTube',
    artwork: cover(s), duration: duration(item.contentDetails?.duration), source: 'youtube', kind: 'song', album: '' };
}

export function mountGoogleAuth(app, { env = process.env, fetchImpl = fetch } = {}) {
  const publicOrigin = env.PUBLIC_ORIGIN || 'http://localhost:3000';
  const clientId = env.GOOGLE_CLIENT_ID, clientSecret = env.GOOGLE_CLIENT_SECRET;
  const origin = new URL(publicOrigin).origin;
  const secure = origin.startsWith('https://');
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const configured = Boolean(clientId && clientSecret && (secure || local) && (env.SESSION_SECRET?.length >= 32 || local));
  const redirectUri = origin + '/auth/google/callback';
  const codec = createSessionCodec(env.SESSION_SECRET || b64(randomBytes(32)));
  const setCookie = (res, name, value, age) => res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`);
  const clear = (res, name) => setCookie(res, name, '', 0);
  const sendSession = (res, session) => {
    const encrypted = codec.seal(session);
    if (encrypted.length > 3700) throw new Error('Sessão excedeu o tamanho permitido.');
    setCookie(res, SESSION, encrypted, Math.max(0, Math.floor((session.exp - Date.now()) / 1000)));
  };
  async function google(url, init = {}) {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(res.status === 403 ? 'A API do YouTube recusou esta consulta. Verifique os escopos, a ativação da API e a cota do projeto Google.' : 'Não foi possível validar a sessão com o Google.'), { status: res.status === 401 ? 401 : 502 });
    return data;
  }
  async function authorized(req, res) {
    let session = codec.open(cookieValue(req, SESSION));
    if (!session?.access_token) throw Object.assign(new Error('Entre com sua Conta Google para consultar sua biblioteca.'), { status: 401 });
    if (session.expires_at < Date.now() + 60000) {
      if (!session.refresh_token) { clear(res, SESSION); throw Object.assign(new Error('Sua sessão expirou. Entre novamente.'), { status: 401 }); }
      try {
        const tokens = await google('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
          client_id: clientId, client_secret: clientSecret, refresh_token: session.refresh_token, grant_type: 'refresh_token'
        }) });
        session = { ...session, access_token: tokens.access_token, expires_at: Date.now() + (tokens.expires_in || 3600) * 1000 };
        sendSession(res, session);
      } catch { clear(res, SESSION); throw Object.assign(new Error('Sua sessão expirou. Entre novamente.'), { status: 401 }); }
    }
    return session;
  }
  async function youtube(session, endpoint, params) {
    const u = new URL('https://www.googleapis.com/youtube/v3/' + endpoint);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, String(v));
    return google(u, { headers: { Authorization: `Bearer ${session.access_token}` } });
  }
  app.get('/auth/google', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!configured) return res.redirect('/#account/setup');
    const state = b64(randomBytes(32)), verifier = b64(randomBytes(48));
    setCookie(res, STATE, codec.seal({ state, verifier, exp: Date.now() + 600000 }), 600);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    const params = { client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
      state, code_challenge: b64(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    res.redirect(url.href);
  });
  app.get('/auth/google/callback', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const pending = codec.open(cookieValue(req, STATE)); clear(res, STATE);
    const state = typeof req.query.state === 'string' && /^[A-Za-z0-9_-]{43}$/.test(req.query.state) ? req.query.state : '';
    if (!configured || !pending || !state || pending.state.length !== state.length ||
        !timingSafeEqual(Buffer.from(pending.state), Buffer.from(state))) return res.redirect('/#account/error-state');
    if (req.query.error || typeof req.query.code !== 'string') return res.redirect('/#account/cancelled');
    try {
      const tokens = await google('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
        code: req.query.code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
        grant_type: 'authorization_code', code_verifier: pending.verifier
      }) });
      const granted = new Set((tokens.scope || '').split(' '));
      if (!tokens.access_token || !granted.has('https://www.googleapis.com/auth/youtube.readonly')) return res.redirect('/#account/missing-scope');
      const info = await google('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      if (!info.sub) throw new Error('Perfil inválido.');
      sendSession(res, { access_token: tokens.access_token, refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in || 3600) * 1000, exp: Date.now() + 7 * 86400000,
        user: { name: String(info.name || 'Sua conta').slice(0, 100), picture: /^https:\/\//.test(info.picture || '') ? info.picture : null } });
      res.redirect('/#account');
    } catch { res.redirect('/#account/error'); }
  });
  app.get('/api/account', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', Vary: 'Cookie' });
    if (!codec.open(cookieValue(req, SESSION))) return res.json({ configured, user: null });
    const session = await authorized(req, res);
    res.json({ configured, user: session.user });
  });
  app.post('/api/auth/logout', async (req, res) => {
    if (req.headers.origin !== origin || req.headers['x-reidajbl-csrf'] !== '1') return res.status(403).json({ error: 'Origem inválida.' });
    const session = codec.open(cookieValue(req, SESSION)); clear(res, SESSION); clear(res, STATE);
    if (session) {
      try { await fetchImpl('https://oauth2.googleapis.com/revoke', { method: 'POST',
        body: new URLSearchParams({ token: session.refresh_token || session.access_token }), signal: AbortSignal.timeout(5000) }); } catch { /* Sessão local já removida. */ }
    }
    res.set('Cache-Control', 'no-store').json({ ok: true });
  });
  app.get('/api/account/library', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', Vary: 'Cookie' });
    const session = await authorized(req, res);
    const section = req.query.section || 'playlists';
    const pageToken = req.query.pageToken || '';
    if (typeof pageToken !== 'string' || !/^[A-Za-z0-9_=-]{0,512}$/.test(pageToken)) return res.status(400).json({ error: 'Página inválida.' });
    const base = { part: 'snippet,contentDetails', maxResults: 50, pageToken };
    if (section === 'history') return res.json({ available: false, message: 'A API oficial não permite ler o histórico global do YouTube. O histórico deste aplicativo permanece disponível no início.', items: [] });
    let data, items;
    if (section === 'playlists') {
      data = await youtube(session, 'playlists', { ...base, mine: true });
      items = (data.items || []).map((p) => ({ id: p.id, kind: 'playlist', source: 'google', title: p.snippet.title, artist: `${p.contentDetails.itemCount} faixas`, artwork: cover(p.snippet) }));
    } else if (section === 'likes') {
      data = await youtube(session, 'videos', { ...base, myRating: 'like' }); items = (data.items || []).map(googleTrack).filter(Boolean);
    } else if (section === 'subscriptions') {
      data = await youtube(session, 'subscriptions', { ...base, mine: true, order: 'alphabetical' });
      items = (data.items || []).map((p) => ({ id: p.snippet.resourceId.channelId, kind: 'channel', source: 'google', title: p.snippet.title, artwork: cover(p.snippet) }));
    } else return res.status(400).json({ error: 'Seção inválida.' });
    res.json({ items, nextPageToken: data.nextPageToken || null,
      message: section === 'playlists' ? 'Playlists criadas por você. A API oficial não fornece uma lista completa das playlists de terceiros salvas na sua biblioteca.' : '' });
  });
  app.get('/api/account/playlist/:id', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', Vary: 'Cookie' });
    const session = await authorized(req, res);
    if (!/^[A-Za-z0-9_-]{10,150}$/.test(req.params.id)) return res.status(400).json({ error: 'Playlist inválida.' });
    const pageToken = req.query.pageToken || '';
    if (typeof pageToken !== 'string' || !/^[A-Za-z0-9_=-]{0,512}$/.test(pageToken)) return res.status(400).json({ error: 'Página inválida.' });
    const data = await youtube(session, 'playlistItems', { part: 'snippet,contentDetails', maxResults: 50, playlistId: req.params.id, pageToken });
    res.json({ items: (data.items || []).map(googleTrack).filter(Boolean), nextPageToken: data.nextPageToken || null });
  });
}

```

## package.json

```
{
  "name": "fckyoutube",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": "^22.22.2 || ^24.15.0 || >=26.0.0"
  },
  "scripts": {
    "postinstall": "node scripts/vendor.js",
    "prestart": "node scripts/version-assets.js",
    "predev": "node scripts/version-assets.js",
    "start": "node server.js",
    "dev": "node --watch server.js",
    "build": "node scripts/build.js",
    "test": "node --test",
    "check": "node --check server.js && node --check media.js && node --check combined-video.js && node --check official-video.js && node --check auth.js && node --check public/app.js && node --check public/video-player.js && node --check public/account.js && node --check public/service-worker.js && node --check public/media-controls.js && node --check public/audio-focus.js"
  },
  "dependencies": {
    "@distube/ytdl-core": "5.2.1",
    "express": "5.1.0",
    "ffmpeg-static": "5.3.0",
    "shaka-player": "4.14.10",
    "youtubei.js": "18.3.0"
  },
  "devDependencies": {
    "jsdom": "30.1.3"
  }
}

```

## public/index.html

```
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0B0C10">
  <meta name="description" content="F*ckyoutube. Sua música, no seu ritmo. Player sem anúncios, biblioteca local e busca musical.">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="F*ckyoutube">
  <link rel="manifest" href="/manifest.json">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png?v=2">
  <link rel="icon" type="image/svg+xml" href="/icons/crown.svg?v=2">
  <link rel="stylesheet" href="/styles-v3.css">
  <link rel="stylesheet" href="/car-mode.css">
  <link rel="stylesheet" href="/premium.css">
  <title>F*ckyoutube — Sua trilha, seu ritmo</title>
</head>
<body>
<svg class="sprite" aria-hidden="true"><defs>
<symbol id="i-crown" viewBox="0 0 24 24"><path d="M5 4h12v3H9v5h7v3H9v6H5Z" fill="currentColor" stroke="none"/><path d="m19 16 1 2 2 .5-2 1-1 2-1-2-2-.5 2-1Z" fill="currentColor" stroke="none"/></symbol>
<symbol id="i-home" viewBox="0 0 24 24"><path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/></symbol>
<symbol id="i-library" viewBox="0 0 24 24"><path d="M4 4v16M9 4v16m5-15 5 15M3 20h18"/></symbol>
<symbol id="i-play" viewBox="0 0 24 24"><path class="fill" d="m8 4 12 8-12 8Z"/></symbol>
<symbol id="i-pause" viewBox="0 0 24 24"><path d="M8 5v14M16 5v14" stroke-width="4"/></symbol>
<symbol id="i-next" viewBox="0 0 24 24"><path class="fill" d="m4 5 11 7-11 7Z"/><path d="M19 5v14" stroke-width="3"/></symbol>
<symbol id="i-prev" viewBox="0 0 24 24"><path class="fill" d="m20 5-11 7 11 7Z"/><path d="M5 5v14" stroke-width="3"/></symbol>
<symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 4v16M4 12h16"/></symbol>
<symbol id="i-heart" viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></symbol>
<symbol id="i-more" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></symbol>
<symbol id="i-down" viewBox="0 0 24 24"><path d="m5 9 7 7 7-7"/></symbol>
<symbol id="i-queue" viewBox="0 0 24 24"><path d="M3 5h18M3 11h18M3 17h10m4-2 5 3-5 3Z"/></symbol>
<symbol id="i-volume" viewBox="0 0 24 24"><path d="M3 9h4l5-5v16l-5-5H3Zm13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></symbol>
<symbol id="i-shuffle" viewBox="0 0 24 24"><path d="M3 6h3c4 0 8 12 12 12h3m-4-4 4 4-4 4M3 18h3c1 0 3-2 4-4m4-4c2-3 3-4 4-4h3m-4-4 4 4-4 4"/></symbol>
<symbol id="i-repeat" viewBox="0 0 24 24"><path d="M20 10V6H4v4m0 4v4h16v-4M17 3l3 3-3 3M7 15l-3 3 3 3"/></symbol>
<symbol id="i-upload" viewBox="0 0 24 24"><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/></symbol>
<symbol id="i-arrow" viewBox="0 0 24 24"><path d="M4 12h16m-6-6 6 6-6 6"/></symbol>
<symbol id="i-close" viewBox="0 0 24 24"><path d="m6 6 12 12M6 18 18 6"/></symbol>
</defs></svg>
<aside class="sidebar">
  <a class="brand" href="#home" aria-label="F*ckyoutube, início"><span class="brandmark"><svg><use href="#i-crown"/></svg></span><span>F*ck<span class="brand-light">youtube</span><small>SEU UNIVERSO MUSICAL</small></span></a>
  <p class="nav-label">EXPLORAR</p>
  <nav class="desktop-nav" aria-label="Navegação principal">
    <a href="#home" data-nav="home"><svg><use href="#i-home"/></svg>Início</a>
    <a href="#search" data-nav="search"><svg><use href="#i-search"/></svg>Buscar</a>
    <a href="#library" data-nav="library"><svg><use href="#i-library"/></svg>Sua biblioteca</a>
  </nav>
  <div class="nav-label row"><span>SUAS PLAYLISTS</span><button class="icon-btn small" data-action="create-playlist" aria-label="Criar playlist"><svg><use href="#i-plus"/></svg></button></div>
  <div id="sidebar-playlists"></div>
  <button class="liked-shortcut" data-action="show-favorites"><span>♥</span> Músicas curtidas</button>
  <div class="sidebar-note"><svg><use href="#i-crown"/></svg><strong>Só você e a música.</strong><p>Sem anúncios.<br>Sem interrupções na interface.</p><button class="text-button" data-action="install">Instalar aplicativo <span>↗</span></button></div>
  <div class="sidebar-bottom"><span class="status-dot"></span><span id="connection">Você está online</span></div>
</aside>
<div class="workspace">
  <header class="topbar">
    <a class="mobile-brand" href="#home"><svg><use href="#i-crown"/></svg>F*ckyoutube</a>
    <form id="search-form" role="search"><svg><use href="#i-search"/></svg><input id="search-input" type="search" placeholder="O que você quer ouvir?" aria-label="Buscar músicas, artistas ou álbuns" maxlength="160" autocomplete="off"><kbd>/</kbd></form>
    <div class="topbar-right"><button class="car-mode-toggle outline-button" data-action="car-mode" aria-pressed="false">Modo Carro</button><span class="ad-free"><i></i> SEM ANÚNCIOS</span><button id="profile-button" class="google-profile" data-action="account" aria-label="Abrir perfil da Conta Google"><span class="google-g">G</span><span id="profile-name">Entrar com a Conta Google</span></button></div>
  </header>
  <main id="content" tabindex="-1"></main>
  <footer class="page-footer"><span><svg><use href="#i-crown"/></svg> Feito para ouvir de verdade.</span><button data-action="install">Como instalar no iPhone ↗</button></footer>
</div>
<section class="mini-player" aria-label="Player de áudio">
  <button class="mini-track" data-action="expand"><img id="mini-art" src="/covers/nocturne.svg" alt=""><span><strong id="mini-title">Escolha sua próxima faixa</strong><small id="mini-artist">O seu som começa aqui</small></span><svg class="mobile-expand"><use href="#i-down"/></svg></button>
  <button class="icon-btn favorite" data-action="like-current" aria-label="Curtir faixa" aria-pressed="false"><svg><use href="#i-heart"/></svg></button>
  <div class="mini-controls"><div class="transport"><button class="icon-btn subtle shuffle" data-action="shuffle" aria-label="Alternar reprodução aleatória" aria-pressed="false"><svg><use href="#i-shuffle"/></svg></button><button class="icon-btn previous" data-action="previous" aria-label="Faixa anterior"><svg><use href="#i-prev"/></svg></button><button class="play-btn mini-play" data-action="toggle" aria-label="Reproduzir"><svg><use href="#i-play"/></svg></button><button class="icon-btn" data-action="next" aria-label="Próxima faixa"><svg><use href="#i-next"/></svg></button><button class="icon-btn subtle repeat" data-action="repeat" aria-label="Repetir faixa" aria-pressed="false"><svg><use href="#i-repeat"/></svg></button></div><div class="timeline"><time class="current-time">0:00</time><input class="progress" type="range" min="0" max="100" value="0" step="0.1" aria-label="Posição da faixa"><time class="duration">0:00</time></div></div>
  <div class="mini-extras"><button class="icon-btn" data-action="queue" aria-label="Abrir fila"><svg><use href="#i-queue"/></svg></button><svg><use href="#i-volume"/></svg><input class="volume" type="range" min="0" max="1" step="0.01" value="0.8" aria-label="Volume"><button class="icon-btn" data-action="expand" aria-label="Expandir player"><svg><use href="#i-down"/></svg></button></div>
</section>
<nav class="mobile-nav" aria-label="Navegação móvel"><a href="#home" data-nav="home"><svg><use href="#i-home"/></svg>Início</a><a href="#search" data-nav="search"><svg><use href="#i-search"/></svg>Buscar</a><a href="#library" data-nav="library"><svg><use href="#i-library"/></svg>Biblioteca</a></nav>
<dialog id="player-dialog" class="full-player"><div class="player-top"><button class="icon-btn" data-action="collapse" aria-label="Minimizar player"><svg><use href="#i-down"/></svg></button><span>TOCANDO AGORA<small>F*ckyoutube</small></span><button class="car-mode-toggle outline-button" data-action="car-mode" aria-pressed="false">Modo Carro</button><button class="icon-btn" data-action="add-current" aria-label="Adicionar à playlist"><svg><use href="#i-plus"/></svg></button></div><div class="mode-switch" role="group" aria-label="Modo de reprodução"><button class="mode-option active" data-action="set-mode" data-mode="audio" aria-pressed="true">Apenas Áudio</button><button class="mode-option" data-action="set-mode" data-mode="video" aria-pressed="false">Vídeo</button></div><p id="video-notice" class="player-status" role="status" hidden></p><video aria-label="Vídeo da faixa atual" id="video" class="full-video" playsinline controls preload="metadata" hidden></video><img class="full-art" id="full-art" src="/covers/nocturne.svg" alt="Capa da faixa"><div class="full-title"><div><h2 id="full-title">Sua próxima descoberta</h2><p id="full-artist">Escolha uma faixa para começar</p></div><button class="icon-btn favorite" data-action="like-current" aria-label="Curtir faixa" aria-pressed="false"><svg><use href="#i-heart"/></svg></button></div><input class="progress" type="range" min="0" max="100" value="0" step="0.1" aria-label="Posição da faixa"><div class="player-times"><time class="current-time">0:00</time><time class="duration">0:00</time></div><div class="full-transport"><button class="icon-btn shuffle" data-action="shuffle" aria-label="Alternar aleatório" aria-pressed="false"><svg><use href="#i-shuffle"/></svg></button><button class="icon-btn" data-action="previous" aria-label="Faixa anterior"><svg><use href="#i-prev"/></svg></button><button class="play-btn full-play" data-action="toggle" aria-label="Reproduzir"><svg><use href="#i-play"/></svg></button><button class="icon-btn" data-action="next" aria-label="Próxima faixa"><svg><use href="#i-next"/></svg></button><button class="icon-btn repeat" data-action="repeat" aria-label="Repetir faixa" aria-pressed="false"><svg><use href="#i-repeat"/></svg></button></div><div class="full-volume"><svg><use href="#i-volume"/></svg><input class="volume" type="range" min="0" max="1" step="0.01" value="0.8" aria-label="Volume"><small id="volume-note"></small></div><button class="queue-link" data-action="queue"><svg><use href="#i-queue"/></svg>A seguir <span>→</span></button><p id="playback-status" class="player-status" role="status"></p></dialog>
<dialog id="sheet" class="sheet"><div class="sheet-heading"><h2 id="sheet-title"></h2><button class="icon-btn" data-action="close-sheet" aria-label="Fechar"><svg><use href="#i-close"/></svg></button></div><div id="sheet-content"></div></dialog>
<input type="file" id="file-input" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac" multiple hidden>
<audio id="audio" preload="metadata" playsinline></audio>
<div id="toast" role="status" aria-live="polite"></div>
<script type="module" src="/app-v7.js"></script>
</body></html>

```

## public/app.js

```
import { createAccountUI } from './account.js';
import { createVideoPlayer } from './video-player-v3.js';
import { createAudioRetry } from './audio-retry.js';
import { installMediaControls, createArtworkVariants } from './media-controls.js';
import { createAudioFocus } from './audio-focus.js';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (s) => Number.isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00';
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { toast('Armazenamento cheio. Não foi possível salvar esta alteração.'); } };
const demos = [
  { id: 'demo-nocturne', title: 'Nocturne', artist: 'Fckyoutube Studio', album: 'Sessions 01', artwork: '/covers/nocturne.svg', duration: 32, source: 'demo', url: '/audio/nocturne.wav', kind: 'song', mood: 'FOCO' },
  { id: 'demo-golden', title: 'Golden hour', artist: 'Fckyoutube Studio', album: 'Sessions 01', artwork: '/covers/golden.svg', duration: 32, source: 'demo', url: '/audio/golden.wav', kind: 'song', mood: 'RELAX' },
  { id: 'demo-orbit', title: 'Em órbita', artist: 'Fckyoutube Studio', album: 'Sessions 01', artwork: '/covers/orbit.svg', duration: 32, source: 'demo', url: '/audio/orbit.wav', kind: 'song', mood: 'DESCOBRIR' }
];
const catalog = new Map(demos.map((t) => [t.id, t]));
const savedLists = read('rj-playlists', []);
const savedLikes = read('rj-likes', []);
const state = {
  lists: Array.isArray(savedLists) ? savedLists.filter((p) => p && typeof p.id === 'string' && Array.isArray(p.tracks)) : [],
  likes: Array.isArray(savedLikes) ? savedLikes.filter((t) => t && typeof t.id === 'string') : [],
  local: [], recent: read('rj-recent', []), queue: [], index: -1, current: null,
  shuffle: false, repeat: false, searchType: 'songs', query: '', home: null,
  loadingHome: false, homeError: '', pageToken: 0, localURLs: new Map(), listId: null, mode: 'audio', pendingSeek: null,
  playbackEpoch: 0, wantsPlayback: false, lastPosition: 0
};
if (!Array.isArray(state.recent)) state.recent = [];
for (const t of [...state.likes, ...state.recent, ...state.lists.flatMap((p) => p.tracks)]) if (t?.id) { if (t.source === 'demo' && demos.some(d => d.id === t.id)) t.artist = 'Fckyoutube Studio'; catalog.set(t.id, t); }
const audioElement = $('#audio'), videoElement = $('#video');
let audio = audioElement;
let audioFocus, artworkGeneration = 0;
let carMode = read('rj-car-mode', false) === true;
const videoPlayer = createVideoPlayer(videoElement, (message) => { $('#playback-status').textContent = message; toast(message); updatePlayback(); });
let deferredInstall, toastTimer, db;
let selectedTrack = null;
let searchAbort;
let videoSearchAbort, videoSearchPosition = null;
function videoNotice(message = '') {
  $('#video-notice').textContent = message; $('#video-notice').hidden = !message;
}
async function startOfficialVideo(track, position, play) {
  videoSearchAbort?.abort();
  const controller = new AbortController(); videoSearchAbort = controller;
  const epoch = state.playbackEpoch; videoSearchPosition = position;
  videoPlayer.stop(); videoElement.hidden = true;
  videoNotice();
  $('#playback-status').textContent = 'Buscando clipe oficial…';
  try {
    const query = new URLSearchParams({id:track.id,title:track.title,artist:track.artist,duration:String(track.duration || 0)});
    const response = await fetch(`/api/official-video?${query}`,{signal:controller.signal});
    if (!response.ok) throw new Error('Não foi possível consultar o clipe agora.');
    const result = await response.json();
    if (controller.signal.aborted || epoch !== state.playbackEpoch || state.mode !== 'video') return;
    if (!result.available) {
      setMode('audio');
      videoNotice('Vídeo oficial indisponível para esta faixa');
      return;
    }
    videoSearchPosition = null;
    videoElement.hidden = false;
    $('#playback-status').textContent = 'Preparando clipe oficial…';
    await videoPlayer.load(result.video.id,position,state.wantsPlayback && !audioFocus?.deferPlay());
  } catch(error) {
    if (controller.signal.aborted || epoch !== state.playbackEpoch) return;
    setMode('audio');videoNotice('Não foi possível consultar o clipe agora. Mantendo o áudio.');
  }
}
const audioRetry = createAudioRetry({
  getContext: () => ({ epoch:state.playbackEpoch, trackId:state.current?.id, source:state.current?.source,
    mode:state.mode, wantsPlayback:state.wantsPlayback,
    position:audioElement.currentTime > 0 ? audioElement.currentTime : state.lastPosition }),
  reconnect: ({position,attempt}) => {
    if (audioFocus?.deferPlay()) return;
    state.pendingSeek = {id:state.current.id,position};
    audioElement.src = trackSource(state.current) + `&retry=${attempt}`;
    audioElement.load();
    return audioElement.play();
  },
  onRetry: () => { $('#playback-status').textContent = 'Conexão interrompida. Reconectando uma vez…'; },
  onFinal: () => {
    state.wantsPlayback=false; audioElement.pause();
    $('#playback-status').textContent = 'O áudio falhou mesmo após tentar reconectar. Toque na faixa para tentar novamente.';
    toast('Não foi possível manter o áudio após a reconexão.'); updatePlayback();
  }
});
function pausePlayback() { state.wantsPlayback = false; audioFocus?.cancel(); audioRetry.cancel(); audio.pause(); }
function stopPlayback() {
  pausePlayback(); videoSearchAbort?.abort(); videoSearchPosition=null;state.playbackEpoch++;
  if(state.mode==='video') {state.mode='audio';renderer('audio');if(state.current){audio.src=trackSource(state.current);audio.load();}}
  state.lastPosition=0;state.pendingSeek=state.current?{id:state.current.id,position:0}:null;
  try {audio.currentTime=0;}catch { /* Aplicado em loadedmetadata. */ }
  updateProgress();updatePlayback();
}
function setCarMode(enabled) {
  carMode=enabled;write('rj-car-mode',enabled);document.body.classList.toggle('car-mode',enabled);
  $$('.car-mode-toggle').forEach(b=>{b.setAttribute('aria-pressed',String(enabled));b.textContent=enabled?'Sair do Modo Carro':'Modo Carro';});
  if(enabled) {if(state.mode==='video')setMode('audio');$('#player-dialog').showModal();}
}
function playbackRejected(error, epoch = state.playbackEpoch) {
  if (epoch !== state.playbackEpoch || error.name === 'AbortError') return;
  if (error.name === 'NotAllowedError') {
    state.wantsPlayback=false; audioRetry.cancel();
    $('#playback-status').textContent = 'Toque em reproduzir para autorizar o áudio.';
    toast('Toque em reproduzir para autorizar o áudio.');
  } else if (!audioRetry.handleError()) toast('Não foi possível reproduzir esta faixa.');
  updatePlayback();
}

function toast(message) {
  $('#toast').textContent = message; $('#toast').classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 5000);
}
function persist() {
  write('rj-playlists', state.lists); write('rj-likes', state.likes); write('rj-recent', state.recent.slice(0, 30));
  renderSidebar();
}
function register(items) { for (const t of items) if (t?.id) catalog.set(t.id, t); return items; }
const account = createAccountUI({ esc, api, toast, card, row, register, onTracks: (items) => { state.visible = items; } });
function art(url) { return /^(https:\/\/|\/covers\/|blob:)/.test(url || '') ? url : '/covers/nocturne.svg'; }
function card(track) {
  const label = track.kind === 'artist' ? 'Artista' : track.kind === 'album' ? 'Álbum' : track.kind === 'mix' ? '3 sessions para desacelerar' : track.source === 'demo' ? 'Instrumental original · 0:32' : track.artist;
  return `<article class="music-card"><button class="cover-button" data-action="open-item" data-id="${esc(track.id)}" aria-label="${esc(track.kind === 'song' ? 'Reproduzir ' : 'Abrir ')}${esc(track.title)}"><img src="${esc(art(track.artwork))}" alt="" loading="lazy">${track.mood ? `<span class="card-tag">${esc(track.mood)}</span>` : ''}<span class="cover-play">${icon(track.kind === 'song' ? 'play' : 'arrow')}</span></button><a href="#" class="card-title" data-action="open-item" data-id="${esc(track.id)}">${esc(track.title)}</a><div class="card-subtitle">${esc(label)}</div></article>`;
}
function row(track, index = 0, queueMode = false) {
  return `<div class="track-row ${track.id === state.current?.id ? 'is-current' : ''}"><span class="track-number">${String(index + 1).padStart(2, '0')}</span><img class="track-art" src="${esc(art(track.artwork))}" alt="" loading="lazy"><button class="track-main" data-action="${queueMode ? 'queue-play' : 'open-item'}" data-id="${esc(track.id)}" data-index="${index}"><strong>${esc(track.title)}</strong><small>${esc(track.artist)}</small></button><time>${clock(track.duration)}</time><button class="icon-btn" data-action="track-menu" data-id="${esc(track.id)}" aria-label="Opções de ${esc(track.title)}">${icon('more')}</button></div>`;
}
function heading(title, subtitle = '', action = '') {
  return `<div class="section-heading"><div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>${action}</div>`;
}
function empty(title, message, button = '') { return `<div class="empty-state">${icon('library')}<h2>${esc(title)}</h2><p>${esc(message)}</p>${button}</div>`; }
function renderSidebar() {
  $('#sidebar-playlists').innerHTML = state.lists.slice(0, 5).map((p) => `<a class="sidebar-playlist" href="#playlist/${encodeURIComponent(p.id)}">♫ &nbsp; ${esc(p.name)}</a>`).join('');
}
function renderHome() {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const localCount = state.local.length;
  const recent = state.recent.length ? state.recent.slice(0, 4) : demos;
  $('#content').innerHTML = `<div class="eyebrow">O SEU PRÓXIMO PLAY COMEÇA AQUI</div><h1>${greeting}. Qual é o seu ritmo?</h1><p class="greeting-sub">Um universo de música. Um espaço só seu.</p>
    <div class="filters" aria-label="Explorar por clima"><button class="chip active" data-action="home">Para você</button>${['Relaxar', 'Foco', 'MPB', 'Jazz', 'Eletrônica'].map((q) => `<button class="chip" data-action="quick-search" data-query="${esc(q)}">${esc(q)}</button>`).join('')}</div>
    <section class="hero"><img class="hero-visual" src="/covers/hero.svg" alt="Composição abstrata com discos e luz dourada"><div class="hero-copy"><span class="eyebrow">${icon('crown')} FCKYOUTUBE SESSIONS / VOL. 01</span><h2>Sua trilha.<br><em>No seu ritmo.</em></h2><p>Desacelere o mundo lá fora.<br>Encontre o som que combina com você.</p><button class="gold-button" data-action="play-demos">${icon('play')}Ouvir sessions</button></div><span class="hero-badge">3 INSTRUMENTAIS ORIGINAIS</span></section>
    ${heading('Pequenas pausas. Grandes vibrações.', 'Sessions originais para conhecer o player.', `<button data-action="play-demos">Ouvir tudo ${icon('arrow')}</button>`)}
    <div class="card-grid">${demos.map(card).join('')}${card({ ...demos[0], id: 'mix-slow', title: 'Modo tranquilo', artist: 'Uma pausa no seu dia', artwork: '/covers/slow.svg', kind: 'mix', mood: 'SEU MOMENTO' })}</div>
    <div class="lower-grid"><section>${heading(state.recent.length ? 'Ouvidas recentemente' : 'Comece por aqui', state.recent.length ? 'Volte aos seus últimos plays.' : 'Três faixas curtas, prontas para tocar.')}<div class="track-list">${recent.map((t, i) => row(t, i)).join('')}</div></section><section>${heading('Um lugar para o seu som', 'Sua biblioteca acompanha você.')}<div class="collection-grid"><button class="collection-tile" data-action="show-favorites"><span class="tile-icon">${icon('heart')}</span><span><strong>Músicas curtidas</strong><small>${state.likes.length} faixas salvas</small></span></button><button class="collection-tile" data-action="library"><span class="tile-icon">${icon('library')}</span><span><strong>Sua biblioteca</strong><small>${localCount} arquivos locais</small></span></button></div><div class="import-card">${icon('upload')}<div><strong>Traga suas músicas</strong><p>Seus arquivos. Até sem internet.</p></div><button data-action="import" aria-label="Importar músicas">${icon('plus')}</button></div></section></div>
    ${heading('Descubra no YouTube Music', 'Seleções públicas do serviço, sem personalização de conta.', '<button data-action="reload-home">Atualizar ↻</button>')}
    <div id="remote-home">${remoteHome()}</div>`;
}
function remoteHome() {
  if (state.loadingHome) return '<div class="loading">Conectando ao YouTube Music…</div>';
  if (state.homeError) return `<div class="error-banner">${esc(state.homeError)} <button class="text-button" data-action="reload-home">Tentar novamente</button></div>`;
  const sections = state.home?.sections || [];
  if (!sections.length) return '<p class="api-notice">As seleções online aparecerão aqui quando o serviço responder.</p>';
  return sections.slice(0, 2).map((s) => `${heading(s.title)}<div class="card-grid">${s.items.slice(0, 4).map(card).join('')}</div>`).join('');
}
async function api(url, signal) {
  const response = await fetch(url, { signal: signal || AbortSignal.timeout(30000) });
  let data;
  try { data = await response.json(); } catch { throw new Error('Resposta inválida do servidor.'); }
  if (!response.ok) throw new Error(data.error || 'Não foi possível consultar o serviço.');
  return data;
}
async function loadHome() {
  if (state.loadingHome) return;
  state.loadingHome = true; state.homeError = '';
  if ($('#remote-home')) $('#remote-home').innerHTML = remoteHome();
  try {
    state.home = await api('/api/home');
    for (const s of state.home.sections) register(s.items);
  } catch (e) { state.homeError = navigator.onLine ? e.message : 'Você está offline. As sessions e os arquivos importados continuam disponíveis.'; }
  state.loadingHome = false;
  if ($('#remote-home')) $('#remote-home').innerHTML = remoteHome();
}
function renderSearch() {
  $('#content').innerHTML = `<div class="eyebrow">SIGA A SUA CURIOSIDADE</div><h1>Seu próximo favorito está aqui.</h1><p class="greeting-sub">Busque músicas, artistas e álbuns no YouTube Music.</p><div class="result-tabs">${[['songs', 'Músicas'], ['artists', 'Artistas'], ['albums', 'Álbuns']].map(([type, label]) => `<button class="chip ${state.searchType === type ? 'active' : ''}" data-action="search-type" data-type="${type}">${label}</button>`).join('')}</div><div id="search-results">${state.query ? '<div class="loading">Buscando…</div>' : `${heading('Explore um novo clima', 'Uma boa descoberta começa com um play.')}<div class="search-genres">${[['MPB', '#443125'], ['Jazz', '#322735'], ['Lo-fi', '#302738'], ['Soul', '#42222C'], ['Instrumental', '#272A34'], ['Eletrônica', '#3C2030']].map(([q, color]) => `<button class="genre" style="--color:${color}" data-action="quick-search" data-query="${q}"><strong>${q}</strong></button>`).join('')}</div>`}</div>`;
  if (state.query) search(state.query);
}
async function search(query) {
  query = query.trim().slice(0, 160);
  if (!query) return;
  state.query = query; $('#search-input').value = query;
  if (!$('#search-results')) { location.hash = '#search'; return; }
  searchAbort?.abort(); searchAbort = new AbortController();
  const controller = searchAbort;
  const timeout = setTimeout(() => controller.abort('timeout'), 30000);
  $('#search-results').innerHTML = '<div class="loading">Encontrando o seu som…</div>';
  try {
    const result = await api(`/api/search?q=${encodeURIComponent(query)}&type=${state.searchType}`, controller.signal);
    if (controller !== searchAbort || !$('#search-results')) return;
    const items = register(result.items);
    $('#search-results').innerHTML = `${heading(`Resultados para “${query}”`, `${items.length} resultados nesta página`)}${items.length ? state.searchType === 'songs' ? `<div class="track-list">${items.map((t, i) => row(t, i)).join('')}</div>` : `<div class="card-grid">${items.map(card).join('')}</div>` : empty('Nenhum resultado por aqui', 'Tente outro nome ou mude entre músicas, artistas e álbuns.')}`;
    state.visible = items.filter((t) => t.kind === 'song');
  } catch (e) {
    if (controller !== searchAbort || !$('#search-results')) return;
    $('#search-results').innerHTML = `<div class="error-banner">${esc(controller.signal.aborted ? 'A busca demorou mais que o esperado. Tente novamente.' : e.message)}</div>${empty('Enquanto isso, o som continua.', 'Ouça as sessions ou importe músicas para sua biblioteca.', '<button class="gold-button" data-action="library">Abrir biblioteca</button>')}`;
  } finally { clearTimeout(timeout); }
}
function renderLibrary() {
  $('#content').innerHTML = `<div class="eyebrow">SEMPRE DO SEU JEITO</div><h1>Sua biblioteca.</h1><p class="greeting-sub">Suas favoritas, suas playlists e suas músicas offline.</p><div class="library-actions"><button class="gold-button" data-action="import">${icon('upload')}Importar músicas</button><button class="outline-button" data-action="create-playlist">${icon('plus')}Criar playlist</button><button class="outline-button" data-action="export">Exportar playlists</button></div>
    <div class="collection-grid"><button class="collection-tile" data-action="show-favorites"><span class="tile-icon">${icon('heart')}</span><span><strong>Músicas curtidas</strong><small>${state.likes.length} faixas</small></span></button>${state.lists.map((p) => `<a class="collection-tile" href="#playlist/${encodeURIComponent(p.id)}"><span class="tile-icon">${icon('library')}</span><span><strong>${esc(p.name)}</strong><small>${p.tracks.length} faixas</small></span></a>`).join('')}</div>
    ${heading('Neste dispositivo', 'Arquivos importados ficam no navegador, sem envio ao servidor.')}${state.local.length ? `<div class="track-list">${state.local.map((t, i) => row(t, i)).join('')}</div>` : empty('Sua coleção começa aqui', 'Importe MP3, M4A, AAC ou outros formatos aceitos pelo navegador. O iOS pode liberar espaço; mantenha seus arquivos originais.', '<button class="outline-button" data-action="import">Selecionar arquivos</button>')}
    ${heading('Fckyoutube Sessions', 'Instrumentais originais incluídos no aplicativo.')}<div class="track-list">${demos.map((t, i) => row(t, i)).join('')}</div>`;
  state.visible = [...state.local, ...demos];
}
function renderPlaylist(id) {
  const isLikes = id === 'favorites';
  const list = isLikes ? { name: 'Músicas curtidas', tracks: state.likes } : state.lists.find((p) => p.id === id);
  if (!list) { $('#content').innerHTML = empty('Playlist não encontrada', 'Abra sua biblioteca para criar uma nova coleção.'); return; }
  state.listId = id; state.visible = list.tracks;
  $('#content').innerHTML = `<div class="eyebrow">SUA COLEÇÃO</div><h1>${esc(list.name)}</h1><p class="greeting-sub">${list.tracks.length} faixas · Salva neste navegador</p><div class="playlist-top"><button class="gold-button" data-action="play-list">${icon('play')}Ouvir playlist</button>${!isLikes ? '<button class="outline-button" data-action="rename-playlist">Renomear</button><button class="outline-button delete-button" data-action="delete-playlist">Excluir playlist</button>' : ''}</div>${list.tracks.length ? `<div class="track-list">${list.tracks.map((t, i) => row(t, i)).join('')}</div>` : empty('Um espaço para suas descobertas', 'Busque uma música e use o menu da faixa para adicioná-la aqui.', '<a class="gold-button" href="#search">Buscar músicas</a>')}`;
}
async function renderCollection(id, type) {
  const token = state.pageToken;
  $('#content').innerHTML = '<div class="loading">Abrindo coleção…</div>';
  try {
    const data = await api(`/api/collection/${encodeURIComponent(id)}?type=${encodeURIComponent(type)}`);
    if (state.pageToken !== token) return;
    register(data.items); state.visible = data.items.filter((t) => t.kind === 'song');
    $('#content').innerHTML = `<div class="eyebrow">${type === 'artist' ? 'ARTISTA' : 'ÁLBUM'} · YOUTUBE MUSIC</div><h1>${esc(data.title)}</h1><p class="greeting-sub">${data.items.length} itens nesta página</p>${state.visible.length ? '<button class="gold-button" data-action="play-list">Reproduzir faixas</button>' : ''}<div class="track-list">${data.items.filter((t) => t.kind === 'song').map((t, i) => row(t, i)).join('')}</div><div class="card-grid">${data.items.filter((t) => t.kind !== 'song').map(card).join('')}</div>${data.items.length ? '' : empty('Esta coleção está vazia', 'Tente buscar o nome das faixas diretamente.')}`;
  } catch (e) { if (state.pageToken === token) $('#content').innerHTML = `<div class="error-banner">${esc(e.message)}</div>`; }
}
function route() {
  state.pageToken++; state.visible = demos; state.listId = null;
  const [name, id, kind] = location.hash.slice(1).split('/');
  const page = ['search', 'library', 'playlist', 'collection', 'account'].includes(name) ? name : 'home';
  $$('[data-nav]').forEach((el) => { el.classList.toggle('active', el.dataset.nav === (page === 'playlist' ? 'library' : page)); if (el.classList.contains('active')) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  if (page === 'home') { renderHome(); if (!state.home && !state.homeError) loadHome(); }
  if (page === 'search') renderSearch();
  if (page === 'library') renderLibrary();
  if (page === 'playlist') renderPlaylist(decodeURIComponent(id || ''));
  if (page === 'collection') renderCollection(decodeURIComponent(id || ''), kind);
  if (page === 'account') account.render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderer(mode) {
  if (mode !== 'video') videoPlayer.stop();
  const target = mode === 'video' ? videoElement : audioElement;
  if (target !== audio) {
    const volume = audio.volume;
    audio.pause(); audio.removeAttribute('src'); audio.load();
    audio = target; audio.volume = volume;
  }
  audio.loop = state.repeat;
  videoElement.hidden = mode !== 'video';
  $('#full-art').hidden = mode === 'video';
  $('#player-dialog').classList.toggle('video-mode', mode === 'video');
  $$('.mode-option').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
}
function trackSource(track) {
  return track.source === 'local' ? state.localURLs.get(track.id) : track.source === 'demo' ? track.url : `/api/stream?id=${encodeURIComponent(track.id)}&mode=${state.mode}`;
}
function setMode(mode) {
  if (!['audio', 'video'].includes(mode) || state.mode === mode) return;
  if (mode==='video' && carMode) return videoNotice('O Modo Carro usa apenas áudio.');
  if (mode === 'video' && state.current?.source !== 'youtube') return toast('Selecione uma faixa do YouTube para assistir ao vídeo.');
  videoNotice();
  const position = state.mode === 'video' ? videoSearchPosition ?? videoPlayer.position() : audio.currentTime || state.lastPosition || 0;
  const wasPlaying = !audio.paused || (audio.readyState === 0 && state.wantsPlayback);
  audioRetry.reset(); state.playbackEpoch++; state.wantsPlayback = wasPlaying; state.lastPosition = position;
  videoSearchAbort?.abort(); videoSearchPosition = null;
  state.mode = mode; renderer(mode);
  if (!state.current) return;
  if (mode === 'video') {
    state.pendingSeek = null;
    $('#playback-status').textContent = 'Preparando vídeo com áudio…';
    if (!audioFocus?.deferPlay()) startOfficialVideo(state.current, position, wasPlaying);
  }
  else {
    state.pendingSeek = { id: state.current.id, position };
    audio.src = trackSource(state.current); audio.load();
    if (wasPlaying && !audioFocus?.deferPlay()) { const epoch=state.playbackEpoch; audio.play().catch((e)=>playbackRejected(e,epoch)); }
  }
  updatePlayback();
}
function playTrack(track, queue = state.visible || demos, index) {
  if (!track || track.kind !== 'song') return;
  audioFocus?.cancel();
  videoNotice();
  videoSearchAbort?.abort(); videoSearchPosition = null;
  audioRetry.reset(); state.playbackEpoch++; state.wantsPlayback=true; state.lastPosition=0;
  $('#toast').classList.remove('show');
  if (track.source !== 'youtube') state.mode = 'audio';
  renderer(state.mode); state.pendingSeek = null;
  const source = trackSource(track);
  if (!source) { toast('Este arquivo não está neste navegador. Importe-o novamente.'); return; }
  state.queue = queue.filter((t) => t.kind === 'song');
  state.index = typeof index === 'number' ? index : state.queue.findIndex((t) => t.id === track.id);
  if (state.index < 0) { state.queue = [track]; state.index = 0; }
  state.current = track;
  if (state.mode === 'audio') { audio.src = source; audio.load(); }
  // play() ocorre no mesmo gesto de clique; não aguardamos uma consulta de metadados.
  const playing = audioFocus?.deferPlay() ? undefined : state.mode === 'video' ? startOfficialVideo(track, 0, true) : audio.play();
  updateTrack();
  $('#playback-status').textContent = 'Preparando áudio…';
  const epoch=state.playbackEpoch;
  playing?.catch((e) => playbackRejected(e,epoch));
  state.recent = [track, ...state.recent.filter((t) => t.id !== track.id)].slice(0, 30);
  persist();
}
function updateTrack() {
  const t = state.current; if (!t) return;
  for (const prefix of ['mini', 'full']) { $(`#${prefix}-title`).textContent = t.title; $(`#${prefix}-artist`).textContent = t.artist; $(`#${prefix}-art`).src = art(t.artwork); }
  $$('.favorite').forEach((b) => b.setAttribute('aria-pressed', String(state.likes.some((x) => x.id === t.id))));
  if ('mediaSession' in navigator && 'MediaMetadata' in window) {
    const url = new URL(art(t.artwork), location.origin).href;
    const artwork = t.source === 'youtube' ? [{ src: url }] : [
      { src: new URL('/icons/icon-512.png', location.origin).href, sizes: '512x512', type: 'image/png' }
    ];
    const info={ title:t.title,artist:t.artist,album:t.album || 'F*ckyoutube' };
    navigator.mediaSession.metadata = new MediaMetadata({ ...info, artwork });
    const ticket=++artworkGeneration;
    createArtworkVariants(url).then(variants=>{
      if(ticket===artworkGeneration)navigator.mediaSession.metadata=new MediaMetadata({...info,artwork:variants});
    }).catch(()=>{});
  }
  $$('.track-row').forEach((el) => el.classList.toggle('is-current', el.querySelector('[data-id]')?.dataset.id === t.id));
  updateProgress();
}
function updatePlayback() {
  const playing = (!audio.paused || audioFocus?.interrupted && state.wantsPlayback) && !audio.ended;
  $$('.mini-play, .full-play').forEach((b) => { b.innerHTML = icon(playing ? 'pause' : 'play'); b.setAttribute('aria-label', playing ? 'Pausar' : 'Reproduzir'); });
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state.current ? playing && !audioFocus?.interrupted ? 'playing' : 'paused' : 'none';
}
function updateProgress() {
  if (Number.isFinite(audio.currentTime) && audio.currentTime >= 0) state.lastPosition=audio.currentTime;
  const duration = Number.isFinite(audio.duration) ? audio.duration : state.current?.duration || 0;
  $$('.progress').forEach((s) => { s.max = String(duration || 100); s.value = String(audio.currentTime || 0); s.disabled = !Number.isFinite(audio.duration); s.style.setProperty('--progress', `${duration ? audio.currentTime / duration * 100 : 0}%`); });
  $$('.current-time').forEach((el) => el.textContent = clock(audio.currentTime));
  $$('.duration').forEach((el) => el.textContent = clock(duration));
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && Number.isFinite(audio.duration) && audio.duration > 0) {
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) }); } catch { /* APIs variam entre versões do iOS. */ }
  }
}
function toggle() {
  if (!state.current) return playTrack(demos[0], demos);
  if (!audio.paused || state.wantsPlayback && !audio.error && (audio.readyState < 2 || audioFocus?.interrupted)) pausePlayback();
  else resumePlayback();
}
function resumePlayback() {
  audioRetry.reset();
  state.wantsPlayback=true;
  if (audioFocus?.deferPlay()) {updatePlayback();return;}
  if (state.mode === 'video' && videoSearchPosition !== null) { updatePlayback(); return; }
  if (state.mode === 'video' && !audio.getAttribute('src')) return startOfficialVideo(state.current,state.lastPosition,true);
  if (audio.error && state.mode === 'audio' && state.current?.source === 'youtube') {
    audioRetry.reset(); state.pendingSeek={id:state.current.id,position:state.lastPosition};
    audio.src=trackSource(state.current); audio.load();
  }
  const epoch=state.playbackEpoch;
  return audio.play().then(()=>true).catch((e)=>{playbackRejected(e,epoch);return false;});
}
function next(direction = 1) {
  if (!state.queue.length) return playTrack(demos[0], demos);
  if (direction < 0 && audio.currentTime > 3) { audio.currentTime = 0; return; }
  let index = (state.index + direction + state.queue.length) % state.queue.length;
  if (state.shuffle && direction > 0 && state.queue.length > 1) index = (state.index + 1 + Math.floor(Math.random() * (state.queue.length - 1))) % state.queue.length;
  playTrack(state.queue[index], state.queue, index);
}
function like(track) {
  if (!track) return toast('Escolha uma música primeiro.');
  const liked = state.likes.some((t) => t.id === track.id);
  state.likes = liked ? state.likes.filter((t) => t.id !== track.id) : [...state.likes, track];
  persist(); updateTrack(); toast(liked ? 'Removida das curtidas.' : 'Adicionada às músicas curtidas.');
  if (location.hash === '#playlist/favorites') renderPlaylist('favorites');
}
function sheet(title, content) {
  $('#sheet-title').textContent = title; $('#sheet-content').innerHTML = content;
  if (!$('#sheet').open) $('#sheet').showModal();
}
function trackMenu(track) {
  selectedTrack = track;
  const list = state.lists.find((p) => p.id === state.listId);
  sheet(track.title, `<button class="sheet-button" data-action="like-selected">${icon('heart')}${state.likes.some((x) => x.id === track.id) ? 'Remover das curtidas' : 'Curtir música'}</button><button class="sheet-button" data-action="queue-selected">${icon('queue')}Adicionar à fila</button><button class="sheet-button" data-action="add-selected">${icon('plus')}Adicionar à playlist</button>${list ? '<button class="sheet-button delete-button" data-action="remove-selected">Remover desta playlist</button>' : ''}${track.source === 'local' ? '<button class="sheet-button delete-button" data-action="delete-local">Excluir arquivo deste navegador</button>' : ''}`);
}
function playlistPicker(track) {
  if (!track) return toast('Escolha uma faixa primeiro.');
  selectedTrack = track;
  sheet('Adicionar à playlist', `${state.lists.map((p) => `<button class="sheet-button" data-action="add-to-list" data-id="${esc(p.id)}">${icon('library')}${esc(p.name)}</button>`).join('')}<button class="sheet-button" data-action="create-and-add">${icon('plus')}Criar nova playlist</button>`);
}
function playlistForm(add = false, rename = false) {
  const list = state.lists.find((p) => p.id === state.listId);
  sheet(rename ? 'Renomear playlist' : 'Uma nova coleção', `<form id="playlist-form"><label class="sr-only" for="playlist-name">Nome da playlist</label><input id="playlist-name" name="name" maxlength="60" placeholder="Dê um nome para sua playlist" value="${esc(rename ? list?.name || '' : '')}" required><button class="gold-button" type="submit">Salvar</button></form>`);
  $('#playlist-form').addEventListener('submit', (event) => {
    event.preventDefault(); const name = $('#playlist-name').value.trim(); if (!name) return;
    if (rename && list) list.name = name;
    else state.lists.push({ id: crypto.randomUUID(), name, tracks: add && selectedTrack ? [selectedTrack] : [] });
    persist(); $('#sheet').close(); toast(rename ? 'Playlist renomeada.' : 'Playlist criada.');
    if (location.hash.includes('library') || location.hash.includes('playlist')) route();
  });
  $('#playlist-name').focus();
}
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('reidajbl-library', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('tracks', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
function dbOp(mode, fn) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('Armazenamento local indisponível.'));
    const tx = db.transaction('tracks', mode); const request = fn(tx.objectStore('tracks'));
    tx.oncomplete = () => resolve(request?.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
async function loadLocal() {
  db = await openDB();
  const all = await dbOp('readonly', (store) => store.getAll());
  state.local = all.map(({ blob, ...track }) => { state.localURLs.set(track.id, URL.createObjectURL(blob)); return track; });
  register(state.local);
}
async function importFiles(files) {
  let count = 0;
  for (const file of files) {
    if (file.size > 150 * 1024 * 1024) { toast(`${file.name}: limite de 150 MB por arquivo.`); continue; }
    if (!file.type.startsWith('audio/') && !/\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(file.name)) continue;
    const track = { id: `local-${crypto.randomUUID()}`, title: file.name.replace(/\.[^.]+$/, ''), artist: 'Seu arquivo local', album: 'Neste dispositivo', artwork: '/covers/slow.svg', duration: 0, source: 'local', kind: 'song' };
    try {
      await dbOp('readwrite', (store) => store.put({ ...track, blob: file }));
      state.localURLs.set(track.id, URL.createObjectURL(file)); state.local.push(track); catalog.set(track.id, track); count++;
    } catch { toast('Não foi possível salvar. Verifique o espaço livre e as permissões do navegador.'); break; }
  }
  $('#file-input').value = '';
  if (count) { toast(`${count} música(s) importada(s).`); location.hash = '#library'; if (location.hash === '#library') renderLibrary(); }
}
async function deleteLocal(track) {
  await dbOp('readwrite', (store) => store.delete(track.id));
  if (state.current?.id === track.id) { audio.pause(); audio.removeAttribute('src'); audio.load(); state.current = null; }
  URL.revokeObjectURL(state.localURLs.get(track.id)); state.localURLs.delete(track.id);
  state.local = state.local.filter((t) => t.id !== track.id); state.likes = state.likes.filter((t) => t.id !== track.id);
  state.recent = state.recent.filter((t) => t.id !== track.id);
  state.queue = state.queue.filter((t) => t.id !== track.id); state.index = state.queue.findIndex((t) => t.id === state.current?.id);
  for (const p of state.lists) p.tracks = p.tracks.filter((t) => t.id !== track.id);
  catalog.delete(track.id); persist(); route(); $('#sheet').close(); updatePlayback(); toast('Arquivo excluído deste navegador.');
}
async function install() {
  if (deferredInstall) { await deferredInstall.prompt(); deferredInstall = null; return; }
  sheet('Leve seu som com você', '<p><strong>No iPhone:</strong> abra esta página no Safari, toque em Compartilhar e escolha “Adicionar à Tela de Início”.</p><p>No Android, use “Instalar aplicativo” no menu do navegador. A instalação exige HTTPS.</p><p>Inicie uma faixa tocando em reproduzir. Os controles da tela bloqueada dependem do navegador e da versão do sistema.</p>');
}
const actions = {
  'car-mode': () => setCarMode(!carMode),
  account: () => { location.hash = '#account'; },
  'set-mode': (el) => setMode(el.dataset.mode),
  home: () => { if (location.hash === '#home') renderHome(); else location.hash = '#home'; },
  library: () => { location.hash = '#library'; },
  toggle, next: () => next(), previous: () => next(-1), install,
  expand: () => { if (!$('#player-dialog').open) $('#player-dialog').showModal(); },
  collapse: () => $('#player-dialog').close(),
  'close-sheet': () => $('#sheet').close(),
  'play-demos': () => playTrack(demos[0], demos),
  'play-list': () => state.visible?.length ? playTrack(state.visible[0], state.visible) : toast('Adicione músicas à playlist.'),
  'open-item': (el) => {
    if (el.dataset.id === 'mix-slow') return playTrack(demos[1], [demos[1], demos[0], demos[2]]);
    const t = catalog.get(el.dataset.id); if (!t) return;
    if (t.kind === 'song') playTrack(t, state.visible?.some((x) => x.id === t.id) ? state.visible : [t]);
    else location.hash = `#collection/${encodeURIComponent(t.id)}/${t.kind}`;
  },
  'quick-search': (el) => { state.query = el.dataset.query; state.searchType = 'songs'; if (location.hash === '#search') renderSearch(); else location.hash = '#search'; },
  'search-type': (el) => { state.searchType = el.dataset.type; renderSearch(); },
  'reload-home': loadHome,
  'like-current': () => like(state.current),
  'show-favorites': () => { location.hash = '#playlist/favorites'; },
  'track-menu': (el) => { const t = catalog.get(el.dataset.id); if (t) trackMenu(t); },
  'like-selected': () => { like(selectedTrack); $('#sheet').close(); },
  'queue-selected': () => {
    state.queue.push(selectedTrack); $('#sheet').close(); toast('Adicionada à fila.');
  },
  'add-current': () => playlistPicker(state.current), 'add-selected': () => playlistPicker(selectedTrack),
  'create-playlist': () => playlistForm(), 'create-and-add': () => playlistForm(true),
  'rename-playlist': () => playlistForm(false, true),
  'add-to-list': (el) => {
    const list = state.lists.find((p) => p.id === el.dataset.id);
    if (list && selectedTrack && !list.tracks.some((t) => t.id === selectedTrack.id)) { list.tracks.push(selectedTrack); persist(); }
    $('#sheet').close(); toast('Faixa salva na playlist.');
  },
  'remove-selected': () => {
    const list = state.lists.find((p) => p.id === state.listId);
    if (list) list.tracks = list.tracks.filter((t) => t.id !== selectedTrack.id);
    persist(); $('#sheet').close(); route();
  },
  'delete-playlist': () => sheet('Excluir esta playlist?', '<p>Os arquivos de música continuarão neste dispositivo.</p><button class="gold-button" data-action="confirm-delete">Excluir playlist</button>'),
  'confirm-delete': () => { state.lists = state.lists.filter((p) => p.id !== state.listId); persist(); $('#sheet').close(); location.hash = '#library'; },
  import: () => $('#file-input').click(),
  'delete-local': () => deleteLocal(selectedTrack).catch(() => toast('Não foi possível excluir o arquivo.')),
  shuffle: () => { state.shuffle = !state.shuffle; $$('.shuffle').forEach((b) => b.setAttribute('aria-pressed', String(state.shuffle))); },
  repeat: () => { state.repeat = !state.repeat; audio.loop = state.repeat; $$('.repeat').forEach((b) => b.setAttribute('aria-pressed', String(state.repeat))); },
  queue: () => sheet('A seguir', state.queue.length ? state.queue.map((t, i) => row(t, i, true)).join('') : '<p>A fila está vazia. Escolha uma faixa para começar.</p>'),
  'queue-play': (el) => { const i = Number(el.dataset.index); playTrack(state.queue[i], state.queue, i); },
  export: () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ playlists: state.lists, likes: state.likes }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'fckyoutube-playlists.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('Playlists exportadas. Arquivos de áudio não estão incluídos.');
  }
};
document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-action]');
  if (el && actions[el.dataset.action]) { event.preventDefault(); actions[el.dataset.action](el); }
});
$('#search-form').addEventListener('submit', (event) => { event.preventDefault(); const q = $('#search-input').value.trim(); if (q) search(q); });
$('#file-input').addEventListener('change', (event) => importFiles([...event.target.files]));
window.addEventListener('hashchange', route);
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); deferredInstall = event; });
function connection() { $('#connection').textContent = navigator.onLine ? 'Você está online' : 'Modo offline'; }
window.addEventListener('online', connection); window.addEventListener('offline', connection);
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')) { event.preventDefault(); $('#search-input').focus(); }
});
$$('.progress').forEach((slider) => slider.addEventListener('input', () => { if (Number.isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, Number(slider.value)); updateProgress(); }));
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
$$('.volume').forEach((slider) => {
  if (isIOS) { slider.hidden = true; $('#volume-note').textContent = 'Volume pelos botões do iPhone'; }
  slider.addEventListener('input', () => { audio.volume = Number(slider.value); $$('.volume').forEach((s) => { s.value = slider.value; s.style.setProperty('--progress', `${audio.volume * 100}%`); }); });
  slider.style.setProperty('--progress', '80%');
});
if (!isIOS) audio.volume = 0.8;
audioFocus = createAudioFocus({session:navigator.audioSession,
  getContext:()=>({epoch:state.playbackEpoch,trackId:state.current?.id,mode:state.mode,wantsPlayback:state.wantsPlayback}),
  getMedia:()=>audio,
  pause:()=>{audioRetry.cancel();audio.pause();updatePlayback();},
  resume:()=>resumePlayback(),
  onInterrupted:()=>{$('#playback-status').textContent='Áudio interrompido pelo sistema. Aguardando liberação.';updatePlayback();},
  onResumeBlocked:()=>{$('#playback-status').textContent='Toque em Reproduzir para retomar o áudio.';}
});
for (const player of [audioElement, videoElement]) {
  for (const event of ['play', 'pause', 'ended']) player.addEventListener(event, () => { if (player === audio) updatePlayback(); });
  for (const event of ['timeupdate', 'durationchange', 'seeked']) player.addEventListener(event, () => { if (player === audio) updateProgress(); });
  player.addEventListener('loadedmetadata', () => {
    if (player !== audio) return;
    if (state.pendingSeek?.id === state.current?.id && Number.isFinite(audio.duration)) audio.currentTime = Math.min(state.pendingSeek.position, audio.duration);
    state.pendingSeek = null; updateProgress();
  });
  player.addEventListener('playing', () => { if (player === audio) $('#playback-status').textContent = state.current?.source === 'youtube' ? state.mode === 'video' ? 'YouTube · vídeo e áudio' : 'YouTube · apenas áudio AAC' : 'Áudio local · pronto para ouvir'; });
  player.addEventListener('waiting', () => { if (player === audio) $('#playback-status').textContent = 'Carregando mídia…'; });
  player.addEventListener('error', () => {
    if (player !== audio || !audio.getAttribute('src')) return;
    if (player === audioElement && audioRetry.handleError()) { updatePlayback(); return; }
    $('#playback-status').textContent = state.mode === 'video' ? 'Vídeo MP4 com áudio indisponível para esta faixa. Tente Apenas Áudio.' : 'O serviço recusou o áudio ou a conexão foi interrompida. Selecione a faixa para tentar novamente.';
    toast(state.mode === 'video' ? 'Vídeo indisponível. Tente Apenas Áudio.' : 'Falha no áudio. Tente novamente ou outra faixa.'); updatePlayback();
  });
  player.addEventListener('ended', () => { if (player === audio && !state.repeat && (state.index < state.queue.length - 1 || state.shuffle)) next(); });
}
if ('mediaSession' in navigator) {
  installMediaControls(navigator.mediaSession,{getMedia:()=>audio,
    play:()=>state.current?resumePlayback():playTrack(demos[0],demos),pause:pausePlayback,stop:stopPlayback,
    previous:()=>next(-1),next:()=>next(),onSeek:updateProgress});
}
for (const dialog of $$('dialog')) dialog.addEventListener('click', (event) => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
document.addEventListener('error', (event) => { if (event.target instanceof HTMLImageElement && !event.target.src.endsWith('/covers/nocturne.svg')) event.target.src = '/covers/nocturne.svg'; }, true);
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/service-worker.js').then((registration) => {
    function ready() {
      if (!registration.waiting || $('#update-app')) return;
      const button = document.createElement('button'); button.id = 'update-app'; button.className = 'outline-button'; button.textContent = 'Atualizar app';
      button.addEventListener('click', () => { pausePlayback(); registration.waiting?.postMessage({ type:'SKIP_WAITING' }); });
      $('.topbar-right').prepend(button);
    }
    ready(); registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', ready));
    registration.update().catch(() => {});
  }).catch(() => toast('O cache offline não pôde ser ativado neste navegador.'));
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (document.querySelector('#update-app')) location.reload(); });
}
try { await loadLocal(); } catch { toast('Biblioteca offline indisponível neste modo do navegador.'); }
renderSidebar(); connection(); route(); account.loadProfile();
setCarMode(carMode);

```

## public/audio-retry.js

```
// Uma reconexão por reprodução; a tentativa não se renova a cada evento playing.
export function createAudioRetry({ getContext, reconnect, onRetry, onFinal, delayMs = 700, schedule = setTimeout, unschedule = clearTimeout }) {
  let generation = 0, timer = null, attempts = 0, finished = false;
  const key = (c) => `${c.epoch}:${c.trackId}:${c.mode}`;
  function cancel() { generation++; if (timer !== null) unschedule(timer); timer = null; }
  function reset() { cancel(); attempts = 0; finished = false; }
  function handleError() {
    const context = getContext();
    if (context.source !== 'youtube' || context.mode !== 'audio' || !context.trackId) return false;
    if (!context.wantsPlayback || timer !== null || finished) return true;
    if (attempts >= 1) { finished = true; onFinal(); return true; }
    attempts++; const ticket = generation, expected = key(context);
    onRetry();
    timer = schedule(async () => {
      timer = null;
      const latest = getContext();
      if (ticket !== generation || key(latest) !== expected || !latest.wantsPlayback) return;
      try { await reconnect({ position: context.position, attempt: attempts }); }
      catch {
        if (ticket === generation && key(getContext()) === expected && getContext().wantsPlayback && !finished) {
          finished = true; onFinal();
        }
      }
    }, delayMs);
    return true;
  }
  return { handleError, reset, cancel };
}

```

## public/audio-focus.js

```
export function createAudioFocus({ session, getContext, getMedia, pause, resume, onInterrupted = () => {}, onResumeBlocked = () => {} }) {
  let interrupted = false, pending = null;
  const key = c => `${c.epoch}:${c.trackId}:${c.mode}`;
  function cancel() { pending = null; }
  function deferPlay() {
    // Um novo Play explícito pode pedir foco quando o SO deixou estado inactive.
    if (interrupted && session?.state === 'inactive') {interrupted=false;pending=null;return false;}
    if (!interrupted) return false;
    const c=getContext();pending=c.wantsPlayback && c.trackId ? key(c) : null;return true;
  }
  async function changed() {
    if (session.state === 'interrupted') {
      if (interrupted) return;
      interrupted=true;const c=getContext();
      pending=c.wantsPlayback && c.trackId && !getMedia().ended ? key(c) : null;
      if (pending) { pause(); onInterrupted(); }
      return;
    }
    // inactive não comprova que uma ligação terminou. Não tenta disputar foco.
    if (session.state !== 'active' || !interrupted) return;
    interrupted=false;const expected=pending;pending=null;const c=getContext();
    if (!c.wantsPlayback && !getMedia().paused) {pause();return;}
    if (!expected || expected!==key(c) || !c.wantsPlayback || getMedia().ended || !getMedia().paused) return;
    try { const ok=await resume();if(ok===false)onResumeBlocked(); } catch { onResumeBlocked(); }
  }
  if (session?.addEventListener) {
    try { session.type='playback';session.addEventListener('statechange',changed);changed(); } catch { /* API opcional. */ }
  }
  return { cancel, deferPlay, get interrupted() { return interrupted; }, dispose() { cancel();session?.removeEventListener?.('statechange',changed); } };
}

```

## public/media-controls.js

```
export function installMediaControls(session, { getMedia, play, pause, stop, previous, next, onSeek = () => {} }) {
  const seek = (position, fast = false) => {
    const media = getMedia();
    if (!Number.isFinite(position) || !Number.isFinite(media.duration) || media.duration <= 0) return;
    const time = Math.max(0, Math.min(media.duration, position));
    try { if (fast && typeof media.fastSeek === 'function') media.fastSeek(time); else media.currentTime = time; onSeek(); } catch { /* Metadados ainda indisponíveis. */ }
  };
  const offset = (details) => Number.isFinite(details?.seekOffset) && details.seekOffset > 0 ? details.seekOffset : 10;
  const handlers = { play, pause, stop, previoustrack: previous, nexttrack: next,
    seekbackward: (d) => seek(getMedia().currentTime - offset(d)),
    seekforward: (d) => seek(getMedia().currentTime + offset(d)),
    seekto: (d) => seek(d?.seekTime, d?.fastSeek) };
  for (const [name, handler] of Object.entries(handlers)) {
    try { session?.setActionHandler(name, handler); } catch { /* Suporte varia por ação. */ }
  }
  return { seek };
}

export const ARTWORK_SIZES = [96,128,192,256,512];
export async function createArtworkVariants(src, { origin = location.origin, loadImage = loadArtworkImage, canvas = () => document.createElement('canvas') } = {}) {
  let image;
  try { image = await loadImage(new URL(src,origin).href); }
  catch { image = await loadImage(new URL('/icons/icon-512.png',origin).href); }
  const width=image.naturalWidth, height=image.naturalHeight, edge=Math.min(width,height);
  if (!edge) throw new Error('Capa inválida.');
  return ARTWORK_SIZES.map(size=>{
    const target=canvas();target.width=size;target.height=size;
    const ctx=target.getContext('2d');ctx.drawImage(image,(width-edge)/2,(height-edge)/2,edge,edge,0,0,size,size);
    return {src:target.toDataURL('image/png'),sizes:`${size}x${size}`,type:'image/png'};
  });
}
function loadArtworkImage(src) {
  return new Promise((resolve,reject)=>{
    const image=new Image();image.crossOrigin='anonymous';
    const timer=setTimeout(()=>{image.src='';reject(new Error('Tempo de capa excedido.'));},8000);
    image.onload=()=>{clearTimeout(timer);resolve(image);};image.onerror=()=>{clearTimeout(timer);reject(new Error('Capa indisponível.'));};image.src=src;
  });
}

```

## public/car-mode.css

```
.car-mode-toggle {white-space:nowrap;min-height:44px;font-size:12px;padding:10px 14px}
.car-mode-toggle[aria-pressed="true"] {background:var(--gold);color:#16181E}
.car-mode .full-player {width:min(980px,100%);max-height:100dvh;padding:24px 32px;overflow:auto}
.car-mode .full-art {width:120px;height:120px;max-height:120px;object-fit:cover;margin:0 auto}
.car-mode .full-title {margin:18px 0}
.car-mode .full-title h2 {font-size:clamp(25px,4vw,38px);line-height:1.2}
.car-mode .full-title p,.car-mode .player-times {font-size:20px}
.car-mode .full-transport {gap:clamp(12px,3vw,45px);justify-content:center;margin:20px 0}
.car-mode .full-transport .icon-btn {width:72px;height:72px}
.car-mode .full-transport .icon-btn svg {width:36px;height:36px}
.car-mode .full-transport .play-btn {width:100px;height:100px;flex-shrink:0}
.car-mode .full-transport .play-btn svg {width:48px;height:48px}
.car-mode .full-transport .shuffle,.car-mode .full-transport .repeat {width:54px;height:54px}
.car-mode .progress {height:32px;touch-action:pan-x}
.car-mode .mode-switch,.car-mode .full-video,.car-mode .full-volume {display:none!important}
.car-mode .queue-link {font-size:20px;min-height:56px}
.car-mode .player-status {font-size:14px}
.car-mode .mini-controls .previous {display:inline-grid}
.car-mode .mini-player .play-btn,.car-mode .mini-player .icon-btn {min-width:52px;min-height:52px}
.car-mode .mini-track strong {font-size:18px}
@media(max-width:640px) {
 .topbar-right {gap:5px}.topbar-right .car-mode-toggle {font-size:10px;padding:7px}
 .topbar-right .google-profile>span:last-child {display:none}.topbar-right .google-profile {max-width:44px;padding:5px}
 .car-mode .full-player {padding:16px 18px calc(16px + env(safe-area-inset-bottom))}
 .car-mode .full-transport {gap:8px}.car-mode .full-transport .icon-btn {width:58px;height:58px}
 .car-mode .full-transport .shuffle,.car-mode .full-transport .repeat {width:40px;height:44px;padding:4px}
 .car-mode .full-transport .play-btn {width:82px;height:82px}
 .car-mode .full-title p {font-size:17px}.car-mode .full-title h2 {font-size:26px}
}
@media(max-height:600px) and (min-width:641px) {
 .car-mode .full-player[open] {display:grid;grid-template-columns:140px 1fr;gap:6px 24px;align-items:center;padding:16px 32px}
 .car-mode .player-top {margin:0}
 .car-mode .player-top,.car-mode .full-transport,.car-mode .queue-link,.car-mode .player-status {grid-column:1/-1}
 .car-mode .full-art {grid-row:2/5}.car-mode .full-title {margin:4px 0}
 .car-mode .full-transport {margin:4px 0}.car-mode .queue-link {min-height:44px}
}
@media(max-width:360px){.car-mode .full-transport .shuffle,.car-mode .full-transport .repeat{display:none}}

```

## capacitor.config.json

```
{
  "appId": "com.fckyoutube.app",
  "appName": "F*ckyoutube",
  "webDir": "dist",
  "loggingBehavior": "debug",
  "ios": {
    "contentInset": "automatic",
    "backgroundColor": "#0B0C10"
  }
}

```

## public/account.js

```
export function createAccountUI({ esc, api, toast, card, row, register, onTracks }) {
  let profile = null, configured = false, section = 'playlists', page = null, items = [], playlist = null, generation = 0;
  const root = () => document.querySelector('#content');
  const viewActive = () => location.hash.startsWith('#account');
  const labels = { playlists: 'Minhas playlists', likes: 'Gostei no YouTube', subscriptions: 'Inscrições', history: 'Histórico' };
  function updateHeader() {
    document.querySelector('#profile-name').textContent = profile?.name || 'Entrar com a Conta Google';
    const button = document.querySelector('#profile-button');
    button.querySelector('.google-g')?.remove(); button.querySelector('img')?.remove();
    const avatar = document.createElement(profile?.picture ? 'img' : 'span');
    if (profile?.picture) { avatar.src = profile.picture; avatar.alt = ''; avatar.referrerPolicy = 'no-referrer'; }
    else { avatar.className = 'google-g'; avatar.textContent = 'G'; }
    button.prepend(avatar);
  }
  async function loadProfile() {
    try { const data = await api('/api/account'); profile = data.user; configured = data.configured; updateHeader(); }
    catch { profile = null; updateHeader(); }
  }
  function base() {
    const status = location.hash.split('/')[1];
    if (!profile) {
      const message = ({ 'error-state': 'O login expirou ou a validação de segurança falhou. Tente novamente.', cancelled: 'O login foi cancelado.', 'missing-scope': 'Autorize o acesso de leitura ao YouTube para mostrar sua biblioteca.', error: 'Não foi possível concluir o login. Verifique a configuração do projeto Google.' })[status];
      return `<div class="eyebrow">SUA CONTA, SUA MÚSICA</div><h1>Seu universo musical.</h1><p class="greeting-sub">Conecte sua Conta Google para consultar playlists, curtidas e inscrições.</p>${message ? `<p class="error-banner">${esc(message)}</p>` : ''}<div class="account-card"><span class="account-logo">G</span><h2>Entre com sua Conta Google</h2><p>O acesso solicitado é somente de leitura. Sua senha é digitada exclusivamente na página do Google.</p><button class="gold-button" data-account-action="login">Entrar com a Conta Google</button></div>${!configured ? `<div class="error-banner"><strong>Configure o OAuth para ativar o login.</strong><p>O servidor precisa de GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e PUBLIC_ORIGIN. Em produção, configure também SESSION_SECRET. Veja AUTENTICACAO.md no projeto. Não cole senhas ou tokens aqui.</p></div>` : ''}<p class="top-message">O histórico global e a lista completa de playlists de terceiros salvas não são expostos pela API oficial. O histórico e as playlists locais do F*ckyoutube continuam disponíveis na biblioteca.</p>`;
    }
    return `<div class="account-heading">${profile.picture ? `<img class="account-avatar" src="${esc(profile.picture)}" alt="" referrerpolicy="no-referrer">` : ''}<div><div class="eyebrow">CONECTADO COM GOOGLE</div><h1>Olá, ${esc(profile.name)}.</h1></div><button class="outline-button" data-account-action="logout">Sair</button></div><p class="greeting-sub">Sua biblioteca do YouTube, com acesso somente de leitura.</p><div class="filters account-tabs">${Object.entries(labels).map(([id, label]) => `<button class="chip ${id === section && !playlist ? 'active' : ''}" data-account-action="section" data-section="${id}">${label}</button>`).join('')}</div><div id="account-results"><div class="loading">Carregando sua biblioteca…</div></div>`;
  }
  function paintResults(message = '') {
    const target = document.querySelector('#account-results'); if (!target) return;
    const list = section === 'likes' || playlist;
    target.innerHTML = `${playlist ? `<div class="section-heading"><h2>${esc(playlist.title)}</h2><button data-account-action="section" data-section="playlists">Voltar às playlists</button></div>` : ''}${message ? `<p class="top-message">${esc(message)}</p>` : ''}${items.length ? list ? `<div class="track-list">${items.map((t, i) => row(t, i)).join('')}</div>` : `<div class="card-grid">${items.map((t) => t.kind === 'channel' ? `<article class="music-card"><a class="cover-button" href="https://www.youtube.com/channel/${encodeURIComponent(t.id)}" target="_blank" rel="noopener noreferrer"><img src="${esc(t.artwork)}" alt="" loading="lazy"></a><a class="card-title" href="https://www.youtube.com/channel/${encodeURIComponent(t.id)}" target="_blank" rel="noopener noreferrer">${esc(t.title)}</a><p class="card-subtitle">Abrir canal no YouTube ↗</p></article>` : `<article class="music-card"><button class="cover-button" data-account-action="playlist" data-id="${esc(t.id)}" data-title="${esc(t.title)}"><img src="${esc(t.artwork)}" alt="" loading="lazy"></button><button class="card-title" data-account-action="playlist" data-id="${esc(t.id)}" data-title="${esc(t.title)}">${esc(t.title)}</button><div class="card-subtitle">${esc(t.artist)}</div></article>`).join('')}</div>` : `<div class="empty-state"><h2>${section === 'history' ? 'Histórico do aplicativo' : 'Nenhum item disponível'}</h2><p>${section === 'history' ? 'Consulte suas últimas reproduções no início do F*ckyoutube.' : 'Esta seção ainda não tem itens ou a conta não possui um canal do YouTube.'}</p><a class="outline-button" href="#home">Ir para o início</a></div>`}${page ? '<button class="outline-button account-more" data-account-action="more">Carregar mais</button>' : ''}`;
  }
  async function load(more = false) {
    const token = ++generation;
    const endpoint = playlist ? `/api/account/playlist/${encodeURIComponent(playlist.id)}` : `/api/account/library?section=${section}`;
    const url = endpoint + (endpoint.includes('?') ? '&' : '?') + (more && page ? `pageToken=${encodeURIComponent(page)}` : '');
    try {
      const data = await api(url);
      if (token !== generation || !viewActive()) return;
      items = more ? [...items, ...data.items] : data.items;
      page = data.nextPageToken || null; register(items); onTracks(items.filter((t) => t.kind === 'song'));
      paintResults(data.message);
    } catch (error) {
      if (token !== generation || !viewActive()) return;
      const target = document.querySelector('#account-results');
      if (target) target.innerHTML = `<div class="error-banner">${esc(error.message)}</div>`;
    }
  }
  async function render() {
    root().innerHTML = '<div class="loading">Consultando sua sessão…</div>';
    await loadProfile(); if (!viewActive()) return;
    root().innerHTML = base(); if (profile) load();
  }
  document.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-account-action]'); if (!el) return;
    event.preventDefault(); const action = el.dataset.accountAction;
    if (action === 'login') {
      if (!configured) return toast('Configure as credenciais OAuth no servidor. Consulte AUTENTICACAO.md.');
      location.assign('/auth/google');
    }
    if (action === 'section') { section = el.dataset.section; playlist = null; items = []; page = null; root().innerHTML = base(); load(); }
    if (action === 'more') { el.disabled = true; load(true); }
    if (action === 'playlist') { playlist = { id: el.dataset.id, title: el.dataset.title }; items = []; page = null; root().innerHTML = base(); load(); }
    if (action === 'logout') {
      el.disabled = true;
      try {
        const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Reidajbl-CSRF': '1' } });
        if (!response.ok) throw new Error('Não foi possível sair. Verifique PUBLIC_ORIGIN no servidor.');
        generation++; profile = null; items = []; page = null; playlist = null; updateHeader();
        for (const storage of [localStorage, sessionStorage]) for (const key of ['rj-google-profile', 'rj-auth-session']) storage.removeItem(key);
        onTracks([]); root().innerHTML = base(); toast('Você saiu da Conta Google.');
      } catch (error) { toast(error.message); el.disabled = false; }
    }
  });
  return { render, loadProfile };
}

```

## public/video-player.js

```
export function createVideoPlayer(element, onError) {
  let generation = 0, pendingPosition = 0, metadataHandler;
  function stop() {
    generation++;
    if (metadataHandler) element.removeEventListener('loadedmetadata', metadataHandler);
    metadataHandler = null; pendingPosition = 0;
    element.pause(); element.removeAttribute('src'); element.load();
  }
  async function load(id, start = 0, play = true) {
    stop(); const ticket = generation;
    pendingPosition = Number.isFinite(start) ? Math.max(0,start) : 0;
    metadataHandler = () => {
      if (ticket !== generation) return;
      const position = Number.isFinite(element.duration) ? Math.min(pendingPosition,element.duration) : pendingPosition;
      element.currentTime = position; pendingPosition = 0;
      element.removeEventListener('loadedmetadata',metadataHandler); metadataHandler = null;
    };
    element.addEventListener('loadedmetadata',metadataHandler);
    element.src = `/api/stream?id=${encodeURIComponent(id)}&type=video`;
    element.load();
    // Solicita play no gesto do usuário; o browser aguarda o MP4 e seus metadados.
    if (play) {
      try { await element.play(); }
      catch(error) { if (ticket === generation && error.name !== 'AbortError') onError(error.name === 'NotAllowedError'
        ? 'Toque em Reproduzir para iniciar o vídeo.' : 'Não foi possível reproduzir o vídeo. Tente Apenas Áudio.'); }
    }
  }
  return { load, stop, position: () => pendingPosition || element.currentTime || 0 };
}

```

## public/premium.css

```
body{background:#0B0C10;color:#F3F4F6}::selection{background:#FF2A5450;color:#fff}
.sidebar{background:linear-gradient(180deg,#101116,#0B0C10);border-color:#2A2D37}.brand{font-size:20px;letter-spacing:-.8px}.brand-light{font-weight:450;color:#9CA3AF}.brand small{color:#9CA3AF;letter-spacing:2px}.brandmark{background:linear-gradient(145deg,#FF476C,#CE1740);color:#fff;box-shadow:0 5px 24px #FF2A5420}
.topbar{background:linear-gradient(180deg,#0B0C10,transparent);gap:14px}.topbar-right{gap:12px}#search-form{background:#16181E;border:1px solid #2A2D37;border-radius:14px}#search-form:focus-within{border-color:#FF2A5470;box-shadow:0 0 0 3px #FF2A540A}.desktop-nav a.active{background:#FF2A5410;color:#FF5A79}
.hero{background:#16181E;border-color:#2A2D37;border-radius:24px;box-shadow:0 25px 70px #0003}.hero:after{background:linear-gradient(90deg,#16181E 15%,#16181EEB 38%,#16181E00 88%)}.hero-copy>span,.hero .eyebrow{color:#E5C158}.hero h2{font-weight:650;letter-spacing:-1.8px}.hero-badge{border-color:#E5C15840;color:#E5C158;background:#0B0C1080;backdrop-filter:blur(12px)}
.gold-button,.play-btn{background:linear-gradient(135deg,#FF476C,#FF2A54 55%,#D61B46);color:#fff;border:1px solid #FF6C8830;box-shadow:0 6px 24px #FF2A5420}.gold-button:hover,.play-btn:hover{filter:brightness(1.08);box-shadow:0 8px 28px #FF2A5430}.chip.active,.mode-option.active{background:#FF2A54;color:#fff;border-color:#FF2A54}.outline-button{border-color:#2A2D37;color:#D4D7DF;border-radius:10px}.outline-button:hover{border-color:#FF2A5460;background:#FF2A5408}
.cover-button{border:1px solid #2A2D3780;box-shadow:0 10px 24px #0002}.cover-play{background:#FF2A54;color:#fff;box-shadow:0 4px 18px #0005}.card-tag{color:#E5C158;background:#0B0C10C0;border:1px solid #E5C15830}.track-row.is-current{background:#FF2A540B;border-color:#FF2A5420}.track-row.is-current .track-main strong{color:#FF6784}.track-row:hover{background:#16181E}.music-card .card-subtitle,.track-main small{color:#9CA3AF}
.collection-tile,.import-card,.account-card,.sidebar-note{background:linear-gradient(145deg,#191B23,#16181E);border-color:#2A2D37}.collection-tile .tile-icon,.liked-shortcut span{background:linear-gradient(135deg,#FF2A5420,#E5C15815);color:#E5C158}.sidebar-note>svg{color:#E5C158}.sidebar-note strong{color:#F3F4F6}
.full-player,.sheet{background:radial-gradient(ellipse at 85% 0,#FF2A540C,transparent 55%),#16181EF5;border:1px solid #2A2D37;backdrop-filter:blur(28px) saturate(120%);box-shadow:0 30px 100px #0008}.full-player::backdrop,.sheet::backdrop{background:#03040AD0;backdrop-filter:blur(14px)}.mode-switch{background:#0B0C1080;border-color:#2A2D37}.player-top>span,.player-top small{color:#9CA3AF}.full-title h2{letter-spacing:-.8px}.full-art{box-shadow:0 20px 55px #0004}.full-volume svg,.icon-btn{color:#AAB0BD}.favorite[aria-pressed="true"]{color:#FF2A54}.google-profile{background:#16181E;border-color:#2A2D37;color:#F3F4F6}
.mini-player{background:#101116ED;border-color:#2A2D37;backdrop-filter:blur(24px) saturate(130%)}.mobile-nav{background:#101116ED;border-color:#2A2D37;backdrop-filter:blur(24px)}.mini-track strong{color:#F3F4F6}.mobile-nav a.active{color:#FF5677}.status-dot,.ad-free i{background:#E5C158}.ad-free{color:#9CA3AF}.section-heading button,.text-button{color:#E5C158}.greeting-sub,.section-heading p,.page-footer,.sidebar-playlist{color:#9CA3AF}
input[type="range"]{accent-color:#FF2A54}.progress{background:linear-gradient(to right,#FF2A54 0%,#FF2A54 var(--progress,0%),#2A2D37 var(--progress,0%),#2A2D37 100%)}input[type="range"]::-webkit-slider-thumb{background:#FF2A54}input[type="range"]::-moz-range-thumb{background:#FF2A54}.car-mode-toggle[aria-pressed="true"]{background:linear-gradient(135deg,#E5C158,#BFA04D);color:#0B0C10}.car-mode .full-player{background:#16181E}.genre{border:1px solid #FFFFFF08}.error-banner{background:#FF2A540B;border-color:#FF2A5430;color:#F3B8C5}#toast{background:#16181EF5;border-color:#2A2D37;backdrop-filter:blur(18px);color:#F3F4F6}
@media(max-width:640px){.brand{font-size:18px}.hero{border-radius:20px}.hero:after{background:linear-gradient(90deg,#16181E 2%,#16181EF2 23%,#16181E22 95%)}.topbar-right{gap:6px}.mini-controls .play-btn{background:transparent;box-shadow:none;border:0;color:#FF5677}.full-player{border-radius:0}.car-mode .full-player{border:0}}

```

## scripts/brand-icons.js

```
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

```

## scripts/rebrand.js

```
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

```

## public/styles.css

```
@import url('/tokens.css');
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.5}button,input,a{-webkit-tap-highlight-color:transparent}button,input{font:inherit}button,a{touch-action:manipulation}button{cursor:pointer;color:inherit}button{border:0;background:none}a{color:inherit;text-decoration:none}svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.65;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}.fill{fill:currentColor;stroke:none}.sprite{position:absolute;width:0;height:0;overflow:hidden}button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid var(--gold);outline-offset:5px}button:hover{filter:brightness(1.15)}.sidebar{width:245px;position:fixed;inset:0 auto 93px 0;background:#0B0C10;border-right:1px solid var(--line);padding:33px 24px;display:flex;flex-direction:column}.brand{display:flex;align-items:center;gap:11px;font-size:18px;font-weight:750;letter-spacing:-.6px}.brandmark{display:grid;place-items:center;background:var(--gold);width:38px;height:38px;border-radius:11px;color:#16181E}.brandmark svg{width:24px;height:24px}.brand-light{font-weight:400}.brand small{display:block;color:#9CA3AF;font-size:8px;letter-spacing:2.5px;font-weight:600;margin-top:4px}.nav-label{font-size:10px;letter-spacing:1.8px;color:#9CA3AF;font-weight:600;margin:43px 11px 12px}.desktop-nav{display:grid;gap:7px}.desktop-nav a{height:47px;display:flex;align-items:center;gap:15px;padding:0 14px;border-radius:9px;color:#9CA3AF;font-weight:500}.desktop-nav a.active{color:var(--gold);background:#B8964312}.desktop-nav a.active:before{content:"";position:absolute;left:0;height:24px;width:3px;border-radius:0 3px 3px 0;background:var(--gold)}.row{display:flex;justify-content:space-between;align-items:center}.icon-btn{display:inline-grid;place-items:center;width:40px;height:40px;padding:8px;background:none;border-radius:50%;color:#9CA3AF;flex-shrink:0}.icon-btn:hover{background:#F3F4F60b;color:white}.small{width:24px;height:24px;padding:3px}.small svg{width:17px;height:17px}.liked-shortcut{display:flex;gap:12px;text-align:left;align-items:center;padding:12px 10px;color:#9CA3AF;font-size:13px}.liked-shortcut span{width:27px;height:27px;display:grid;place-items:center;border-radius:5px;background:linear-gradient(140deg,#B89643,#B89643);color:#0B0C10}.sidebar-playlist{display:block;padding:10px;color:#9CA3AF;text-align:left;width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sidebar-note{margin-top:auto;border:1px solid #B8964326;border-radius:12px;background:radial-gradient(ellipse at top right,#B8964313,transparent 80%);padding:19px 15px 13px}.sidebar-note>svg{color:var(--gold);margin-bottom:13px}.sidebar-note strong{display:block;font-size:13px;font-weight:550}.sidebar-note p{font-size:11px;color:#9CA3AF;line-height:1.8}.text-button{font-size:11px;color:var(--gold);padding:0}.text-button span{margin-left:12px}.sidebar-bottom{display:flex;align-items:center;gap:8px;color:#9CA3AF;font-size:10px;padding:22px 5px 0}.status-dot,.ad-free i{width:5px;height:5px;background:#9CA3AF;border-radius:50%;display:inline-block}.workspace{margin-left:245px;padding-bottom:110px}.topbar{height:97px;padding:0 44px;display:flex;align-items:center;justify-content:space-between;gap:20px}#search-form{display:flex;align-items:center;gap:12px;border:1px solid #F3F4F60a;background:#16181E;border-radius:10px;padding:11px 14px;width:min(440px,70%);color:#9CA3AF}#search-form svg{width:19px;height:19px}#search-input{background:transparent;border:0;outline:0;color:#F3F4F6;width:100%;font-size:12px}#search-input::placeholder{color:#9CA3AF}kbd{font:11px inherit;padding:0 6px;border:1px solid #9CA3AF46;border-radius:4px}.topbar-right{display:flex;gap:25px;align-items:center}.ad-free{font-size:9px;letter-spacing:1.8px;color:#9CA3AF;white-space:nowrap}.ad-free i{margin-right:7px}.avatar{width:33px;height:33px;border-radius:50%;border:1px solid #B8964366;background:#29231C30;color:#E5C158;font-size:12px}.mobile-brand{display:none}main{padding:17px 44px 0;max-width:1600px;margin:auto}h1,h2,h3,p{margin-top:0}.eyebrow{font-size:10px;letter-spacing:2.3px;color:var(--gold);font-weight:650}h1{font-size:31px;letter-spacing:-1.1px;font-weight:650;margin:7px 0 7px}.greeting-sub{color:#9CA3AF;font-size:12px;margin-bottom:27px}.filters{display:flex;gap:8px;margin-bottom:28px;overflow-x:auto;scrollbar-width:none}.chip{white-space:nowrap;padding:8px 18px;border:1px solid var(--line);border-radius:8px;color:#9CA3AF;font-size:11px}.chip.active{color:#16181E;background:var(--gold);border-color:var(--gold);font-weight:600}.hero{min-height:312px;background:#16181E;border:1px solid #B8964318;border-radius:18px;display:flex;position:relative;overflow:hidden;padding:35px 37px;isolation:isolate}.hero:after{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(90deg,#16181E 15%,#16181Eed 38%,#16181E00 78%)}.hero-visual{position:absolute;right:0;top:0;height:100%;width:58%;object-fit:cover;z-index:-2}.hero-copy{max-width:56%}.hero .eyebrow{font-size:9px;letter-spacing:2px;display:flex;align-items:center;gap:7px}.hero .eyebrow svg{width:14px;height:14px}.hero h2{font-weight:500;font-size:44px;letter-spacing:-1.9px;line-height:1.12;margin:20px 0 13px}.hero h2 em{font-family:Georgia,serif;color:var(--gold);font-weight:400}.hero p{font-size:11px;color:#9CA3AF;max-width:280px;line-height:1.8}.gold-button{display:inline-flex;align-items:center;justify-content:center;gap:9px;background:var(--gold);border-radius:8px;color:#16181E;font-size:11px;padding:12px 20px;font-weight:650}.gold-button svg{width:16px;height:16px}.hero-badge{position:absolute;bottom:24px;right:25px;font-size:8px;color:#E5C158;letter-spacing:2px;border:1px solid #E5C1582b;padding:6px 10px;border-radius:20px}.section-heading{display:flex;justify-content:space-between;align-items:end;margin:31px 0 17px;gap:15px}.section-heading h2{font-size:18px;font-weight:600;letter-spacing:-.45px;margin:0}.section-heading p{font-size:11px;color:#9CA3AF;margin:4px 0 0}.section-heading button{font-size:10px;letter-spacing:.2px;color:#9CA3AF;white-space:nowrap;display:flex;align-items:center;gap:8px}.section-heading svg{width:14px;height:14px}.card-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px}.music-card{min-width:0}.cover-button{padding:0;display:block;position:relative;width:100%;border-radius:12px;overflow:hidden;aspect-ratio:1;background:#16181E;text-align:left}.cover-button img{width:100%;height:100%;display:block;object-fit:cover;transition:transform .4s}.cover-button:hover img{transform:scale(1.045)}.cover-play{position:absolute;bottom:12px;right:12px;width:38px;height:38px;background:var(--gold);color:#16181E;border-radius:50%;display:grid;place-items:center;box-shadow:0 5px 20px #0005}.cover-play svg{width:19px;height:19px}.card-title{display:block;margin:12px 0 3px;font-size:13px;font-weight:550;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.card-subtitle{font-size:10px;color:#9CA3AF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.card-tag{position:absolute;top:12px;left:12px;font-size:8px;letter-spacing:1.7px;font-weight:700;color:#E5C158;background:#16181E80;padding:4px 8px;border:1px solid #fff2;border-radius:4px}.lower-grid{display:grid;grid-template-columns:1.45fr 1fr;gap:32px}.track-list{display:grid;gap:4px}.track-row{display:flex;align-items:center;gap:13px;border-radius:8px;min-width:0;padding:8px 7px}.track-row:hover{background:#F3F4F605}.track-row.is-current{background:#B8964310}.track-number{font-size:10px;color:#9CA3AF;min-width:15px;text-align:center;font-variant-numeric:tabular-nums}.track-art{width:42px;height:42px;object-fit:cover;border-radius:6px}.track-main{min-width:0;flex:1;text-align:left;padding:0}.track-main strong{display:block;font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.track-main small{display:block;font-size:10px;color:#9CA3AF;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.track-row time{font-size:10px;color:#9CA3AF;font-variant-numeric:tabular-nums}.track-row .icon-btn{width:28px;height:28px;padding:5px}.track-row .icon-btn svg{width:17px}.collection-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.collection-tile{display:flex;align-items:center;gap:12px;background:#16181E;border:1px solid var(--line);padding:13px;border-radius:10px;text-align:left;min-height:81px}.collection-tile .tile-icon{width:44px;height:44px;border-radius:8px;background:#B896431f;color:var(--gold);display:grid;place-items:center;flex-shrink:0}.collection-tile strong{font-size:11px;display:block;font-weight:550}.collection-tile small{font-size:9px;display:block;color:#9CA3AF;margin-top:5px}.import-card{margin-top:12px;border:1px dashed #9CA3AF4d;border-radius:10px;padding:17px;display:flex;align-items:center;gap:14px}.import-card>svg{color:var(--gold);width:25px}.import-card strong{font-size:11px}.import-card p{font-size:10px;color:#9CA3AF;margin:3px 0 0}.import-card button{margin-left:auto;color:var(--gold)}.page-footer{padding:40px 44px 20px;display:flex;align-items:center;justify-content:space-between;color:#9CA3AF;font-size:9px;max-width:1600px;margin:auto}.page-footer span{display:flex;align-items:center;gap:7px}.page-footer svg{width:13px;height:13px}.page-footer button{font-size:9px;color:#9CA3AF}.mini-player{position:fixed;bottom:0;left:0;right:0;height:93px;border-top:1px solid #9CA3AF24;background:#0B0C10f5;backdrop-filter:blur(20px);display:flex;align-items:center;padding:12px 25px;gap:14px;z-index:10}.mini-track{display:flex;align-items:center;gap:12px;min-width:0;width:225px;text-align:left;padding:0}.mini-track img{width:51px;height:51px;border-radius:8px}.mini-track>span{min-width:0}.mini-track strong{display:block;font-size:11px;font-weight:550;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.mini-track small{font-size:9px;color:#9CA3AF;display:block;margin-top:4px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.mini-player>.favorite{margin-right:20px}.mini-controls{width:42%;max-width:590px;margin:auto}.transport{display:flex;justify-content:center;gap:15px;align-items:center}.transport .icon-btn{width:28px;height:28px;padding:5px}.transport svg{width:17px;height:17px}.play-btn{background:var(--gold);color:#16181E;display:inline-grid;place-items:center;border-radius:50%;width:34px;height:34px}.play-btn svg{width:18px;height:18px}.timeline{display:flex;align-items:center;gap:11px;margin-top:7px}.timeline time{font-size:9px;min-width:25px;color:#9CA3AF;font-variant-numeric:tabular-nums}.timeline time:last-child{text-align:right}input[type=range]{-webkit-appearance:none;appearance:none;accent-color:var(--gold);background:linear-gradient(to right,var(--gold) var(--progress,0%),#2A2D3738 var(--progress,0%));border-radius:5px;height:3px;cursor:pointer;min-width:0}input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:9px;height:9px;background:var(--gold);border-radius:50%}input[type=range]::-moz-range-thumb{width:9px;height:9px;background:var(--gold);border:0;border-radius:50%}.progress{flex:1;width:100%}.mini-extras{display:flex;align-items:center;gap:10px;margin-left:auto}.mini-extras>svg{width:16px;height:16px;color:#9CA3AF}.mini-extras .volume{width:75px}.mini-extras>.icon-btn:last-child{transform:rotate(180deg)}.mini-extras .icon-btn svg{width:18px}.mobile-nav,.mobile-expand{display:none}.icon-btn[aria-pressed=true]{color:var(--gold)}.favorite[aria-pressed=true] svg{fill:var(--gold)}dialog{color:var(--text);background:#16181E;border:1px solid #9CA3AF26;border-radius:20px;box-shadow:0 25px 100px #0008}dialog::backdrop{background:#0B0C10bc;backdrop-filter:blur(12px)}.full-player{width:min(510px,100% - 32px);max-height:95dvh;padding:24px 38px 20px;background:radial-gradient(ellipse at top,#2A2D37,#16181E 75%);overflow-y:auto}.player-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:25px}.player-top>span{font-size:8px;letter-spacing:2px;text-align:center;color:#9CA3AF}.player-top small{display:block;font-size:10px;letter-spacing:0;margin-top:3px;color:#F3F4F6}.full-art{width:100%;aspect-ratio:1;object-fit:cover;border-radius:16px;box-shadow:0 17px 40px #0004}.full-title{display:flex;align-items:center;justify-content:space-between;margin:28px 0}.full-title>div{min-width:0}.full-title h2{font-size:22px;font-weight:600;letter-spacing:-.7px;margin:0;overflow:hidden;text-overflow:ellipsis}.full-title p{font-size:13px;color:#9CA3AF;margin:4px 0 0}.player-times{display:flex;justify-content:space-between;font-size:10px;color:#9CA3AF;margin-top:8px}.full-transport{display:flex;align-items:center;justify-content:space-between;margin:24px 0}.full-transport .play-btn{width:66px;height:66px}.full-transport .play-btn svg{width:28px;height:28px}.full-volume{display:flex;gap:10px;align-items:center;color:#9CA3AF}.full-volume>svg{width:17px}.full-volume input{flex:1}.full-volume small{font-size:10px}.queue-link{display:flex;align-items:center;gap:9px;padding:17px 0 0;width:100%;font-size:11px;color:#9CA3AF}.queue-link svg{width:17px}.queue-link span{margin-left:auto}.player-status{color:#9CA3AF;font-size:11px;margin:12px 0 0}.sheet{width:min(540px,calc(100% - 28px));max-height:85dvh;padding:22px}.sheet-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:17px}.sheet-heading h2{font-size:19px;margin:0}.sheet p{color:#9CA3AF;font-size:13px}.sheet form{display:flex;gap:10px}.sheet input{background:#0B0C10;color:white;padding:11px;border:1px solid #9CA3AF55;border-radius:8px;min-width:0;flex:1}.sheet-button{display:flex;align-items:center;gap:15px;padding:13px;width:100%;text-align:left;border-radius:8px}.sheet-button:hover{background:#F3F4F608}.sheet-button svg{color:var(--gold)}#toast{position:fixed;left:50%;bottom:110px;transform:translateX(-50%);z-index:100;background:#E5C158;color:#16181E;padding:12px 20px;border-radius:10px;font-size:12px;box-shadow:0 8px 40px #0005;max-width:calc(100% - 28px);width:max-content;opacity:0;pointer-events:none;transition:opacity .2s}#toast.show{opacity:1}.empty-state{text-align:center;padding:45px 20px;border:1px dashed #9CA3AF4a;border-radius:14px;color:#9CA3AF;margin-top:20px}.empty-state>svg{width:35px;height:35px;color:var(--gold);margin-bottom:15px}.empty-state h2{color:#9CA3AF;font-size:18px}.empty-state p{max-width:400px;margin:0 auto 18px;font-size:12px}.error-banner{border:1px solid #B8964344;background:#B896430a;border-radius:10px;padding:15px;color:#E5C158;font-size:12px;margin:16px 0}.result-tabs{display:flex;gap:8px;margin:23px 0}.section-label{font-size:10px;color:#9CA3AF;letter-spacing:2px}.library-actions{display:flex;gap:10px;flex-wrap:wrap;margin:25px 0}.outline-button{display:inline-flex;align-items:center;gap:8px;padding:10px 15px;border:1px solid #9CA3AF44;border-radius:8px;font-size:11px;color:#9CA3AF}.outline-button svg{width:16px;height:16px}.search-genres{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px}.genre{min-height:115px;position:relative;overflow:hidden;padding:22px;border:1px solid #F3F4F60e;border-radius:12px;background:linear-gradient(130deg,var(--color),#16181E);text-align:left}.genre strong{position:relative;z-index:1;font-size:19px;font-weight:550;letter-spacing:-.6px}.genre:after{content:'♫';position:absolute;font-size:100px;right:0;bottom:-35px;transform:rotate(20deg);opacity:.15}.loading{color:#9CA3AF;padding:30px 0;font-size:12px}.loading:before{content:"";display:inline-block;width:12px;height:12px;border-radius:50%;border:2px solid #B8964330;border-top-color:var(--gold);animation:spin 1s linear infinite;margin-right:10px;vertical-align:middle}@keyframes spin{to{transform:rotate(360deg)}}.top-message{color:#9CA3AF;font-size:11px;margin:16px 0}.collection-header{display:flex;gap:24px;align-items:center;margin:20px 0}.collection-header img{width:140px;height:140px;border-radius:15px}.collection-header h1{margin:6px 0}.collection-header p{font-size:12px;color:#9CA3AF}.api-notice{font-size:10px;color:#9CA3AF}.mobile-nav a.active{color:var(--gold)}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.delete-button{color:#9CA3AF!important}.playlist-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:20px 0}
@media(min-width:1500px){main{padding-top:30px}.hero{min-height:360px}.hero h2{font-size:54px}.card-grid{gap:26px}}
@media(max-width:1150px){.sidebar{width:205px;padding:27px 17px}.brand{font-size:16px;gap:8px}.brand small{font-size:7px;letter-spacing:2px}.brandmark{width:32px;height:32px}.workspace{margin-left:205px}.topbar{padding:0 28px}main{padding:12px 28px 0}.card-grid{gap:14px}.hero{padding:28px;min-height:290px}.hero h2{font-size:37px}.mini-track{width:190px}.mini-player>.favorite{margin-right:0}.mini-extras .volume{width:45px}.lower-grid{gap:20px}.page-footer{padding-inline:28px}.collection-grid{gap:8px}.collection-tile{padding:10px;gap:8px}.collection-tile .tile-icon{width:32px;height:32px}}
@media(max-width:850px){.sidebar{width:180px;padding-inline:12px}.brand{font-size:14px}.brand small{font-size:6px}.brandmark{width:29px;height:29px}.desktop-nav a{font-size:12px;gap:10px}.workspace{margin-left:180px}.topbar{padding-inline:22px}.ad-free{display:none}main{padding-inline:22px}.hero{min-height:270px;padding:25px}.hero h2{font-size:32px}.hero p{font-size:10px}.hero-copy{max-width:65%}.lower-grid{grid-template-columns:1fr}.mini-extras .volume,.mini-extras>svg{display:none}.mini-track{width:180px}.mini-controls{width:46%}.mini-extras{gap:0}.mini-player{gap:8px;padding-inline:18px}.card-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.music-card:nth-child(4){display:none}.music-card:only-child{display:block}.search-genres{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:640px){.sidebar{display:none}.workspace{margin-left:0;padding-bottom:173px}.topbar{height:auto;padding:calc(17px + env(safe-area-inset-top)) 21px 13px;flex-wrap:wrap;gap:18px}.mobile-brand{display:flex;align-items:center;gap:8px;font-size:17px;font-weight:650;letter-spacing:-.5px}.mobile-brand svg{color:var(--gold);width:22px}.topbar-right{margin-left:auto}.topbar .avatar{width:29px;height:29px}#search-form{order:3;width:100%;padding:12px 13px;border-radius:10px}#search-input{font-size:13px}kbd{display:none}main{padding:14px 21px 0}h1{font-size:28px;letter-spacing:-.9px}.eyebrow{font-size:9px}.greeting-sub{font-size:11px;margin-bottom:23px}.filters{margin-bottom:22px;gap:7px}.chip{padding:8px 16px;font-size:11px;border-radius:8px}.hero{padding:26px 22px;min-height:290px;border-radius:15px}.hero-copy{max-width:77%}.hero h2{font-size:37px;margin-top:22px}.hero p{max-width:200px;font-size:10px}.hero-visual{width:78%;right:-28%;object-fit:cover}.hero:after{background:linear-gradient(90deg,#16181E 2%,#16181Ef2 23%,#16181E44 90%)}.hero-badge{font-size:6px;bottom:15px;right:13px;letter-spacing:1.3px;padding:4px 6px}.gold-button{font-size:11px;padding:11px 17px}.section-heading{margin:28px 0 16px}.section-heading h2{font-size:18px}.section-heading p{font-size:10px}.section-heading button{font-size:9px}.card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 14px}.music-card:nth-child(4){display:block}.card-title{font-size:12px;margin-top:10px}.card-subtitle{font-size:10px}.cover-button{border-radius:11px}.cover-play{width:33px;height:33px;right:10px;bottom:10px}.cover-play svg{width:17px}.card-tag{font-size:7px;left:9px;top:9px;padding:3px 6px}.lower-grid{gap:0}.track-row{gap:11px;padding:9px 0}.track-art{width:43px;height:43px}.track-main strong{font-size:12px}.collection-grid{gap:10px}.collection-tile{padding:13px;gap:11px}.collection-tile .tile-icon{width:38px;height:38px}.page-footer{padding:30px 21px 15px;display:block}.page-footer button{margin:12px 0 0;padding:0}.mini-player{bottom:calc(63px + env(safe-area-inset-bottom));height:66px;left:9px;right:9px;border:1px solid #9CA3AF2d;border-radius:11px;padding:9px 10px;gap:4px;background:#16181Ef5}.mini-track{flex:1;min-width:0;width:auto;gap:10px}.mini-track img{width:43px;height:43px;border-radius:7px}.mini-track strong{font-size:11px;max-width:185px}.mini-track small{font-size:9px;max-width:185px;margin-top:3px}.mini-player>.favorite{width:33px;height:33px;padding:8px}.mini-player>.favorite svg{width:19px}.mini-controls{width:auto;margin:0}.mini-controls .transport{gap:1px}.mini-controls .subtle,.mini-controls .previous,.mini-controls .timeline{display:none}.mini-controls .play-btn{background:transparent;color:#F3F4F6;width:37px;height:37px}.mini-controls .play-btn svg{width:25px;height:25px}.mini-controls .transport>.icon-btn{width:29px;height:29px}.mini-extras{display:none}.mobile-nav{display:flex;position:fixed;bottom:0;left:0;right:0;height:calc(62px + env(safe-area-inset-bottom));padding-bottom:env(safe-area-inset-bottom);background:#0B0C10f7;border-top:1px solid #2A2D3730;backdrop-filter:blur(15px);z-index:10;justify-content:space-around}.mobile-nav a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;width:33%;font-size:9px;color:#9CA3AF}.mobile-nav svg{width:21px;height:21px}.full-player{width:100%;height:100dvh;max-height:100dvh;border:0;border-radius:0;padding:calc(20px + env(safe-area-inset-top)) 29px calc(20px + env(safe-area-inset-bottom));margin:0;max-width:none}.player-top{margin-bottom:24px}.full-art{max-height:43dvh;max-width:43dvh;display:block;margin:0 auto;border-radius:13px}.full-title{margin:25px 0}.full-title h2{font-size:23px}.full-transport{margin:22px 0}.full-transport .play-btn{width:67px;height:67px}.full-volume{margin-top:5px}.player-status{font-size:10px}.sheet{border-radius:19px 19px 0 0;position:fixed;bottom:0;top:auto;margin:0;width:100%;max-width:none;padding-bottom:calc(23px + env(safe-area-inset-bottom))}#toast{bottom:calc(145px + env(safe-area-inset-bottom));font-size:11px}.search-genres{gap:11px}.genre{min-height:100px;padding:18px}.genre strong{font-size:18px}.collection-header{gap:16px}.collection-header img{width:100px;height:100px}.collection-header h1{font-size:25px}.library-actions{gap:8px}.outline-button{font-size:10px;padding:10px}.error-banner{font-size:11px}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
.google-profile{display:flex;align-items:center;gap:9px;max-width:235px;padding:7px 11px;border:1px solid #E5C15835;border-radius:24px;background:#E5C15809;font-size:11px;color:#F3F4F6;text-align:left}.google-profile img,.google-g{width:26px;height:26px;border-radius:50%;object-fit:cover;display:grid;place-items:center;flex-shrink:0}.google-g{background:#F3F4F6;color:#9CA3AF;font-weight:800;font-size:16px}.google-profile>span:last-child{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.mode-switch{display:flex;gap:4px;padding:4px;background:#0B0C1080;border:1px solid #E5C1581c;border-radius:12px;width:max-content;margin:0 auto 22px}.mode-option{font-size:11px;padding:8px 19px;border-radius:8px;color:#9CA3AF}.mode-option.active{background:var(--gold);color:#16181E;font-weight:650}.full-video{width:100%;aspect-ratio:16/9;object-fit:contain;background:#0B0C10;border-radius:13px;max-height:43dvh}.full-video[hidden],.full-art[hidden]{display:none!important}.full-player.video-mode{width:min(760px,calc(100% - 32px))}.account-card{max-width:520px;border:1px solid #9CA3AF40;border-radius:18px;padding:35px;background:radial-gradient(at top right,#29231C30,transparent 75%);margin:25px 0}.account-card h2{font-size:23px;letter-spacing:-.7px;margin-top:15px}.account-card p{font-size:13px;color:#9CA3AF;line-height:1.8;margin-bottom:22px}.account-logo{display:grid;place-items:center;width:43px;height:43px;border-radius:13px;background:#F3F4F6;color:#9CA3AF;font-size:26px;font-weight:800}.account-heading{display:flex;align-items:center;gap:18px;margin:10px 0 20px}.account-heading>div{min-width:0}.account-heading h1{font-size:28px;overflow-wrap:anywhere}.account-heading>.outline-button{margin-left:auto;flex-shrink:0}.account-avatar{width:62px;height:62px;border-radius:50%;object-fit:cover}.account-more{margin-top:25px}.account-tabs{flex-wrap:wrap}.account-card+.error-banner p{font-size:12px;margin:8px 0 0;overflow-wrap:anywhere}
@media(max-width:640px){.google-profile{font-size:10px;max-width:154px;padding:4px 8px;gap:6px}.google-g,.google-profile img{width:23px;height:23px;font-size:13px}.topbar-right{max-width:46%}.full-player.video-mode{width:100%}.full-player .player-top{margin-bottom:15px}.mode-switch{margin-bottom:19px}.full-player .full-title{margin:20px 0}.full-player .full-transport{margin:18px 0}.account-heading{gap:10px}.account-heading h1{font-size:23px}.account-avatar{width:45px;height:45px}.account-card{padding:25px}.account-tabs{gap:6px}.account-tabs .chip{padding:8px 12px}}

```

## public/tokens.css

```
:root{color-scheme:dark;--bg:#0B0C10;--surface:#16181E;--text:#F3F4F6;--muted:#9CA3AF;--accent:#FF2A54;--champagne:#E5C158;--gold:var(--accent);--line:#2A2D37}

```

## public/manifest.json

```
{
  "id": "/",
  "name": "F*ckyoutube",
  "short_name": "F*ckyoutube",
  "description": "Sua trilha, seu ritmo. Player de música sem anúncios na interface.",
  "lang": "pt-BR",
  "start_url": "/?source=pwa",
  "scope": "/",
  "display": "standalone",
  "background_color": "#0B0C10",
  "theme_color": "#0B0C10",
  "orientation": "portrait-primary",
  "categories": [
    "music",
    "entertainment"
  ],
  "icons": [
    {
      "src": "/icons/icon-192.png?v=2",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/icon-512.png?v=2",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    },
    {
      "src": "/icons/maskable-512.png?v=2",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ],
  "shortcuts": [
    {
      "name": "Buscar música",
      "url": "/#search"
    },
    {
      "name": "Sua biblioteca",
      "url": "/#library"
    }
  ]
}

```

## public/service-worker.js

```
const CACHE = 'fckyoutube-shell-v2';
const SHELL = ['/', '/index.html', '/styles.css', '/tokens.css', '/app.js', '/account.js', '/video-player.js', '/vendor/shaka-player.compiled.js', '/manifest.json',
  '/app-v7.js', '/video-player-v3.js', '/audio-retry.js', '/audio-focus.js', '/media-controls.js', '/car-mode.css', '/styles-v3.css', '/premium.css',
  '/icons/crown.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png',
  '/covers/hero.svg', '/covers/nocturne.svg', '/covers/golden.svg', '/covers/orbit.svg', '/covers/slow.svg',
  '/audio/nocturne.wav', '/audio/golden.wav', '/audio/orbit.wav'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  // A atualização aguarda o fechamento das abas para não interromper áudio em execução.
});
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const key of await caches.keys()) if ((key.startsWith('reidajbl-shell-') || key.startsWith('fckyoutube-shell-')) && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('message', (event) => { if (event.data?.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;
  // Gera 206 a partir do arquivo completo em cache, permitindo seek e áudio offline.
  if (request.headers.has('range') && url.pathname.startsWith('/audio/') && SHELL.includes(url.pathname)) {
    event.respondWith((async () => {
      const hit = await caches.match(url.pathname);
      if (!hit) return fetch(request);
      const bytes = await hit.arrayBuffer();
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range'));
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.byteLength}` } });
      let start = match[1] ? Number(match[1]) : Math.max(0, bytes.byteLength - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(Number(match[2]), bytes.byteLength - 1) : bytes.byteLength - 1;
      if (start > end || start >= bytes.byteLength) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.byteLength}` } });
      return new Response(bytes.slice(start, end + 1), { status: 206, headers: {
        'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`
      } });
    })());
    return;
  }
  if (request.headers.has('range')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')));
  } else if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request)));
  }
});

```

## api/index.js

```
// Adaptador opcional para Vercel Functions.
export { default } from '../server.js';

```

## functions/api/[[path]].js

```
// Cloudflare Pages: mantém /api no mesmo domínio e transmite a resposta do backend Node.
export async function onRequest({ request, env }) {
  const incoming = new URL(request.url);
  if (!['GET', 'HEAD'].includes(request.method) && !(request.method === 'POST' && incoming.pathname === '/api/auth/logout')) return new Response('Método não permitido', { status: 405 });
  if (!env.BACKEND_ORIGIN) return Response.json({ error: 'Configure BACKEND_ORIGIN no Cloudflare Pages.' }, { status: 503 });
  const base = new URL(env.BACKEND_ORIGIN);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/') return Response.json({ error: 'Origem de backend inválida.' }, { status: 503 });
  const target = new URL(incoming.pathname + incoming.search, base.origin);
  const headers = new Headers();
  if (request.headers.has('range')) headers.set('Range', request.headers.get('range'));
  for (const name of ['cookie', 'origin', 'x-reidajbl-csrf']) if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  const upstream = await fetch(target, { method: request.method, headers, redirect: 'manual' });
  return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
}

```

## functions/auth/[[path]].js

```
export { onRequest } from '../api/[[path]].js';

```

## render.yaml

```
services:
  - type: web
    name: reidajbl-tube
    runtime: node
    plan: free
    buildCommand: npm ci && npm run build
    startCommand: npm start
    healthCheckPath: /api/health
    envVars:
      - key: NODE_VERSION
        value: 22
      - key: TRUST_PROXY
        value: "1"

```

## vercel.json

```
{
  "version": 2,
  "buildCommand": "npm run build",
  "outputDirectory": "public",
  "functions": { "api/index.js": { "maxDuration": 60 } },
  "rewrites": [
    { "source": "/api/:path*", "destination": "/api/index" },
    { "source": "/auth/:path*", "destination": "/api/index" }
  ]
}

```

## Dockerfile

```
FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY scripts/vendor.js ./scripts/vendor.js
RUN npm ci --omit=dev
COPY server.js auth.js media.js combined-video.js official-video.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000
USER node
EXPOSE 3000
CMD ["node", "server.js"]

```

## iniciar.ps1

```
param([int]$Port = 3000)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (!$nodeCommand) {
    $workspace = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $portable = Join-Path $workspace 'work\node-v22.23.4-win-x64'
    if (!(Test-Path (Join-Path $portable 'node.exe'))) { throw 'Instale Node.js 22 ou superior de https://nodejs.org e execute novamente.' }
    $env:PATH = "$portable;$env:PATH"
}
if (!(Test-Path node_modules)) {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar dependencias.' }
}
$env:PORT = [string]$Port
if (Test-Path .env) { & node.exe --env-file=.env server.js }
else { & node.exe server.js }
exit $LASTEXITCODE

```

## scripts/build.js

```
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './version-assets.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// O destino é fixo e restrito ao dist deste projeto.
const destination = path.join(root, 'dist');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(path.join(root, 'public'), destination, { recursive: true });
console.log('Frontend estático em dist/. O backend server.js deve ser hospedado em Node.js.');

```

## scripts/assets.js

```
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
await Promise.all(['covers', 'icons', 'audio'].map((d) => mkdir(path.join(root, d), { recursive: true })));
const crown = '<path d="M28 39 43 51 60 27 77 51 92 39 85 83H35Z" fill="#E5C158"/><path d="M37 91h46" stroke="#E5C158" stroke-width="5" stroke-linecap="round"/>';
await writeFile(path.join(root, 'icons/crown.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="28" fill="#16181E"/>${crown}</svg>`);
const defs = `<defs><radialGradient id="glow"><stop stop-color="#E5C158" stop-opacity=".48"/><stop offset="1" stop-color="#B89643" stop-opacity="0"/></radialGradient><linearGradient id="metal" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#E5C158"/><stop offset=".3" stop-color="#B89643"/><stop offset=".55" stop-color="#2A2D37"/><stop offset=".8" stop-color="#B89643"/><stop offset="1" stop-color="#2A2D37"/></linearGradient><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".72" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".12"/></feComponentTransfer></filter></defs>`;
const vinyl = (cx, cy, r) => `<g transform="translate(${cx} ${cy})"><circle r="${r + 5}" fill="#0B0C10" stroke="#B8964340"/><circle r="${r}" fill="url(#metal)"/>${Array.from({ length: 27 }, (_, i) => `<circle r="${r * (.27 + i * .026)}" fill="none" stroke="${i % 3 ? '#16181E99' : '#E5C15828'}" stroke-width="1"/>`).join('')}<circle r="${r * .23}" fill="#E5C158"/><circle r="${r * .19}" fill="#16181E"/><circle r="${r * .034}" fill="#0B0C10"/><path d="M-8-4 7 4l-15 8Z" fill="#E5C158"/></g>`;
await writeFile(path.join(root, 'covers/hero.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 430">${defs}<rect width="720" height="430" fill="#16181E"/><ellipse cx="438" cy="212" rx="310" ry="280" fill="url(#glow)"/><g opacity=".45" stroke="#9CA3AF" fill="none"><ellipse cx="490" cy="225" rx="300" ry="108" transform="rotate(-35 490 225)"/><ellipse cx="490" cy="225" rx="290" ry="140" transform="rotate(-35 490 225)"/></g><g transform="rotate(-24 450 220)">${vinyl(450, 220, 165)}</g><path d="M610-10V90l-100 86" stroke="#E5C158" stroke-width="10" fill="none"/><circle cx="510" cy="176" r="9" fill="#E5C158"/><g fill="#E5C158"><circle cx="256" cy="86" r="2"/><circle cx="641" cy="302" r="2"/><path d="m580 74 3 8 8 3-8 3-3 8-3-8-8-3 8-3Z"/></g><rect width="720" height="430" filter="url(#grain)" opacity=".9"/></svg>`);
const covers = {
  nocturne: { bg: '#16181E', color: '#9CA3AF', name: 'NOCTURNE', sub: 'THE QUIET HOURS', shape: '<circle cx="280" cy="243" r="148" fill="#9CA3AF"/><path d="M0 340 118 211l83 76 99-131 200 210V500H0Z" fill="#16181E"/><path d="m0 405 147-120 118 75 115-68 120 94v114H0Z" fill="#2A2D37"/>' },
  golden: { bg: '#29231C', color: '#B89643', name: 'GOLDEN HOUR', sub: 'A LITTLE WARMTH', shape: '<circle cx="250" cy="250" r="146" fill="#E5C158"/><circle cx="250" cy="250" r="113" fill="#29231C"/><circle cx="250" cy="250" r="80" fill="#B89643"/><path d="M-10 356q130-70 260 0t260 0v154H-10Z" fill="#2A2D37"/><path d="M-10 398q130-70 260 0t260 0" stroke="#B89643" fill="none" stroke-width="2"/>' },
  orbit: { bg: '#2A2D37', color: '#9CA3AF', name: 'EM ÓRBITA', sub: 'A SPACE TO WANDER', shape: '<circle cx="250" cy="255" r="118" fill="#9CA3AF"/><circle cx="233" cy="230" r="90" fill="#2A2D37"/><g transform="rotate(-30 250 255)" fill="none" stroke="#9CA3AF"><ellipse cx="250" cy="255" rx="212" ry="62" stroke-width="3"/><ellipse cx="250" cy="255" rx="233" ry="75" stroke-width="1"/></g><circle cx="91" cy="122" r="3" fill="#E5C158"/><circle cx="410" cy="327" r="2" fill="#E5C158"/>' },
  slow: { bg: '#2A2D37', color: '#B89643', name: 'MODO TRANQUILO', sub: 'TAKE YOUR TIME', shape: '<g transform="translate(250 285)" fill="none" stroke="#B89643">'+Array.from({ length: 14 }, (_, i) => `<ellipse rx="${35 + i * 10}" ry="${95 + i * 4}" transform="rotate(${i * 14})" opacity="${.3 + i * .04}"/>`).join('')+'</g>' }
};
for (const [key, c] of Object.entries(covers)) {
  await writeFile(path.join(root, `covers/${key}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500">${defs}<rect width="500" height="500" fill="${c.bg}"/>${c.shape}<rect width="500" height="500" fill="url(#glow)" opacity=".3"/><text x="34" y="63" fill="${c.color}" font-family="Arial,sans-serif" font-size="10" letter-spacing="5">FCKYOUTUBE SESSIONS — 01</text><text x="34" y="439" fill="#F3F4F6" font-family="Georgia,serif" font-size="27" letter-spacing="1">${c.name}</text><text x="36" y="465" fill="${c.color}" font-family="Arial,sans-serif" font-size="8" letter-spacing="4">${c.sub}</text><rect width="500" height="500" filter="url(#grain)" opacity=".8"/></svg>`);
}
// Miniaturas sonoras originais, sintetizadas localmente; não são faixas extraídas do APK.
const rate = 22050, seconds = 32;
const pieces = { nocturne: [48, 55, 60, 64, 55, 60, 67, 64], golden: [45, 52, 57, 61, 52, 57, 64, 61], orbit: [50, 57, 62, 65, 57, 62, 69, 65] };
for (const [name, notes] of Object.entries(pieces)) {
  const pcm = Buffer.alloc(rate * seconds * 2), size = pcm.length;
  for (let n = 0; n < rate * seconds; n++) {
    const t = n / rate; let value = 0;
    for (let delay = 0; delay < 5; delay++) {
      const nt = t - delay * .31;
      if (nt < 0) continue;
      const step = Math.floor(nt / .5), age = nt - step * .5;
      const midi = notes[step % notes.length] + (step % 16 >= 8 ? 12 : 0);
      const hz = 440 * 2 ** ((midi - 69) / 12);
      value += Math.sin(2 * Math.PI * hz * age) * Math.exp(-age * 6) * Math.min(age * 90, 1) * .14 * (.5 ** delay);
      value += Math.sin(2 * Math.PI * hz * 2.001 * age) * Math.exp(-age * 12) * .018 * (.5 ** delay);
    }
    const fade = Math.min(t / 1.2, 1, (seconds - t) / 2.5);
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value * fade)) * 32767), n * 2);
  }
  const head = Buffer.alloc(44); head.write('RIFF'); head.writeUInt32LE(36 + size, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(size, 40);
  await writeFile(path.join(root, `audio/${name}.wav`), Buffer.concat([head, pcm]));
}
console.log('Capas SVG e 3 instrumentais originais gerados.');

await import('./brand-icons.js');

```

## scripts/vendor.js

```
import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
await mkdir(new URL('public/vendor/', root), { recursive:true });
await cp(new URL('node_modules/shaka-player/dist/shaka-player.compiled.js', root), new URL('public/vendor/shaka-player.compiled.js', root));
await cp(new URL('node_modules/shaka-player/LICENSE', root), new URL('public/vendor/SHAKA-LICENSE', root));
console.log('Player DASH e licença copiados para public/vendor.');

```

## scripts/version-assets.js

```
import { cp } from 'node:fs/promises';
const root = new URL('../public/', import.meta.url);
await cp(new URL('app.js', root), new URL('app-v7.js', root));
await cp(new URL('video-player.js', root), new URL('video-player-v3.js', root));
await cp(new URL('styles.css', root), new URL('styles-v3.css', root));

```

## scripts/live-check.js

```
// Verificação opcional de integração: depende da rede e da disponibilidade do YouTube.
const origin = process.env.TEST_ORIGIN || 'http://localhost:3000';
let song;
for (const type of ['songs', 'artists', 'albums']) {
  const response = await fetch(`${origin}/api/search?q=jazz&type=${type}`, { signal: AbortSignal.timeout(35000) });
  const data = await response.json();
  console.log(type, response.status, 'itens:', data.items?.length ?? 0, data.error || '');
  if (type === 'songs') song = data.items?.find((t) => t.duration > 0 && t.duration < 600) || data.items?.[0];
}
if (!song) { console.log('Sem faixa disponível para testar stream.'); process.exit(1); }
// Verifica só o primeiro intervalo; não grava áudio em disco.
const response = await fetch(`${origin}/api/stream/${song.id}`, {
  headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(45000)
});
console.log('stream', response.status, response.headers.get('content-type'), response.headers.get('content-range'));
if (!response.ok) console.log(await response.text());
else { console.log('bytes:', (await response.arrayBuffer()).byteLength); }
if (process.argv.includes('--full')) {
  try {
    let offset=0,total=Infinity;
    const signal=AbortSignal.timeout(90000);
    while(offset<total) {
      const full=await fetch(`${origin}/api/stream/${song.id}`,{headers:{Range:`bytes=${offset}-`},signal});
      if(full.status!==206) throw new Error(`HTTP ${full.status} no byte ${offset}`);
      const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(full.headers.get('content-range'));
      if(!range||Number(range[1])!==offset) throw new Error('Content-Range inválido.');
      const bytes=(await full.arrayBuffer()).byteLength;
      if(bytes!==Number(range[2])-offset+1) throw new Error('Corpo incompleto.');
      offset=Number(range[2])+1;total=Number(range[3]);
    }
    console.log('stream integral validado; bytes totais:',offset);
  } catch (error) {
    console.error('Stream integral não validado:', error.message);
    process.exitCode = 1;
  }
}

```

## test/review-regressions.test.js

```
import{test}from'node:test';import assert from'node:assert/strict';
import{createApp}from'../server.js';import{Readable}from'node:stream';
test('timeout da resolução de mídia encerra espera e retorna HTTP 504',async()=>{
 const server=createApp({getStream:()=>new Promise(()=>{}),sourceTimeoutMs:20}).listen(0,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));
 try{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/stream?id=abcdefghijk`,{signal:AbortSignal.timeout(800)});assert.equal(response.status,504);assert.match((await response.json()).error,/demorou/i);}
 finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('desconexão durante resolução libera vagas do proxy',async()=>{
 let seen=0;const node=createApp({sourceTimeoutMs:1000,getStream:async id=>{if(id==='12345678901')return{size:3,mime:'audio/mp4',read:()=>Readable.from([Buffer.from('abc')])};seen++;return new Promise(()=>{});}}).listen(0,'127.0.0.1');
 await new Promise(r=>node.once('listening',r));const base=`http://127.0.0.1:${node.address().port}`;
 try{
  for(let i=0;i<12;i++){
   const controller=new AbortController();const request=fetch(base+'/api/stream?id=abcdefghijk',{signal:controller.signal}).catch(()=>{});
   const limit=Date.now()+1000;while(seen<i+1&&Date.now()<limit)await new Promise(r=>setTimeout(r,2));assert.equal(seen,i+1);
   controller.abort();await request;await new Promise(r=>setTimeout(r,10));
  }
  const response=await fetch(base+'/api/stream?id=12345678901');assert.equal(response.status,200);assert.equal(await response.text(),'abc');
 }finally{node.closeAllConnections();await new Promise(r=>node.close(r));}
});

```

## test/account-dom.test.js

```
import{test}from'node:test';import assert from'node:assert/strict';import{JSDOM}from'jsdom';import{createAccountUI}from'../public/account.js';
test('perfil e playlists com HTML hostil permanecem texto, sem criar atributos executáveis',async()=>{
 const dom=new JSDOM('<main id="content"></main><button id="profile-button"><span class="google-g">G</span><span id="profile-name"></span></button>',{url:'https://app.test/#account'});
 const previous={document:globalThis.document,location:globalThis.location};globalThis.document=dom.window.document;globalThis.location=dom.window.location;
 const payload='<img src=x onerror="alert(1)">';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 try{
  const account=createAccountUI({esc,toast:()=>{},register:()=>{},onTracks:()=>{},api:async url=>url==='/api/account'?{configured:true,user:{name:payload,picture:'https://images.test/a.png'}}:{items:[{id:'PL1234567890',kind:'playlist',title:payload,artist:payload,artwork:'https://images.test/x" onerror="alert(1)'}],nextPageToken:null}});
  await account.render();await new Promise(r=>setTimeout(r,0));
  assert.ok(document.querySelector('#content h1').textContent.includes(payload));
  assert.equal(document.querySelector('.card-title').textContent,payload);
  assert.equal(document.querySelectorAll('[onerror],script').length,0);
  assert.equal(document.querySelectorAll('img[src="x"]').length,0);
  assert.equal(document.querySelector('.cover-button img').getAttribute('src'),'https://images.test/x" onerror="alert(1)');
 }finally{dom.window.close();if(previous.document===undefined)delete globalThis.document;else globalThis.document=previous.document;if(previous.location===undefined)delete globalThis.location;else globalThis.location=previous.location;}
});

```

## test/car-media.test.js

```
import{test}from'node:test';import assert from'node:assert/strict';
import{createAudioFocus}from'../public/audio-focus.js';
import{installMediaControls,createArtworkVariants,ARTWORK_SIZES}from'../public/media-controls.js';
class Session extends EventTarget{state='active';change(state){this.state=state;this.dispatchEvent(new Event('statechange'));}}
function fixture(){const session=new Session();let pauses=0,resumes=0;const context={epoch:1,trackId:'song',mode:'audio',wantsPlayback:true};const media={paused:false,ended:false};
const focus=createAudioFocus({session,getContext:()=>context,getMedia:()=>media,pause:()=>{pauses++;media.paused=true;},resume:()=>{resumes++;media.paused=false;return Promise.resolve(true);}});return{session,context,media,focus,get pauses(){return pauses;},get resumes(){return resumes;}};}
test('interrupção pausa sem reset e retoma uma vez quando foco fica ativo',()=>{
 const f=fixture();assert.equal(f.session.type,'playback');f.session.change('interrupted');f.session.change('interrupted');assert.equal(f.pauses,1);assert.equal(f.resumes,0);assert.equal(f.context.wantsPlayback,true);
 f.session.change('inactive');assert.equal(f.resumes,0);f.session.change('active');f.session.change('active');assert.equal(f.resumes,1);assert.equal(f.focus.interrupted,false);
});
test('pausa/stop do usuário cancelam retomada, inclusive se o SO tentar retomá-la',()=>{
 const f=fixture();f.session.change('interrupted');f.context.wantsPlayback=false;f.focus.cancel();f.media.paused=false;f.session.change('active');assert.equal(f.resumes,0);assert.equal(f.media.paused,true);
});
test('troca de faixa não herda retomada da faixa interrompida',()=>{
 const f=fixture();f.session.change('interrupted');f.context.epoch++;f.context.trackId='other';f.session.change('active');assert.equal(f.resumes,0);
});
test('play durante interrupção é adiado, faixa pausada não retoma sozinha',()=>{
 const f=fixture();f.context.wantsPlayback=false;f.media.paused=true;f.session.change('interrupted');f.session.change('active');assert.equal(f.resumes,0);
 f.session.change('interrupted');f.context.wantsPlayback=true;assert.equal(f.focus.deferPlay(),true);assert.equal(f.resumes,0);f.session.change('active');assert.equal(f.resumes,1);
});
test('não duplica play já retomado pelo navegador e lida com API ausente',()=>{
 const f=fixture();f.session.change('interrupted');f.media.paused=false;f.session.change('active');assert.equal(f.resumes,0);
 assert.equal(createAudioFocus({getContext:()=>({}),getMedia:()=>({})}).deferPlay(),false);
});
test('Play explícito consegue sair de estado inactive sem retomada automática',()=>{
 const f=fixture();f.session.change('interrupted');f.session.change('inactive');assert.equal(f.resumes,0);
 assert.equal(f.focus.deferPlay(),false);assert.equal(f.focus.interrupted,false);
});
test('rejeição de autoplay é tratada sem loop de retomada',async()=>{
 const session=new Session();let blocked=0,attempts=0;
 createAudioFocus({session,getContext:()=>({epoch:1,trackId:'x',wantsPlayback:true}),getMedia:()=>({paused:true}),pause:()=>{},resume:()=>{attempts++;return Promise.reject(Error('blocked'));},onResumeBlocked:()=>blocked++});
 session.change('interrupted');session.change('active');await Promise.resolve();session.change('active');assert.equal(attempts,1);assert.equal(blocked,1);
});
test('oito ações são registradas mesmo se uma não for suportada; seek respeita limites',()=>{
 const handlers={};const media={currentTime:5,duration:100};let stop=0,previous=0,next=0;
 const controls=installMediaControls({setActionHandler:(name,fn)=>{handlers[name]=fn;if(name==='stop')throw Error('unsupported');}},{getMedia:()=>media,play:()=>{},pause:()=>{},stop:()=>stop++,previous:()=>previous++,next:()=>next++});
 assert.deepEqual(Object.keys(handlers),['play','pause','stop','previoustrack','nexttrack','seekbackward','seekforward','seekto']);handlers.stop();handlers.previoustrack();handlers.nexttrack();assert.deepEqual([stop,previous,next],[1,1,1]);
 handlers.seekbackward({});assert.equal(media.currentTime,0);handlers.seekforward({});assert.equal(media.currentTime,10);handlers.seekto({seekTime:200});assert.equal(media.currentTime,100);handlers.seekforward({seekOffset:Infinity});assert.equal(media.currentTime,100);
 handlers.seekto({seekTime:NaN});assert.equal(media.currentTime,100);media.duration=NaN;controls.seek(20);assert.equal(media.currentTime,100);
});
test('capas são redimensionadas de verdade nas cinco resoluções e têm fallback local',async()=>{
 const dimensions=[];let loads=0;
 const variants=await createArtworkVariants('https://example.com/no-cors.jpg',{origin:'https://app.example',loadImage:async src=>{loads++;if(loads===1)throw Error('CORS');assert.equal(src,'https://app.example/icons/icon-512.png');return{naturalWidth:512,naturalHeight:512};},canvas:()=>{const c={getContext:()=>({drawImage:()=>{}}),toDataURL:()=>{dimensions.push([c.width,c.height]);return'data:image/png;base64,fixture';}};return c;}});
 assert.deepEqual(dimensions,ARTWORK_SIZES.map(n=>[n,n]));assert.deepEqual(variants.map(a=>a.sizes),['96x96','128x128','192x192','256x256','512x512']);assert.ok(variants.every(a=>a.type==='image/png'));
});

```

## test/official-video.test.js

```
import{test}from'node:test';import assert from'node:assert/strict';
import{selectOfficialVideo,createOfficialVideoSearch}from'../official-video.js';
import{createApp}from'../server.js';
const track={id:'abcdefghijk',title:'Never Gonna Give You Up',artist:'Rick Astley',duration:213};
const official={id:'dQw4w9WgXcQ',title:'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',author:{name:'Rick Astley',verified:true},lengthSeconds:214};
test('seleciona clipe correspondente sem aceitar primeiro resultado de capa ou letra',()=>{
 const audio={...official,id:'12345678901',title:'Never Gonna Give You Up (Official Audio)'};
 const lyrics={...official,title:'Never Gonna Give You Up (Official Video Lyrics)'};
 assert.equal(selectOfficialVideo([audio,lyrics,official],track).id,official.id);
 assert.equal(selectOfficialVideo([official],{...track,title:'Never Gonna Give You Up (2022 Remaster)'}).id,official.id);
});
test('rejeita título/artista/versão divergentes e ausência de evidência de clipe',()=>{
 for(const candidate of [{...official,title:'Rick Astley - Together Forever (Official Video)'},{...official,title:'Other Artist - Never Gonna Give You Up (Official Video)',author:{name:'Other Artist',verified:true}},{...official,lengthSeconds:900},{...official,author:{name:'Rick Astley - Topic',verified:true}},{...official,author:{name:'Fan Channel',verified:false}},{...official,title:'Never Gonna Give You Up'}])assert.equal(selectOfficialVideo([candidate],track),null);
});
test('busca por música/artista/Official Video e deduplica sem misturar faixas',async()=>{
 let calls=0,query;const find=createOfficialVideoSearch({search:async q=>{calls++;query=q;return[official];}});
 const[a,b]=await Promise.all([find(track),find(track)]);assert.equal(calls,1);assert.equal(a.video.id,official.id);assert.deepEqual(a,b);assert.match(query,/Never Gonna Give You Up Rick Astley Official Video/);
 await find(track);assert.equal(calls,1);const absent=await find({...track,title:'Independent original song'});assert.equal(absent.available,false);assert.equal(calls,2);
});
test('rota valida entrada e devolve ausência de clipe como fallback normal',async()=>{
 const server=createApp({findOfficialVideo:createOfficialVideoSearch({search:async()=>[]})}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(base+'/api/official-video?id=invalid')).status,400);
 const r=await fetch(base+'/api/official-video?'+new URLSearchParams({...track,duration:String(track.duration)}));assert.equal(r.status,200);assert.deepEqual(await r.json(),{available:false,message:'Vídeo oficial indisponível para esta faixa'});
 }finally{await new Promise(r=>server.close(r));}
});

```

## test/video-player.test.js

```
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVideoPlayer} from '../public/video-player.js';
class Media extends EventTarget {
  currentTime=0;duration=300;paused=true;src='';plays=0;
  load(){this.currentTime=0;}
  pause(){this.paused=true;}
  play(){this.plays++;this.paused=false;return Promise.resolve();}
  removeAttribute(){this.src='';}
}
test('vídeo usa MP4 combinado e busca posição somente após metadados',async()=>{
  const el=new Media();const controller=createVideoPlayer(el,assert.fail);
  await controller.load('abcdefghijk',72.5,true);
  assert.match(el.src,/type=video/);assert.equal(el.currentTime,0);assert.equal(controller.position(),72.5);
  el.dispatchEvent(new Event('loadedmetadata'));assert.equal(el.currentTime,72.5);assert.equal(el.plays,1);
  controller.stop();assert.equal(el.paused,true);assert.equal(el.src,'');
});
test('troca rápida cancela seek antigo e preserva estado pausado',async()=>{
  const el=new Media();const controller=createVideoPlayer(el,assert.fail);
  await controller.load('abcdefghijk',80,true);await controller.load('12345678901',20,false);
  el.dispatchEvent(new Event('loadedmetadata'));assert.equal(el.currentTime,20);assert.equal(el.paused,true);assert.equal(el.plays,1);
  await controller.load('abcdefghijk',200,false);controller.stop();el.dispatchEvent(new Event('loadedmetadata'));assert.equal(el.currentTime,0);
});
test('rejeição tardia de play não mostra erro de modo anterior',async()=>{
  const el=new Media();let reject;el.play=()=>new Promise((_,r)=>reject=r);const errors=[];
  const controller=createVideoPlayer(el,e=>errors.push(e));const loading=controller.load('abcdefghijk',0,true);
  controller.stop();reject(new Error('obsolete'));await loading;assert.deepEqual(errors,[]);
});

```

## test/combined-video.test.js

```
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,stat,unlink,rmdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import {createCombinedVideo} from '../combined-video.js';
import {createApp} from '../server.js';
const run=(args)=>new Promise((resolve,reject)=>{const child=spawn(ffmpeg,['-hide_banner','-loglevel','error',...args],{windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('close',c=>c===0?resolve():reject(Error('FFmpeg fixture')));});
test('combina H264 e AAC em MP4 decodificável e serve bytes seekable',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'reidajbl-fixture-'));const v=path.join(dir,'v.mp4'),a=path.join(dir,'a.m4a'),out=path.join(dir,'out.mp4');let calls=0;
 let server;
 try {
  await run(['-f','lavfi','-i','color=c=gold:s=160x90:r=10','-t','1','-c:v','libx264','-pix_fmt','yuv420p',v]);
  await run(['-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','1','-c:a','aac',a]);
  const getStream=async(_id,mode)=>{calls++;const file=mode==='video'?v:a;return{size:(await stat(file)).size,read:({signal})=>createReadStream(file,{signal})};};
  const combined=createCombinedVideo({getStream});
  const [one,two]=await Promise.all([combined('abcdefghijk'),combined('abcdefghijk')]);assert.equal(one,two);assert.equal(calls,2);
  const {writeFile}=await import('node:fs/promises');const chunks=[];for await(const c of one.read({}))chunks.push(c);const body=Buffer.concat(chunks);await writeFile(out,body);
  await run(['-i',out,'-map','0:v:0','-map','0:a:0','-f','null','-']);
  server=createApp({getCombinedVideo:combined}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(base+'/api/stream?id=abcdefghijk&type=video',{headers:{Range:'bytes=4-19'}});
  assert.equal(response.status,206);assert.equal(response.headers.get('content-type'),'video/mp4');assert.equal(response.headers.get('content-range'),`bytes 4-19/${body.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),body.subarray(4,20));
  assert.equal((await fetch(base+'/api/stream?id=abcdefghijk&type=invalid')).status,400);
  // Três arquivos prontos + um preparo ocupam as quatro vagas do cache.
  await combined('cachefile02');await combined('cachefile03');
  const fourth=combined('cachefile04');
  await assert.rejects(combined('cachefile05'),e=>e.status===503);
  await fourth;
 } finally {
  if(server)await new Promise(r=>server.close(r));
  for(const file of [v,a,out])await unlink(file).catch(()=>{});await rmdir(dir);
 }
});

```

## test/media.test.js

```
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createMediaProvider } from '../media.js';
import { createApp } from '../server.js';

test('mantém sessão única, cliente nativo e leitura AAC com Range sem expor URL', async () => {
  let constructions = 0, options, readOptions;
  const f = { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', container: 'mp4', codecs: 'mp4a.40.2',
    audioCodec: 'mp4a.40.2', hasAudio: true, hasVideo: false, contentLength: 100, client: 'visionos', audioBitrate: 128 };
  const provider = createMediaProvider({ env: { YOUTUBE_CLIENTS: 'visionos,tv', YOUTUBE_COOKIE: 'private-fixture' },
    createYtdl: (o) => { constructions++; options=o; return {
      getInfo: async () => ({ formats: [f] }), open: () => ({ read: (o) => { readOptions=o; return Readable.from([Buffer.alloc(o.range.end-o.range.start+1,7)]); } })
    }; } });
  const source=await provider('abcdefghijk');await provider('abcdefghijk');
  assert.equal(constructions,1);assert.equal(options.cookie,'private-fixture');assert.deepEqual(options.clients,['visionos','tv']);
  assert.equal(source.url,undefined);assert.equal(source.size,100);
  const app=createApp({getStream:async()=>source});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const url=`http://127.0.0.1:${server.address().port}/api/stream?id=abcdefghijk`;
  try {
    for (const [range,start,end,status] of [['bytes=5-9',5,9,206],['bytes=94-',94,99,206],['bytes=-4',96,99,206],[null,0,99,200]]) {
      const res=await fetch(url,{headers:range?{Range:range}:{}});
      assert.equal(res.status,status);assert.equal(res.headers.get('content-length'),String(end-start+1));
      assert.equal(res.headers.get('content-range'),range?`bytes ${start}-${end}/100`:null);
      assert.deepEqual([...new Uint8Array(await res.arrayBuffer())],Array(end-start+1).fill(7));
      assert.deepEqual(readOptions.range,{start,end});assert.ok(readOptions.signal instanceof AbortSignal);
    }
    const head=await fetch(url,{method:'HEAD',headers:{Range:'bytes=0-1'}});assert.equal(head.status,206);assert.equal((await head.arrayBuffer()).byteLength,0);
    const invalid=await fetch(url,{headers:{Range:'bytes=100-'}});assert.equal(invalid.status,416);assert.equal(invalid.headers.get('content-range'),'bytes */100');
  } finally {await new Promise(r=>server.close(r));}
});

test('rejeita clientes desconhecidos e cookies ambíguos sem imprimir segredo',async()=>{
  for(const env of [{YOUTUBE_CLIENTS:'ANDROID_FAKE'},{YOUTUBE_COOKIE:'secret',YOUTUBE_COOKIE_FILE:'private'}]) {
    await assert.rejects(createMediaProvider({env})('abcdefghijk'),e=>!e.message.includes('secret'));
  }
});

```

## test/server.test.js

```
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, safeMediaURL, normalizeItem, TTLCache, evaluatePlayer, rangeBounds, mediaHeaders, STREAM_USER_AGENT } from '../server.js';
let observedRange;
let observedHeaders;
const item = { id: 'abcdefghijk', item_type: 'song', title: 'Faixa teste', artists: [{ name: 'Artista' }], duration: { seconds: 180 }, thumbnails: [{ url: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' }] };
const app = createApp({
  getClient: async () => ({ music: {
    search: async () => ({ contents: [{ contents: [item, item] }] }),
    getHomeFeed: async () => ({ sections: [{ header: { title: 'Seleção' }, contents: [item] }] }),
    getAlbum: async () => ({ header: { title: 'Álbum' }, contents: [item] })
  } }),
  getStream: async (_id, mode) => ({ url: 'https://rr1.googlevideo.com/videoplayback', mime: mode === 'video' ? 'video/mp4' : 'audio/mp4', size: 100,
    dash:{init:{start:0,end:9},index:{start:10,end:20},codecs:mode === 'video' ? 'avc1.42E01E' : 'mp4a.40.2',bitrate:128000,width:640,height:360,duration:180} }),
  audioFetch: async (_url, headers) => {
    observedRange = headers.Range;
    observedHeaders=headers;
    let start,end;
    try { ({start,end}=rangeBounds(headers.Range,100)); }
    catch { return new Response(null,{status:416,headers:{'content-range':'bytes */100'}}); }
    return new Response(Uint8Array.from({ length: end - start + 1 }, (_, i) => start + i + 1), { status: headers.Range ? 206 : 200, headers: {
      ...(headers.Range?{'content-range': `bytes ${start}-${end}/100`}:{}),
      'content-length': String(end-start+1), 'accept-ranges': 'bytes','content-type':'audio/mp4'
    } });
  }
});
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => new Promise((r) => server.close(r)));
test('executa o corpo do decipher com retorno e variáveis da sessão', () => {
  assert.equal(evaluatePlayer({ output: 'return sig.split("").reverse().join("");' }, { sig: 'abc' }), 'cba');
  assert.equal(evaluatePlayer({ output: 'return typeof process;' }), 'undefined');
});
test('permite apenas URLs de áudio HTTPS do googlevideo', () => {
  assert.equal(safeMediaURL('https://rr1---sn-a.googlevideo.com/audio').protocol, 'https:');
  for (const url of ['http://rr1.googlevideo.com/a', 'https://googlevideo.com.evil.test/a', 'https://127.0.0.1/a', 'https://rr1.googlevideo.com:8000/a', 'https://user:pw@rr1.googlevideo.com/a']) assert.throws(() => safeMediaURL(url));
});
test('normaliza metadados e ignora itens desconhecidos', () => {
  assert.equal(normalizeItem(item).artist, 'Artista');
  assert.equal(normalizeItem(item).duration, 180);
  assert.equal(normalizeItem({ ...item, id: 'invalido' }), null);
  assert.equal(normalizeItem({ ...item, item_type: 'ad' }), null);
});
test('limita a quantidade de entradas em cache', () => {
  const cache = new TTLCache(2); cache.set('a', 1); cache.set('b', 2); cache.set('c', 3);
  assert.equal(cache.get('a'), undefined); assert.equal(cache.get('c'), 3);
});
test('cabeçalhos coerentes com cliente Android ou iOS',()=>{
 assert.match(mediaHeaders('ANDROID')['User-Agent'],/Android/);
 assert.match(mediaHeaders('IOS')['User-Agent'],/iPhone/);
 assert.equal(mediaHeaders('IOS').Origin,'https://www.youtube.com');
 assert.equal(mediaHeaders('IOS').Referer,'https://www.youtube.com/');
});
test('DASH referencia trilhas de áudio e vídeo pelo mesmo domínio',async()=>{
 const res=await fetch(`${base}/api/dash/abcdefghijk`);const xml=await res.text();
 assert.equal(res.status,200);assert.match(res.headers.get('content-type'),/dash\+xml/);
 assert.match(xml,/mimeType="audio\/mp4"/);assert.match(xml,/mimeType="video\/mp4"/);
 assert.match(xml,/mode=audio/);assert.match(xml,/mode=video/);assert.ok(!xml.includes('googlevideo.com'));
});
test('valida busca e remove resultados duplicados', async () => {
  assert.equal((await fetch(`${base}/api/search?q=`)).status, 400);
  assert.equal((await fetch(`${base}/api/search?q=x&type=unknown`)).status, 400);
  const data = await (await fetch(`${base}/api/search?q=unit-search&type=songs`)).json();
  assert.equal(data.items.length, 1); assert.equal(data.items[0].id, item.id);
});
test('não aceita URL arbitrária como identificador de stream', async () => {
  assert.equal((await fetch(`${base}/api/stream/invalid`)).status, 400);
  assert.equal((await fetch(`${base}/api/stream/abcdefghijk`, { headers: { Range: 'bytes=0-1,4-5' } })).status, 416);
});
test('encaminha intervalo, status 206 e corpo sem modificar', async () => {
  const res = await fetch(`${base}/api/stream/abcdefghijk`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(res.status, 206); assert.equal(observedRange, 'bytes=0-3');
  assert.equal(res.headers.get('content-range'), 'bytes 0-3/100');
  assert.equal(res.headers.get('content-length'),'4');
  assert.equal(observedHeaders['User-Agent'],STREAM_USER_AGENT);
  assert.equal(observedHeaders['Accept-Encoding'],'identity');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3, 4]);
});
test('Range aberto é encaminhado sem corte ou reescrita', async () => {
  const res = await fetch(`${base}/api/stream/abcdefghijk`, { headers: { Range: 'bytes=94-' } });
  assert.equal(observedRange,'bytes=94-');
  assert.equal(res.status, 206); assert.equal(res.headers.get('content-range'), 'bytes 94-99/100');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [95,96,97,98,99,100]);
  const last=await fetch(`${base}/api/stream/abcdefghijk`,{headers:{Range:'bytes=98-'}});
  assert.equal(last.headers.get('content-range'),'bytes 98-99/100');
  assert.deepEqual([...new Uint8Array(await last.arrayBuffer())],[99,100]);
});
test('sem Range retorna arquivo completo com 200 e suporte a suffix ranges', async () => {
  const res = await fetch(`${base}/api/stream/abcdefghijk`);
  assert.equal(res.status, 200); assert.equal((await res.arrayBuffer()).byteLength, 100);
  assert.equal(observedRange,undefined);assert.equal(res.headers.get('content-range'),null);
  const suffix=await fetch(`${base}/api/stream?id=abcdefghijk`,{headers:{Range:'bytes=-4'}});
  assert.equal(suffix.status,206);assert.equal(observedRange,'bytes=-4');assert.equal(suffix.headers.get('content-range'),'bytes 96-99/100');
  assert.deepEqual([...new Uint8Array(await suffix.arrayBuffer())],[97,98,99,100]);
  assert.deepEqual(rangeBounds('bytes=-4', 100), { start:96, end:99 });
  assert.throws(() => rangeBounds('bytes=-0',100));
  assert.throws(() => rangeBounds('bytes=100-',100));
});
test('preserva Content-Range de erro 416 do upstream',async()=>{
 const res=await fetch(`${base}/api/stream/abcdefghijk`,{headers:{Range:'bytes=100-'}});
 assert.equal(res.status,416);assert.equal(res.headers.get('content-range'),'bytes */100');
});
test('falha no corpo upstream encerra a conexão e mantém o servidor saudável',async()=>{
 const broken=createApp({getStream:async()=>({url:'https://rr1.googlevideo.com/x',mime:'audio/mp4'}),
  audioFetch:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,2,3]));controller.error(new Error('fixture: conexao upstream interrompida'));}}),{status:200,headers:{'content-type':'audio/mp4','content-length':'100'}})});
 const node=broken.listen(0,'127.0.0.1');await new Promise(r=>node.once('listening',r));
 const host=`http://127.0.0.1:${node.address().port}`;
 try{await assert.rejects(async()=>{const r=await fetch(host+'/api/stream/abcdefghijk');await r.arrayBuffer();});assert.equal((await fetch(host+'/api/health')).status,200);}
 finally{await new Promise(r=>node.close(r));}
});
test('um Range aberto transmite mais de 2 MiB sem cortar a resposta em janelas',async()=>{
 const size=2*1024*1024+123;let requestedRange,requests=0;
 const large=createApp({getStream:async()=>({url:'https://rr1.googlevideo.com/x',mime:'audio/mp4'}),
  audioFetch:async(_url,headers)=>{requests++;requestedRange=headers.Range;let sent=0;
   return new Response(new ReadableStream({pull(controller){if(sent===size)return controller.close();const length=Math.min(32768,size-sent);controller.enqueue(new Uint8Array(length).fill(73));sent+=length;}}),
    {status:206,headers:{'content-type':'audio/mp4','content-length':String(size),'content-range':`bytes 0-${size-1}/${size}`}});
  }});
 const node=large.listen(0,'127.0.0.1');await new Promise(r=>node.once('listening',r));
 try{
  const response=await fetch(`http://127.0.0.1:${node.address().port}/api/stream/abcdefghijk`,{headers:{Range:'bytes=0-'}});
  assert.equal(response.status,206);assert.equal(response.headers.get('content-length'),String(size));
  const bytes=new Uint8Array(await response.arrayBuffer());assert.equal(bytes.byteLength,size);assert.ok(bytes.every(b=>b===73));
  assert.equal(requestedRange,'bytes=0-');assert.equal(requests,1);
 }finally{await new Promise(r=>node.close(r));}
});
test('arquivos PWA e ícones são servidos no mesmo domínio', async () => {
  for (const file of ['/', '/manifest.json', '/service-worker.js', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/app.js', '/audio/nocturne.wav']) assert.equal((await fetch(base + file, { method: 'HEAD' })).status, 200, file);
  const manifest = await (await fetch(`${base}/manifest.json`)).json(); assert.equal(manifest.display, 'standalone');
});

```

## test/audio-retry.test.js

```
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAudioRetry} from '../public/audio-retry.js';
function fixture(reconnect=async()=>{}) {
 const context={epoch:1,trackId:'abcdefghijk',mode:'audio',source:'youtube',position:17,wantsPlayback:true};
 const tasks=new Map(),events=[];let id=0;
 const retry=createAudioRetry({getContext:()=>context,reconnect:async(data)=>{events.push(['connect',data]);await reconnect();},
  onRetry:()=>events.push(['retry']),onFinal:()=>events.push(['final']),
  schedule:(fn)=>{tasks.set(++id,fn);return id;},unschedule:(key)=>tasks.delete(key)});
 async function tick(){for(const [key,fn] of [...tasks]){tasks.delete(key);await fn();}}
 return {context,tasks,events,retry,tick};
}
test('reconecta uma vez na posição anterior, antes de exibir falha',async()=>{
 const f=fixture();assert.equal(f.retry.handleError(),true);assert.deepEqual(f.events,[['retry']]);
 await f.tick();assert.deepEqual(f.events[1],['connect',{position:17,attempt:1}]);
 f.retry.handleError();f.retry.handleError();assert.equal(f.events.filter(e=>e[0]==='final').length,1);
});
test('eventos de erro duplicados não criam várias reconexões',async()=>{
 const f=fixture();f.retry.handleError();f.retry.handleError();assert.equal(f.tasks.size,1);
 await f.tick();assert.equal(f.events.filter(e=>e[0]==='connect').length,1);
});
test('pausar ou cancelar impede retomada automática',async()=>{
 const f=fixture();f.retry.handleError();f.context.wantsPlayback=false;f.retry.cancel();await f.tick();
 assert.equal(f.events.filter(e=>e[0]==='connect').length,0);
});
test('trocar de faixa invalida tentativa pendente',async()=>{
 const f=fixture();f.retry.handleError();f.context.trackId='new-track';await f.tick();
 assert.equal(f.events.filter(e=>e[0]==='connect').length,0);
});
test('falha da tentativa automática gera somente um alerta',async()=>{
 const f=fixture(async()=>{throw new Error('network');});f.retry.handleError();await f.tick();f.retry.handleError();
 assert.equal(f.events.filter(e=>e[0]==='final').length,1);
});
test('reprodução nova recebe orçamento novo; arquivos locais não são reconectados',async()=>{
 const f=fixture();f.retry.handleError();await f.tick();f.retry.handleError();f.retry.reset();
 f.retry.handleError();await f.tick();assert.equal(f.events.filter(e=>e[0]==='connect').length,2);
 f.context.source='local';assert.equal(f.retry.handleError(),false);
});

```

## test/auth.test.js

```
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createSessionCodec } from '../auth.js';
const env = { PUBLIC_ORIGIN:'http://localhost:3000', GOOGLE_CLIENT_ID:'test-client', GOOGLE_CLIENT_SECRET:'test-secret', SESSION_SECRET:'test-session-secret-with-at-least-32-characters' };
const scope = 'openid profile https://www.googleapis.com/auth/youtube.readonly';
let tokenRequests = 0;
const google = async (url, init = {}) => {
  const u = new URL(url);
  if (u.pathname === '/token') { tokenRequests++; assert.ok(init.body.get('code_verifier') || init.body.get('refresh_token')); return Response.json({access_token:'private-test-token',refresh_token:'private-test-refresh',expires_in:3600,scope}); }
  if (u.pathname === '/v1/userinfo') return Response.json({sub:'123',name:'Pessoa Teste',picture:'https://example.com/avatar.png'});
  if (u.pathname === '/revoke') return Response.json({});
  assert.equal(init.headers.Authorization,'Bearer private-test-token');
  if (u.pathname.endsWith('/videos')) return Response.json({items:[{id:'abcdefghijk',snippet:{title:'Curtida',channelTitle:'Artista'},contentDetails:{duration:'PT3M5S'}}]});
  if (u.pathname.endsWith('/playlists')) return Response.json({items:[{id:'PLabcdefghijk',snippet:{title:'Minha playlist'},contentDetails:{itemCount:1}}]});
  return Response.json({items:[]});
};
const app = createApp({authOptions:{env,fetchImpl:google}});
const server=app.listen(0,'127.0.0.1');await new Promise((r)=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}`;
after(()=>new Promise((r)=>server.close(r)));
let sessionCookie;
test('sessão é cifrada, rejeita adulteração e expiração',()=>{
 const codec=createSessionCodec('secret'); const value=codec.seal({exp:Date.now()+10000,token:'private'});
 assert.ok(!value.includes('private'));assert.equal(codec.open(value).token,'private');
 assert.equal(codec.open('changed'+value),null);assert.equal(codec.open(codec.seal({exp:1})),null);
});
test('biblioteca exige login e perfil anônimo não expõe tokens',async()=>{
 assert.equal((await fetch(base+'/api/account/library')).status,401);
 const data=await(await fetch(base+'/api/account')).json();assert.equal(data.user,null);assert.equal(data.configured,true);
});
test('OAuth usa state, PKCE, escopo de leitura e cookie HttpOnly',async()=>{
 const res=await fetch(base+'/auth/google',{redirect:'manual'});const url=new URL(res.headers.get('location'));
 assert.equal(url.origin,'https://accounts.google.com');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 assert.ok(url.searchParams.get('scope').includes('youtube.readonly'));
 const cookie=res.headers.getSetCookie()[0];assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Lax/);
 const callback=await fetch(base+`/auth/google/callback?code=example&state=${url.searchParams.get('state')}`,{redirect:'manual',headers:{Cookie:cookie.split(';')[0]}});
 assert.equal(callback.headers.get('location'),'/#account');
 sessionCookie=callback.headers.getSetCookie().find((c)=>c.startsWith('rj_session=')).split(';')[0];
 assert.ok(!sessionCookie.includes('private-test-token'));
});
test('perfil e curtidas usam token no servidor, sem retorná-lo ao cliente',async()=>{
 const headers={Cookie:sessionCookie};
 const account=await(await fetch(base+'/api/account',{headers})).json();assert.equal(account.user.name,'Pessoa Teste');assert.ok(!JSON.stringify(account).includes('private-test'));
 const likes=await(await fetch(base+'/api/account/library?section=likes',{headers})).json();assert.equal(likes.items[0].duration,185);assert.equal(likes.items[0].title,'Curtida');
 const playlists=await(await fetch(base+'/api/account/library?section=playlists',{headers})).json();assert.equal(playlists.items[0].title,'Minha playlist');
});
test('histórico global é explicitamente indisponível',async()=>{
 const res=await fetch(base+'/api/account/library?section=history',{headers:{Cookie:sessionCookie}});const data=await res.json();assert.equal(data.available,false);
});
test('renova access token expirado usando refresh token sem expor credenciais',async()=>{
 const cookie=createSessionCodec(env.SESSION_SECRET).seal({exp:Date.now()+600000,expires_at:0,access_token:'old-token',refresh_token:'private-test-refresh',user:{name:'Pessoa Teste'}});
 const res=await fetch(base+'/api/account',{headers:{Cookie:`rj_session=${cookie}`}});const data=await res.json();
 assert.equal(res.status,200);assert.equal(data.user.name,'Pessoa Teste');assert.ok(res.headers.getSetCookie().some(c=>c.startsWith('rj_session=')));assert.ok(!JSON.stringify(data).includes('token'));
});
test('callback rejeita state inválido sem trocar código por token',async()=>{
 const count=tokenRequests;
 const res=await fetch(base+'/auth/google/callback?code=x&state=invalid',{redirect:'manual'});
 assert.equal(res.headers.get('location'),'/#account/error-state');assert.equal(tokenRequests,count);
});
test('logout exige mesma origem, limpa cookie e revoga credencial',async()=>{
 const denied=await fetch(base+'/api/auth/logout',{method:'POST',headers:{Cookie:sessionCookie}});assert.equal(denied.status,403);
 const res=await fetch(base+'/api/auth/logout',{method:'POST',headers:{Cookie:sessionCookie,Origin:env.PUBLIC_ORIGIN,'X-Reidajbl-CSRF':'1'}});
 assert.equal(res.status,200);assert.ok(res.headers.getSetCookie().some((c)=>c.startsWith('rj_session=;')&&c.includes('Max-Age=0')));
});

```

## test/service-worker.test.js

```
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, access } from 'node:fs/promises';
const code = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
function harness() {
  const listeners = {};
  const context = {
    self: { location: { origin: 'https://app.test' }, addEventListener: (name, fn) => listeners[name] = fn, clients: { claim: async () => {} } },
    URL, Response,
    caches: { match: async () => new Response(new Uint8Array([0, 1, 2, 3, 4, 5])), keys: async () => [],
      open: async () => ({ addAll: async (paths) => { context.shell = paths; } }) },
    fetch: async () => { throw new Error('offline'); }
  };
  vm.runInNewContext(code, context);
  return { listeners, context };
}
test('todos os assets precacheados existem no pacote', async () => {
  const { listeners, context } = harness(); let promise;
  listeners.install({ waitUntil: (p) => promise = p }); await promise;
  for (const name of context.shell) await access(new URL(`../public${name === '/' ? '/index.html' : name}`, import.meta.url));
});
test('áudio em cache responde a Range com 206 e comprimento correto', async () => {
  const { listeners } = harness(); let promise;
  listeners.fetch({ request: new Request('https://app.test/audio/nocturne.wav', { headers: { Range: 'bytes=2-4' } }), respondWith: (p) => promise = p });
  const response = await promise; assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2-4/6');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [2, 3, 4]);
});
test('Range fora do arquivo resulta em 416', async () => {
  const { listeners } = harness(); let promise;
  listeners.fetch({ request: new Request('https://app.test/audio/nocturne.wav', { headers: { Range: 'bytes=99-' } }), respondWith: (p) => promise = p });
  assert.equal((await promise).status, 416);
});
test('requisições API não são interceptadas ou armazenadas', () => {
  const { listeners } = harness(); let handled = false;
  listeners.fetch({ request: new Request('https://app.test/api/stream/abcdefghijk'), respondWith: () => handled = true });
  assert.equal(handled, false);
  listeners.fetch({ request: new Request('https://app.test/auth/google/callback?code=private'), respondWith: () => handled = true });
  assert.equal(handled, false);
});

```

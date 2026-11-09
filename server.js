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

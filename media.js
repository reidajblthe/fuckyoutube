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

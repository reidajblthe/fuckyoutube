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

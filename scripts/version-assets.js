import { cp } from 'node:fs/promises';
const root = new URL('../public/', import.meta.url);
await cp(new URL('app.js', root), new URL('app-v7.js', root));
await cp(new URL('video-player.js', root), new URL('video-player-v3.js', root));
await cp(new URL('styles.css', root), new URL('styles-v3.css', root));

import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
await mkdir(new URL('public/vendor/', root), { recursive:true });
await cp(new URL('node_modules/shaka-player/dist/shaka-player.compiled.js', root), new URL('public/vendor/shaka-player.compiled.js', root));
await cp(new URL('node_modules/shaka-player/LICENSE', root), new URL('public/vendor/SHAKA-LICENSE', root));
console.log('Player DASH e licença copiados para public/vendor.');

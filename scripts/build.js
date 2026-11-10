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

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

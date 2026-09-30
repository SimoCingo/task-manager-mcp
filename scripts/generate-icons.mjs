// Genera le icone della PWA senza dipendenze: un quadrato con lo sfondo del
// marchio e un segno di spunta, disegnato pixel per pixel e sovracampionato
// 4x per bordi morbidi, poi compresso in PNG con zlib (gia' in Node).
// Si lancia una volta sola: `node scripts/generate-icons.mjs`.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = [47, 93, 80]; // #2f5d50, lo stesso verde della pagina di autorizzazione
const FG = [246, 245, 242]; // #f6f5f2

function crc(buf) {
  // CRC-32 di PNG: node:zlib non lo espone prima di v22 come helper stabile
  // ovunque, quindi lo calcoliamo a mano con la tabella standard.
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(typeData));
  return Buffer.concat([len, typeData, c]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // profondita' 8 bit
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // nessun filtro riga per riga
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** Distanza minima da un punto a un segmento (per il tratto della spunta). */
function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1)));
  const cx = ax + t * abx, cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}

/** true se (x,y) sta dentro un rettangolo con angoli arrotondati di raggio r. */
function insideRoundedRect(x, y, size, r) {
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

/**
 * Disegna l'icona a `size` px, sovracampionando SS^2 volte per bordi lisci.
 * rounded=true ritaglia gli angoli (icone "any"); rounded=false riempie tutto
 * il quadrato (apple-touch-icon e varianti "maskable", che il sistema ritaglia da solo).
 */
function drawIcon(size, { rounded }) {
  const SS = 4;
  const big = size * SS;
  const rgba = Buffer.alloc(big * big * 4);
  const r = big * 0.22;
  const thickness = big * 0.085;
  // Il segno di spunta, in coordinate 0..1 del quadrato: corto a sinistra,
  // lungo verso l'alto a destra.
  const p1 = [0.27 * big, 0.53 * big];
  const p2 = [0.44 * big, 0.70 * big];
  const p3 = [0.74 * big, 0.34 * big];

  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const i = (y * big + x) * 4;
      const inBg = rounded ? insideRoundedRect(x, y, big, r) : true;
      if (!inBg) { rgba[i + 3] = 0; continue; }
      rgba[i] = BG[0]; rgba[i + 1] = BG[1]; rgba[i + 2] = BG[2]; rgba[i + 3] = 255;
      const d = Math.min(distToSegment(x, y, ...p1, ...p2), distToSegment(x, y, ...p2, ...p3));
      if (d <= thickness / 2) {
        rgba[i] = FG[0]; rgba[i + 1] = FG[1]; rgba[i + 2] = FG[2];
      }
    }
  }

  // Downsample SS x SS -> size x size (media dei blocchi, con alpha corretto).
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r_ = 0, g_ = 0, b_ = 0, a_ = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const si = ((y * SS + sy) * big + (x * SS + sx)) * 4;
          const a = rgba[si + 3];
          r_ += rgba[si] * a; g_ += rgba[si + 1] * a; b_ += rgba[si + 2] * a; a_ += a;
        }
      }
      const o = (y * size + x) * 4;
      if (a_ > 0) { out[o] = r_ / a_; out[o + 1] = g_ / a_; out[o + 2] = b_ / a_; }
      out[o + 3] = Math.round(a_ / (SS * SS));
    }
  }
  return out;
}

mkdirSync('public/icons', { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, rounded: true },
  { file: 'icon-512.png', size: 512, rounded: true },
  { file: 'icon-192-maskable.png', size: 192, rounded: false },
  { file: 'icon-512-maskable.png', size: 512, rounded: false },
  { file: 'apple-touch-icon.png', size: 180, rounded: false },
];

for (const t of targets) {
  const rgba = drawIcon(t.size, { rounded: t.rounded });
  writeFileSync(`public/icons/${t.file}`, encodePng(t.size, t.size, rgba));
  console.log('scritta', t.file);
}

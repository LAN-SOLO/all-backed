// Generates the extension icons (16/32/48/128) as PNGs — no dependencies.
// Design: dark slate rounded square, sky-blue "download into tray" glyph,
// matching the lan-solo.com palette (#0f172a / #38bdf8).
// Rasterized with 4x supersampling; PNG encoded by hand via node:zlib.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const BG = [15, 23, 42]; // #0f172a
const FG = [56, 189, 248]; // #38bdf8

// stroke segments in a 24-unit design space, drawn with round caps
const SEGMENTS = [
  [5.2, 13.5, 5.2, 18.2],
  [5.2, 18.2, 18.8, 18.2],
  [18.8, 18.2, 18.8, 13.5],
  [12, 4.8, 12, 12.8],
  [8.6, 9.8, 12, 13.6],
  [12, 13.6, 15.4, 9.8],
];
const LINE_WIDTH = 2.4;

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function insideRoundedRect(x, y, size, radius) {
  if (x < 0 || y < 0 || x > size || y > size) return false;
  const cx = Math.max(radius, Math.min(size - radius, x));
  const cy = Math.max(radius, Math.min(size - radius, y));
  return Math.hypot(x - cx, y - cy) <= radius;
}

function render(size) {
  const SS = 4; // supersampling
  const pixels = new Uint8Array(size * size * 4);
  const radius = size * 0.21;
  const unit = size / 24;
  const halfStroke = (LINE_WIDTH * unit) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (!insideRoundedRect(px, py, size, radius)) continue;
          bgHits += 1;
          const ux = px / unit;
          const uy = py / unit;
          for (const [x1, y1, x2, y2] of SEGMENTS) {
            if (distToSegment(ux, uy, x1, y1, x2, y2) <= halfStroke / unit) {
              fgHits += 1;
              break;
            }
          }
        }
      }
      const total = SS * SS;
      const alpha = bgHits / total;
      const fgRatio = bgHits === 0 ? 0 : fgHits / bgHits;
      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        pixels[offset + channel] = Math.round(BG[channel] + (FG[channel] - BG[channel]) * fgRatio);
      }
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

// --- minimal PNG encoder (RGBA, 8-bit) ---

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(render(size), size);
  writeFileSync(`public/icons/icon${size}.png`, png);
  console.log(`public/icons/icon${size}.png (${png.length} B)`);
}

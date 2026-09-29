/**
 * App icon generator
 *
 * Generates the PNG app icons, favicon and logo using only Node built-ins
 * (zlib), so `node scripts/generate-icons.js` works offline with no install.
 *
 * The default mark is deliberately neutral — an invoice sheet, not a
 * product-specific emblem — because this is a white-label template. Swap
 * `drawMarkIcon()` for a client's own mark and re-run to rebrand the icons.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GREEN = [46, 125, 50];      // #2E7D32
const GREEN_DARK = [27, 94, 32];  // darker edge
const GOLD = [249, 168, 37];      // #F9A825
const GOLD_LIGHT = [255, 213, 79];
const CREAM = [255, 248, 225];

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- Drawing helpers (normalized 0..1 coordinate space) ---
function createCanvas(size) {
  const buf = Buffer.alloc(size * size * 4);
  return { size, buf };
}

function setPixel(c, x, y, rgb, a = 255) {
  const { size, buf } = c;
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  // simple blend over what's there (assume opaque base)
  buf[i] = rgb[0];
  buf[i + 1] = rgb[1];
  buf[i + 2] = rgb[2];
  buf[i + 3] = a;
}

function fillRect(c, x0, y0, x1, y1, rgb, a = 255) {
  const { size } = c;
  const ax = Math.max(0, Math.floor(Math.min(x0, x1) * size));
  const ay = Math.max(0, Math.floor(Math.min(y0, y1) * size));
  const bx = Math.min(size - 1, Math.ceil(Math.max(x0, x1) * size));
  const by = Math.min(size - 1, Math.ceil(Math.max(y0, y1) * size));
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) setPixel(c, x, y, rgb, a);
}

function fillCircle(c, cx, cy, r, rgb, a = 255) {
  const { size } = c;
  const rad = r * size;
  const px = cx * size;
  const py = cy * size;
  const x0 = Math.max(0, Math.floor(px - rad));
  const x1 = Math.min(size - 1, Math.ceil(px + rad));
  const y0 = Math.max(0, Math.floor(py - rad));
  const y1 = Math.min(size - 1, Math.ceil(py + rad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - px;
      const dy = y + 0.5 - py;
      if (dx * dx + dy * dy <= rad * rad) setPixel(c, x, y, rgb, a);
    }
  }
}

function fillTriangle(c, p1, p2, p3, rgb, a = 255) {
  const { size } = c;
  const pts = [p1, p2, p3].map(([u, v]) => [u * size, v * size]);
  const minX = Math.max(0, Math.floor(Math.min(...pts.map(p => p[0]))));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(...pts.map(p => p[0]))));
  const minY = Math.max(0, Math.floor(Math.min(...pts.map(p => p[1]))));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(...pts.map(p => p[1]))));
  const area = (a1, a2, a3) => (a2[0] - a1[0]) * (a3[1] - a1[1]) - (a2[1] - a1[1]) * (a3[0] - a1[0]);
  const A = area(pts[0], pts[1], pts[2]);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const q = [x + 0.5, y + 0.5];
      const w0 = area(pts[1], pts[2], q);
      const w1 = area(pts[2], pts[0], q);
      const w2 = area(pts[0], pts[1], q);
      const eps = 0.0001;
      const inside = (A >= 0) ? (w0 >= -eps && w1 >= -eps && w2 >= -eps) : (w0 <= eps && w1 <= eps && w2 <= eps);
      if (inside) setPixel(c, x, y, rgb, a);
    }
  }
}

/**
 * Default app mark: green full-bleed background + an invoice sheet.
 * Produces opaque RGBA. Full bleed is correct for PWA maskable icons; the
 * rounded variant is cut afterwards with applyRoundedMask().
 *
 * Everything is expressed in 0..1 coordinates so one definition renders
 * correctly at 32px and at 512px.
 */
function drawMarkIcon(size) {
  const c = createCanvas(size);
  // Background — full bleed green, with a darker strip along the bottom edge
  // so the tile reads as a solid object rather than a flat square.
  fillRect(c, 0, 0, 1, 1, GREEN);
  fillRect(c, 0, 0.95, 1, 1, GREEN_DARK);

  const L = 0.26, R = 0.74, T = 0.16, B = 0.84;   // sheet bounds
  // Sheet
  fillRect(c, L, T, R, B, CREAM);
  // Header band across the top of the sheet
  fillRect(c, L, T, R, 0.27, GOLD);
  fillRect(c, L, T, R, 0.215, GOLD_LIGHT);
  // Line items
  fillRect(c, 0.34, 0.36, 0.66, 0.405, GREEN_DARK);
  fillRect(c, 0.34, 0.455, 0.58, 0.50, GREEN_DARK);
  fillRect(c, 0.34, 0.55, 0.66, 0.595, GREEN_DARK);
  // Total row — heavier, in gold, so it is legible at 32px
  fillRect(c, 0.34, 0.665, 0.66, 0.745, GOLD);
  // Torn bottom edge: notch the sheet with background-coloured wedges
  const n = 4, w = (R - L) / n;
  for (let i = 0; i < n; i++) {
    const x0 = L + i * w;
    fillTriangle(c, [x0, B], [x0 + w / 2, B - 0.05], [x0 + w, B], GREEN);
  }
  return c;
}

/**
 * Rounded-square mask: makes the area outside the corner radius transparent.
 *
 * A pixel is only cut when it sits inside one of the four corner squares AND
 * further from that corner's circle centre than the radius. `cornerSigns`
 * gives, per corner, the direction pointing *into* that corner from its
 * centre: top-left (-1,-1), top-right (+1,-1), bottom-left (-1,+1),
 * bottom-right (+1,+1).
 *
 * (These signs used to be flipped, which cut 100% of pixels and shipped fully
 * transparent icons. `scripts/test-assets.js` now guards against a repeat.)
 */
function applyRoundedMask(c, radiusNorm = 0.18) {
  const { size, buf } = c;
  const r = radiusNorm * size;
  const corners = [
    [r, r], [size - 1 - r, r], [r, size - 1 - r], [size - 1 - r, size - 1 - r]
  ];
  const cornerSigns = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let k = 0; k < 4; k++) {
        const [cx, cy] = corners[k];
        const [sx, sy] = cornerSigns[k];
        // Is the pixel on the far side of the corner centre, i.e. inside the
        // square that the rounded corner is carved out of?
        const inCornerX = sx > 0 ? x > cx : x < cx;
        const inCornerY = sy > 0 ? y > cy : y < cy;
        if (inCornerX && inCornerY) {
          const dx = (x - cx) * sx;
          const dy = (y - cy) * sy;
          if (dx * dx + dy * dy > r * r) {
            buf[(y * size + x) * 4 + 3] = 0; // transparent
          }
        }
      }
    }
  }
}

/** Logo: cream canvas with the mark inset, for use as a square brand asset. */
function drawLogo(size) {
  const c = createCanvas(size);
  fillRect(c, 0, 0, 1, 1, CREAM);
  // Thin green rules top and bottom so the logo reads as a lockup.
  fillRect(c, 0, 0, 1, 0.05, GREEN);
  fillRect(c, 0, 0.95, 1, 1, GREEN);
  const inner = Math.floor(size * 0.78);
  const mark = drawMarkIcon(inner);
  applyRoundedMask(mark, 0.18);
  const off = Math.floor(size * 0.11);
  for (let y = 0; y < mark.size; y++) {
    // Alpha-aware composite: the rounded corners must let the cream show through.
    for (let x = 0; x < mark.size; x++) {
      const si = (y * mark.size + x) * 4;
      if (mark.buf[si + 3] === 0) continue;
      const di = ((y + off) * c.size + (x + off)) * 4;
      c.buf[di] = mark.buf[si];
      c.buf[di + 1] = mark.buf[si + 1];
      c.buf[di + 2] = mark.buf[si + 2];
      c.buf[di + 3] = mark.buf[si + 3];
    }
  }
  return c;
}

const outDir = path.join(__dirname, '..', 'assets', 'icons');

function save(c, name) {
  fs.writeFileSync(path.join(outDir, name), encodePNG(c.size, c.size, c.buf));
  console.log('wrote', name, c.size + 'x' + c.size);
}

const sizes = [192, 512];
for (const s of sizes) {
  const icon = drawMarkIcon(s);
  applyRoundedMask(icon, 0.18);
  save(icon, `icon-${s}.png`);
  const mask = drawMarkIcon(s);
  save(mask, `icon-maskable-${s}.png`);
}

// favicon 32 & apple 180
const fav = drawMarkIcon(32);
applyRoundedMask(fav, 0.2);
save(fav, 'favicon-32.png');
const apple = drawMarkIcon(180);
applyRoundedMask(apple, 0.18);
save(apple, 'apple-touch-icon.png');

// copy favicon to root
fs.writeFileSync(path.join(__dirname, '..', 'favicon.png'), encodePNG(fav.size, fav.size, fav.buf));
console.log('wrote favicon.png');

// logo.png (brand placeholder)
const logo = drawLogo(1024);
save(logo, `logo.png`); // note: saved under assets/icons; root logo copy below
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'logo.png'), encodePNG(logo.size, logo.size, logo.buf));
console.log('wrote assets/logo.png');

console.log('All icons generated.');
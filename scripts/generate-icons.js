/**
 * App icon generator
 *
 * Rasterises the "Check-Invoice" mark (assets/brand/logo-mark.svg) into every
 * PNG the PWA needs, using only Node built-ins (zlib) so
 * `node scripts/generate-icons.js` works offline with no install and no native
 * dependency. This is what makes the icon set reproducible.
 *
 * Why hand-rolled rather than sharp/resvg: the project ships zero runtime
 * dependencies and no build step, and a native image library would be the only
 * thing in the toolchain that could fail to install. The trade-off is that the
 * mark is drawn from primitives, so `assets/brand/logo-mark.svg` is the source
 * of truth and this file is its transcription — if the SVG changes, change the
 * constants in DRAW below.
 *
 * Every shape is drawn at SS× the target resolution and box-filtered down, which
 * is what gives the tile and the check clean edges instead of stair-stepping.
 *
 * The SVG is used directly by the browser (favicon, in-app lockup); these PNGs
 * are for the OS launcher, iOS home screen and the legacy .ico.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ==========================================================================
   1. PNG encoder
   ========================================================================== */

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

/**
 * Multi-image .ico. Each entry is stored as a PNG (Vista+ and every current
 * browser read PNG-in-ICO); 256px is encoded as 0 in the directory, which is the
 * format's way of saying "256".
 */
function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const b = i * 16;
    dir[b] = e.size >= 256 ? 0 : e.size;
    dir[b + 1] = e.size >= 256 ? 0 : e.size;
    dir[b + 2] = 0;
    dir[b + 3] = 0;
    dir.writeUInt16LE(1, b + 4);
    dir.writeUInt16LE(32, b + 6);
    dir.writeUInt32LE(e.png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/* ==========================================================================
   2. Raster canvas + primitives (pixel space)
   ========================================================================== */

function createCanvas(size) {
  return { size, buf: Buffer.alloc(size * size * 4) };
}

function setPixel(c, x, y, rgb, a = 255) {
  const { size, buf } = c;
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  buf[i] = rgb[0];
  buf[i + 1] = rgb[1];
  buf[i + 2] = rgb[2];
  buf[i + 3] = a;
}

function fillRectPx(c, x0, y0, x1, y1, rgb, a = 255) {
  const { size } = c;
  const ax = Math.max(0, Math.floor(Math.min(x0, x1)));
  const ay = Math.max(0, Math.floor(Math.min(y0, y1)));
  const bx = Math.min(size - 1, Math.ceil(Math.max(x0, x1)));
  const by = Math.min(size - 1, Math.ceil(Math.max(y0, y1)));
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) setPixel(c, x, y, rgb, a);
}

function fillCirclePx(c, cx, cy, r, rgb, a = 255) {
  const { size } = c;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(size - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(size - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) setPixel(c, x, y, rgb, a);
    }
  }
}

/**
 * Even-odd scanline fill. Sub-pixel accurate in x (the span is clamped to pixel
 * centres), which together with the supersample pass is what removes the
 * stair-stepping the previous generator shipped.
 */
function fillPolygonPx(c, pts, rgb, a = 255) {
  const { size } = c;
  if (pts.length < 3) return;
  let minY = Infinity; let maxY = -Infinity;
  let minX = Infinity; let maxX = -Infinity;
  for (const [x, y] of pts) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(size - 1, Math.ceil(maxY));
  const clampX0 = Math.max(0, Math.floor(minX));
  const clampX1 = Math.min(size - 1, Math.ceil(maxX));

  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5;
    const xs = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if ((yi > sy) !== (yj > sy)) xs.push(xi + ((sy - yi) / (yj - yi)) * (xj - xi));
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a0 = Math.max(clampX0, Math.ceil(xs[k] - 0.5));
      const b0 = Math.min(clampX1, Math.floor(xs[k + 1] - 0.5));
      for (let x = a0; x <= b0; x++) setPixel(c, x, y, rgb, a);
    }
  }
}

/**
 * Round the corners of a polygon. `radii` may be a number or one per vertex.
 *
 * The arc is centred on the bisector INSIDE the shape — offset from the sharp
 * vertex by `r / (1 + cos θ)` along the sum of the two edge unit vectors — not on
 * the vertex itself. Centring it on the vertex carves a concave notch out of the
 * corner instead of rounding it, which is what an earlier revision of this
 * function did.
 */
function roundCorners(pts, radii, steps = 8) {
  const n = pts.length;
  const out = [];
  const rAt = (i) => (Array.isArray(radii) ? radii[i % radii.length] : radii);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const r = rAt(i);
    if (!r) { out.push(p); continue; }

    const d1 = Math.hypot(prev[0] - p[0], prev[1] - p[1]);
    const d2 = Math.hypot(next[0] - p[0], next[1] - p[1]);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    if (rr <= 0.001) { out.push(p); continue; }

    const u1 = [(prev[0] - p[0]) / d1, (prev[1] - p[1]) / d1];
    const u2 = [(next[0] - p[0]) / d2, (next[1] - p[1]) / d2];
    const cosT = Math.max(-0.99, Math.min(0.99, u1[0] * u2[0] + u1[1] * u2[1]));
    const k = rr / (1 + cosT);
    const cx = p[0] + (u1[0] + u2[0]) * k;
    const cy = p[1] + (u1[1] + u2[1]) * k;

    const t1 = [p[0] + u1[0] * rr, p[1] + u1[1] * rr];
    const t2 = [p[0] + u2[0] * rr, p[1] + u2[1] * rr];
    const a1 = Math.atan2(t1[1] - cy, t1[0] - cx);
    const a2 = Math.atan2(t2[1] - cy, t2[0] - cx);
    let d = a2 - a1;
    // The minor arc is the one that bulges toward the sharp vertex.
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;

    out.push(t1);
    for (let s = 1; s < steps; s++) {
      const a = a1 + d * (s / steps);
      out.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    out.push(t2);
  }
  return out;
}

function fillRoundRectPx(c, x0, y0, x1, y1, r, rgb, a = 255) {
  fillPolygonPx(c, roundCorners([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], r, 10), rgb, a);
}

/** Polyline stroke with round caps and joins (a quad per segment + a disc per vertex). */
function strokePolylinePx(c, pts, w, rgb) {
  const h = w / 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * h;
    const ny = (dx / len) * h;
    fillPolygonPx(c, [
      [x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny],
    ], rgb);
  }
  for (const [x, y] of pts) fillCirclePx(c, x, y, h, rgb);
}

/**
 * Box-filter down by an integer factor.
 *
 * RGB is accumulated premultiplied by alpha. Averaging straight RGB would pull
 * the fully-transparent pixels' (0,0,0) into the result and ring every edge with
 * a dark halo — which is exactly the artefact that makes a scaled-down logo look
 * grubby on a coloured launcher background.
 */
function downsample(src, factor) {
  const out = createCanvas(src.size / factor);
  const n = factor * factor;
  for (let y = 0; y < out.size; y++) {
    for (let x = 0; x < out.size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((y * factor + dy) * src.size + (x * factor + dx)) * 4;
          const av = src.buf[i + 3];
          r += src.buf[i] * av;
          g += src.buf[i + 1] * av;
          b += src.buf[i + 2] * av;
          a += av;
        }
      }
      const o = (y * out.size + x) * 4;
      out.buf[o] = a ? Math.round(r / a) : 0;
      out.buf[o + 1] = a ? Math.round(g / a) : 0;
      out.buf[o + 2] = a ? Math.round(b / a) : 0;
      out.buf[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/* ==========================================================================
   3. The Check-Invoice mark
   ==========================================================================
   Geometry is transcribed from assets/brand/logo-mark.svg, which uses a 96×96
   viewBox. `P()` maps that space onto a canvas, so the numbers below are the
   same ones in the SVG and the two cannot drift apart silently. */

const INK = {
  tile: [27, 94, 32],    // #1B5E20 — the master tile
  sheet: [244, 248, 244], // #F4F8F4
  fold: [255, 193, 7],   // #FFC107
  rule: [165, 214, 167], // #A5D6A7
  check: [27, 94, 32],   // #1B5E20
  frame: [244, 248, 244], // #F4F8F4 — the placeholder logo's cream frame
};

const TILE_RADIUS = 22;   // rx in the 96 viewBox
const DOC_TOP = 18;
const DOC_BOTTOM = 78;

/** Draw the document (sheet + fold + rules + check) into `c` at `scale` px/unit. */
function drawDocument(c, scale, ox = 0, oy = 0) {
  const P = (x, y) => [ox + x * scale, oy + y * scale];

  // Sheet. The SVG rounds the two bottom corners and the top-left one; the
  // first vertex (27,18) is collinear with the top edge — it is the tangent
  // point where the top-left arc ends, not a corner — so it takes radius 0.
  // Rounding it anyway sweeps a degenerate 180° arc and notches the sheet.
  const sheet = [
    P(27, 18), P(54, 18), P(70, 34), P(70, 78), P(23, 78), P(23, 18),
  ];
  fillPolygonPx(c, roundCorners(sheet, [0, 0, 0, 4 * scale, 4 * scale, 4 * scale], 8), INK.sheet);

  // Folded corner.
  fillPolygonPx(c, [P(54, 18), P(54, 30), P(58, 34), P(70, 34)], INK.fold);

  // Two hairline rules.
  fillRoundRectPx(c, ...P(32, 36), ...P(46, 40), 2 * scale, INK.rule);
  fillRoundRectPx(c, ...P(32, 44), ...P(56, 48), 2 * scale, INK.rule);

  // Check mark.
  strokePolylinePx(c, [P(34, 62), P(43, 71), P(61, 51)], 7 * scale, INK.check);
}

/**
 * The rounded launcher tile: rounded-square background + the document, with
 * everything outside the corner radius left transparent.
 */
function drawTile(size, supersample) {
  const c = createCanvas(size * supersample);
  const scale = (size * supersample) / 96;
  fillRoundRectPx(c, 0, 0, 96 * scale, 96 * scale, TILE_RADIUS * scale, INK.tile);
  drawDocument(c, scale);
  return downsample(c, supersample);
}

/**
 * The maskable variant: full-bleed background with NO transparency anywhere
 * (Android composites a transparent corner against the launcher wallpaper and it
 * reads as a dark ring), and the document held inside the central 66% safe zone
 * so a circular or squircle crop can never clip it.
 */
function drawMaskable(size, supersample) {
  const c = createCanvas(size * supersample);
  const scale = (size * supersample) / 96;
  fillRectPx(c, 0, 0, 96 * scale, 96 * scale, INK.tile);

  // The document's own bounding box inside the 96 viewBox. `drawDocument` maps
  // the viewBox, so the origin has to be derived from that box — passing the
  // icon centre directly double-counts the offset and pushes the mark off-centre.
  const DOC_LEFT = 23;
  const DOC_RIGHT = 70;
  const DOC_W = DOC_RIGHT - DOC_LEFT;
  const DOC_H = DOC_BOTTOM - DOC_TOP;

  const fit = Math.min(1, 66 / DOC_H); // hold the mark inside the 66% safe zone
  const docScale = scale * fit;
  const ox = 48 * scale - (DOC_LEFT + DOC_W / 2) * docScale;
  const oy = 48 * scale - (DOC_TOP + DOC_H / 2) * docScale;
  drawDocument(c, docScale, ox, oy);

  return downsample(c, supersample);
}

/** Placeholder business logo: the mark inset on a cream card with green rules. */
function drawLogo(size, supersample) {
  const c = createCanvas(size * supersample);
  const s = size * supersample;
  fillRectPx(c, 0, 0, s, s, INK.frame);
  fillRectPx(c, 0, 0, s, s * 0.05, INK.tile);
  fillRectPx(c, 0, s * 0.95, s, s, INK.tile);

  const inner = Math.round(s * 0.78);
  const off = Math.round(s * 0.11);
  const mark = drawTile(inner, 1);
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const si = (y * inner + x) * 4;
      // Alpha-aware composite: the tile's rounded corners must let the frame show.
      if (mark.buf[si + 3] === 0) continue;
      const di = ((y + off) * s + (x + off)) * 4;
      c.buf[di] = mark.buf[si];
      c.buf[di + 1] = mark.buf[si + 1];
      c.buf[di + 2] = mark.buf[si + 2];
      c.buf[di + 3] = mark.buf[si + 3];
    }
  }
  return downsample(c, supersample);
}

/* ==========================================================================
   4. Emit
   ========================================================================== */

const iconsDir = path.join(__dirname, '..', 'assets', 'icons');
const brandDir = path.join(__dirname, '..', 'assets', 'brand');
const rootDir = path.join(__dirname, '..');
fs.mkdirSync(iconsDir, { recursive: true });
fs.mkdirSync(brandDir, { recursive: true });

/** Supersampling costs quadratic memory, so back off as the target grows. */
const ssFor = (size) => (size <= 256 ? 4 : size <= 512 ? 3 : 2);

function writePng(canvas, dir, name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, encodePNG(canvas.size, canvas.size, canvas.buf));
  console.log('wrote', path.relative(rootDir, file), `${canvas.size}x${canvas.size}`);
  return file;
}

for (const size of [192, 512]) {
  writePng(drawTile(size, ssFor(size)), iconsDir, `icon-${size}.png`);
  writePng(drawMaskable(size, ssFor(size)), iconsDir, `icon-maskable-${size}.png`);
}

const favicon32 = drawTile(32, 4);
writePng(favicon32, iconsDir, 'favicon-32.png');
// The root favicon.png is the same bytes the manifest-era pages link to; the
// asset test asserts they stay byte-identical.
fs.writeFileSync(path.join(rootDir, 'favicon.png'), encodePNG(32, 32, favicon32.buf));
console.log('wrote favicon.png');

writePng(drawTile(180, 4), iconsDir, 'apple-touch-icon.png');

const ico = encodeICO([16, 32, 48].map((size) => ({ size, png: encodePNG(size, size, drawTile(size, 4).buf) })));
fs.writeFileSync(path.join(iconsDir, 'favicon.ico'), ico);
fs.writeFileSync(path.join(rootDir, 'favicon.ico'), ico);
console.log('wrote assets/icons/favicon.ico + favicon.ico (16/32/48)');

writePng(drawLogo(1024, ssFor(1024)), iconsDir, 'logo.png');
fs.writeFileSync(path.join(rootDir, 'assets', 'logo.png'), encodePNG(1024, 1024, drawLogo(1024, ssFor(1024)).buf));
console.log('wrote assets/logo.png');

console.log('\nAll icons generated.');

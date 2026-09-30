/**
 * Brand engine test
 *
 * The important test here is the PARITY check: js/brand-boot.js duplicates the
 * palette algorithm from js/brand.js (it must, because ES modules are deferred
 * and would flash the default theme before applying). If those two ever drift,
 * a client sees one palette on first paint and another a frame later.
 *
 * Run: node scripts/test-brand.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPalette, normalizeBrand, matchPreset, paletteToCss, pdfColors,
  hexToRgb, rgbToHex, lighten, darken, mix, withAlpha,
  relativeLuminance, contrastRatio, readableOn, ensureContrast, contrastGrade,
  PRESETS, SIDEBAR_STYLES, DEFAULT_BRAND, isValidHex,
} from '../js/brand.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;

function assert(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name} \u2014 expected ${expected}, got ${actual}`); }
}

function assertTrue(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${detail ? ' \u2014 ' + detail : ''}`); }
}

/* ---------- Load brand-boot.js the way a browser would ---------- */
function loadBoot(written = {}) {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'brand-boot.js'), 'utf8');
  const win = {};
  const doc = {
    title: '',
    documentElement: {
      style: { setProperty(k, v) { written[k] = v; } },
      setAttribute() {},
    },
    // brand-boot.js now stamps the white-label identity (name, tagline, logo
    // initials) before first paint, so it reaches for these nodes on boot.
    getElementById() { return null; },
    querySelector() { return { setAttribute() {} }; },
  };
  const localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  new Function('window', 'document', 'localStorage', src)(win, doc, localStorage);
  return win.BrandBoot;
}

const Boot = loadBoot();

/* ================= Color math ================= */
console.log('== Color math ==');
assert('hexToRgb #2E7D32', JSON.stringify(hexToRgb('#2E7D32')), JSON.stringify({ r: 46, g: 125, b: 50 }));
assert('hexToRgb short #FFF', JSON.stringify(hexToRgb('#FFF')), JSON.stringify({ r: 255, g: 255, b: 255 }));
assert('hexToRgb invalid', hexToRgb('nope'), null);
assert('isValidHex rejects 5-digit', isValidHex('#12345'), false);
assert('isValidHex accepts no-hash', isValidHex('2E7D32'), true);
assert('rgbToHex round-trip', rgbToHex(hexToRgb('#F9A825')), '#F9A825');
assert('mix midpoint white/black', mix('#FFFFFF', '#000000', 0.5), '#808080');
assert('mix weight 0 = first', mix('#123456', '#FFFFFF', 0), '#123456');
assert('mix weight 1 = second', mix('#123456', '#FFFFFF', 1), '#FFFFFF');
assert('lighten white saturates', lighten('#FFFFFF', 0.2), '#FFFFFF');
assert('darken black saturates', darken('#000000', 0.2), '#000000');
assert('withAlpha', withAlpha('#2E7D32', 0.5), 'rgba(46, 125, 50, 0.5)');
assert('withAlpha clamps', withAlpha('#2E7D32', 5), 'rgba(46, 125, 50, 1)');
assert('luminance white', relativeLuminance('#FFFFFF'), 1);
assert('luminance black', relativeLuminance('#000000'), 0);
assert('contrast white/black', Math.round(contrastRatio('#FFFFFF', '#000000')), 21);
assert('contrast identical', contrastRatio('#2E7D32', '#2E7D32'), 1);
assert('readableOn white bg', readableOn('#FFFFFF'), '#1A1A1A');
assert('readableOn black bg', readableOn('#000000'), '#FFFFFF');
assert('contrastGrade 21 = AAA', contrastGrade(21).label, 'AAA');
assert('contrastGrade 4.5 = AA', contrastGrade(4.5).label, 'AA');
assert('contrastGrade 2 = Fail', contrastGrade(2).label, 'Fail');
assert('ensureContrast returns input when already ok', ensureContrast('#000000', '#FFFFFF', 4.5), '#000000');
assertTrue('ensureContrast darkens pale color', contrastRatio(ensureContrast('#FFF9C4', '#FFFFFF', 4.5), '#FFFFFF') >= 4.5);

/* ================= normalizeBrand ================= */
console.log('\n== normalizeBrand ==');
assert('invalid primary falls back', normalizeBrand({ primary: 'zzz' }).primary, DEFAULT_BRAND.primary);
assert('uppercases colors', normalizeBrand({ primary: '#abcdef' }).primary, '#ABCDEF');
assert('radius clamped high', normalizeBrand({ radius: 999 }).radius, 24);
assert('radius clamped low', normalizeBrand({ radius: -5 }).radius, 0);
assert('radius rounds', normalizeBrand({ radius: 11.6 }).radius, 12);
assert('radius non-numeric falls back', normalizeBrand({ radius: 'abc' }).radius, DEFAULT_BRAND.radius);
assert('unknown sidebar falls back', normalizeBrand({ sidebar: 'hacker' }).sidebar, 'gradient');
assert('appName trimmed + capped', normalizeBrand({ appName: '  ' + 'x'.repeat(100) + '  ' }).appName.length, 60);
assert('null input safe', normalizeBrand(null).primary, DEFAULT_BRAND.primary);
assert('array input safe', normalizeBrand([]).primary, DEFAULT_BRAND.primary);
assert('matchPreset finds the default preset', matchPreset('#1B5E20', '#FFC107'), 'signature');
assert('matchPreset case-insensitive', matchPreset('#1b5e20', '#ffc107'), 'signature');
assert('preset alias: legacy crown id maps to signature', normalizeBrand({ preset: 'crown' }).preset, 'signature');
assert('matchPreset unknown = custom', matchPreset('#123456', '#654321'), 'custom');

/* ================= PARITY: brand.js vs brand-boot.js ================= */
console.log('\n== Parity: brand.js vs brand-boot.js ==');
{
  const inputs = [];
  for (const p of PRESETS) {
    for (const sidebar of SIDEBAR_STYLES.map((s) => s.id)) {
      for (const radius of [0, 8, 12, 18, 24]) {
        inputs.push({ preset: p.id, primary: p.primary, accent: p.accent, radius, sidebar });
      }
    }
  }
  inputs.push({ primary: '#FFF9C4', accent: '#FFFDE7', radius: 12, sidebar: 'light' }); // pale
  inputs.push({ primary: '#000000', accent: '#FFFFFF', radius: 24, sidebar: 'deep' });   // extremes

  let mismatches = [];
  for (const input of inputs) {
    for (const theme of ['light', 'dark']) {
      const a = buildPalette(input, theme);
      const b = Boot.buildPalette(input, theme);
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const k of keys) {
        if (a[k] !== b[k]) {
          mismatches.push(`${theme} ${input.primary}/${input.accent}/${input.sidebar}/r${input.radius} ${k}: brand.js=${a[k]} boot=${b[k]}`);
        }
      }
    }
  }
  assertTrue(
    `palettes identical across ${inputs.length} brands x 2 themes`,
    mismatches.length === 0,
    mismatches.slice(0, 6).join(' | ')
  );
  assert('same key count', Object.keys(buildPalette(DEFAULT_BRAND, 'light')).length,
    Object.keys(Boot.buildPalette(Boot.DEFAULT_BRAND, 'light')).length);
}

/* ================= Contrast guarantees ================= */
console.log('\n== Contrast guarantees (all presets, both themes) ==');
{
  let bad = [];
  for (const p of PRESETS) {
    for (const theme of ['light', 'dark']) {
      const v = buildPalette({ ...p, radius: 12, sidebar: 'gradient' }, theme);
      const surface = theme === 'dark' ? '#12231A' : '#FFFFFF';

      const inkOnSurface = contrastRatio(v['--brand-ink'], surface);
      if (inkOnSurface < 4.5) bad.push(`${p.id}/${theme} brand-ink on surface = ${inkOnSurface.toFixed(2)}`);

      const onBrand = contrastRatio(v['--brand-contrast'], v['--brand']);
      if (onBrand < 4.5) bad.push(`${p.id}/${theme} contrast on brand fill = ${onBrand.toFixed(2)}`);

      const onAccent = contrastRatio(v['--gold-contrast'], v['--gold']);
      if (onAccent < 4.5) bad.push(`${p.id}/${theme} contrast on accent fill = ${onAccent.toFixed(2)}`);

      const activeOnActive = contrastRatio(v['--sidebar-active-fg'], v['--sidebar-active-bg']);
      if (activeOnActive < 4.5) bad.push(`${p.id}/${theme} sidebar active = ${activeOnActive.toFixed(2)}`);
    }
  }
  assertTrue('every preset meets WCAG AA for text/fill pairs', bad.length === 0, bad.slice(0, 6).join(' | '));
}

/* ================= Radius + sidebar tokens ================= */
console.log('\n== Radius + sidebar ==');
{
  const v = buildPalette({ ...DEFAULT_BRAND, radius: 10 }, 'light');
  assert('--radius', v['--radius'], '10px');
  assert('--radius-sm', v['--radius-sm'], '7px');
  assert('--radius-lg', v['--radius-lg'], '13px');
  assert('--radius-xl', v['--radius-xl'], '20px');

  const z = buildPalette({ ...DEFAULT_BRAND, radius: 0 }, 'light');
  assert('radius 0 keeps min on sm', z['--radius-sm'], '3px');

  for (const s of SIDEBAR_STYLES) {
    const sv = buildPalette({ ...DEFAULT_BRAND, sidebar: s.id }, 'light');
    assertTrue(`sidebar "${s.id}" defines --sidebar-bg`, typeof sv['--sidebar-bg'] === 'string' && sv['--sidebar-bg'].length > 0);
  }
  const light = buildPalette({ ...DEFAULT_BRAND, sidebar: 'light' }, 'light');
  assert('light sidebar uses a light surface', light['--sidebar-bg'], '#FFFFFF');
  assert('light sidebar uses dark text', light['--sidebar-fg'], '#2B2B2B');
}

/* ================= CSS defaults stay in sync ================= */
console.log('\n== css/styles.css defaults match the engine ==');
{
  const css = fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8');

  const blockFor = (selector) => {
    const i = css.indexOf(selector);
    if (i === -1) return '';
    const open = css.indexOf('{', i);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
  };
  const readVar = (block, name) => {
    const m = block.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
    return m ? m[1].trim() : null;
  };

  const rootBlock = blockFor(':root {');
  const darkBlock = blockFor('[data-theme="dark"] {');
  const lightVars = buildPalette(DEFAULT_BRAND, 'light');
  const darkVars = buildPalette(DEFAULT_BRAND, 'dark');

  // Only the brand-derived tokens are asserted; neutral tokens are hand-tuned.
  const checked = ['brand', 'brand-dark', 'brand-darker', 'brand-light', 'brand-soft', 'brand-ink',
    'brand-contrast', 'gold', 'gold-light', 'gold-soft', 'gold-ink', 'gold-contrast'];

  let drift = [];
  for (const k of checked) {
    if (readVar(rootBlock, k) !== lightVars[`--${k}`]) {
      drift.push(`light --${k}: css=${readVar(rootBlock, k)} engine=${lightVars[`--${k}`]}`);
    }
    if (readVar(darkBlock, k) !== darkVars[`--${k}`]) {
      drift.push(`dark --${k}: css=${readVar(darkBlock, k)} engine=${darkVars[`--${k}`]}`);
    }
  }
  assertTrue('CSS :root + dark tokens match buildPalette(DEFAULT_BRAND)', drift.length === 0, drift.join(' | '));
}

/* ================= Output helpers ================= */
console.log('\n== Output helpers ==');
{
  const css = paletteToCss(DEFAULT_BRAND, 'light');
  assertTrue('paletteToCss emits :root block', css.startsWith(':root {') && css.includes('--brand:'));
  assertTrue('paletteToCss has no unresolved template holes', !css.includes('undefined') && !css.includes('[object'));

  const p = pdfColors(DEFAULT_BRAND, 'light');
  assert('pdfColors brand is an rgb triple', p.brand.length, 3);
  assertTrue('pdfColors brand matches hex', p.brand.join(',') === hexToRgb(DEFAULT_BRAND.primary).r + ',' + hexToRgb(DEFAULT_BRAND.primary).g + ',' + hexToRgb(DEFAULT_BRAND.primary).b);
  assertTrue('pdfColors exposes brandInk + accentInk', Array.isArray(p.brandInk) && Array.isArray(p.accentInk));
  assertTrue('pdfColors brandContrast is valid', p.brandContrast.length === 3 && p.brandContrast.every((n) => n >= 0 && n <= 255));
}

/* ================= Boot script behaviour ================= */
console.log('\n== Boot script ==');
{
  assert('boot exports DEFAULT_BRAND', Boot.DEFAULT_BRAND.primary, '#1B5E20');
  assertTrue('boot normalizes bad input', Boot.normalizeBrand({ primary: 'nope' }).primary === '#1B5E20');
  assert('boot loadBrandSync with empty storage', Boot.loadBrandSync(), null);

  // applyPalette must write every token onto the element
  const written = {};
  const B2 = loadBoot(written);
  B2.applyPalette({ ...B2.DEFAULT_BRAND }, 'light');
  const expected = Object.keys(B2.buildPalette(B2.DEFAULT_BRAND, 'light'));
  const missing = expected.filter((k) => !(k in written));
  assertTrue('boot applyPalette writes all tokens', missing.length === 0, missing.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

/**
 * markup / CSS contract test
 *
 * Guards the class of bug where HTML uses a utility class the stylesheet never
 * defines. A missing `.col-span-7` does not error — the element silently collapses
 * to a single grid column and the layout looks broken with no clue why.
 *
 * Run: node scripts/test-markup.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
const assert = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${detail ? ' \u2014 ' + detail : ''}`); }
};

const PAGES = ['index.html', 'invoice.html', 'customers.html', 'products.html', 'reports.html', 'settings.html', 'admin.html'];
const css = fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8');
const definedClasses = new Set((css.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) || []).map((c) => c.slice(1)));

/* ---------- CSS parsing helpers ----------
   The stylesheet is mobile-first: the base layer targets the phone and
   `min-width` blocks add capability on top. To assert that contract we must
   know which declarations live in the base layer versus inside a media query,
   so split the sheet into top-level CSS plus a list of media blocks. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

function splitMedia(src) {
  const clean = stripComments(src);
  let base = '';
  const medias = [];
  let i = 0;
  while (i < clean.length) {
    const at = clean.indexOf('@media', i);
    if (at === -1) { base += clean.slice(i); break; }
    base += clean.slice(i, at);
    const open = clean.indexOf('{', at);
    let depth = 0;
    let j = open;
    for (; j < clean.length; j++) {
      if (clean[j] === '{') depth++;
      else if (clean[j] === '}') { depth--; if (depth === 0) break; }
    }
    medias.push({ cond: clean.slice(at + 6, open).trim(), body: clean.slice(open + 1, j) });
    i = j + 1;
  }
  return { base, medias };
}

/** Flatten a CSS string into `{ selectors[], decls }` pairs. */
function parseRules(src) {
  const out = [];
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@')) continue;
    out.push({ selectors: sel.split(',').map((s) => s.trim()), decls: m[2] });
  }
  return out;
}

/** Split a declaration value on top-level commas (ignoring commas inside parens). */
function splitTracks(value) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((t) => t.trim()).filter(Boolean);
}

const { base: cssBase, medias: cssMedias } = splitMedia(css);
const baseRules = parseRules(cssBase);
const minWidthRules = cssMedias.filter((m) => /min-width/.test(m.cond)).flatMap((m) => parseRules(m.body));
const maxWidthBlocks = cssMedias.filter((m) => /max-width/.test(m.cond));

/* ---------- 1. Every layout utility used in HTML must exist in the CSS ---------- */
console.log('== Layout utility classes ==');
{
  // Only these prefixes are part of the hand-rolled utility layer; everything
  // else is a component class or is emitted by JS at runtime.
  const UTILITY = /^(col-span-\d+|grid-cols-\d+|grid|gap-\d+|mt-\d+|mb-\d+|py-\d+|px-\d+|text-(xs|sm|base|lg|xl|2xl|3xl)|font-(semibold|bold|medium)|items-\w+|justify-\w+|flex|flex-col|truncate|hidden|relative|absolute|w-full|h-full|uppercase|capitalize|ml-auto|mr-auto|num)$/;

  const missing = new Map();
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const classAttrs = html.match(/class="[^"]*"/g) || [];
    for (const attr of classAttrs) {
      const names = attr.slice(7, -1).split(/\s+/).filter(Boolean);
      for (const n of names) {
        if (!UTILITY.test(n)) continue;
        if (!definedClasses.has(n)) {
          if (!missing.has(n)) missing.set(n, []);
          missing.get(n).push(page);
        }
      }
    }
  }
  const detail = [...missing.entries()].map(([c, p]) => `${c} (${[...new Set(p)].join(',')})`).join(' | ');
  assert('all utility classes used in HTML are defined in styles.css', missing.size === 0, detail);
}

/* ---------- 2. The mobile-first grid contract ----------
   The worst responsive bug this app shipped was a 12-column grid that was never
   collapsed: every child carries `col-span-N`, which resolved to `span 1` of 12
   and crushed each card to ~1/12 of the width (9px on a 320px phone). A grid
   class that stops collapsing fails silently, so guard the contract statically. */
console.log('\n== Grid span coverage (mobile-first) ==');
{
  const baseGridCols = new Map(); // N -> declaration body of `.grid-cols-N` at base
  const baseSpan = new Map();     // N -> declaration body of `.col-span-N` at base
  for (const rule of baseRules) {
    for (const sel of rule.selectors) {
      const g = sel.match(/^\.grid-cols-(\d+)$/);
      if (g) baseGridCols.set(Number(g[1]), rule.decls);
      const s = sel.match(/^\.col-span-(\d+)$/);
      if (s) baseSpan.set(Number(s[1]), rule.decls);
    }
  }

  // 2a. Every grid-cols-N the sheet defines must be single-column at base.
  const notCollapsed = [];
  for (const [n, decls] of baseGridCols) {
    if (!/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/.test(decls)) notCollapsed.push(n);
  }
  assert(`every grid-cols-N collapses to one column at base (${[...baseGridCols.keys()].sort((a, b) => a - b).join(', ')})`,
    baseGridCols.size > 0 && notCollapsed.length === 0, 'not collapsed: ' + notCollapsed.join(', '));

  // 2b. Any grid-cols-N used in the markup must be one of those collapsed classes.
  const usedGridCols = new Set();
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    for (const m of html.matchAll(/\bgrid-cols-(\d+)\b/g)) usedGridCols.add(Number(m[1]));
  }
  const undefinedGrids = [...usedGridCols].filter((n) => !baseGridCols.has(n));
  assert(`every grid-cols-N in the markup has a base collapse rule (${[...usedGridCols].sort((a, b) => a - b).join(', ')})`,
    undefinedGrids.length === 0, 'undefined: ' + undefinedGrids.join(', '));

  // 2c. col-span-1..12 must all exist, and all be inert at base.
  const spanMissing = [];
  for (let i = 1; i <= 12; i++) if (!baseSpan.has(i)) spanMissing.push(i);
  assert('col-span-1..12 all defined', spanMissing.length === 0, 'missing: ' + spanMissing.join(', '));

  const spanActive = [...baseSpan].filter(([, decls]) => !/grid-column:\s*auto/.test(decls)).map(([n]) => n);
  assert('col-span-* are inert (grid-column:auto) at base', spanActive.length === 0, 'active: ' + spanActive.join(', '));

  // 2d. The 12-track grid is a desktop affordance: absent at base, re-enabled
  //     only inside a min-width block, along with the spans it gives meaning to.
  assert('grid-cols-12 is NOT multi-column at base', !/repeat\(12/.test(baseGridCols.get(12) || ''), baseGridCols.get(12) || '');
  const twelveUp = minWidthRules.some((rule) =>
    rule.selectors.includes('.grid-cols-12') && /repeat\(12,\s*minmax\(0,\s*1fr\)/.test(rule.decls));
  assert('grid-cols-12 re-enabled inside a min-width block', twelveUp);

  const spanUp = new Set();
  for (const rule of minWidthRules) {
    for (const sel of rule.selectors) {
      const m = sel.match(/^\.col-span-(\d+)$/);
      if (m && new RegExp(`grid-column:\\s*span\\s+${m[1]}\\s*;`).test(rule.decls)) spanUp.add(Number(m[1]));
    }
  }
  const spanNotUp = [];
  for (let i = 1; i <= 12; i++) if (!spanUp.has(i)) spanNotUp.push(i);
  assert('col-span-1..12 all re-enabled inside a min-width block', spanNotUp.length === 0, 'missing: ' + spanNotUp.join(', '));

  // 2e. Mobile-first means capability only ever grows. A max-width block that
  //     redefines grid-cols-* would fight the min-width layer — and, because it
  //     comes later in the file, win.
  const maxWidthGrids = maxWidthBlocks
    .flatMap((m) => parseRules(m.body))
    .filter((rule) => rule.selectors.some((s) => /^\.grid-cols-/.test(s)))
    .map((rule) => rule.selectors.join(', '));
  assert('no max-width block redefines grid-cols-* (mobile-first)', maxWidthGrids.length === 0, maxWidthGrids.join(' | '));
}

/* ---------- 2b. No bare `1fr` grid track anywhere ----------
   Bare `1fr` is `minmax(auto, 1fr)`, whose auto minimum is min-content: a wide
   child (a 640px table) then forces the track — and the whole page — wider than
   the viewport. Every flexible track must be `minmax(0, 1fr)`. */
console.log('\n== Grid track minimums ==');
{
  const offenders = [];
  for (const { body } of [{ body: cssBase }, ...cssMedias]) {
    for (const rule of parseRules(body)) {
      const m = rule.decls.match(/grid-template-columns:\s*([^;]+);/);
      if (!m) continue;
      for (const track of splitTracks(m[1])) {
        if (/\b1fr\b/.test(track) && !/minmax\(/.test(track)) offenders.push(track.trim());
      }
    }
  }
  assert('every flexible grid track uses minmax(0, 1fr)', offenders.length === 0, offenders.join(' | '));
}

/* ---------- 3. Brand boot wiring in every page ---------- */
console.log('\n== Brand boot wiring ==');
{
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const headEnd = html.indexOf('</head>');
    const head = html.slice(0, headEnd);
    const bootIdx = head.indexOf('js/brand-boot.js');
    const bodyIdx = html.indexOf('<body');

    assert(`${page}: brand-boot.js in <head>`, bootIdx !== -1);
    assert(`${page}: brand-boot.js before <body>`, bootIdx !== -1 && bootIdx < bodyIdx);
    assert(`${page}: brand-boot.js is a classic (render-blocking) script`,
      /<script src="js\/brand-boot\.js"><\/script>/.test(head),
      'must not be type="module" or deferred, or the default theme paints first');
    assert(`${page}: theme-color meta present`, /<meta name="theme-color"/.test(head));
    assert(`${page}: brand-boot.js after the stylesheet`,
      head.indexOf('css/styles.css') !== -1 && head.indexOf('css/styles.css') < bootIdx);
    assert(`${page}: sidebar brand name has an id`, /id="sidebarBrandName"/.test(html));
  }
}

/* ---------- 3b. PWA head wiring on every page ----------
   The head is the one place a per-page detail is easy to forget: adding a
   favicon to index.html and not to the other five is silent, and only shows up
   as a 404 in the console on a page nobody opened. */
console.log('\n== PWA head wiring ==');
{
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    assert(`${page}: links the SVG favicon`, /<link rel="icon" href="favicon\.svg" type="image\/svg\+xml">/.test(head));
    assert(`${page}: links the .ico favicon`, /<link rel="icon" href="favicon\.ico"/.test(head));
    assert(`${page}: links the apple-touch-icon`, /<link rel="apple-touch-icon" href="assets\/icons\/apple-touch-icon\.png">/.test(head));
    assert(`${page}: declares apple-mobile-web-app-capable`, /<meta name="apple-mobile-web-app-capable" content="yes">/.test(head));
    assert(`${page}: declares mobile-web-app-capable`, /<meta name="mobile-web-app-capable" content="yes">/.test(head));
    assert(`${page}: declares an apple-mobile-web-app-title`, /<meta name="apple-mobile-web-app-title"/.test(head));
  }
  // A head full of 404s is worse than no head at all, so prove the targets exist.
  for (const rel of ['favicon.svg', 'favicon.ico', 'favicon.png', 'assets/icons/apple-touch-icon.png', 'assets/brand/favicon.svg']) {
    assert(`head-referenced file exists: ${rel}`, fs.existsSync(path.join(ROOT, rel)), rel);
  }
}

/* ---------- 3c. Fonts are self-hosted (the offline contract) ----------
   The whole app is offline-first, so a remote font host would be a silent
   dependency: it works on a developer's machine and breaks on a plane. */
console.log('\n== Self-hosted fonts ==');
{
  const css = fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8');
  const faces = css.match(/@font-face\s*\{[^}]*\}/gs) || [];
  const faceFor = (name) => faces.find((f) => new RegExp(`font-family:\\s*'${name}'`).test(f));

  assert('declares a Plus Jakarta Sans @font-face', !!faceFor('Plus Jakarta Sans'));
  assert('declares an Inter @font-face', !!faceFor('Inter'));
  assert('both faces use font-display: swap', faces.length >= 2 && faces.every((f) => /font-display:\s*swap/.test(f)));
  assert('faces reference local woff2 files', faces.every((f) => /url\('\.\.\/assets\/fonts\/[a-z-]+\.woff2'\)\s*format\('woff2'\)/.test(f)));
  assert('no remote font host is referenced', !/fonts\.(googleapis|gstatic)\.com/.test(css));
  assert('both faces declare a unicode-range subset', faces.every((f) => /unicode-range:/.test(f)));
  assert('the font stacks fall back to the platform UI stack',
    /--font-sans:\s*'Inter',\s*"Segoe UI",\s*system-ui/.test(css) &&
    /--font-display:\s*'Plus Jakarta Sans',\s*'Inter',\s*"Segoe UI"/.test(css));

  for (const f of ['assets/fonts/inter-latin.woff2', 'assets/fonts/plus-jakarta-sans-latin.woff2']) {
    assert(`font file exists: ${f}`, fs.existsSync(path.join(ROOT, f)), f);
  }
}

/* ---------- 3d. The identity ramp is declared once on :root ----------
   The app's own green/gold ramp is what the mark, the favicon and the PWA icon
   are built from. It must NOT be expressed in terms of --brand, or a client's
   palette would recolour the app's own logo. */
console.log('\n== Identity ramp ==');
{
  const css = fs.readFileSync(path.join(ROOT, 'css', 'styles.css'), 'utf8');
  const i = css.indexOf(':root {');
  const rootBlock = css.slice(i, css.indexOf('}', i));
  const has = (t) => new RegExp(`${t}(?![\\w-])\\s*:\\s*[^;]+;`).test(rootBlock);

  for (const t of [
    '--brand-900', '--brand-700', '--brand-500', '--brand-200', '--brand-100', '--brand-50',
    '--spark', '--spark-100', '--spark-900',
    '--ink', '--ink-2', '--line', '--surface', '--bg',
    '--danger', '--danger-100', '--danger-900',
    '--radius-sm', '--radius', '--radius-lg',
    '--shadow-1', '--shadow-2',
  ]) {
    assert(`:root declares ${t}`, has(t), t);
  }
  // Literal hexes, not var() indirection — see the note above.
  for (const t of ['--brand-900', '--brand-700', '--brand-500', '--spark']) {
    assert(`${t} is a literal colour, not brand-derived`,
      new RegExp(`${t}(?![\\w-])\\s*:\\s*#[0-9A-Fa-f]{6}\\s*;`).test(rootBlock), t);
  }
}

/* ---------- 4. Service worker precaches everything it must ---------- */
console.log('\n== Service worker precache ==');
{
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const shellMatch = sw.match(/const APP_SHELL = \[([\s\S]*?)\];/);
  const shell = shellMatch ? shellMatch[1] : '';
  // `listed` holds bare paths with any leading `./` stripped, e.g. `js/brand.js`.
  const listed = new Set((shell.match(/'\.\/[^']+'/g) || []).map((s) => s.slice(3, -1)));

  for (const page of PAGES) {
    assert(`sw precaches ${page}`, listed.has(page));
  }
  for (const js of ['js/brand.js', 'js/brand-boot.js', 'js/shell.js', 'js/export.js', 'js/db.js']) {
    assert(`sw precaches ${js}`, listed.has(js));
  }

  /* The self-hosted fonts and the brand sources are offline-critical: a cold
     start with no network must still paint the real typeface and the real mark.
     These are exactly the files a "add a font" change is most likely to forget. */
  for (const asset of [
    'assets/fonts/inter-latin.woff2',
    'assets/fonts/plus-jakarta-sans-latin.woff2',
    'assets/brand/logo-mark.svg',
    'assets/brand/logo-horizontal.svg',
    'assets/brand/logo-horizontal-dark.svg',
    'assets/brand/logo-mono.svg',
    'favicon.svg',
    'favicon.ico',
  ]) {
    assert(`sw precaches ${asset}`, listed.has(asset));
  }

  // Every file the sw claims to cache must actually exist on disk.
  const missingFiles = [];
  for (const entry of listed) {
    if (entry === './') continue;
    const p = path.join(ROOT, entry.replace(/^\.\//, ''));
    if (!fs.existsSync(p)) missingFiles.push(entry);
  }
  assert('every precached path exists on disk', missingFiles.length === 0, missingFiles.join(', '));

  // A stale cache name is why users get stuck on an old version.
  const cacheName = (sw.match(/const CACHE_NAME = '([^']+)'/) || [])[1];
  assert('CACHE_NAME is versioned', /-v\d+$/.test(cacheName || ''), cacheName);

  // addAll() is all-or-nothing and would break install on a single 404.
  assert('precache is resilient (no bare addAll)', !/cache\.addAll\(APP_SHELL\)/.test(sw));
}

/* ---------- 5. Form controls have accessible names ----------
   An unlabelled input is invisible to screen readers and unclickable via its
   label. Both failure modes are silent in a browser, so assert statically. */
console.log('\n== Accessible names (static) ==');
{
  const orphanLabels = [];
  const nameless = [];

  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');

    // Ranges covered by a wrapping <label>…</label>
    const wrapped = [];
    for (const m of html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)) {
      wrapped.push([m.index, m.index + m[0].length]);
    }
    const isWrapped = (i) => wrapped.some(([a, b]) => i > a && i < b);

    const forIds = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));

    for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      const attrs = m[2];
      const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
      const type = (attrs.match(/\btype="([^"]+)"/) || [])[1];
      if (type === 'hidden') continue;
      if (/\baria-label(?:ledby)?="/.test(attrs)) continue;
      if (id && forIds.has(id)) continue;
      if (isWrapped(m.index)) continue;
      nameless.push(`${page}:<${m[1]}${id ? '#' + id : ''}>`);
    }

    // A <label> with no control is invalid HTML and announces nothing.
    for (const m of html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)) {
      const hasFor = /\bfor="/.test(m[1]);
      const hasControl = /<(input|select|textarea)\b/.test(m[2]);
      if (!hasFor && !hasControl) {
        orphanLabels.push(`${page}: ${m[2].replace(/<[^>]*>/g, '').trim().slice(0, 30)}`);
      }
    }
  }

  assert('every form control has an accessible name', nameless.length === 0, nameless.join(', '));
  assert('no orphan <label> elements', orphanLabels.length === 0, orphanLabels.join(' | '));
}

/* ---------- 6. package.json scripts resolve to real files ---------- */
console.log('\n== package.json ==');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const missing = [];
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    for (const m of cmd.matchAll(/node\s+(\S+\.js)/g)) {
      if (!fs.existsSync(path.join(ROOT, m[1]))) missing.push(`${name} -> ${m[1]}`);
    }
  }
  assert('all npm scripts point at existing files', missing.length === 0, missing.join(', '));
  assert('serve uses the zero-dependency server', /node scripts\/serve\.js/.test(pkg.scripts.serve || ''), pkg.scripts.serve);
}

/* ---------- 7. Dark theme token contract ----------
   The dark theme is built by ALIASING the legacy tokens (--bg, --surface, --ink,
   --border, …) onto a new enterprise slate scale, so ~1200 lines of component
   CSS adopt the palette without a single component rule changing. That trick
   only holds while both blocks stay complete and in sync — and every way it can
   break is silent: a dropped alias just keeps the light value, a typo'd var()
   resolves to unset, and an unscoped consumer leaks dark values into light mode.
   None of those raise an error, so assert the contract statically. */
console.log('\n== Dark theme token contract ==');
{
  /* Declaration names, not values: a token is free to be re-pointed (that is the
     whole point of the layer) but a name must never go missing. */
  const declNames = (decls) => new Set([...decls.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]));
  const valueOf = (decls, name) => {
    const m = decls.match(new RegExp(`${name}(?![\\w-])\\s*:\\s*([^;]+);`));
    return m ? m[1].trim() : null;
  };

  const rootRule = baseRules.find((r) => r.selectors.includes(':root'));
  const darkRule = baseRules.find((r) => r.selectors.includes('[data-theme="dark"]'));
  assert(':root token block found', !!rootRule);
  assert('[data-theme="dark"] token block found', !!darkRule);

  const rootDecls = rootRule ? rootRule.decls : '';
  const darkDecls = darkRule ? darkRule.decls : '';
  const rootTokens = declNames(rootDecls);
  const darkTokens = declNames(darkDecls);

  // 7a. The enterprise scale must be declared in BOTH blocks. The light values
  //     reproduce the legacy tokens exactly, so declaring them changes nothing.
  const SCALE = [
    '--bg-canvas', '--bg-surface', '--bg-elevated', '--bg-hover',
    '--border-subtle', '--border-medium', '--border-focus',
    '--text-primary', '--text-secondary', '--text-tertiary',
    '--accent-primary', '--accent-glow',
    '--badge-paid-bg', '--badge-paid-text', '--badge-paid-border',
    '--badge-unpaid-bg', '--badge-unpaid-text', '--badge-unpaid-border',
    '--badge-partial-bg', '--badge-partial-text', '--badge-partial-border',
    '--badge-overdue-bg', '--badge-overdue-text', '--badge-overdue-border',
  ];
  const missingScale = [];
  for (const t of SCALE) {
    if (!rootTokens.has(t)) missingScale.push(`${t}@root`);
    if (!darkTokens.has(t)) missingScale.push(`${t}@dark`);
  }
  assert(`all ${SCALE.length} enterprise tokens declared in both :root and dark`,
    missingScale.length === 0, missingScale.join(', '));

  // 7b. The legacy aliases are the load-bearing part: every component rule above
  //     still reads these names, so all of them must be re-pointed in dark.
  const LEGACY = ['--bg', '--surface', '--surface-2', '--border', '--border-strong', '--ink', '--ink-soft', '--ink-faint'];
  const missingAlias = LEGACY.filter((t) => !darkTokens.has(t));
  assert(`all ${LEGACY.length} legacy tokens re-declared in the dark block`,
    missingAlias.length === 0, missingAlias.join(', '));

  const aliasRe = (t) => new RegExp(`(?:^|;)\\s*${t}(?![\\w-])\\s*:\\s*var\\(`);
  const notAliased = LEGACY.filter((t) => !aliasRe(t).test(darkDecls));
  assert('every legacy dark token aliases the scale (var(--…)), never a literal',
    notAliased.length === 0, notAliased.join(', '));

  // 7c. …and the light block must NOT alias, or light mode would depend on the
  //     dark scale and the pinned baseline capture would prove nothing.
  const lightAliased = LEGACY.filter((t) => aliasRe(t).test(rootDecls));
  assert('light :root keeps literal legacy values (no aliasing)',
    lightAliased.length === 0, lightAliased.join(', '));

  // 7d. The safety claim behind the whole refactor: in light mode the new scale
  //     resolves to the SAME values as the legacy tokens it shadows. If these
  //     ever drift, light mode has silently changed appearance.
  const MIRROR = [
    ['--bg-canvas', '--bg'], ['--bg-surface', '--surface'], ['--bg-elevated', '--surface'],
    ['--bg-hover', '--surface-2'],
    ['--border-subtle', '--border'], ['--border-medium', '--border-strong'],
    ['--text-primary', '--ink'], ['--text-secondary', '--ink-soft'], ['--text-tertiary', '--ink-faint'],
  ];
  const drifted = [];
  for (const [scaleTok, legacyTok] of MIRROR) {
    const a = valueOf(rootDecls, scaleTok);
    const b = valueOf(rootDecls, legacyTok);
    if (a === null || a !== b) drifted.push(`${scaleTok}=${a} vs ${legacyTok}=${b}`);
  }
  assert(`light :root scale mirrors the ${MIRROR.length} legacy token values exactly`,
    drifted.length === 0, drifted.join(' | '));

  // 7e. Every var() the dark block references must resolve to a token some rule
  //     declares. A typo produces an invalid-at-computed-value-time declaration
  //     that silently falls back to unset — no console error, no visible clue.
  const declaredAnywhere = declNames(cssBase);
  const referenced = new Set([...darkDecls.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)].map((m) => m[1]));
  const unresolved = [...referenced].filter((t) => !declaredAnywhere.has(t));
  assert(`every var() in the dark block resolves to a declared token (${referenced.size} referenced)`,
    unresolved.length === 0, unresolved.join(', '));

  // 7f. The enterprise tokens may only be CONSUMED under [data-theme="dark"].
  //     An unscoped consumer would leak slate values into light mode, which is
  //     the one thing this refactor promises not to do.
  const leaky = [];
  for (const rule of baseRules) {
    for (const sel of rule.selectors) {
      if (/^\[data-theme="dark"\]/.test(sel)) continue;
      if (SCALE.some((t) => new RegExp(`var\\(\\s*${t}(?![\\w-])`).test(rule.decls))) leaky.push(sel);
    }
  }
  assert('enterprise tokens are consumed only under [data-theme="dark"]',
    leaky.length === 0, leaky.join(' | '));

  /* All rules matching `[data-theme="dark"] <sel>`. A component may legitimately
     carry several (an earlier interaction-polish rule and a later section-25
     one), so match on any of them rather than the first. */
  const darkRules = (sel) => baseRules.filter((r) => r.selectors.includes(`[data-theme="dark"] ${sel}`));

  // 7g. Section 25 itself: a component that needed a dark-specific material must
  //     actually carry one, or it quietly reverts to its light-mode treatment.
  //     (The topbar's blur is inherited from its base rule, so the dark rule only
  //     needs to pin a fill translucent enough for that blur to be visible.)
  const REQUIRED = {
    '.topbar': /background:\s*rgba\(18, 35, 26, 0\.75\)/,
    '.sidebar': /backdrop-filter:\s*blur\(12px\)/,
    '.bottom-nav': /backdrop-filter:\s*blur\(12px\)/,
    '.card': /border-radius:\s*var\(--radius\)/,
    '.table-wrap': /border-radius:\s*var\(--radius\)/,
    '.table tbody tr:hover': /background:\s*var\(--bg-hover\)/,
    '.btn-primary': /inset 0 1px 0 0 rgba\(255, 255, 255, 0\.2\)/,
    '.input': /border-color:\s*var\(--border-medium\)/,
    '.modal': /background:\s*var\(--bg-elevated\)/,
    '.toast': /background:\s*var\(--bg-elevated\)/,
    '.dropdown-menu': /background:\s*var\(--bg-elevated\)/,
    '.invoice-doc': /background:\s*var\(--bg-elevated\)/,
    '.skeleton': /background:\s*var\(--bg-hover\)/,
    '.progress': /background:\s*var\(--bg-hover\)/,
    '.chip': /background:\s*var\(--bg-elevated\)/,
    '.tip::after': /background:\s*var\(--bg-elevated\)/,
  };
  const missingDark = [];
  for (const [sel, re] of Object.entries(REQUIRED)) {
    const rules = darkRules(sel);
    if (!rules.length) { missingDark.push(`${sel} (no rule)`); continue; }
    if (!rules.some((r) => re.test(r.decls))) missingDark.push(`${sel} (rule present, declaration missing)`);
  }
  assert(`all ${Object.keys(REQUIRED).length} dark component treatments present`,
    missingDark.length === 0, missingDark.join(', '));

  // 7h. Status pills must use the translucent tokens, not a solid fill.
  const PILLS = {
    '.badge-green': '--badge-paid-bg',
    '.badge-orange': '--badge-unpaid-bg',
    '.badge-gold': '--badge-partial-bg',
    '.badge-red': '--badge-overdue-bg',
    '.badge-blue': '--badge-partial-bg',
    '.badge-gray': '--bg-hover',
  };
  const badPills = [];
  for (const [sel, token] of Object.entries(PILLS)) {
    const rules = darkRules(sel);
    if (!rules.length) { badPills.push(`${sel} (no rule)`); continue; }
    if (!rules.some((r) => new RegExp(`background:\\s*var\\(${token}\\)`).test(r.decls))) badPills.push(`${sel} (expected ${token})`);
  }
  assert(`all ${Object.keys(PILLS).length} status pills use the translucent dark tokens`,
    badPills.length === 0, badPills.join(', '));

  // 7i. Those pill backgrounds must themselves be translucent — the alpha is
  //     what separates them from the solid pale fills the light palette uses.
  const pillBgTokens = SCALE.filter((t) => /^--badge-.*-bg$/.test(t));
  const opaque = pillBgTokens.filter((t) => !/rgba?\(/.test(valueOf(darkDecls, t) || ''));
  assert(`all ${pillBgTokens.length} dark badge backgrounds are translucent`,
    opaque.length === 0, opaque.join(', '));

  // 7j. The dark aliases must point at the RAISED surface for --surface-2, not
  //     the hover one: in light mode a grey panel is recessed, but on a near-black
  //     canvas the same treatment is invisible, so it has to step up instead.
  assert('dark --surface-2 aliases the elevated surface, not the hover one',
    valueOf(darkDecls, '--surface-2') === 'var(--bg-elevated)',
    valueOf(darkDecls, '--surface-2') || '(missing)');

  // 7k. Printing is paper. Without a reset in the print block, a dark-mode
  //     session prints near-white text (--ink → #F8FAFC) on a slate block — an
  //     unreadable page. The reset must cover the structural tokens but must NOT
  //     pin the brand: the brand tokens are inline on <html>, so the only way to
  //     swap them is js/shell.js re-deriving the light palette on `beforeprint`.
  const printBlock = cssMedias.find((m) => /\bprint\b/.test(m.cond));
  assert('a @media print block exists', !!printBlock);
  const printRoot = printBlock ? parseRules(printBlock.body).find((r) => r.selectors.includes(':root')) : null;
  assert('the print block resets tokens on :root', !!printRoot);
  const printTokens = printRoot ? declNames(printRoot.decls) : new Set();
  const NEEDED_IN_PRINT = ['--bg-canvas', '--bg-surface', '--bg-elevated', '--text-primary', '--text-secondary', '--border-subtle', '--bg', '--surface', '--ink', '--border'];
  const missingPrint = NEEDED_IN_PRINT.filter((t) => !printTokens.has(t));
  assert(`the print reset covers the ${NEEDED_IN_PRINT.length} structural tokens`,
    missingPrint.length === 0, missingPrint.join(', '));
  const printPinsBrand = printRoot ? /(?:^|;)\s*--(?:brand|gold)(?![\w-])\s*:/.test(printRoot.decls) : false;
  assert('the print reset does not pin the brand (js swaps it on beforeprint)', !printPinsBrand);

  // 7l. …and that JS swap must actually be wired, or printing from dark mode
  //     keeps the lightened dark brand — too pale to read on white paper.
  const shellSrc = fs.readFileSync(path.join(ROOT, 'js', 'shell.js'), 'utf8');
  assert('shell.js registers a beforeprint palette swap',
    /addEventListener\(\s*'beforeprint'/.test(shellSrc) && /addEventListener\(\s*'afterprint'/.test(shellSrc));
  assert('shell.js installs the print palette during initShell',
    /initPrintPalette\s*\(\s*\)/.test(shellSrc));
}

/* ---------- 8. Onboarding guide contract ----------
   The guide is the first thing a new client sees, and every way it can break is
   silent: a launcher dropped from one page, a `data-tour` anchor renamed by a
   layout tweak, or a missing CSS class means a card floating over an empty
   screen explaining a button that is not there. js/onboarding.js already skips
   a step whose anchor has vanished, so nothing throws — it just quietly gets
   worse. Assert the whole contract statically instead. */
console.log('\n== Onboarding guide contract ==');
{
  const PAGE_FILE = {
    dashboard: 'index.html',
    invoice: 'invoice.html',
    customers: 'customers.html',
    products: 'products.html',
    reports: 'reports.html',
    settings: 'settings.html',
  };
  const onboardingSrc = fs.readFileSync(path.join(ROOT, 'js', 'onboarding.js'), 'utf8');

  // 8a. Every page ships the launcher; every END-USER page also ships a way
  //     back into the tour.
  //
  //     admin.html is the exception, and deliberately so: it is the vendor's
  //     licence desk, not a surface a first-time customer is ever sent to, so a
  //     "New here? Take the guided tour" banner on it would be advice aimed at
  //     the wrong person. The launcher is still asserted there because it comes
  //     from the shared shell — the manual should be one tap away everywhere.
  const END_USER_PAGES = PAGES.filter((p) => p !== 'admin.html');
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert(`${page} has the Guide launcher`, /id="helpBtn"[^>]*class="guide-card"|class="guide-card[^"]*"[^>]*id="helpBtn"/.test(html));
    if (END_USER_PAGES.includes(page)) {
      assert(`${page} has a tour re-entry affordance`, /data-tour-start/.test(html));
    }
  }
  assert('the tour re-entry contract covers every end-user page',
    END_USER_PAGES.length === 6, END_USER_PAGES.length);

  // 8b. Every spotlight anchor a step declares must exist on that step's page.
  //     Parsed straight out of the content array so the two can never drift.
  const pairs = [...onboardingSrc.matchAll(/page:\s*'([a-z]+)',\s*\n\s*target:\s*(null|'([^']*)')/g)];
  assert('onboarding.js declares spotlight steps', pairs.length >= 8, pairs.length);
  const missingAnchors = [];
  for (const [, page, raw, sel] of pairs) {
    if (raw === 'null') continue;
    const file = PAGE_FILE[page];
    if (!file) { missingAnchors.push(`${page}: unknown page`); continue; }
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // The selector is `[data-tour="x"]`; the contract is the attribute value.
    const anchor = (sel.match(/data-tour="([^"]+)"/) || [])[1];
    if (!anchor || !html.includes(`data-tour="${anchor}"`)) {
      missingAnchors.push(`${file}: ${sel}`);
    }
  }
  assert('every step anchor exists on its page', missingAnchors.length === 0, missingAnchors.join(', '));

  // 8c. The guide is loaded and started by the shared shell.
  const shellSrc = fs.readFileSync(path.join(ROOT, 'js', 'shell.js'), 'utf8');
  assert('shell.js imports the onboarding module', /from\s+'\.\/onboarding\.js'/.test(shellSrc));
  assert('shell.js starts onboarding during initShell', /await\s+initOnboarding\s*\(\s*\)/.test(shellSrc));

  // 8d. The guide ships offline like everything else.
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert('sw precaches js/onboarding.js', /'\.\/js\/onboarding\.js'/.test(sw));

  // 8e. The CSS the engine depends on must exist, or the tour renders unstyled
  //     (a full-screen white sheet with the card somewhere on it).
  for (const cls of ['.tour-root', '.tour-block', '.tour-glow', '.tour-card', '.tour-dot', '.help-overlay', '.help-drawer', '.guide-card', '.guide-hint']) {
    assert(`css defines ${cls}`, definedClasses.has(cls.slice(1)), cls);
  }

  // 8f. The scrim is a theme token, so the dimming is legible in both themes.
  const tourScrims = (css.match(/--tour-scrim\s*:/g) || []).length;
  assert('--tour-scrim is declared in both themes', tourScrims >= 2, tourScrims);

  // 8g. Either surface open must stop the page scrolling behind it.
  assert('an open guide locks page scroll',
    /\.tour-active\s*,\s*\.help-active\s*\{[^}]*overflow\s*:\s*hidden/.test(css));

  // 8h. The guide must never print. `.guide-hint` carries `.no-print`, and the
  //     print block hides the rest by name.
  const printBlock = cssMedias.find((m) => /\bprint\b/.test(m.cond));
  const printBody = printBlock ? printBlock.body : '';
  for (const sel of ['.tour-root', '.help-overlay', '.guide-card', '.no-print']) {
    assert(`the print stylesheet hides ${sel}`, printBody.includes(sel), sel);
  }
}

/* ---------- 9. Monetization gates, feedback and the admin console ----------
   These three features all fail the same silent way: a renamed id, a feature
   id typo, or a gate wired to the wrong control leaves the app looking
   perfectly healthy while charging nobody and locking nothing. None of it
   raises an error, so assert the whole contract statically.

   The behavioural half (does pressing the locked control actually open the
   upgrade prompt, does the admin console unlock) is asserted by
   scripts/test-features.js against the real app. */
console.log('\n== Monetization gates, feedback & admin console ==');
{
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const configSrc = read('js/app.config.js');
  const licenseSrc = read('js/licenseService.js');
  const settingsSrc = read('js/settings.js');
  const reportSrc = read('js/report.js');
  const invoiceSrc = read('js/invoice.js');
  const feedbackSrc = read('js/feedback.js');
  const adminSrc = read('js/admin.js');
  const adminHtml = read('admin.html');
  const shellSrc = read('js/shell.js');
  const swSrc = read('sw.js');

  // 9a. The three gated features must be declared once, paid, and absent from
  //     the free plan. A feature id that exists in the UI but not in the config
  //     would make `hasFeature()` return false for EVERY plan — locking a
  //     paying customer out of what they bought.
  //
  //     The plans are parsed out of their own `features` array rather than
  //     matched with a `free:[\s\S]*?'id'` pattern: that pattern is lazy but
  //     unbounded, so it happily runs past the end of the free plan and finds
  //     the id on pro — passing while asserting the exact opposite.
  const planFeatures = (planId) => {
    const m = configSrc.match(new RegExp(`\\b${planId}:\\s*\\{[\\s\\S]*?features:\\s*\\[([\\s\\S]*?)\\]`));
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  };
  const freeFeatures = planFeatures('free');
  const proFeatures = planFeatures('pro');
  assert('the free plan feature list was parsed', freeFeatures.length >= 5, freeFeatures.length);
  assert('the pro plan feature list was parsed', proFeatures.length >= 8, proFeatures.length);

  const GATED = ['custom-app-name', 'signature-stamp', 'monthly-report'];
  for (const feature of GATED) {
    assert(`config declares the "${feature}" feature id`, configSrc.includes(`'${feature}'`));
    assert(`"${feature}" is listed in paidFeatures`,
      new RegExp(`paidFeatures:[\\s\\S]*?'${feature}'`).test(configSrc));
    assert(`"${feature}" is on the pro plan`, proFeatures.includes(feature), proFeatures.join(','));
    assert(`"${feature}" is NOT on the free plan`, !freeFeatures.includes(feature), freeFeatures.join(','));
  }

  // 9b. Every paid feature needs a human label, or the upgrade prompt prints a
  //     raw kebab-case id at a customer.
  const paidBlock = (configSrc.match(/paidFeatures:\s*\[([\s\S]*?)\]/) || [, ''])[1];
  const paidIds = [...paidBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert('paidFeatures is non-empty', paidIds.length >= 3, paidIds.length);
  const unlabelled = paidIds.filter((id) => !new RegExp(`'${id}':`).test(licenseSrc));
  assert('every paid feature has a FEATURE_LABELS entry', unlabelled.length === 0, unlabelled.join(', '));

  // 9c. The shared gate exists and is what the UI calls.
  assert('licenseService exports gateFeature', /export async function gateFeature\s*\(/.test(licenseSrc));
  assert('licenseService exports FEATURE_LABELS', /export const FEATURE_LABELS\s*=/.test(licenseSrc));
  assert('gateFeature routes to showUpgradeModal', /gateFeature[\s\S]*?await showUpgradeModal\(/.test(licenseSrc));

  // 9d. Settings locks the app name and the two artwork uploaders, and does NOT
  //     lock the logo or the Business Name. The Business Name is the customer's
  //     own data and is printed on their invoices — taking it hostage would make
  //     the free tier useless rather than tempting, which is the opposite of the
  //     intent.
  assert('settings.js locks the app name', /brandAppName/.test(settingsSrc) && /custom-app-name/.test(settingsSrc));
  assert('settings.js locks the app tagline too', /brandAppTagline/.test(settingsSrc));
  assert('settings.js gates the signature uploader', /setSignatureInput'[\s\S]{0,200}feature: 'signature-stamp'/.test(settingsSrc));
  assert('settings.js gates the stamp uploader', /setStampInput'[\s\S]{0,200}feature: 'signature-stamp'/.test(settingsSrc));
  assert('settings.js does NOT gate the logo uploader', !/setLogoInput'[^)]*feature:/.test(settingsSrc));
  assert('settings.js does NOT lock the business name field', !/#setBusinessName[\s\S]{0,120}markLocked/.test(settingsSrc));
  assert('settings.js applies the locks during init', /applyPlanLocks\s*\(\s*\)/.test(settingsSrc));
  assert('settings.js loads the licence before applying locks',
    /await loadLicense\(\)[\s\S]*?applyPlanLocks\(\)/.test(settingsSrc));

  // 9e. Reports gate the MONTHLY download only. Daily/weekly/yearly must stay
  //     exportable, or the free tier loses the feature the plan cards promise.
  assert('report.js gates the monthly period', /monthlyLocked[\s\S]*?'monthly'[\s\S]*?'monthly-report'/.test(reportSrc));
  assert('report.js guards the CSV export', /exportReportCSV[\s\S]{0,200}allowMonthlyExport/.test(reportSrc));
  assert('report.js guards the PDF export', /exportReportPDF[\s\S]{0,200}allowMonthlyExport/.test(reportSrc));
  assert('report.js reflects the lock on the toolbar', /refreshExportLocks\s*\(\s*\)/.test(reportSrc));

  // 9f. The inline customer feature: the editor offers it, and the save path
  //     persists the customer before the invoice so one save links both.
  assert('invoice.html offers the inline new-customer control', /id="invNewCustomerBtn"/.test(read('invoice.html')));
  assert('invoice.js binds the inline new-customer control', /\$\('#invNewCustomerBtn'\)\?\.addEventListener/.test(invoiceSrc));
  assert('invoice.js writes customers through saveCustomer', /import\s*\{[\s\S]*?saveCustomer[\s\S]*?\}\s*from\s*'\.\/storageService\.js'/.test(invoiceSrc));
  assert('invoice.js auto-saves the customer on invoice save', /ensureCustomerFor\s*\(\s*invoice\s*\)/.test(invoiceSrc));
  assert('the customer is persisted BEFORE the invoice',
    invoiceSrc.indexOf('await ensureCustomerFor(invoice)') < invoiceSrc.indexOf('await saveInvoice(invoice)', invoiceSrc.indexOf('await ensureCustomerFor(invoice)')));
  assert('the customer form is filled through one shared helper', /function applyCustomerToForm\s*\(/.test(invoiceSrc));

  // 9g. Feedback is reachable from every page and wired by the shared shell.
  for (const page of PAGES) {
    const html = read(page);
    assert(`${page} has the Feedback launcher`, /id="feedbackBtn"[^>]*data-action="feedback"/.test(html));
  }
  assert('shell.js imports the feedback module', /from\s+'\.\/feedback\.js'/.test(shellSrc));
  assert('shell.js starts feedback during initShell', /await\s+initFeedback\s*\(\s*\)/.test(shellSrc));
  assert('feedback.js delegates its entry points', /data-action="feedback"/.test(feedbackSrc));
  assert('feedback.js never competes with the first-run tour', /onboardingSeen/.test(feedbackSrc));
  assert('feedback.js asks only once', /NUDGE_KEY|feedbackAsked/.test(feedbackSrc));
  assert('feedback.js can compose a WhatsApp message', /whatsappUrl/.test(feedbackSrc));

  // 9h. The admin page is reachable from every page's sidebar.
  for (const page of PAGES) {
    assert(`${page} links to the admin console`, /href="admin\.html" data-nav="admin"/.test(read(page)));
  }

  // 9i. Every element the admin module queries must exist on the admin page.
  //     A renamed id is the single most likely way to break the console, and it
  //     fails as a silent `?.` no-op rather than an error.
  const queried = [...new Set([...adminSrc.matchAll(/\$\('#([A-Za-z][\w-]*)'/g)].map((m) => m[1]))];
  assert('admin.js queries a substantial set of elements', queried.length >= 25, queried.length);
  const missing = queried.filter((id) => !adminHtml.includes(`id="${id}"`));
  assert('every id admin.js queries exists in admin.html', missing.length === 0, missing.join(', '));

  // 9j. The admin console is a console: the passcode gate and the plan matrix
  //     must both be present, or "professional admin panel" is just a page of
  //     stat cards.
  assert('admin.html ships the passcode gate', /id="adminGate"/.test(adminHtml) && /type="password" class="input" id="adminPass"/.test(adminHtml));
  assert('admin.html ships the plan matrix', /id="planMatrixTable"/.test(adminHtml));
  assert('admin.html ships the key ledger', /id="keyTableBody"/.test(adminHtml));
  assert('admin.html ships the feedback inbox', /id="feedbackInbox"/.test(adminHtml));

  // The ledger's pure logic lives in its own DOM-free module so it can be
  // unit-tested; the page module must not grow a second copy of it.
  const adminKeysSrc = read('js/adminKeys.js');
  assert('admin.js imports the ledger logic', /from\s+'\.\/adminKeys\.js'/.test(adminSrc));
  assert('admin.js hashes the passcode rather than storing it',
    /hashPasscode/.test(adminKeysSrc) && !/passcode:\s*next/.test(adminSrc));
  assert('the passcode hash is honest about what it is', /not a password hash/i.test(adminKeysSrc));
  assert('the key batch is built by the tested generator', /buildKeyBatch/.test(adminSrc));
  assert('admin.js mints keys through makeLicenseKey', /makeLicenseKey/.test(adminSrc));
  assert('admin.js verifies keys through inspectKey', /inspectKey/.test(adminSrc));

  // 9k. Everything new ships offline.
  for (const asset of ['./admin.html', './js/admin.js', './js/adminKeys.js', './js/feedback.js']) {
    assert(`sw precaches ${asset}`, swSrc.includes(`'${asset}'`), asset);
  }

  // 9l. The CSS the new surfaces depend on.
  for (const cls of ['.star-rating', '.star-btn', '.feedback-item', '.feedback-nudge', '.pro-tag', '.upgrade-features', '.is-locked', '.admin-gate', '.admin-stats', '.admin-verdict', '.key-code', '.mono']) {
    assert(`css defines ${cls}`, definedClasses.has(cls.slice(1)), cls);
  }
  // A locked control must never be `disabled`: a disabled element cannot
  // receive the press that opens the upgrade prompt, so the upsell would be
  // unreachable for exactly the users it is aimed at.
  assert('the plan lock does not rely on [disabled]',
    !/\.is-locked[^{]*\{[^}]*pointer-events\s*:\s*none/.test(css));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

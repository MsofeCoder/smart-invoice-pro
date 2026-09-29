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

const PAGES = ['index.html', 'invoice.html', 'customers.html', 'products.html', 'reports.html', 'settings.html'];
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

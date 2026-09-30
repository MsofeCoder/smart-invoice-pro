/**
 * Post-deploy verification against the DEPLOYED site.
 *
 * Everything else in scripts/ tests the working tree over a local server. This
 * one points at the real GitHub Pages URL, because a static app can pass every
 * local test and still be broken in production: a path that only resolves from
 * the repo root, an asset missing from the precache, a service worker that
 * never updates, a 404 on an icon that only the browser requests.
 *
 * Deliberately NOT part of `npm run test:e2e` — it needs the network and a
 * finished Pages build. Run it after a deploy:
 *
 *   npm run test:live
 *   npm run test:live -- https://example.com/some-path/
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, connect, createReporter, sleep } from './lib/cdp.js';

const LIVE = (process.argv[2] || 'https://msofecoder.github.io/smart-invoice-pro/').replace(/\/?$/, '/');
const EXPECTED_CACHE = process.env.EXPECTED_CACHE || 'v14';
/* The version the app was on immediately before this deploy. Derived rather
   than hard-coded so bumping EXPECTED_CACHE cannot leave the stale-cache probe
   planting a version that is no longer "one behind". */
const STALE_CACHE = `smart-invoice-pro-v${Math.max(1, Number(EXPECTED_CACHE.replace(/^v/, '')) - 1)}`;

const r = createReporter('Live');
const { send, evaluate, shot, errors, netFails, state, close } = await connect();

/** Drop accumulated console/network noise, e.g. everything before install finished. */
const resetLogs = () => { state.logs = []; state.netFails.length = 0; };

const goLive = async (page = 'index.html', wait = 3200) => {
  await send('Page.navigate', { url: LIVE + page });
  await send('Page.bringToFront');
  await sleep(wait);
};
const setWidth = (w, h) =>
  send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
const waitFor = async (expr, tries = 80, gap = 300) => {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(expr)) return true;
    await sleep(gap);
  }
  return false;
};

/**
 * Wait until both entrance animations have finished.
 *
 * Asserting "the chart is drawn" the moment the elements appear is a race: the
 * bars are deliberately rendered collapsed and then grow, and the donut writes
 * its dash on a staggered timeout. For about a second the CORRECT state is an
 * empty ring and zero-height bars. Measured on the live site the animation
 * settles ~2s after first paint, so poll rather than sleep a fixed amount.
 */
const SETTLED = `(() => {
  const fills = [...document.querySelectorAll('#salesChart .bar-fill')];
  const arcs = [...document.querySelectorAll('#statusDonut .donut-arc')];
  return fills.length > 0 && arcs.length > 0
    && fills.every((f) => getComputedStyle(f).transform === 'matrix(1, 0, 0, 1, 0, 0)')
    && arcs.every((a) => a.style.strokeDasharray && a.style.strokeDasharray !== '0 100');
})()`;
const waitSettled = (tries = 48, gap = 250) => waitFor(SETTLED, tries, gap);

const shotRegion = async (selector, file) => {
  const box = await evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: Math.max(0, b.x + window.scrollX), y: Math.max(0, b.y + window.scrollY), width: b.width, height: b.height };
  })()`);
  if (!box) return null;
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 2 } });
  const dir = path.join(CONFIG.shots, 'live');
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, file);
  fs.writeFileSync(full, Buffer.from(data, 'base64'));
  return full;
};

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await goLive('index.html', 4000);
await waitFor(`!!document.querySelector('#statusDonut .donut-seg') && !!document.querySelector('#salesChart .bar-col')`);
await waitSettled();

/* ---------- 1. the page came from the right place ---------- */
r.section('Live load');
const boot = await evaluate(`(() => ({
  url: location.href, title: document.title, swSupported: 'serviceWorker' in navigator,
}))()`);
r.check('served from the expected base path', boot.url.startsWith(LIVE), boot.url);
r.check('app booted with a title', !!boot.title, boot.title);
r.check('service workers are available (HTTPS)', boot.swSupported, boot.swSupported);

/* ---------- 2. both charts render, and agree with themselves ---------- */
r.section('Charts on the live site');
const charts = await evaluate(`(() => {
  const d = document.querySelector('#statusDonut');
  const b = document.querySelector('#salesChart');
  const arcs = [...d.querySelectorAll('.donut-arc')];
  const fills = [...b.querySelectorAll('.bar-fill')];
  const band = (el, s) => { const e = el.querySelector(s); if (!e) return null; const x = e.getBoundingClientRect(); return [Math.round(x.top), Math.round(x.bottom)]; };
  return {
    donutArcs: arcs.length,
    donutDrawn: arcs.length > 0 && arcs.every((a) => a.style.strokeDasharray && a.style.strokeDasharray !== '0 100'),
    donutRole: d.querySelector('svg.donut-svg')?.getAttribute('role'),
    donutLabel: (d.querySelector('svg.donut-svg')?.getAttribute('aria-label') || '').slice(0, 70),
    legendRows: d.querySelectorAll('.legend-row').length,
    barCols: b.querySelectorAll('.bar-col').length,
    barHeights: fills.map((f) => Math.round(f.getBoundingClientRect().height)),
    barDrawn: fills.some((f) => f.getBoundingClientRect().height > 5),
    barBand: band(b, '.bar-scale'), gridBand: band(b, '.chart-grid'), yBand: band(b, '.chart-ybox'),
    ticks: [...b.querySelectorAll('.chart-ytick')].map((t) => t.textContent),
    barRole: b.querySelector('.chart-plot')?.getAttribute('role'),
    barTable: b.querySelectorAll('table.sr-only tbody tr').length,
    peakColour: (() => { const p = b.querySelector('.bar-fill.is-peak'); return p ? getComputedStyle(p).backgroundColor : null; })(),
    crossOrigin: performance.getEntriesByType('resource').map((e) => e.name).filter((u) => !u.startsWith(location.origin)),
  };
})()`);
r.check('donut renders arcs', charts.donutArcs > 0, charts.donutArcs);
r.check('donut arcs are actually drawn (not stuck at 0)', charts.donutDrawn, charts.donutDrawn);
r.eq('donut svg is role=img', charts.donutRole, 'img');
r.check('donut has a generated summary', /Invoice status:/.test(charts.donutLabel), charts.donutLabel);
r.check('donut legend is populated', charts.legendRows > 0, charts.legendRows);
r.eq('bar chart renders 7 columns', charts.barCols, 7);
r.check('bars have real height', charts.barDrawn, JSON.stringify(charts.barHeights));
r.check('bar band == gridline band', JSON.stringify(charts.barBand) === JSON.stringify(charts.gridBand), `${JSON.stringify(charts.barBand)} vs ${JSON.stringify(charts.gridBand)}`);
r.check('bar band == y-axis band', JSON.stringify(charts.barBand) === JSON.stringify(charts.yBand), `${JSON.stringify(charts.barBand)} vs ${JSON.stringify(charts.yBand)}`);
r.check('axis ticks are compact', charts.ticks.length >= 4 && charts.ticks.slice(1).every((t) => /[KM]$/.test(t)), JSON.stringify(charts.ticks));
r.eq('bar plot is role=img', charts.barRole, 'img');
r.eq('bar hidden table matches columns', charts.barTable, charts.barCols);
r.check('peak bar is highlighted', !!charts.peakColour, charts.peakColour);
r.eq('zero cross-origin requests', charts.crossOrigin.length, 0);
if (charts.crossOrigin.length) console.log('  external:', charts.crossOrigin);

/* ---------- 3. the animation actually plays in production ---------- */
r.section('Entrance animation');
await evaluate(`document.querySelector('[data-range="30"]').click()`);
await sleep(40);
const anim = await evaluate(`(() => {
  const b = document.querySelector('#salesChart');
  return {
    grown: b.classList.contains('is-grown'),
    collapsed: [...b.querySelectorAll('.bar-fill')].some((f) => /matrix\\(1, 0, 0, 0, 0, 0\\)/.test(getComputedStyle(f).transform)),
    cols: b.querySelectorAll('.bar-col').length,
  };
})()`);
// 30 bars x 60ms stagger + 500ms duration = ~2.3s of animation. Poll rather
// than sleep a fixed amount: a fixed sleep is a coin flip under load.
const settled = await waitFor(
  `[...document.querySelectorAll('#salesChart .bar-fill')].every((f) => getComputedStyle(f).transform === 'matrix(1, 0, 0, 1, 0, 0)')`,
  48, 250,
);
r.check('bar animation is armed', anim.grown, anim.grown);
r.check('bars start collapsed then grow', anim.collapsed, anim.collapsed);
r.eq('30D renders 30 columns', anim.cols, 30);
r.check('bars settle at full scale', settled, settled);
await evaluate(`document.querySelector('[data-range="7"]').click()`);
await sleep(900);

/* ---------- 4. theme toggle ---------- */
r.section('Theme toggle');
const theme = await evaluate(`(async () => {
  const before = document.documentElement.getAttribute('data-theme');
  const btn = document.querySelector('[data-theme-toggle], #themeToggle, .theme-toggle');
  if (!btn) return { hasToggle: false, before };
  btn.click();
  await new Promise((r) => setTimeout(r, 400));
  const after = document.documentElement.getAttribute('data-theme');
  btn.click();
  await new Promise((r) => setTimeout(r, 400));
  return { hasToggle: true, before, after, restored: document.documentElement.getAttribute('data-theme') };
})()`);
r.check('a theme toggle exists', theme.hasToggle, JSON.stringify(theme));
r.check('toggling changes data-theme', theme.hasToggle && theme.before !== theme.after, `${theme.before} -> ${theme.after}`);
r.check('toggling back restores the theme', theme.restored === theme.before, `${theme.restored} vs ${theme.before}`);

/* ---------- 5. service worker: current cache, old caches reaped ---------- */
r.section('Service worker');

/* The install handler caches each shell entry independently (deliberately: one
   missing asset must not abort the whole install). That means the cache fills
   PROGRESSIVELY, so measuring straight after load reports a partial precache
   and the assertion fails for no real reason. Wait for it to finish. */
const SW_READY = `(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg || !reg.active) return false;
  const keys = await caches.keys();
  const name = keys.find((k) => k.includes('smart-invoice-pro'));
  if (!name) return false;
  const cached = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
  return cached.some((p) => p.endsWith('/js/charts.js'))
    && cached.some((p) => p.includes('/assets/fonts/'))
    && cached.some((p) => p.includes('/assets/brand/'));
})()`;
const swReady = await waitFor(SW_READY, 120, 500);
r.check('service worker activated and finished precaching', swReady, swReady);
// Anything logged while the shell was still downloading is not a runtime defect.
resetLogs();

const sw = await evaluate(`(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  const keys = await caches.keys();
  const name = keys.find((k) => k.includes('smart-invoice-pro'));
  const cache = await caches.open(name || keys[0] || '');
  const cached = (await cache.keys()).map((r) => new URL(r.url).pathname);
  return {
    scope: reg?.scope, active: reg?.active?.scriptURL, keys, cachedCount: cached.length,
    hasCharts: cached.some((p) => p.endsWith('/js/charts.js')),
    hasFonts: cached.some((p) => p.includes('/assets/fonts/')),
    hasBrand: cached.some((p) => p.includes('/assets/brand/')),
  };
})()`);
r.check('service worker is active', !!sw.active, sw.active);
r.check('SW scope is the project subpath', (sw.scope || '').endsWith(new URL(LIVE).pathname), `${sw.scope} vs ${new URL(LIVE).pathname}`);
r.check(`cache name is ${EXPECTED_CACHE}`, sw.keys.some((k) => k.includes(EXPECTED_CACHE)), JSON.stringify(sw.keys));
r.check('charts.js is precached', sw.hasCharts, sw.hasCharts);
r.check('self-hosted fonts are precached', sw.hasFonts, sw.hasFonts);
r.check('brand SVGs are precached', sw.hasBrand, sw.hasBrand);
console.log(`  caches: ${JSON.stringify(sw.keys)} (${sw.cachedCount} entries)`);

const planted = await evaluate(`(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  await reg.unregister();
  const stale = await caches.open('${STALE_CACHE}');
  await stale.put(location.pathname + 'stale-probe.txt', new Response('x'));
  return (await caches.keys()).includes('${STALE_CACHE}');
})()`);
r.check(`planted a stale ${STALE_CACHE} cache`, planted === true, planted);
await goLive('index.html', 5000);
await waitFor(`!!document.querySelector('#salesChart .bar-col')`);
// The unregister forced a fresh install, so the shell is downloading again.
// Let it finish before the next navigation, or in-flight precache fetches are
// aborted and show up as network failures that say nothing about the app.
await waitFor(SW_READY, 120, 500);
resetLogs();
const after = await evaluate(`(async () => ({ keys: await caches.keys() }))()`);
r.check(`stale ${STALE_CACHE} cache was deleted on activate`, !after.keys.includes(STALE_CACHE), JSON.stringify(after.keys));
r.check(`${EXPECTED_CACHE} cache is present after re-activate`, after.keys.some((k) => k.includes(EXPECTED_CACHE)), JSON.stringify(after.keys));

/* ---------- 6. every asset resolves from the subpath ---------- */
r.section('Assets (subpath)');
const assets = await evaluate(`(async () => {
  const paths = [
    'manifest.json', 'favicon.svg', 'favicon.ico', 'favicon.png', 'sw.js', 'js/charts.js',
    'assets/fonts/inter-latin.woff2', 'assets/fonts/plus-jakarta-sans-latin.woff2',
    'assets/brand/logo-mark.svg', 'assets/brand/logo-horizontal.svg',
    'assets/brand/logo-horizontal-dark.svg', 'assets/brand/logo-mono.svg', 'assets/brand/favicon.svg',
    'assets/icons/icon-192.png', 'assets/icons/icon-512.png', 'assets/icons/apple-touch-icon.png',
    'assets/icons/favicon.ico', 'assets/icons/favicon-32.png',
    'assets/icons/icon-maskable-192.png', 'assets/icons/icon-maskable-512.png',
  ];
  const out = [];
  for (const p of paths) {
    try { const res = await fetch(p, { cache: 'no-store' }); out.push({ p, status: res.status }); }
    catch (e) { out.push({ p, status: 'ERR ' + e.message }); }
  }
  let manifest = null;
  try { manifest = await (await fetch('manifest.json')).json(); } catch {}
  return { out, icons: (manifest?.icons || []).map((i) => i.src), start: manifest?.start_url, scope: manifest?.scope };
})()`);
const bad = assets.out.filter((a) => a.status !== 200);
r.check('every asset returns 200 (no 404s)', bad.length === 0, JSON.stringify(bad));
if (bad.length) console.log('  bad:', bad);
r.check('manifest icons resolve', (assets.icons || []).length > 0, JSON.stringify(assets.icons));
r.check('manifest start_url/scope are relative', !/^https?:/.test(assets.start || 'x') && !/^https?:/.test(assets.scope || 'x'), `${assets.start} / ${assets.scope}`);

/* ---------- 7. it still works with the network gone ---------- */
r.section('Offline');
await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
await goLive('index.html', 4500);
const off = await evaluate(`(() => ({
  donut: document.querySelectorAll('#statusDonut .donut-arc').length,
  bars: document.querySelectorAll('#salesChart .bar-col').length,
  drawn: [...document.querySelectorAll('.donut-arc')].every((a) => a.style.strokeDasharray && a.style.strokeDasharray !== '0 100'),
}))()`);
r.check('reload while offline still renders the donut', off.donut > 0 && off.drawn, JSON.stringify(off));
r.check('reload while offline still renders the bars', off.bars > 0, off.bars);
await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

/* ---------- 8. both widths, both themes ---------- */
r.section('Screenshots at 360 and 1440, both themes');
for (const [w, h, name] of [[360, 900, 'phone-360'], [1440, 1000, 'desktop-1440']]) {
  await setWidth(w, h);
  await goLive('index.html', 3200);
  await waitFor(`!!document.querySelector('#salesChart .bar-col')`);
  await waitSettled();
  for (const t of ['light', 'dark']) {
    await evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(t)})`);
    await evaluate(`document.querySelector('#salesChart').scrollIntoView({ block: 'center' })`);
    await sleep(900);
    const f = await shotRegion('#salesChart', `live-bars-${name}-${t}.png`);
    await evaluate(`document.querySelector('#statusDonut').scrollIntoView({ block: 'center' })`);
    await sleep(500);
    const g = await shotRegion('#statusDonut', `live-donut-${name}-${t}.png`);
    console.log(`  ${path.basename(f)} / ${path.basename(g)}`);
  }
  await evaluate(`document.documentElement.setAttribute('data-theme', 'light')`);
  await evaluate(`window.scrollTo(0, 0)`);
  await sleep(400);
  console.log(`  ${path.basename(await shot(`live-dash-${name}.png`))}`);
}

await setWidth(1440, 1000);
await goLive('reports.html', 3200);
await waitFor(`!!document.querySelector('#revenueChart .bar-col')`);
await sleep(2600);
const rep = await evaluate(`(() => ({
  bars: document.querySelectorAll('#revenueChart .bar-col').length,
  donut: document.querySelectorAll('#reportDonut .donut-arc').length,
  drawn: [...document.querySelectorAll('#reportDonut .donut-arc')].every((a) => a.style.strokeDasharray && a.style.strokeDasharray !== '0 100'),
}))()`);
r.section('Reports page (live)');
r.check('revenue chart renders bars', rep.bars > 0, rep.bars);
r.check('report donut renders drawn arcs', rep.donut > 0 && rep.drawn, JSON.stringify(rep));
await evaluate(`document.querySelector('#revenueChart').scrollIntoView({ block: 'center' })`);
await sleep(700);
console.log(`  ${path.basename(await shotRegion('#revenueChart', 'live-bars-reports.png'))}`);

/* ---------- 9. nothing shouted into the console ---------- */
r.section('Console');
const errs = errors();
r.eq('zero console errors / exceptions', errs.length, 0);
errs.slice(0, 10).forEach((e) => console.log('   !', e.level, e.text));
const nf = netFails();
r.eq('zero failed network requests', nf.length, 0);
nf.slice(0, 10).forEach((e) => console.log('   !', e));

const ok = r.finish();
close();
process.exit(ok ? 0 : 1);

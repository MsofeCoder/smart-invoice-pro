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

if (!process.env.E2E_ISOLATED_PROFILE) throw new Error('Use npm run test:live with an isolated browser profile');
const LIVE = ((process.argv[2] === '--local' ? CONFIG.origin + '/dist/site/' : process.argv[2]) || 'https://msofecoder.github.io/smart-invoice-pro/').replace(/\/?$/, '/');
const workerSource = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const EXPECTED_CACHE = process.env.EXPECTED_CACHE || workerSource.match(/const CACHE_NAME = '[^']+-(v\d+)'/)[1];
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
await evaluate(`(async () => { const db = await import('./js/db.js'); await db.seedSampleData(); })()`);
await goLive('index.html', 2000);
await waitFor(`!!document.querySelector('#statusDonut .donut-seg') && !!document.querySelector('#salesChart .bar-col')`);
await waitSettled();

/* On the first load after a cache-version bump the service worker re-installs
   and precaches ~50 entries, which competes with app boot for the main thread.
   Interacting before the shell has bound its handlers makes the theme toggle
   look broken (it reported "light -> light" exactly once, on the first run
   after the v14 bump, and passed on every subsequent run). Wait for the app's
   own ready flag before touching anything. */
const appReady = await waitFor(`!!window.__APP_READY__`, 80, 250);
r.check('app reported ready before interaction', appReady === true, appReady);

/* ---------- 1. the page came from the right place ---------- */
r.section('Live load');
const boot = await evaluate(`(() => ({
  url: location.href, title: document.title, swSupported: 'serviceWorker' in navigator,
}))()`);
r.check('served from the expected base path', boot.url.startsWith(LIVE), boot.url);
r.check('app booted with a title', !!boot.title, boot.title);
r.check('service workers are available (HTTPS)', boot.swSupported, boot.swSupported);

r.section('Client navigation');
for (const page of ['index.html', 'invoice.html', 'customers.html', 'products.html', 'reports.html', 'settings.html']) {
  const clientPage = await evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(page)}, {cache: 'no-store'});
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    return {status: response.status, admin: !!doc.querySelector('a[href="admin.html"], [data-nav="admin"]')};
  })()`);
  r.check(`${page} loads without Admin navigation`, clientPage.status === 200 && !clientPage.admin, JSON.stringify(clientPage));
}
for (const asset of ['admin.html', 'js/admin.js', 'js/adminKeys.js']) {
  const status = await evaluate(`fetch(${JSON.stringify(asset)}, {cache: 'no-store'}).then(response => response.status)`);
  r.eq(`operator asset ${asset} is not published`, status, 404);
}
// Expected 404 probes above are deliberate, not client runtime errors.
resetLogs();

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
    crossOrigin: performance.getEntriesByType('resource').map((e) => e.name).filter((u) => {
      const resource = new URL(u, location.href);
      // Embedded data/blob resources do not contact another host. Compare
      // complete origins so a hostname prefix cannot conceal a remote request.
      return ['http:', 'https:', 'ws:', 'wss:'].includes(resource.protocol) && resource.origin !== location.origin;
    }),
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
  // Poll for the change rather than sleeping a fixed 400ms: a busy main thread
  // can delay the handler, and a fixed sleep then reports a false failure.
  const until = (test) => new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      if (test() || n++ > 40) resolve();
      else setTimeout(tick, 50);
    };
    tick();
  });
  btn.click();
  await until(() => document.documentElement.getAttribute('data-theme') !== before);
  const after = document.documentElement.getAttribute('data-theme');
  btn.click();
  await until(() => document.documentElement.getAttribute('data-theme') === before);
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

/* ---------- 9. the preview panel and the PDF, in production ----------
   The two defects this deploy fixes were both only visible in the built app:
   a dead Download PDF button when the preview was opened from the list, and a
   signature band that landed on page two. Assert them against the real URL. */
r.section('Preview panel and PDF (live)');

await setWidth(1440, 1000);
await goLive('invoice.html', 4200);
await waitFor(`!!document.querySelector('#invoiceTableBody [data-action="view"]')`);

const livePreview = await evaluate(`(async () => {
  if (!window.__blobs) {
    window.__blobs = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (b) { try { window.__blobs.push(b); } catch (e) {} return orig(b); };
  }
  const row = document.querySelector('#invoiceTableBody [data-action="view"]').closest('tr');
  const expected = row.children[1].textContent.trim();
  document.querySelector('#invoiceTableBody [data-action="view"]').click();
  await new Promise((r) => setTimeout(r, 900));
  const title = [...document.querySelectorAll('#previewDoc .doc-section-title')]
    .find((n) => /BILL TO|MLIPAJI/i.test(n.textContent));
  const nameEl = title && title.parentElement.querySelector('.doc-company strong');
  const shown = nameEl ? nameEl.textContent.trim() : '';
  const editorFormName = (document.querySelector('#invCustomerName') || {}).value || '';
  document.querySelector('#downloadPdfBtn2').click();
  return { expected, shown, editorFormName, opened: !document.querySelector('#previewView').classList.contains('hidden') };
})()`);
r.check('the eye icon opens the preview on the live site', livePreview.opened === true, JSON.stringify(livePreview));
r.check('the preview shows the row customer while the editor form is empty',
  livePreview.shown === livePreview.expected && livePreview.editorFormName === '', JSON.stringify(livePreview));

const livePdfReady = await waitFor(`window.__blobs && window.__blobs.length > 0`, 60, 300);
r.check('Download PDF from the preview produces a file (live)', livePdfReady === true, livePdfReady);
const livePdf = await evaluate(`(async () => {
  const b = window.__blobs && window.__blobs[0];
  if (!b) return null;
  const buf = new Uint8Array(await b.arrayBuffer());
  return { size: buf.length, head: Array.from(buf.slice(0, 5)).map((c) => String.fromCharCode(c)).join('') };
})()`);
r.check('the live download is a real PDF', !!livePdf && livePdf.head === '%PDF-' && livePdf.size > 3000, JSON.stringify(livePdf));

/* Pagination: build a realistic invoice in the live app and count its pages. */
const livePages = await evaluate(`(async () => {
  const [ss, db, exp] = await Promise.all([
    import('./js/storageService.js'), import('./js/db.js'), import('./js/export.js')
  ]);
  const profile = await ss.getCompanyProfile();
  const stored = (await db.getInvoices())[0];
  const cur = { code: 'TZS', symbol: 'TZS', name: 'Tanzanian Shilling', decimals: 2, words: 'Tanzanian Shillings', wordsSingular: 'Tanzanian Shilling' };
  const png = (w, h, c) => { const el = document.createElement('canvas'); el.width = w; el.height = h; const g = el.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, w, h); return el.toDataURL('image/png'); };
  const company = {
    businessName: 'CHICHI NYAMA FRESH', address: 'Plot 45, Nyerere Road',
    region: 'Dar es Salaam', district: 'Ilala', country: 'Tanzania',
    phone: '+255 712 000 111', email: 'sales@chichinyama.co.tz',
    tin: '123-456-789', vrn: '10-123456-A', regNumber: 'REG-99887',
    website: 'https://atz-website.vercel.app/', whatsapp: '+255 712 000 111',
    bankName: 'CRDB', bankAccountName: 'RODGERS AMINI SABUNI',
    bankAccountNumber: '1111222233333', mobileMoney: '+255 765 191 919',
    logoDataUrl: png(200, 80, '#1B5E20'), signatureDataUrl: png(240, 90, '#0000ff'), stampDataUrl: png(160, 160, '#8B0000'),
  };
  const mk = (n) => Array.from({ length: n }, (_, i) => ({
    id: 'l' + i, productId: 'p' + i, name: 'Line item ' + (i + 1), description: '',
    qty: 10 + i, unitPrice: 4500 + i * 250, discountRate: i === 1 ? 5 : 0, taxRate: 18,
    total: (10 + i) * (4500 + i * 250) * (i === 1 ? 0.95 : 1),
  }));
  const build = (n) => {
    const items = mk(n);
    const subtotal = items.reduce((s, i) => s + i.total, 0);
    const tax = subtotal * 0.18;
    return {
      ...stored, id: 'inv_live_fit', number: 'INV-FIT',
      customerName: 'RODGERS AMINI SABUNI', customerPhone: '+255 712 345 678',
      customerEmail: 'rodgers@example.co.tz', customerTin: '123-456-789',
      customerAddress: 'Kariakoo, Dar es Salaam', shipToName: 'RODGERS AMINI SABUNI',
      shipToAddress: 'Kariakoo, Dar es Salaam', shipToPhone: '+255 712 345 678',
      items, subtotal, tax, taxRate: 18, invoiceDiscount: 0, discount: 0, shipping: 0,
      grandTotal: subtotal + tax, amountPaid: 0, balance: subtotal + tax,
      notes: 'Thank you for your business. Please settle by the due date.', currency: 'TZS',
    };
  };
  const qr = await exp.generateQRDataURL('INV:INV-FIT', 220);
  const opts = { logoDataUrl: company.logoDataUrl, signatureDataUrl: company.signatureDataUrl, stampDataUrl: company.stampDataUrl, qrDataUrl: qr, language: 'en' };
  const count = async (n) => (await exp.generateInvoicePDF(build(n), company, cur, opts)).internal.getNumberOfPages();
  return { five: await count(5), sixteen: await count(16) };
})()`);
r.eq('a 5-line invoice with full artwork is ONE page (live)', livePages.five, 1);
r.check('a 16-line invoice still paginates (live)', livePages.sixteen > 1, livePages.sixteen);

/* ---------- 10. nothing shouted into the console ---------- */
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

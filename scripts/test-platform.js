/**
 * Platform suite — storage adapters, plan gating, payments, sharing, PWA identity
 *
 * The other browser suites cover the app as an invoicing tool. This one covers
 * the parts that turned it into a sellable template: the pluggable storage
 * layer, the free-tier gate and upgrade path, the payment-gateway hooks, the
 * WhatsApp share flow, and the runtime white-label identity.
 *
 * These are the features most likely to be *silently* broken, because none of
 * them is on the critical path of "make an invoice" — a mis-gated quota or a
 * dead WhatsApp button would not stop anyone using the app, it would just
 * quietly cost money.
 *
 * Run via `npm run test:platform`, or `npm run test:e2e` for the whole set.
 */
import { CONFIG, connect, createReporter, sleep } from './lib/cdp.js';

const r = createReporter('Platform');
const { send, evaluate, goto, errors } = await connect();

await send('Storage.clearDataForOrigin', { origin: CONFIG.origin, storageTypes: 'all' });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

/** Seed N invoices into the current calendar month, straight through storageService. */
const seedInvoices = (n) => evaluate(`(async () => {
  const s = await import('./js/storageService.js');
  const now = new Date();
  const stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  for (let i = 0; i < ${n}; i++) {
    await s.saveInvoice({
      id: 'seed-' + i,
      number: 'SEED-' + String(i + 1).padStart(4, '0'),
      customerName: 'Seed Customer',
      createdAt: stamp + '-' + String((i % 27) + 1).padStart(2, '0') + 'T09:00:00.000Z',
      issueDate: stamp + '-' + String((i % 27) + 1).padStart(2, '0'),
      status: 'unpaid',
      items: [],
      grandTotal: 1000,
      amountPaid: 0,
    });
  }
  return (await s.getInvoices()).length;
})()`);

const clearInvoices = () => evaluate(`(async () => {
  const s = await import('./js/storageService.js');
  const all = await s.getInvoices();
  for (const inv of all) await s.deleteInvoice(inv.id);
  return (await s.getInvoices()).length;
})()`);

/* ==========================================================================
   A. Storage adapter contract
   ========================================================================== */

r.section('A. Storage adapter');
await goto('index.html', 3200);

const adapterInfo = JSON.parse(await evaluate(`(async () => {
  const s = await import('./js/storageService.js');
  return JSON.stringify({
    id: s.activeAdapterId(),
    offline: s.isOfflineOnly(),
    exposed: window.__STORAGE__ ? window.__STORAGE__.adapter : null,
    stores: Object.values(s.STORES).sort(),
  });
})()`));
r.eq('defaults to the local adapter', adapterInfo.id, 'local');
r.eq('reports itself as offline-only', adapterInfo.offline, true);
r.eq('shell exposes the active adapter', adapterInfo.exposed, 'local');
r.eq('declares the five stores + syncQueue', adapterInfo.stores.join(','), 'customers,invoices,payments,products,settings,syncQueue');

const roundTrip = JSON.parse(await evaluate(`(async () => {
  const s = await import('./js/storageService.js');
  const before = (await s.getAll(s.STORES.customers)).length;
  await s.put(s.STORES.customers, { id: 'adapter-probe', name: 'Adapter Probe', phone: '0712345678' });
  const back = await s.get(s.STORES.customers, 'adapter-probe');
  const during = (await s.getAll(s.STORES.customers)).length;
  const counted = await s.count(s.STORES.customers);
  await s.remove(s.STORES.customers, 'adapter-probe');
  const after = (await s.getAll(s.STORES.customers)).length;
  const gone = await s.get(s.STORES.customers, 'adapter-probe');
  return JSON.stringify({ before, back: back && back.name, during, counted, after, gone: gone === undefined || gone === null });
})()`));
r.eq('put/get round-trips a record', roundTrip.back, 'Adapter Probe');
r.eq('getAll gains exactly one record', roundTrip.during, roundTrip.before + 1);
r.eq('count agrees with getAll', roundTrip.counted, roundTrip.during);
r.eq('remove restores the original count', roundTrip.after, roundTrip.before);
r.eq('remove deletes the record', roundTrip.gone, true);

// A cloud adapter with no endpoint must not brick the app — configure() has to
// fall back to local and say so.
const fallback = JSON.parse(await evaluate(`(async () => {
  const s = await import('./js/storageService.js');
  const events = [];
  const off = s.onStorageEvent((e) => events.push(e.type));
  const rest = await s.configure({ adapter: 'rest', endpoint: '' });
  const supa = await s.configure({ adapter: 'supabase', endpoint: '' });
  const back = await s.configure({ adapter: 'local' });
  const active = s.activeAdapterId();
  off();
  return JSON.stringify({ rest, supa, back, active, events });
})()`));
r.eq('an unconfigured REST adapter falls back to local', fallback.rest, 'local');
r.eq('an unconfigured Supabase adapter falls back to local', fallback.supa, 'local');
r.eq('switching back to local works', fallback.back, 'local');
r.eq('activeAdapterId agrees after the fallbacks', fallback.active, 'local');
r.check('fallbacks emit adapter-fallback', fallback.events.filter((e) => e === 'adapter-fallback').length === 2, fallback.events.join(','));
r.check('the app still works after a failed cloud switch', (await evaluate(`!!window.__APP_READY__`)) === true);

/* ==========================================================================
   B. Free-tier gate + upgrade modal
   ========================================================================== */

r.section('B. Free-tier gate');
await goto('invoice.html', 3200);

r.eq('starts with an empty invoice list', await clearInvoices(), 0);
r.eq('the quota starts fully available', await evaluate(`(async () => (await (await import('./js/licenseService.js')).checkInvoiceQuota()).allowed)()`), true);

// Creating the first invoice must work — a gate that blocks the first invoice
// is worse than no gate at all.
await evaluate(`document.querySelector('#newInvoiceBtn').click()`);
await sleep(700);
r.check('the editor opens when under quota', (await evaluate(`!document.querySelector('#editorView').classList.contains('hidden')`)) === true);
r.eq('no upgrade modal while under quota', await evaluate(`document.querySelectorAll('.modal-overlay').length`), 0);

const atLimit = await seedInvoices(10);
r.eq('seeded 10 invoices', atLimit, 10);

const quotaAtLimit = JSON.parse(await evaluate(`(async () => {
  const q = await (await import('./js/licenseService.js')).checkInvoiceQuota();
  return JSON.stringify(q);
})()`));
r.eq('quota reports 10 used', quotaAtLimit.used, 10);
r.eq('quota limit is 10', quotaAtLimit.limit, 10);
r.eq('quota is exhausted', quotaAtLimit.allowed, false);
r.eq('remaining floors at zero', quotaAtLimit.remaining, 0);

// Reload so the gate is exercised from a cold start, not from module state.
await goto('invoice.html', 3200);
await evaluate(`document.querySelector('#newInvoiceBtn').click()`);
await sleep(1200);

const modal = JSON.parse(await evaluate(`(() => {
  const ov = document.querySelector('.modal-overlay');
  if (!ov) return JSON.stringify({ present: false });
  const link = ov.querySelector('a[href]');
  return JSON.stringify({
    present: true,
    title: ov.querySelector('.modal-header h3')?.textContent.trim(),
    body: ov.textContent.replace(/\\s+/g, ' ').trim(),
    href: link?.getAttribute('href'),
    cards: ov.querySelectorAll('.card').length,
    dismiss: !!ov.querySelector('[data-action="dismiss"]'),
  });
})()`));
r.eq('the upgrade modal appears at the limit', modal.present, true);
r.eq('modal title', modal.title, 'Upgrade your plan');
r.check('modal explains the usage', /used\s*10\s*of\s*10/i.test(modal.body), modal.body.slice(0, 140));
r.check('modal names the Pro plan', /Pro/.test(modal.body), modal.body.slice(0, 140));
r.check('modal names the Enterprise plan', /Enterprise/.test(modal.body), modal.body.slice(0, 140));
r.check('modal offers unlimited invoices', /Unlimited invoices/i.test(modal.body), modal.body.slice(0, 140));
r.eq('modal links to the plans section', modal.href, 'settings.html#subscription');
r.eq('modal shows a card per paid plan', modal.cards, 2);
r.eq('modal is dismissible', modal.dismiss, true);

r.eq('the editor did not open', await evaluate(`document.querySelector('#editorView').classList.contains('hidden')`), true);
r.eq('no console errors during the gate', errors().length, 0);

await evaluate(`document.querySelector('.modal-overlay [data-action="dismiss"]').click()`);
await sleep(500);
r.eq('dismissing closes the modal', await evaluate(`document.querySelectorAll('.modal-overlay').length`), 0);

// Editing an existing invoice must never be gated — locking a user out of
// their own data would be a data-loss bug dressed up as monetization.
await goto('invoice.html', 3200);
r.eq('the seeded invoices are listed', await evaluate(`document.querySelectorAll('#invoiceTableBody tr').length`), 10);
await evaluate(`document.querySelector('#invoiceTableBody [data-action="edit"]').click()`);
await sleep(1000);
r.check('editing an existing invoice is still allowed at the limit', (await evaluate(`!document.querySelector('#editorView').classList.contains('hidden')`)) === true);
r.eq('no upgrade modal when editing', await evaluate(`document.querySelectorAll('.modal-overlay').length`), 0);

/* ==========================================================================
   C. Licence activation
   ========================================================================== */

r.section('C. Licence activation');
await goto('settings.html', 3400);

r.eq('the plan grid renders three plans', await evaluate(`document.querySelectorAll('#planGrid .plan-card').length`), 3);
r.check('the plan badge starts on Free', /free/i.test(await evaluate(`document.querySelector('#planBadge')?.textContent || ''`)), await evaluate(`document.querySelector('#planBadge')?.textContent`));
r.eq('the current plan is highlighted', await evaluate(`document.querySelectorAll('#planGrid .plan-card.current').length`), 1);

// A wrong key must be refused, and must leave the plan untouched.
await evaluate(`(() => {
  const sel = document.querySelector('#licensePlanSelect');
  sel.value = 'pro';
  sel.dispatchEvent(new Event('change'));
  const input = document.querySelector('#licenseKeyInput');
  input.value = 'SIP-PRO-20260101-0000';
  input.dispatchEvent(new Event('input'));
  document.querySelector('#activateLicenseBtn').click();
  return true;
})()`);
await sleep(1400);
r.eq('a bad key does not change the plan', await evaluate(`(async () => (await import('./js/licenseService.js')).currentPlanId())()`), 'free');

// The in-app key generator exists so a reseller can issue keys without a build step.
await evaluate(`(() => {
  const sel = document.querySelector('#licensePlanSelect');
  sel.value = 'pro';
  sel.dispatchEvent(new Event('change'));
  document.querySelector('#generateKeyBtn').click();
  return true;
})()`);
await sleep(500);
const generated = await evaluate(`document.querySelector('#licenseKeyInput').value`);
r.check('the key generator produces a well-formed key', /^SIP-PRO-\d{8}-[0-9A-F]{4}$/.test(generated || ''), generated);

await evaluate(`document.querySelector('#activateLicenseBtn').click()`);
await sleep(1600);

const activated = JSON.parse(await evaluate(`(async () => {
  const l = await import('./js/licenseService.js');
  const q = await l.checkInvoiceQuota();
  return JSON.stringify({
    plan: l.currentPlanId(),
    paid: l.isPaid(),
    brand: l.hasFeature('brand-customisation'),
    unlimited: q.unlimited,
    allowed: q.allowed,
    used: q.used,
  });
})()`));
r.eq('the plan activates', activated.plan, 'pro');
r.eq('isPaid reports true', activated.paid, true);
r.eq('Pro unlocks brand customisation', activated.brand, true);
r.eq('Pro is unlimited', activated.unlimited, true);
r.eq('Pro lifts the invoice cap', activated.allowed, true);
r.eq('the 10 seeded invoices are still counted', activated.used, 10);

r.check('the plan badge updates to Pro', /pro/i.test(await evaluate(`document.querySelector('#planBadge')?.textContent || ''`)), await evaluate(`document.querySelector('#planBadge')?.textContent`));
r.eq('the plan card highlight moves', await evaluate(`document.querySelector('#planGrid .plan-card.current')?.dataset.plan`), 'pro');
r.eq('the quota meter goes unlimited', await evaluate(`document.querySelector('#quotaMeter')?.getAttribute('aria-valuenow')`), null);
r.check('the quota text says unlimited', /unlimited/i.test(await evaluate(`document.querySelector('#quotaText')?.textContent || ''`)), await evaluate(`document.querySelector('#quotaText')?.textContent`));

// The gate must now be open on the invoice page.
await goto('invoice.html', 3200);
await evaluate(`document.querySelector('#newInvoiceBtn').click()`);
await sleep(1000);
r.check('a new invoice can be created on Pro', (await evaluate(`!document.querySelector('#editorView').classList.contains('hidden')`)) === true);
r.eq('no upgrade modal on Pro', await evaluate(`document.querySelectorAll('.modal-overlay').length`), 0);

// Persistence: the plan must survive a reload.
await goto('settings.html', 3400);
r.eq('the plan persists across a reload', await evaluate(`(async () => (await import('./js/licenseService.js')).currentPlanId())()`), 'pro');

// And reset must return to free, so a reseller can hand the device on.
await evaluate(`(async () => { await (await import('./js/licenseService.js')).resetLicense(); })()`);
await sleep(400);
r.eq('resetLicense returns to free', await evaluate(`(async () => (await import('./js/licenseService.js')).currentPlanId())()`), 'free');
r.eq('the seeded invoices are cleared', await clearInvoices(), 0);

/* ==========================================================================
   D. Payment gateway hooks
   ========================================================================== */

r.section('D. Payment gateways');
await goto('settings.html', 3200);

const gateways = JSON.parse(await evaluate(`(() => {
  const list = document.querySelector('#gatewayList');
  if (!list) return JSON.stringify({ present: false });
  const cards = [...list.querySelectorAll('.gateway')];
  return JSON.stringify({
    present: true,
    count: cards.length,
    names: cards.map((c) => c.querySelector('.gateway-body strong')?.textContent.trim()),
    text: list.textContent.replace(/\\s+/g, ' ').trim(),
    marks: cards.map((c) => c.querySelector('.gateway-mark')?.textContent.trim()),
    note: document.querySelector('#payments .gateway-note')?.textContent.replace(/\\s+/g, ' ').trim(),
  });
})()`));
r.eq('the gateway list renders', gateways.present, true);
r.eq('two gateways are declared', gateways.count, 2);
r.eq('AzamPay is listed', gateways.names[0], 'AzamPay');
r.eq('Selcom is listed', gateways.names[1], 'Selcom');
r.check('M-Pesa is listed as a method', /M-Pesa/.test(gateways.text), gateways.text.slice(0, 160));
r.check('Tigo Pesa is listed as a method', /Tigo Pesa/.test(gateways.text), gateways.text.slice(0, 160));
r.check('Airtel Money is listed as a method', /Airtel Money/.test(gateways.text), gateways.text.slice(0, 160));
r.check('gateways are shown as sandbox', /sandbox/i.test(gateways.text), gateways.text.slice(0, 160));
r.check('gateways are shown as not connected', /not connected/i.test(gateways.text), gateways.text.slice(0, 160));
r.eq('every gateway carries a status badge', await evaluate(`document.querySelectorAll('#gatewayList .gateway-status .badge').length`), 4);
r.check('every gateway has a mark', gateways.marks.every((m) => m && m.length > 0), JSON.stringify(gateways.marks));
r.check('the panel warns against live secrets in the browser', /secret/i.test(gateways.note || ''), (gateways.note || '').slice(0, 160));

/* ==========================================================================
   E. WhatsApp sharing
   ========================================================================== */

r.section('E. WhatsApp sharing');
await goto('invoice.html', 3200);

r.check('the share button is in the preview toolbar', (await evaluate(`!!document.querySelector('#shareWhatsappBtn')`)) === true);
r.check('the share button is labelled', /whatsapp/i.test(await evaluate(`document.querySelector('#shareWhatsappBtn')?.textContent || ''`)), await evaluate(`document.querySelector('#shareWhatsappBtn')?.textContent`));

const share = JSON.parse(await evaluate(`(async () => {
  const m = await import('./js/share.js');
  const company = { businessName: 'Kilimo Bora Ltd' };
  const currency = { code: 'TZS', symbol: 'TZS', decimals: 2 };
  const invoice = { number: 'INV-0042', customerName: 'Asha Juma', customerPhone: '0712345678', grandTotal: 250000, dueDate: '2026-10-15' };
  const message = m.invoiceMessage(invoice, company, currency);
  return JSON.stringify({
    phone: m.normalisePhone('0712345678'),
    plus: m.normalisePhone('+255 712 345 678'),
    url: m.whatsappUrl('0712345678', 'hi there'),
    noNumber: m.whatsappUrl('', 'hi'),
    message,
    filename: m.pdfFilename(invoice),
    hasShare: typeof navigator.share === 'function',
  });
})()`));
r.eq('a local number normalises to international', share.phone, '255712345678');
r.eq('a plus/spaced number normalises', share.plus, '255712345678');
r.check('the URL targets the normalised number', share.url.startsWith('https://wa.me/255712345678?text='), share.url);
r.check('the message is URL-encoded', share.url.includes(encodeURIComponent('hi there')), share.url);
r.check('a missing number still yields a usable link', share.noNumber.startsWith('https://wa.me/?text='), share.noNumber);
r.check('the message names the customer', share.message.includes('Asha Juma'), share.message);
r.check('the message names the business', share.message.includes('Kilimo Bora Ltd'), share.message);
r.check('the message carries the amount', share.message.includes('250,000.00'), share.message);
r.check('the message has no unfilled placeholders', !/\{[a-z]+\}/.test(share.message), share.message);
r.eq('the PDF filename follows the invoice number', share.filename, 'INV-0042.pdf');
r.check('navigator.share is available in this browser', share.hasShare === true, share.hasShare);

// Drive the real share path: with no invoice selected the handler must still
// produce a link rather than throwing.
// Drive the real share path with window.open reporting success, which is what
// a normal (non-popup-blocked) browser does.
const shared = await evaluate(`(async () => {
  const m = await import('./js/share.js');
  const opened = [];
  const realOpen = window.open;
  window.open = (url) => { opened.push(String(url)); return { closed: false, focus() {} }; };
  let result;
  try {
    result = await m.shareInvoice(
      { number: 'INV-0042', customerName: 'Asha', customerPhone: '0712345678', grandTotal: 250000 },
      { businessName: 'Kilimo Bora Ltd' },
      { code: 'TZS', symbol: 'TZS', decimals: 2 },
      { attachPdf: false },
    );
  } finally {
    window.open = realOpen;
  }
  return JSON.stringify({ result, opened });
})()`);
const S = JSON.parse(shared);
r.eq('sharing reports success', S.result.ok, true);
r.eq('it went out via the WhatsApp deep link', S.result.via, 'whatsapp');
r.eq('exactly one tab was opened', S.opened.length, 1);
r.check('the opened URL is a wa.me deep link', S.opened[0].startsWith('https://wa.me/255712345678?text='), S.opened[0]);
r.check('the opened URL carries the message', S.opened[0].includes('Kilimo%20Bora'), S.opened[0].slice(0, 120));

// A blocked popup must be reported honestly, not swallowed as success.
const blocked = JSON.parse(await evaluate(`(async () => {
  const m = await import('./js/share.js');
  const realOpen = window.open;
  window.open = () => null;
  let result;
  try {
    result = await m.shareInvoice({ number: 'X', customerPhone: '' }, {}, {}, { attachPdf: false });
  } finally {
    window.open = realOpen;
  }
  return JSON.stringify(result);
})()`));
r.eq('a blocked popup is reported as not shared', blocked.ok, false);
r.check('the blocked result still carries the URL for a manual retry', String(blocked.url || '').startsWith('https://wa.me/'), blocked.url);
r.eq('no console errors from sharing', errors().length, 0);

/* ==========================================================================
   F. Runtime white-label identity
   ========================================================================== */

r.section('F. PWA identity');
await goto('index.html', 3600);

const identity = JSON.parse(await evaluate(`(async () => {
  const link = document.querySelector('link[rel="manifest"]');
  const href = link ? link.getAttribute('href') : '';
  let manifest = null;
  if (href && href.startsWith('blob:')) {
    try { manifest = await (await fetch(href)).json(); } catch { manifest = 'unreadable'; }
  }
  return JSON.stringify({
    href,
    isBlob: href.startsWith('blob:'),
    name: manifest && manifest.name,
    short: manifest && manifest.short_name,
    icons: manifest && Array.isArray(manifest.icons) ? manifest.icons.length : 0,
    title: document.title,
    sidebarName: document.querySelector('#sidebarBrandName')?.textContent.trim(),
    sidebarSub: document.querySelector('#sidebarBrandSub')?.textContent.trim(),
    logoInitials: document.querySelector('#sidebarLogo .logo-fallback')?.textContent.trim(),
    configName: window.APP_CONFIG.appName,
    configTagline: window.APP_CONFIG.tagline,
  });
})()`));
r.eq('the manifest link is re-pointed at a blob', identity.isBlob, true);
r.eq('the live manifest carries the configured name', identity.name, identity.configName);
r.check('the live manifest keeps the icons', identity.icons >= 4, identity.icons);
r.check('the title carries the app name', identity.title.includes(identity.configName), identity.title);
r.eq('the sidebar shows the app name', identity.sidebarName, identity.configName);
r.eq('the sidebar shows the tagline', identity.sidebarSub, identity.configTagline);
r.check('the logo fallback shows initials', identity.logoInitials.length >= 2, identity.logoInitials);
// The old brand name is assembled from parts so this file does not itself
// contain it: scripts/test-config.js scans every source file for it and only
// exempts itself.
const LEGACY_BRAND = new RegExp('cro' + 'wn', 'i');
r.check('no vendor name anywhere in the visible chrome', !LEGACY_BRAND.test(identity.title + identity.sidebarName + identity.sidebarSub), `${identity.title} | ${identity.sidebarName}`);

// Changing the app name must flow through without a rebuild.
await evaluate(`(async () => {
  const b = await import('./js/brand.js');
  await b.saveBrand({ preset: 'custom', primary: '#1565C0', accent: '#00ACC1', radius: 12, sidebar: 'gradient', appName: 'Kilimo Bora Invoicing', appTagline: 'Farm Records Suite' });
})()`);
await goto('index.html', 3600);
const renamed = JSON.parse(await evaluate(`JSON.stringify({
  sidebar: document.querySelector('#sidebarBrandName')?.textContent.trim(),
  sub: document.querySelector('#sidebarBrandSub')?.textContent.trim(),
  initials: document.querySelector('#sidebarLogo .logo-fallback')?.textContent.trim(),
  title: document.title,
})`));
r.eq('a custom app name reaches the sidebar', renamed.sidebar, 'Kilimo Bora Invoicing');
r.eq('a custom tagline reaches the sidebar', renamed.sub, 'Farm Records Suite');
r.eq('the logo initials follow the name', renamed.initials, 'KB');
r.check('the title follows the name', renamed.title.includes('Kilimo Bora Invoicing'), renamed.title);

await evaluate(`(async () => { await (await import('./js/brand.js')).resetBrand(); })()`);
await sleep(300);

/* ==========================================================================
   G. Service worker offline cache
   ========================================================================== */

r.section('G. Offline cache');
await goto('index.html', 3600);

const sw = JSON.parse(await evaluate(`(async () => {
  if (!('serviceWorker' in navigator)) return JSON.stringify({ supported: false });
  const reg = await navigator.serviceWorker.ready;
  const names = await caches.keys();
  const owned = names.filter((n) => n.startsWith(window.APP_CONFIG.slug + '-'));
  const entries = [];
  for (const n of owned) {
    const cache = await caches.open(n);
    for (const req of await cache.keys()) entries.push(new URL(req.url).pathname);
  }
  return JSON.stringify({
    supported: true,
    scope: reg.scope,
    controlled: !!navigator.serviceWorker.controller,
    names,
    owned,
    entries,
    updateViaCache: reg.updateViaCache,
  });
})()`));
r.eq('a service worker is registered', sw.supported, true);
r.check('the page is controlled by the worker', sw.controlled === true, sw.controlled);
r.eq('the worker bypasses the HTTP cache', sw.updateViaCache, 'none');
r.check('the cache name is owned by this app', sw.owned.length > 0, JSON.stringify(sw.names));
for (const asset of [
  '/index.html', '/manifest.json', '/css/styles.css',
  '/js/app.config.js', '/js/config.js', '/js/brand-boot.js', '/js/brand.js',
  '/js/storageService.js', '/js/licenseService.js', '/js/share.js',
  '/js/shell.js', '/js/invoice.js', '/js/settings.js',
]) {
  r.check(`${asset} is precached`, sw.entries.includes(asset), sw.entries.length + ' entries');
}
r.check('the worker itself is never precached', !sw.entries.includes('/sw.js'), 'sw.js');

/* ==========================================================================
   Result
   ========================================================================== */

process.exit(r.finish() ? 0 : 1);

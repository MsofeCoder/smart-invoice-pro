/**
 * End-to-end verification.
 *
 * Drives the real app in a real browser over CDP and asserts on observable
 * behaviour: rendered DOM, computed styles, IndexedDB contents, generated file
 * blobs. Nothing is mocked — if this passes, the app genuinely works.
 *
 * Requires a running server + browser. Normally invoked via:
 *     npm run test:e2e
 * which starts both for you. To point it at your own pair:
 *     E2E_CDP=http://127.0.0.1:9223 E2E_ORIGIN=http://127.0.0.1:8080 node scripts/test-e2e.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, connect, createReporter, sleep } from './lib/cdp.js';

const { origin } = CONFIG;
const r = createReporter('E2E');

fs.rmSync(CONFIG.downloads, { recursive: true, force: true });
fs.mkdirSync(CONFIG.downloads, { recursive: true });
fs.mkdirSync(CONFIG.shots, { recursive: true });

const { send, evaluate, goto, shot, errors, netFails } = await connect();
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: CONFIG.downloads });

/* ---------- Deterministic start ----------
   The browser profile persists between runs, so a previous run's theme, brand
   and records would leak in and produce false failures. Wipe the origin first;
   the app re-seeds its sample data on an empty database. */
await send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
await goto('index.html', 3600);
const seeded = await evaluate(
  `(async () => { const db = await import('./js/db.js'); return { inv: (await db.getInvoices()).length, cus: (await db.getCustomers()).length }; })()`,
);
r.check('fresh seed produced sample data', seeded.inv > 0 && seeded.cus > 0, JSON.stringify(seeded));

/* ---------- Blob capture ----------
   Headless download plumbing is unreliable, and the blob *contents* are what
   actually matter. Intercept createObjectURL and read the blobs directly. */
const installBlobCapture = () =>
  evaluate(`(() => {
    if (window.__blobs) return true;
    window.__blobs = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (b) { try { window.__blobs.push(b); } catch (e) {} return orig(b); };
    return true;
  })()`);

const readBlob = (i, as = 'text') =>
  evaluate(`(async () => {
    const b = window.__blobs && window.__blobs[${i}];
    if (!b) return null;
    if ('${as}' === 'text') return await b.text();
    const buf = new Uint8Array(await b.arrayBuffer());
    return { size: buf.length, head: Array.from(buf.slice(0, 5)).map(c => String.fromCharCode(c)).join(''), type: b.type };
  })()`);

/* ============ A. Every page loads clean ============ */
r.section('A. Page health');
for (const [page, titleRe] of [
  ['index.html', /Dashboard/],
  ['invoice.html', /Invoice/],
  ['customers.html', /Customer/],
  ['products.html', /Product/],
  ['reports.html', /Report/],
  ['settings.html', /Setting/],
]) {
  await goto(page);
  const t = await evaluate('document.title');
  r.check(`${page} loads`, titleRe.test(t || ''), t);
  const e = errors();
  r.check(`${page} no console errors`, e.length === 0, JSON.stringify(e).slice(0, 300));
  const ready = await evaluate('!!window.__APP_READY__');
  r.check(`${page} app ready flag`, ready === true, ready);
}

/* ============ B. Brand theming ============ */
r.section('B. Brand theming');
await goto('settings.html', 2800);

r.eq('12 presets rendered', await evaluate(`document.querySelectorAll('#brandPresets [data-preset]').length`), 12);
r.eq('4 sidebar styles rendered', await evaluate(`document.querySelectorAll('#brandSidebar [data-sidebar]').length`), 4);
r.eq('4 contrast readouts', await evaluate(`document.querySelectorAll('#brandContrast .contrast-item').length`), 4);

const clicked = await evaluate(
  `(() => { const b = document.querySelector('[data-preset="ocean"]'); if (!b) return false; b.click(); return true; })()`,
);
r.check('ocean preset clickable', clicked === true, clicked);
await sleep(600);

const ap = JSON.parse(
  await evaluate(`JSON.stringify({
    brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
    stored: JSON.parse(window.AppConfig.readStorage('brand') || '{}').primary,
    active: document.querySelector('#brandPresets .swatch.active')?.dataset.preset,
    hex: document.querySelector('#brandPrimaryHex')?.value
  })`),
);
r.eq('--brand updated in DOM', ap.brand, '#1565C0');
r.eq('primary persisted to localStorage', ap.stored, '#1565C0');
r.eq('swatch marked active', ap.active, 'ocean');
r.eq('hex input synced', ap.hex, '#1565C0');

await evaluate(
  `(() => { const el = document.querySelector('#brandPrimaryHex'); el.value = '#7B1FA2'; el.dispatchEvent(new Event('change')); return true; })()`,
);
await sleep(600);
const cu = JSON.parse(
  await evaluate(`JSON.stringify({
    brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
    preset: document.querySelector('#brandPresets .swatch.active')?.dataset.preset || null,
    stored: JSON.parse(window.AppConfig.readStorage('brand')||'{}').primary
  })`),
);
r.eq('custom hex applies', cu.brand, '#7B1FA2');
r.check('custom hex clears preset selection', cu.preset === null, cu.preset);
r.eq('custom hex persists', cu.stored, '#7B1FA2');

await evaluate(
  `(() => { const el = document.querySelector('#brandPrimaryHex'); el.value = 'garbage'; el.dispatchEvent(new Event('change')); return true; })()`,
);
await sleep(400);
const ab = JSON.parse(
  await evaluate(
    `JSON.stringify({ brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(), hex: document.querySelector('#brandPrimaryHex').value })`,
  ),
);
r.eq('invalid hex leaves brand intact', ab.brand, '#7B1FA2');
r.eq('invalid hex reverts input', ab.hex, '#7B1FA2');

await evaluate(`document.querySelector('[data-sidebar="deep"]').click()`);
await sleep(500);
const sb = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--sidebar-bg').trim()`);
r.check('deep sidebar applies gradient', /linear-gradient/.test(sb), sb);

await evaluate(`document.querySelector('[data-sidebar="light"]').click()`);
await sleep(500);
const sbl = JSON.parse(
  await evaluate(`JSON.stringify({
    bg: getComputedStyle(document.documentElement).getPropertyValue('--sidebar-bg').trim(),
    fg: getComputedStyle(document.documentElement).getPropertyValue('--sidebar-fg').trim(),
    actual: getComputedStyle(document.querySelector('.sidebar')).backgroundColor
  })`),
);
r.eq('light sidebar bg token', sbl.bg, '#FFFFFF');
r.eq('light sidebar fg token', sbl.fg, '#2B2B2B');
r.check('light sidebar actually paints white', sbl.actual === 'rgb(255, 255, 255)', sbl.actual);

await evaluate(`(() => { const el = document.querySelector('#brandRadius'); el.value = '2'; el.dispatchEvent(new Event('input')); return true; })()`);
await sleep(500);
const rr = JSON.parse(
  await evaluate(
    `JSON.stringify({ r: getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(), label: document.querySelector('#brandRadiusVal').textContent })`,
  ),
);
r.eq('radius token updates', rr.r, '2px');
r.eq('radius label updates', rr.label, '2px');
await evaluate(`(() => { const el = document.querySelector('#brandRadius'); el.value = '14'; el.dispatchEvent(new Event('input')); return true; })()`);
await sleep(400);

await evaluate(
  `(() => { const el = document.querySelector('#brandAppName'); el.value = 'Kilimo Bora Invoicing'; el.dispatchEvent(new Event('input')); return true; })()`,
);
await sleep(700);
const no = JSON.parse(
  await evaluate(`JSON.stringify({
    sidebar: document.querySelector('#sidebarBrandName').textContent,
    title: document.title,
    preview: document.querySelector('#bpTitle').textContent
  })`),
);
r.eq('sidebar shows custom app name', no.sidebar, 'Kilimo Bora Invoicing');
r.check('document title updated', no.title.includes('Kilimo Bora Invoicing'), no.title);
r.eq('preview title updated', no.preview, 'Kilimo Bora Invoicing');

await shot('10-brand-customizer.png');

/* ============ C. Persistence + no-flash ============ */
r.section('C. Persistence & first paint');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__firstFrame = null;
    requestAnimationFrame(function(){
      window.__firstFrame = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
    });`,
});
await goto('index.html', 2600);

r.eq('brand applied by FIRST animation frame (no flash)', await evaluate('window.__firstFrame'), '#7B1FA2');

const pe = JSON.parse(
  await evaluate(`JSON.stringify({
    brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
    sidebar: document.querySelector('#sidebarBrandName').textContent,
    stored: JSON.parse(window.AppConfig.readStorage('brand')||'{}')
  })`),
);
r.eq('brand persists across page navigation', pe.brand, '#7B1FA2');
r.eq('app name persists across pages', pe.sidebar, 'Kilimo Bora Invoicing');
r.eq('stored sidebar style', pe.stored.sidebar, 'light');
r.eq('stored radius', pe.stored.radius, 14);

/* ============ D. Dark mode re-derives palette ============ */
r.section('D. Dark mode');
await evaluate(`document.querySelector('#themeToggle').click()`);
await sleep(600);
const dk = JSON.parse(
  await evaluate(`JSON.stringify({
    theme: document.documentElement.getAttribute('data-theme'),
    brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
    contrast: getComputedStyle(document.documentElement).getPropertyValue('--brand-contrast').trim()
  })`),
);
r.eq('theme switches to dark', dk.theme, 'dark');
r.check('dark mode lightens the brand for contrast', dk.brand !== '#7B1FA2', `${dk.brand} (light theme was #7B1FA2)`);
r.check('dark brand is lighter than light brand', parseInt(dk.brand.slice(1), 16) > parseInt('7B1FA2', 16), dk.brand);

const darkContrast = await evaluate(`(async () => {
  const m = await import('./js/brand.js');
  const cs = getComputedStyle(document.documentElement);
  return m.contrastRatio(cs.getPropertyValue('--brand-contrast').trim(), cs.getPropertyValue('--brand').trim());
})()`);
r.check('dark mode brand/contrast >= 4.5:1', darkContrast >= 4.5, Number(darkContrast).toFixed(2) + ':1');
await shot('11-dark-themed.png');
await evaluate(`document.querySelector('#themeToggle').click()`);
await sleep(500);

/* ============ E. Reset ============ */
r.section('E. Reset');
await goto('settings.html', 2600);
await evaluate(`document.querySelector('#brandReset').click()`);
await sleep(900);
const rs = JSON.parse(
  await evaluate(
    `JSON.stringify({ brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(), name: document.querySelector('#sidebarBrandName').textContent })`,
  ),
);
r.eq('reset restores default brand', rs.brand, '#2E7D32');
r.check('reset clears custom app name', rs.name !== 'Kilimo Bora Invoicing', rs.name);

/* ============ F. Customers CRUD ============ */
r.section('F. Customers');
await goto('customers.html', 2600);
const custBefore = await evaluate(`document.querySelectorAll('#customerTableBody tr').length`);
await evaluate(`document.querySelector('#addCustomerBtn').click()`);
await sleep(700);
await evaluate(`(() => {
  document.querySelector('#custName').value = 'E2E Test Buyer';
  document.querySelector('#custPhone').value = '+255 700 000 111';
  document.querySelector('#custEmail').value = 'e2e@test.co.tz';
  document.querySelector('#custTin').value = '999-888-777';
  document.querySelector('#custAddress').value = 'Test Street 1';
  document.querySelector('[data-action="save"]').click();
  return true;
})()`);
await sleep(1200);
const ca = JSON.parse(
  await evaluate(
    `JSON.stringify({ rows: document.querySelectorAll('#customerTableBody tr').length, has: document.querySelector('#customerTableBody').textContent.includes('E2E Test Buyer') })`,
  ),
);
r.eq('customer row count +1', ca.rows, custBefore + 1);
r.check('new customer appears in table', ca.has === true, ca.has);

await evaluate(`(() => { const s = document.querySelector('#customerSearch'); s.value = 'E2E'; s.dispatchEvent(new Event('input')); return true; })()`);
await sleep(600);
r.eq('search filters to 1 result', await evaluate(`document.querySelectorAll('#customerTableBody tr').length`), 1);
await evaluate(`(() => { const s = document.querySelector('#customerSearch'); s.value = ''; s.dispatchEvent(new Event('input')); return true; })()`);
await sleep(500);
r.check('customers page clean after CRUD', errors().length === 0, JSON.stringify(errors()).slice(0, 300));

/* ============ G. Products CRUD ============ */
r.section('G. Products');
await goto('products.html', 2600);
const prodBefore = await evaluate(`document.querySelectorAll('#productTableBody tr').length`);
await evaluate(`document.querySelector('#addProductBtn').click()`);
await sleep(700);
await evaluate(`(() => {
  document.querySelector('#prodName').value = 'E2E Test Cashews';
  document.querySelector('#prodSku').value = 'E2E-001';
  document.querySelector('#prodCost').value = '5000';
  document.querySelector('#prodPrice').value = '8000';
  document.querySelector('#prodStock').value = '25';
  document.querySelector('#prodLow').value = '5';
  document.querySelector('[data-action="save"]').click();
  return true;
})()`);
await sleep(1200);
const pa = JSON.parse(
  await evaluate(
    `JSON.stringify({ rows: document.querySelectorAll('#productTableBody tr').length, has: document.querySelector('#productTableBody').textContent.includes('E2E Test Cashews') })`,
  ),
);
r.eq('product row count +1', pa.rows, prodBefore + 1);
r.check('new product appears', pa.has === true, pa.has);
r.check('products page clean after CRUD', errors().length === 0, JSON.stringify(errors()).slice(0, 300));

/* ============ H. Invoice creation + math ============ */
r.section('H. Invoice');
await goto('invoice.html', 2800);
await evaluate(`document.querySelector('#newInvoiceBtn').click()`);
await sleep(1000);
await evaluate(`(() => {
  const cs = document.querySelector('#invCustomer');
  if (cs && cs.options.length > 1) { cs.selectedIndex = 1; cs.dispatchEvent(new Event('change', {bubbles:true})); }
  document.querySelector('#addLineBtn').click();
  return true;
})()`);
await sleep(900);

const filled = await evaluate(`(() => {
  const row = document.querySelector('#itemsBody tr');
  if (!row) return 'no-row';
  const setV = (sel, v) => { const el = row.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); };
  const name = row.querySelector('.line-name');
  name.value = 'E2E Widget';
  name.dispatchEvent(new Event('input', {bubbles:true}));
  setV('.line-qty', '4');
  setV('.line-price', '2500');
  setV('.line-disc', '0');
  const tax = document.querySelector('#invTaxRate');
  if (tax) { tax.value = '18'; tax.dispatchEvent(new Event('input', {bubbles:true})); }
  return 'ok';
})()`);
r.eq('line item filled', filled, 'ok');
await sleep(900);

// 4 x 2500 = 10,000 subtotal; 18% VAT = 1,800; grand total 11,800
const tt = JSON.parse(
  await evaluate(`JSON.stringify({
    sub: document.querySelector('#calcSubtotal')?.textContent.trim(),
    tax: document.querySelector('#calcTax')?.textContent.trim(),
    grand: document.querySelector('#calcGrandTotal')?.textContent.trim()
  })`),
);
r.check('subtotal = 10,000', /10,000/.test(tt.sub || ''), tt.sub);
r.check('tax = 1,800', /1,800/.test(tt.tax || ''), tt.tax);
r.check('grand total = 11,800', /11,800/.test(tt.grand || ''), tt.grand);

await evaluate(`document.querySelector('#saveInvoiceBtn').click()`);
await sleep(1500);
r.check('invoice saved to list', (await evaluate(`document.querySelectorAll('#invoiceTableBody tr').length`)) > 0, 'rows');
await shot('12-invoice-editor.png');

/* ============ I. Reports ============ */
r.section('I. Reports');
await goto('reports.html', 2800);
const rp = JSON.parse(
  await evaluate(`JSON.stringify({
    summary: document.querySelectorAll('#reportSummary .stat-card, #reportSummary > *').length,
    chartBars: document.querySelectorAll('#revenueChart .bar-col').length,
    donut: document.querySelectorAll('#reportDonut svg circle, #reportDonut svg path').length,
    topCustomers: document.querySelectorAll('#topCustomers .progress').length,
    topProducts: document.querySelectorAll('#topProducts .progress').length
  })`),
);
r.check('report summary rendered', rp.summary > 0, rp.summary);
r.check('revenue chart rendered', rp.chartBars > 0, rp.chartBars);
r.check('status donut rendered', rp.donut > 0, rp.donut);
r.check('top customers rendered', rp.topCustomers > 0, rp.topCustomers);
r.check('top products rendered', rp.topProducts > 0, rp.topProducts);
r.check('reports page clean', errors().length === 0, JSON.stringify(errors()).slice(0, 300));
await shot('13-reports-branded.png');

/* ============ J. Exports (PDF / CSV / QR) ============ */
r.section('J. Exports');
// jspdf + qrcode are only loaded on invoice.html / reports.html
await goto('invoice.html', 2800);
await installBlobCapture();

const ex = await evaluate(`(async () => {
  const out = {};
  const [{ loadBrandSync, pdfColors }, exp, db] = await Promise.all([
    import('./js/brand.js'), import('./js/export.js'), import('./js/db.js')
  ]);
  const invoices = await db.getInvoices();
  const company = await db.getSetting('company', {});
  const cur = { code: 'TZS', symbol: 'TZS', name: 'Tanzanian Shilling', decimals: 2, words: 'Tanzanian Shillings', wordsSingular: 'Tanzanian Shilling' };

  const payload = exp.buildQRPayload(invoices[0], company);
  const qr = await exp.generateQRDataURL(payload, 200);
  out.qrOk = typeof qr === 'string' && qr.startsWith('data:image/png') && qr.length > 500;
  out.qrPayloadHasNumber = payload.includes('INV:');

  try { await exp.generateInvoicePDF(invoices[0], company, cur, { language: 'en' }); out.pdfOk = true; }
  catch (e) { out.pdfOk = 'ERR ' + e.message; }

  try { await exp.downloadInvoicePDF(invoices[0], company, cur, { language: 'en' }); out.pdfDownloadOk = true; }
  catch (e) { out.pdfDownloadOk = 'ERR ' + e.message; }
  out.afterPdf = window.__blobs.length;

  exp.exportInvoicesCSV(invoices, cur);
  out.afterInvCsv = window.__blobs.length;
  exp.exportCustomersCSV(await db.getCustomers());
  out.afterCustCsv = window.__blobs.length;

  out.pdfBrand = pdfColors(loadBrandSync(), 'light').brand.join(',');
  out.invoiceCount = invoices.length;
  return out;
})()`);
r.check('QR code generated (branded PNG)', ex.qrOk === true, ex.qrOk);
r.check('QR payload carries the invoice number', ex.qrPayloadHasNumber === true, ex.qrPayloadHasNumber);
r.check('invoice PDF generated without error', ex.pdfOk === true, ex.pdfOk);
r.check('invoice PDF downloaded without error', ex.pdfDownloadOk === true, ex.pdfDownloadOk);
r.eq('PDF palette matches stored brand', ex.pdfBrand, '46,125,50');

const pdfBlob = await readBlob(0, 'bytes');
r.check('PDF blob is a real PDF (%PDF magic)', pdfBlob && pdfBlob.head === '%PDF-', JSON.stringify(pdfBlob));
r.check('PDF has meaningful size', pdfBlob && pdfBlob.size > 3000, pdfBlob && pdfBlob.size);

const csvBlob = await readBlob(ex.afterPdf, 'text');
r.check('invoice CSV has a header row', typeof csvBlob === 'string' && csvBlob.includes('Invoice No'), (csvBlob || '').slice(0, 90));
r.check('invoice CSV has data rows', typeof csvBlob === 'string' && csvBlob.split('\r\n').length > 1, csvBlob ? csvBlob.split('\r\n').length : 0);

const custCsv = await readBlob(ex.afterInvCsv, 'text');
r.check('customer CSV has a header row', typeof custCsv === 'string' && /Name|Customer/i.test(custCsv), (custCsv || '').slice(0, 90));
r.check('customer CSV carries the new customer', typeof custCsv === 'string' && custCsv.includes('E2E Test Buyer'), (custCsv || '').slice(0, 120));

/* ============ K. Brand reaches print + PDF HTML ============ */
r.section('K. Print/PDF branding');
const printBranding = await evaluate(`(async () => {
  const [{ loadBrandSync, paletteToCss }] = await Promise.all([import('./js/brand.js')]);
  window.AppConfig.writeStorage('brand', JSON.stringify({ primary: '#00695C', accent: '#FFB300', radius: 12, sidebar: 'gradient', appName: '', appTagline: '' }));
  const css = paletteToCss(loadBrandSync(), 'light');
  return { hasBrand: css.includes('--brand: #00695C'), hasAccent: css.includes('--gold: #FFB300'), isRoot: css.startsWith(':root {') };
})()`);
r.check('print stylesheet carries custom brand', printBranding.hasBrand === true, printBranding.hasBrand);
r.check('print stylesheet carries accent', printBranding.hasAccent === true, printBranding.hasAccent);
await evaluate(`window.AppConfig.removeStorage('brand')`);

/* ============ L. Settings save + backup ============ */
r.section('L. Settings & backup');
await goto('settings.html', 2600);
await evaluate(`(() => {
  const el = document.querySelector('#setBusinessName');
  el.value = 'E2E Cashew Company Ltd';
  el.dispatchEvent(new Event('input', {bubbles:true}));
  document.querySelector('#saveSettingsBtn').click();
  return true;
})()`);
await sleep(1600);
const savedName = await evaluate(
  `(async () => { const db = await import('./js/db.js'); const c = await db.getSetting('company', {}); return c.businessName; })()`,
);
r.eq('business name saved to IndexedDB', savedName, 'E2E Cashew Company Ltd');
r.check('settings save produced no errors', errors().length === 0, JSON.stringify(errors()).slice(0, 300));

await installBlobCapture();
await evaluate(`document.querySelector('#backupBtn').click()`);
await sleep(2000);
const backupText = await readBlob(0, 'text');
r.check('backup JSON blob produced', typeof backupText === 'string' && backupText.startsWith('{'), (backupText || '').slice(0, 60));
if (typeof backupText === 'string' && backupText.startsWith('{')) {
  const payload = JSON.parse(backupText);
  r.eq('backup app id matches the configured slug', payload.app, await evaluate('window.APP_CONFIG.slug'));
  r.check('backup app id is not the legacy name', payload.app !== 'crown-invoice-pro', payload.app);
  r.check('backup contains customers', Array.isArray(payload.data.customers) && payload.data.customers.length > 0, payload.data.customers?.length);
  r.check('backup contains invoices', Array.isArray(payload.data.invoices) && payload.data.invoices.length > 0, payload.data.invoices?.length);
  r.check('backup contains products', Array.isArray(payload.data.products) && payload.data.products.length > 0, payload.data.products?.length);
  r.check('backup includes the brand setting', payload.data.settings.some((s) => s.key === 'brand'), payload.data.settings.map((s) => s.key).join(','));
}

/* ============ M. Currency switching ============ */
r.section('M. Currency');
await goto('index.html', 2600);
r.check('currency selector populated', (await evaluate(`document.querySelectorAll('#currencySelect option').length`)) > 0, 'options');
await evaluate(`(() => { const s = document.querySelector('#currencySelect'); s.value = 'USD'; s.dispatchEvent(new Event('change')); return true; })()`);
await sleep(2200);
const cu2 = JSON.parse(
  await evaluate(`JSON.stringify({ sel: document.querySelector('#currencySelect').value, bodyHasUSD: document.body.textContent.includes('USD') })`),
);
r.eq('currency switched to USD', cu2.sel, 'USD');
r.check('UI reflects USD', cu2.bodyHasUSD === true, cu2.bodyHasUSD);
await evaluate(`(() => { const s = document.querySelector('#currencySelect'); s.value = 'TZS'; s.dispatchEvent(new Event('change')); return true; })()`);
await sleep(1800);

/* ============ N. Offline ============ */
r.section('N. Offline');
// Note: `navigator.onLine` stays true even with every server dead, so a genuine
// offline test must go through CDP's network emulation, not a killed server.
await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
await goto('invoice.html', 3200);
const of = JSON.parse(
  await evaluate(`JSON.stringify({
    title: document.title,
    brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
    badge: getComputedStyle(document.querySelector('#offlineBadge')).display,
    sidebar: !!document.querySelector('.sidebar')
  })`),
);
r.check('offline: page loads from SW cache', /Invoice/.test(of.title || ''), of.title);
r.check('offline: brand still applied', /^#|rgb/.test(of.brand || ''), of.brand);
r.check('offline badge visible', of.badge !== 'none', of.badge);
r.check('offline: sidebar rendered', of.sidebar === true, of.sidebar);
// A missing precache entry surfaces as a failed request, not a console error.
const offFails = netFails().filter((f) => !/favicon/i.test(f));
r.check('offline: no missing cached assets', offFails.length === 0, JSON.stringify(offFails).slice(0, 240));
await shot('14-offline-branded.png');
await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

/* ============ O. Responsive ============ */
r.section('O. Responsive');
for (const w of [1600, 1280, 1024, 768, 390]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 700 });
  await goto('index.html', 2200);
  const o = JSON.parse(await evaluate(`JSON.stringify({ inner: window.innerWidth, scroll: document.documentElement.scrollWidth })`));
  r.check(`no horizontal overflow @${w}px`, o.scroll <= o.inner, `scroll ${o.scroll} vs inner ${o.inner}`);
}
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await goto('settings.html', 2600);
const mb = JSON.parse(
  await evaluate(`JSON.stringify({
    bottomNav: getComputedStyle(document.querySelector('.bottom-nav')).display,
    sidebar: getComputedStyle(document.querySelector('.sidebar')).position,
    swatches: document.querySelectorAll('#brandPresets [data-swatch], #brandPresets [data-preset]').length,
    overflow: document.documentElement.scrollWidth <= window.innerWidth
  })`),
);
r.eq('mobile bottom nav visible', mb.bottomNav, 'block');
r.eq('mobile sidebar fixed', mb.sidebar, 'fixed');
r.check('brand customizer usable on mobile', mb.swatches === 12, mb.swatches);
r.check('no mobile overflow on settings', mb.overflow === true, mb.overflow);
await shot('15-mobile-settings.png');
await send('Emulation.clearDeviceMetricsOverride');

const ok = r.finish();
process.exit(ok ? 0 : 1);

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
await evaluate(`(async () => { const db = await import('./js/db.js'); await db.seedSampleData(); })()`);
await goto('index.html', 2000);
const seeded = await evaluate(
  `(async () => { const db = await import('./js/db.js'); return { inv: (await db.getInvoices()).length, cus: (await db.getCustomers()).length }; })()`,
);
r.check('explicit fixture produced sample data', seeded.inv > 0 && seeded.cus > 0, JSON.stringify(seeded));

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
r.eq('reset restores default brand', rs.brand, '#1B5E20');
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
r.eq('PDF palette matches stored brand', ex.pdfBrand, '27,94,32');

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

/* Dark mode must not print as a dark page. Two halves to that: the print
   stylesheet resets the structural scale (reachable from CSS), and js/shell.js
   swaps in the light brand palette on `beforeprint` — the brand tokens are
   written inline on <html> and cannot be reached from a stylesheet at all. */
await goto('invoice.html', 2600);
await evaluate(`document.documentElement.getAttribute('data-theme') === 'dark' || document.querySelector('#themeToggle').click()`);
await sleep(800);
r.eq('dark mode enabled for the print check', await evaluate(`document.documentElement.getAttribute('data-theme')`), 'dark');

await send('Emulation.setEmulatedMedia', { media: 'print' });
await sleep(400);
const printCss = JSON.parse(await evaluate(`(() => {
  const cs = getComputedStyle(document.querySelector('.invoice-doc'));
  return JSON.stringify({ bg: cs.backgroundColor, color: cs.color });
})()`));
r.check('print forces a light invoice background', printCss.bg === 'rgb(255, 255, 255)', printCss.bg);
r.check('print forces dark invoice text', printCss.color === 'rgb(15, 31, 20)', printCss.color);

await evaluate(`window.dispatchEvent(new Event('beforeprint'))`);
await sleep(500);
r.eq('beforeprint swaps in the light brand palette',
  await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()`), '#1B5E20');
await evaluate(`window.dispatchEvent(new Event('afterprint'))`);
await sleep(500);
r.check('afterprint restores the dark brand',
  (await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()`)) !== '#1B5E20');

await send('Emulation.setEmulatedMedia', { media: '' });
await sleep(300);
await evaluate(`document.querySelector('#themeToggle').click()`);
await sleep(700);
r.eq('theme restored to light after the print check',
  await evaluate(`document.documentElement.getAttribute('data-theme')`), 'light');

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

/* ============ P. Invoice branding (logo + business name) ============
   Regression guard for two failures that were invisible until an invoice was
   actually produced:

     1. the logo is persisted as its own setting (`logoDataUrl`) but the invoice
        read it as `company.logoDataUrl` — so Settings showed a logo, the
        preview showed a "Business Logo" placeholder, and the PDF shipped with
        no image at all;
     2. a non-PNG logo (SVG, JPEG, WebP) was handed to jsPDF as PNG, which drops
        the image without raising.

   Both are only observable end-to-end, which is why they are asserted here. */
r.section('P. Invoice branding');
await goto('settings.html', 3000);

await evaluate(`(async () => {
  // Upload an SVG deliberately — the one format jsPDF cannot embed directly.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140"><rect width="240" height="140" fill="#2E7D32"/></svg>';
  const file = new File([new Blob([svg], { type: 'image/svg+xml' })], 'logo.svg', { type: 'image/svg+xml' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.querySelector('#setLogoInput');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));

  const name = document.querySelector('#setBusinessName');
  name.value = 'E2E Branded Co';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(1000);
await evaluate(`(() => { document.querySelector('#saveSettingsBtn').click(); return true; })()`);
await sleep(900);

const storedBranding = await evaluate(`(async () => {
  const [ss, db] = await Promise.all([import('./js/storageService.js'), import('./js/db.js')]);
  const raw = await db.getSetting('logoDataUrl', null);
  const profile = await ss.getCompanyProfile();
  return { rawMime: raw ? raw.slice(0, 22) : null, profileHasLogo: !!profile.logoDataUrl, name: profile.businessName };
})()`);
r.check('an SVG logo is normalised to PNG on upload', storedBranding.rawMime === 'data:image/png;base64,', storedBranding.rawMime);
r.check('the business profile exposes the stored logo', storedBranding.profileHasLogo === true, storedBranding.profileHasLogo);
r.eq('the business profile keeps the business name', storedBranding.name, 'E2E Branded Co');

await goto('invoice.html', 3200);
await evaluate(`(() => { document.querySelector('[data-action="view"]').click(); return true; })()`);
await sleep(900);
const previewBranding = await evaluate(`(() => {
  const doc = document.querySelector('#previewDoc');
  const img = doc.querySelector('.doc-logo img');
  return {
    logo: !!img && img.src.startsWith('data:image/png'),
    name: doc.querySelector('.doc-company strong')?.textContent || '',
    footer: doc.querySelector('.doc-footer')?.textContent || '',
  };
})()`);
r.check('invoice preview renders the logo', previewBranding.logo === true, previewBranding.logo);
r.eq('invoice preview shows the business name', previewBranding.name, 'E2E Branded Co');
r.check('invoice footer carries the business name', previewBranding.footer.startsWith('E2E Branded Co'), previewBranding.footer);

const pdfBranding = await evaluate(`(async () => {
  const [ss, db, exp] = await Promise.all([
    import('./js/storageService.js'), import('./js/db.js'), import('./js/export.js')
  ]);
  const profile = await ss.getCompanyProfile();
  const inv = (await db.getInvoices())[0];
  const cur = { code: 'TZS', symbol: 'TZS', name: 'Tanzanian Shilling', decimals: 2, words: 'Tanzanian Shillings', wordsSingular: 'Tanzanian Shilling' };
  const doc = await exp.generateInvoicePDF(inv, profile, cur, { logoDataUrl: profile.logoDataUrl, language: 'en' });
  const buf = new Uint8Array(await doc.output('blob').arrayBuffer());
  const text = new TextDecoder('latin1').decode(buf);
  return { images: (text.match(/\\/Subtype\\s*\\/Image/g) || []).length };
})()`);
r.check('invoice PDF embeds the logo', pdfBranding.images > 0, pdfBranding.images);

/* ============ Q. Invoice layout regressions ============
   Four defects reported from a real phone test:

     1. the Qty cell in the line-item table was narrower than its own input, so
        the number and the spinner arrows were clipped;
     2. the Bill To / Ship To panel had a fixed 26 mm height while the detail
        list still drew its 4th line below that — a customer with an address,
        phone, email *and* TIN had the TIN hanging outside the box;
     3. the logo sat beside the business name instead of beneath it;
     4. there was nowhere to put a digital signature or a company stamp.

   All four are layout/paint failures, so they are asserted against the DOM and
   the generated PDF rather than against the code that produces them. */
r.section('Q. Invoice layout regressions');

/* ---- Q1: line-item inputs are not clipped ---- */
await goto('invoice.html', 3200);
await evaluate(`(() => { document.querySelector('#newInvoiceBtn').click(); return true; })()`);
await sleep(900);
const lineInputs = await evaluate(`(() => {
  const out = {};
  for (const cls of ['line-qty', 'line-price', 'line-disc', 'line-name']) {
    const el = document.querySelector('.' + cls);
    out[cls] = el ? { c: el.clientWidth, s: el.scrollWidth } : null;
  }
  return out;
})()`);
for (const cls of ['line-qty', 'line-price', 'line-disc', 'line-name']) {
  const m = lineInputs[cls];
  r.check(`the ${cls.replace('line-', '')} input is not clipped`, !!m && m.s <= m.c + 2, m ? `${m.s}>${m.c}` : 'missing');
}
await shot('16-line-item-inputs.png');

/* ---- Q2: signature + stamp upload, stored under their own keys ---- */

/* Pro first.
 *
 * The signature and stamp uploaders are a Pro feature: on the free plan the
 * picker is gated shut and routes the press to the upgrade prompt, so this
 * section would fail for the right reason at the wrong layer. What is under
 * test HERE is that artwork, once accepted, is stored under its own setting key
 * and reaches the preview and the PDF — the gate itself belongs to
 * `test-features.js`.
 *
 * Note the plan is not reset afterwards: rendering never consults it (the gate
 * lives only on the two uploaders in settings.js), so the preview and PDF
 * assertions further down still see the stored artwork. */
await evaluate(`(async () => {
  const m = await import('./js/licenseService.js');
  return JSON.stringify(await m.setPlan('pro', { licenseKey: m.makeLicenseKey('pro') }));
})()`);

await goto('settings.html', 3000);
await evaluate(`(async () => {
  const png = async (w, h, draw) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    return await (await fetch(c.toDataURL('image/png'))).blob();
  };
  const attach = (id, blob, name) => {
    const dt = new DataTransfer();
    dt.items.add(new File([blob], name, { type: 'image/png' }));
    const input = document.querySelector(id);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const sig = await png(300, 120, (g) => {
    g.strokeStyle = '#101828'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(20, 80); g.bezierCurveTo(80, 10, 160, 110, 280, 50); g.stroke();
  });
  const stamp = await png(240, 240, (g) => {
    g.strokeStyle = '#1D4ED8'; g.lineWidth = 10;
    g.beginPath(); g.arc(120, 120, 100, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#1D4ED8'; g.font = 'bold 30px Arial'; g.textAlign = 'center';
    g.fillText('PAID', 120, 132);
  });
  attach('#setSignatureInput', sig, 'signature.png');
  attach('#setStampInput', stamp, 'stamp.png');
  return true;
})()`);
await sleep(1200);
await evaluate(`(() => { document.querySelector('#saveSettingsBtn').click(); return true; })()`);
await sleep(900);

const artwork = await evaluate(`(async () => {
  const [ss, db] = await Promise.all([import('./js/storageService.js'), import('./js/db.js')]);
  const profile = await ss.getCompanyProfile();
  return {
    sigKey: (await db.getSetting('signatureDataUrl', null)) ? 'set' : 'missing',
    stampKey: (await db.getSetting('stampDataUrl', null)) ? 'set' : 'missing',
    sigProfile: !!profile.signatureDataUrl,
    stampProfile: !!profile.stampDataUrl,
  };
})()`);
r.eq('the signature is stored under its own setting key', artwork.sigKey, 'set');
r.eq('the stamp is stored under its own setting key', artwork.stampKey, 'set');
r.check('the business profile exposes the signature', artwork.sigProfile === true, artwork.sigProfile);
r.check('the business profile exposes the stamp', artwork.stampProfile === true, artwork.stampProfile);

/* ---- Q3: preview stacks name → logo → contacts, and shows signature + stamp ---- */
await goto('invoice.html', 3200);
await evaluate(`(() => { document.querySelector('[data-action="view"]').click(); return true; })()`);
await sleep(1000);
const layout = await evaluate(`(() => {
  const doc = document.querySelector('#previewDoc');
  const brand = doc.querySelector('.doc-brand');
  const logo = doc.querySelector('.doc-brand .doc-logo');
  const name = doc.querySelector('.doc-brand .doc-company strong');
  const rect = (el) => (el ? el.getBoundingClientRect() : null);
  return {
    order: [...brand.children].map((el) => el.className.split(' ')[0]),
    logoBelowName: !!(logo && name) && rect(logo).top >= rect(name).bottom - 1,
    signature: !!doc.querySelector('.doc-sign-img'),
    stamp: !!doc.querySelector('.doc-stamp-img'),
  };
})()`);
r.check('the preview stacks the logo beneath the business name', layout.logoBelowName === true, JSON.stringify(layout.order));
r.check('the preview renders the digital signature', layout.signature === true, layout.signature);
r.check('the preview renders the company stamp', layout.stamp === true, layout.stamp);
await shot('17-preview-artwork.png');

/* ---- Q4: the PDF grows the party box around its contents ---- */
const pdfLayout = await evaluate(`(async () => {
  const [ss, db, exp] = await Promise.all([
    import('./js/storageService.js'), import('./js/db.js'), import('./js/export.js')
  ]);
  const profile = await ss.getCompanyProfile();
  const inv = (await db.getInvoices())[0];
  const cur = { code: 'TZS', symbol: 'TZS', name: 'Tanzanian Shilling', decimals: 2, words: 'Tanzanian Shillings', wordsSingular: 'Tanzanian Shilling' };
  const doc = await exp.generateInvoicePDF(inv, profile, cur, {
    logoDataUrl: profile.logoDataUrl, signatureDataUrl: profile.signatureDataUrl,
    stampDataUrl: profile.stampDataUrl, language: 'en',
  });
  const buf = new Uint8Array(await doc.output('blob').arrayBuffer());
  const text = new TextDecoder('latin1').decode(buf);
  const stream = (doc.internal.pages[1] || []).join('\\n');

  // The party panel is the only SURFACE_2 fill — #EDF3EE in js/export.js, which
  // jsPDF writes as "r g b rg" followed by the rounded-rect path, terminated by
  // "f". Keep these three floats in step with that constant: they are the
  // test's only handle on the panel. Restrict the window to that path so later
  // drawing cannot inflate the extent.
  const MM = 72 / 25.4;
  const fills = [...stream.matchAll(/([\\d.]+) ([\\d.]+) ([\\d.]+) rg/g)];
  const surface = fills.find((m) => {
    const [rr, gg, bb] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return Math.abs(rr - 0.929) < 0.012 && Math.abs(gg - 0.953) < 0.012 && Math.abs(bb - 0.933) < 0.012;
  });
  let box = null;
  if (surface) {
    const end = stream.indexOf('f', surface.index);
    const seg = stream.slice(surface.index, end > 0 ? end : surface.index + 800);
    const ys = [...seg.matchAll(/(?:^|\\s)([\\d.]+) ([\\d.]+) (?:m|l|c)\\b/g)].map((x) => Number(x[2]));
    if (ys.length) box = { top: Math.max(...ys), bottom: Math.min(...ys), heightMm: (Math.max(...ys) - Math.min(...ys)) / MM };
  }

  // The Bill To TIN is the LAST occurrence — the company's own TIN, when set,
  // appears earlier in the letterhead.
  const tin = inv.customerTin || '';
  let tinY = null;
  if (tin) {
    const i = stream.lastIndexOf(tin);
    if (i >= 0) {
      const before = stream.slice(Math.max(0, i - 260), i);
      const td = [...before.matchAll(/([\\d.]+) ([\\d.]+) Td/g)].pop();
      if (td) tinY = Number(td[2]);
    }
  }

  return {
    images: (text.match(/\\/Subtype\\s*\\/Image/g) || []).length,
    boxHeightMm: box ? +box.heightMm.toFixed(2) : null,
    tinFound: tinY !== null,
    tinInsideBox: (box && tinY !== null) ? tinY > box.bottom && tinY < box.top : null,
  };
})()`);
r.check('the PDF embeds the logo, the signature and the stamp', pdfLayout.images >= 3, pdfLayout.images);
r.check('the party box grows past the old fixed 26 mm', pdfLayout.boxHeightMm !== null && pdfLayout.boxHeightMm > 26, pdfLayout.boxHeightMm);
r.check('the Bill To TIN sits inside the party box', pdfLayout.tinInsideBox === true, `found=${pdfLayout.tinFound} inside=${pdfLayout.tinInsideBox}`);

const ok = r.finish();
process.exit(ok ? 0 : 1);

/**
 * Preview panel + PDF pagination suite.
 *
 * Two defects reported from a real test on a phone:
 *
 *   1. With the preview opened from the list's eye icon, the Download PDF
 *      button did nothing at all — no download, no toast, no error.
 *   2. The signature / stamp / QR band jumped to a second page in the PDF even
 *      though the preview showed everything on one page.
 *
 * (1) The preview's actions re-collected the invoice from the EDITOR form.
 *     Reached via the eye icon that form is untouched, so the collected
 *     invoice had no customer name and the `if (inv.customerName)` guard
 *     turned the click into a silent no-op. The preview now acts on the
 *     invoice it is SHOWING (state.previewInvoice).
 *
 * (2) The PDF stacked totals / words / balance / notes / payment details
 *     vertically where the preview lays them out side by side — about 42 mm
 *     of extra height, which is what pushed the band over. The PDF now uses
 *     the preview's two-column summary, so a normal invoice fits on one page.
 *
 * These live in their own suite rather than in test-e2e.js because they need
 * real PDF generation and a couple of navigations, and test-e2e.js already
 * runs close to its 300 s budget.
 *
 * Run via `npm run test:preview`, or `npm run test:e2e` for the whole set.
 */
import { CONFIG, connect, createReporter, sleep } from './lib/cdp.js';

const { origin } = CONFIG;
const r = createReporter('Preview');
const { send, evaluate, goto, shot, errors } = await connect();

await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: CONFIG.downloads });

/* ---------- Deterministic start ----------
   The profile persists between runs, so wipe the origin; the app re-seeds its
   sample data on an empty database. The seed only happens on the dashboard. */
await send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
await goto('index.html', 3600);
await sleep(600);

/* ---------- Blob capture ----------
   Headless download plumbing is unreliable and the blob CONTENTS are what
   matter, so intercept createObjectURL and read the blobs directly. */
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

/* ============ R. Preview panel actions ============
   Two defects reported from a real test on a phone:

     1. With the preview opened from the list's eye icon, the Download PDF
        button did nothing at all — no download, no toast, no error.
     2. The signature / stamp / QR band jumped to a second page in the PDF,
        even though the preview showed everything on one.

   (1) The preview's actions re-collected the invoice from the EDITOR form.
       Reached via the eye icon that form is untouched, so the collected
       invoice had no customer name and the `if (inv.customerName)` guard
       turned the click into a silent no-op. The preview now acts on the
       invoice it is SHOWING (state.previewInvoice).

   (2) The PDF stacked totals / words / balance / notes / payment details
       vertically where the preview lays them out side by side, costing ~42 mm
       — which is what pushed the band over. The PDF now uses the preview's
       two-column summary. */
r.section('Preview panel actions');

await goto('invoice.html', 3200);
await installBlobCapture();
await sleep(800);

const rRows = await evaluate(`document.querySelectorAll('#invoiceTableBody [data-action="view"]').length`);
r.check('the invoice list has rows to preview', rRows > 0, rRows);

/* ---- R1–R5: eye icon -> preview -> Download PDF actually downloads ---- */
// Cell 0 is the invoice number; cell 1 is the customer.
const rowCustomer = await evaluate(`(() => {
  const row = document.querySelector('#invoiceTableBody [data-action="view"]').closest('tr');
  return row.children[1].textContent.trim();
})()`);
await evaluate(`(() => {
  window.__blobs = [];
  document.querySelector('#invoiceTableBody [data-action="view"]').click();
  return true;
})()`);
await sleep(800);

const previewOpen = await evaluate(`(() => {
  // The generic .doc-company strong selector matches the letterhead FIRST, so
  // read the name out of the BILL TO panel specifically.
  const title = [...document.querySelectorAll('#previewDoc .doc-section-title')]
    .find((n) => /BILL TO|MLIPAJI/i.test(n.textContent));
  const nameEl = title && title.parentElement.querySelector('.doc-company strong');
  return {
    open: !document.querySelector('#previewView').classList.contains('hidden'),
    customer: nameEl ? nameEl.textContent.trim() : '',
    editorFormName: (document.querySelector('#invCustomerName') || {}).value || '',
  };
})()`);
r.check('the eye icon opens the preview', previewOpen.open === true, JSON.stringify(previewOpen));
r.check('the preview shows the row customer while the editor form is empty',
  previewOpen.customer === rowCustomer && previewOpen.editorFormName === '',
  JSON.stringify({ ...previewOpen, rowCustomer }));

await evaluate(`(() => { document.querySelector('#downloadPdfBtn2').click(); return true; })()`);
await sleep(3000);
const previewPdf = await readBlob(0, 'bytes');
r.check('Download PDF from the preview produces a file', !!previewPdf, JSON.stringify(previewPdf));
r.check('the downloaded blob is a real PDF', !!previewPdf && previewPdf.head === '%PDF-', JSON.stringify(previewPdf));
const downloadedToast = await evaluate(`[...document.querySelectorAll('[class*="toast"]')].some((n) => /PDF downloaded/i.test(n.textContent))`);
r.check('the user gets a "PDF downloaded" confirmation', downloadedToast === true, downloadedToast);

/* ---- R6: Print from the preview renders the invoice, not a blank page ---- */
await evaluate(`(() => {
  window.__printed = { called: false, html: '' };
  window.open = function () {
    window.__printed.called = true;
    return {
      document: { write(h) { window.__printed.html += h; }, close() {} },
      print() {}, focus() {},
    };
  };
  document.querySelector('#printBtn').click();
  return true;
})()`);
await sleep(900);
const printed = await evaluate(`(() => ({
  called: window.__printed.called,
  hasCustomer: window.__printed.html.includes(${JSON.stringify(previewOpen.customer)}),
  hasSignatureBlock: /Authorized Signature|Sahihi Iliyoidhinishwa/.test(window.__printed.html),
}))()`);
r.check('Print from the preview renders the invoice document',
  printed.called && printed.hasCustomer && printed.hasSignatureBlock, JSON.stringify(printed));

/* ---- R7: Edit returns to the editor with THAT invoice loaded ---- */
await evaluate(`(() => { document.querySelector('#backToEditBtn').click(); return true; })()`);
await sleep(1200);
const editState = await evaluate(`(() => ({
  editorVisible: !document.querySelector('#editorView').classList.contains('hidden'),
  name: (document.querySelector('#invCustomerName') || {}).value || '',
}))()`);
r.check('Edit from a list-opened preview loads that invoice into the form',
  editState.editorVisible === true && editState.name.length > 0, JSON.stringify(editState));

/* ---- R8–R9: a preview opened FROM THE EDITOR must not eat unsaved edits ---- */
await goto('invoice.html', 3200);
await sleep(800);
await evaluate(`(() => { document.querySelector('#invoiceTableBody [data-action="edit"]').click(); return true; })()`);
await sleep(1400);
await evaluate(`(() => {
  document.querySelector('#invCustomerName').value = 'UNSAVED EDIT CO';
  document.querySelector('#previewBtn').click();
  return true;
})()`);
await sleep(900);
const shownInPreview = await evaluate(`(() => {
  const title = [...document.querySelectorAll('#previewDoc .doc-section-title')]
    .find((n) => /BILL TO|MLIPAJI/i.test(n.textContent));
  const nameEl = title && title.parentElement.querySelector('.doc-company strong');
  return nameEl ? nameEl.textContent.trim() : '';
})()`);
r.eq('the preview reflects the unsaved edit', shownInPreview, 'UNSAVED EDIT CO');
await evaluate(`(() => { document.querySelector('#backToEditBtn').click(); return true; })()`);
await sleep(700);
const keptAfterBack = await evaluate(`(document.querySelector('#invCustomerName') || {}).value || ''`);
r.eq('returning to the editor keeps the unsaved edit', keptAfterBack, 'UNSAVED EDIT CO');

/* ---- R10–R11: the PDF paginates like the preview ----
   The band must stay on page 1 for a normal invoice. The profile below is
   deliberately maximal (7 contact lines, 4 payment lines, notes, a discount)
   because that is what overflowed. */
const fit = await evaluate(`(async () => {
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
      ...stored, id: 'inv_fit', number: 'INV-FIT', customerName: 'RODGERS AMINI SABUNI',
      customerPhone: '+255 712 345 678', customerEmail: 'rodgers@example.co.tz',
      customerTin: '123-456-789', customerAddress: 'Kariakoo, Dar es Salaam',
      shipToName: 'RODGERS AMINI SABUNI', shipToAddress: 'Kariakoo, Dar es Salaam',
      shipToPhone: '+255 712 345 678', items, subtotal, tax, taxRate: 18,
      invoiceDiscount: 0, discount: 0, shipping: 0,
      grandTotal: subtotal + tax, amountPaid: 0, balance: subtotal + tax,
      notes: 'Thank you for your business. Please settle by the due date.',
      currency: 'TZS',
    };
  };
  const qr = await exp.generateQRDataURL('INV:INV-FIT', 220);
  const opts = { logoDataUrl: company.logoDataUrl, signatureDataUrl: company.signatureDataUrl, stampDataUrl: company.stampDataUrl, qrDataUrl: qr, language: 'en' };
  const count = async (n) => {
    const doc = await exp.generateInvoicePDF(build(n), company, cur, opts);
    return doc.internal.getNumberOfPages();
  };
  return { one: await count(1), five: await count(5), six: await count(6), sixteen: await count(16) };
})()`);
r.eq('a 5-line invoice with full artwork is ONE page', fit.five, 1);
r.eq('a 6-line invoice is still ONE page', fit.six, 1);
r.check('a 16-line invoice correctly paginates', fit.sixteen > 1, fit.sixteen);

r.section('Console');
r.check('no console errors during the whole run', errors().length === 0, JSON.stringify(errors()).slice(0, 300));

const ok = r.finish();
process.exit(ok ? 0 : 1);

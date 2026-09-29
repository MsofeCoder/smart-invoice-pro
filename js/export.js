/**
 * Export engine
 * Professional PDF generation (jsPDF + AutoTable), CSV export, QR codes, printing.
 */
import { escapeHTML, downloadBlob, downloadDataURI } from './utils.js';
import { formatMoney, amountToWords, amountToWordsSwahili } from './currency.js';
import { round2 } from './calculations.js';
import { loadBrandSync, pdfColors, paletteToCss } from './brand.js';
import { fallbackBusinessName } from './config.js';

/* ---------------- QR Code ---------------- */

/**
 * Generate a QR code data URL using the vendored qrcodejs library.
 * @param {string} text - content to encode
 * @param {number} size - pixel size
 */
export function generateQRDataURL(text, size = 220) {
  return new Promise((resolve, reject) => {
    if (typeof QRCode === 'undefined') {
      reject(new Error('QRCode library not loaded'));
      return;
    }
    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.left = '-9999px';
    document.body.appendChild(container);
    try {
      // QR modules follow the brand so the code looks native to the invoice.
      const { vars } = pdfColors(loadBrandSync(), 'light');
      const qr = new QRCode(container, {
        text: String(text || ''),
        width: size,
        height: size,
        colorDark: vars['--brand-darker'],
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M,
      });
      const canvas = container.querySelector('canvas');
      if (canvas) {
        resolve(canvas.toDataURL('image/png'));
      } else {
        const img = container.querySelector('img');
        if (img) resolve(img.src);
        else reject(new Error('QR code generation failed'));
      }
    } catch (err) {
      reject(err);
    } finally {
      setTimeout(() => container.remove(), 50);
    }
  });
}

/** Build the QR payload for an invoice. */
export function buildQRPayload(invoice, company) {
  const lines = [
    `INV:${invoice.number || ''}`,
    `BIZ:${company.businessName || ''}`,
    `AMT:${round2(invoice.grandTotal || 0)}`,
    `CUR:${invoice.currency || 'TZS'}`,
    `REF:${invoice.paymentReference || ''}`,
  ];
  if (company.website) lines.push(`WEB:${company.website}`);
  if (company.whatsapp) lines.push(`WA:${company.whatsapp}`);
  return lines.join('\n');
}

/* ---------------- PDF ----------------
   The palette is resolved per call from the active brand. Invoices always render
   on white paper, so they use the LIGHT palette regardless of the app's theme. */

let BRAND = [46, 125, 50];          // #2E7D32
let BRAND_DARK = [27, 94, 32];      // #1B5E20
let GOLD = [249, 168, 37];          // #F9A825
let BRAND_INK = [46, 125, 50];      // brand as text on white
let ACCENT_INK = [209, 131, 6];     // accent as text on white
let BRAND_CONTRAST = [255, 255, 255]; // text on a brand fill
const INK = [43, 43, 43];          // #2B2B2B
const INK_SOFT = [90, 90, 90];     // #5A5A5A
const INK_FAINT = [138, 138, 138]; // #8A8A8A
const BORDER = [228, 231, 228];    // #E4E7E4
const SURFACE_2 = [243, 245, 243]; // #F3F5F3

/** Pull the current brand into the module-level palette. Returns the raw CSS vars. */
function syncPdfPalette() {
  const p = pdfColors(loadBrandSync(), 'light');
  BRAND = p.brand;
  BRAND_DARK = p.brandDark;
  GOLD = p.accent;
  BRAND_INK = p.brandInk;
  ACCENT_INK = p.accentInk;
  BRAND_CONTRAST = p.brandContrast;
  return p.vars;
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = dataUrl;
  });
}

/**
 * Generate a professional A4 invoice PDF.
 * @param {Object} invoice - invoice record
 * @param {Object} company - company settings
 * @param {Object} currency - currency definition
 * @param {Object} opts - { logoDataUrl, qrDataUrl, language }
 */
export async function generateInvoicePDF(invoice, company, currency, opts = {}) {
  syncPdfPalette();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  const pageW = doc.internal.pageSize.getWidth();   // 210
  const pageH = doc.internal.pageSize.getHeight();  // 297
  const margin = 14;
  const contentW = pageW - margin * 2;
  const lang = opts.language || 'en';

  const t = (en, sw) => (lang === 'sw' ? sw : en);

  let y = margin;

  /* ---- Header band ---- */
  doc.setFillColor(...BRAND_DARK);
  doc.rect(0, 0, pageW, 6, 'F');
  doc.setFillColor(...GOLD);
  doc.rect(0, 6, pageW, 1.2, 'F');

  /* ---- Company block + logo ---- */
  y = margin + 6;
  const logoSize = 22;
  if (opts.logoDataUrl) {
    try {
      const img = await loadImage(opts.logoDataUrl);
      const ratio = img.width / img.height;
      let w = logoSize;
      let h = logoSize;
      if (ratio > 1) { h = logoSize / ratio; } else { w = logoSize * ratio; }
      doc.addImage(opts.logoDataUrl, 'PNG', margin, y, w, h);
    } catch {
      // fall through without logo
    }
  }

  const companyX = margin + logoSize + 6;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...BRAND_INK);
  doc.text(String(company.businessName || 'Business Name'), companyX, y + 6);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...INK_SOFT);
  const companyLines = [];
  if (company.address) companyLines.push(company.address);
  const regionLine = [company.region, company.district, company.country].filter(Boolean).join(', ');
  if (regionLine) companyLines.push(regionLine);
  if (company.phone) companyLines.push(`Tel: ${company.phone}`);
  if (company.email) companyLines.push(`Email: ${company.email}`);
  if (company.tin) companyLines.push(`TIN: ${company.tin}`);
  if (company.vrn) companyLines.push(`VRN: ${company.vrn}`);
  if (company.regNumber) companyLines.push(`Reg: ${company.regNumber}`);
  companyLines.slice(0, 7).forEach((line, i) => {
    doc.text(String(line), companyX, y + 11 + i * 4.2);
  });

  /* ---- Invoice title + meta (right side) ---- */
  const rightX = pageW - margin;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(...BRAND_INK);
  doc.text(t('INVOICE', 'ANKARA'), rightX, y + 8, { align: 'right' });

  doc.setFontSize(9);
  doc.setTextColor(...INK);
  const meta = [
    [t('Invoice No', 'Namba ya Ankara'), invoice.number || ''],
    [t('Issue Date', 'Tarehe'), invoice.issueDate || ''],
    [t('Due Date', 'Tarehe ya Kukamilika'), invoice.dueDate || ''],
    [t('Payment Terms', 'Masharti ya Malipo'), invoice.paymentTerms || ''],
    [t('Status', 'Hali'), t(statusLabel(invoice.status), statusLabelSw(invoice.status))],
  ];
  let metaY = y + 14;
  meta.forEach(([k, v]) => {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK_FAINT);
    doc.text(String(k), rightX, metaY, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...INK);
    doc.text(String(v), rightX, metaY + 4.2, { align: 'right' });
    metaY += 8.4;
  });

  y = Math.max(y + 11 + companyLines.length * 4.2, metaY) + 8;

  /* ---- Bill To / Ship To ---- */
  doc.setFillColor(...SURFACE_2);
  doc.roundedRect(margin, y, contentW, 26, 2, 2, 'F');
  doc.setDrawColor(...BORDER);
  doc.roundedRect(margin, y, contentW, 26, 2, 2, 'S');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...BRAND_INK);
  doc.text(t('BILL TO', 'MLIPAJI'), margin + 6, y + 7);

  doc.setFontSize(10);
  doc.setTextColor(...INK);
  doc.text(String(invoice.customerName || 'Customer Name'), margin + 6, y + 12);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...INK_SOFT);
  const billLines = [];
  if (invoice.customerAddress) billLines.push(invoice.customerAddress);
  if (invoice.customerPhone) billLines.push(`Tel: ${invoice.customerPhone}`);
  if (invoice.customerEmail) billLines.push(`Email: ${invoice.customerEmail}`);
  if (invoice.customerTin) billLines.push(`TIN: ${invoice.customerTin}`);
  billLines.slice(0, 4).forEach((line, i) => {
    doc.text(String(line), margin + 6, y + 17 + i * 4.2);
  });

  // Ship To (right half)
  const shipX = margin + contentW / 2;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...BRAND_INK);
  doc.text(t('SHIP TO', 'PALE UNAPELEKA'), shipX + 6, y + 7);
  doc.setFontSize(10);
  doc.setTextColor(...INK);
  doc.text(String(invoice.shipToName || invoice.customerName || '—'), shipX + 6, y + 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...INK_SOFT);
  const shipLines = [];
  if (invoice.shipToAddress) shipLines.push(invoice.shipToAddress);
  if (invoice.shipToPhone) shipLines.push(`Tel: ${invoice.shipToPhone}`);
  shipLines.slice(0, 3).forEach((line, i) => {
    doc.text(String(line), shipX + 6, y + 17 + i * 4.2);
  });

  y += 34;

  /* ---- Items table (AutoTable with pagination) ---- */
  const head = [
    [t('#', '#'), t('Description', 'Maelezo'), t('Qty', 'Idadi'), t('Unit Price', 'Bei'), t('Disc %', 'Punguzo %'), t('Amount', 'Kiasi')],
  ];
  const body = (invoice.items || []).map((item, i) => [
    String(i + 1),
    `${item.name || ''}${item.description ? '\n' + item.description : ''}`,
    String(item.qty ?? 0),
    formatMoney(item.unitPrice ?? 0, currency),
    item.discountRate ? `${item.discountRate}%` : '—',
    formatMoney(item.total ?? 0, currency),
  ]);

  doc.autoTable({
    startY: y,
    head,
    body,
    margin: { left: margin, right: margin, top: 20, bottom: 30 },
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 8.5,
      textColor: INK,
      lineColor: BORDER,
      lineWidth: 0.2,
      cellPadding: 2.5,
      valign: 'middle',
    },
    headStyles: {
      fillColor: BRAND,
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 8,
      halign: 'left',
    },
    columnStyles: {
      0: { cellWidth: 10, halign: 'center' },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 16, halign: 'center' },
      3: { cellWidth: 30, halign: 'right' },
      4: { cellWidth: 18, halign: 'center' },
      5: { cellWidth: 32, halign: 'right' },
    },
    alternateRowStyles: { fillColor: [248, 250, 248] },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 1) {
        data.cell.styles.valign = 'middle';
      }
    },
  });

  y = doc.lastAutoTable.finalY + 8;

  /* ---- Totals block ---- */
  const totalsX = pageW - margin - 78;
  const totalsW = 78;
  const totals = [
    [t('Subtotal', 'Jumla Ndogo'), invoice.subtotal ?? 0],
    [t('Item Discount', 'Punguzo la Bidhaa'), -(invoice.itemDiscount ?? 0)],
    [t('Invoice Discount', 'Punguzo la Ankara'), -(invoice.invoiceDiscount ?? 0)],
    [t('Tax', 'Kodi'), invoice.tax ?? 0],
    [t('Shipping', 'Usafirishaji'), invoice.shipping ?? 0],
  ];

  doc.setFontSize(8.5);
  totals.forEach(([label, amount]) => {
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...INK_SOFT);
    doc.text(String(label), totalsX, y);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK);
    doc.text(formatMoney(amount, currency), totalsX + totalsW, y, { align: 'right' });
    y += 6;
  });

  // Grand total band
  doc.setFillColor(...BRAND);
  doc.roundedRect(totalsX - 4, y - 1, totalsW + 8, 9, 2, 2, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...BRAND_CONTRAST);
  doc.text(t('GRAND TOTAL', 'JUMLA KUU'), totalsX, y + 5.5);
  doc.text(formatMoney(invoice.grandTotal ?? 0, currency), totalsX + totalsW, y + 5.5, { align: 'right' });
  y += 16;

  /* ---- Amount in words ---- */
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8.5);
  doc.setTextColor(...INK_SOFT);
  const words = lang === 'sw'
    ? amountToWordsSwahili(invoice.grandTotal ?? 0, currency)
    : amountToWords(invoice.grandTotal ?? 0, currency);
  const wordsLabel = t('Amount in Words:', 'Kiasi kwa Maneno:');
  const wordsText = `${wordsLabel} ${words}`;
  const splitWords = doc.splitTextToSize(wordsText, contentW);
  doc.text(splitWords, margin, y);
  y += splitWords.length * 4.2 + 4;

  /* ---- Balance / paid ---- */
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...INK);
  doc.text(`${t('Amount Paid', 'Kiasi Kilicholipwa')}: ${formatMoney(invoice.amountPaid ?? 0, currency)}`, margin, y);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...BRAND_INK);
  doc.text(`${t('Balance Due', 'Salio')}: ${formatMoney(invoice.balance ?? 0, currency)}`, margin + 70, y);
  y += 8;

  /* ---- Notes ---- */
  if (invoice.notes) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...BRAND_INK);
    doc.text(t('NOTES', 'MAELEZO'), margin, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...INK_SOFT);
    const notes = doc.splitTextToSize(String(invoice.notes), contentW);
    doc.text(notes, margin, y + 5);
    y += notes.length * 4.2 + 8;
  }

  /* ---- Payment details ---- */
  const payDetails = [];
  if (company.bankName) payDetails.push(`${t('Bank', 'Benki')}: ${company.bankName}`);
  if (company.bankAccountName) payDetails.push(`${t('Account Name', 'Jina la Akaunti')}: ${company.bankAccountName}`);
  if (company.bankAccountNumber) payDetails.push(`${t('Account No', 'Namba ya Akaunti')}: ${company.bankAccountNumber}`);
  if (company.mobileMoney) payDetails.push(`${t('Mobile Money', 'Fedha za Simu')}: ${company.mobileMoney}`);
  if (payDetails.length) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...BRAND_INK);
    doc.text(t('PAYMENT DETAILS', 'Maelezo ya MALIPO'), margin, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...INK_SOFT);
    payDetails.slice(0, 4).forEach((line, i) => {
      doc.text(String(line), margin, y + 5 + i * 4.2);
    });
    y += payDetails.length * 4.2 + 8;
  }

  /* ---- QR + signature ---- */
  const qrSize = 30;
  const qrX = pageW - margin - qrSize;
  if (opts.qrDataUrl) {
    try {
      doc.addImage(opts.qrDataUrl, 'PNG', qrX, y, qrSize, qrSize);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(...INK_FAINT);
      doc.text(t('Scan to verify', 'Changanua kuthibitisha'), qrX + qrSize / 2, y + qrSize + 4, { align: 'center' });
    } catch {
      // skip QR if it fails
    }
  }

  // Signature line
  const sigX = margin;
  const sigY = y + qrSize - 4;
  doc.setDrawColor(...INK_FAINT);
  doc.setLineWidth(0.3);
  doc.line(sigX, sigY, sigX + 55, sigY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...INK_SOFT);
  doc.text(t('Authorized Signature', 'Sahihi Iliyoidhinishwa'), sigX, sigY + 5);

  // Stamp placeholder
  doc.setDrawColor(...GOLD);
  doc.setLineWidth(0.6);
  doc.circle(pageW - margin - qrSize - 18, sigY - 8, 12, 'S');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.5);
  doc.setTextColor(...ACCENT_INK);
  doc.text(t('COMPANY STAMP', 'MUHURI WA KAMPUNI'), pageW - margin - qrSize - 18, sigY - 2, { align: 'center' });

  /* ---- Footer on every page ---- */
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    const h = doc.internal.pageSize.getHeight();
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.3);
    doc.line(margin, h - 14, pageW - margin, h - 14);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...INK_FAINT);
    const footerLeft = company.businessName || fallbackBusinessName();
    const footerRight = `${t('Page', 'Ukurasa')} ${i} / ${pageCount}`;
    doc.text(String(footerLeft), margin, h - 9);
    doc.text(footerRight, pageW - margin, h - 9, { align: 'right' });
    if (company.website) {
      doc.text(String(company.website), pageW / 2, h - 9, { align: 'center' });
    }
  }

  return doc;
}

function statusLabel(status) {
  const map = { draft: 'Draft', unpaid: 'Unpaid', partial: 'Partially Paid', paid: 'Paid', overdue: 'Overdue', cancelled: 'Cancelled' };
  return map[status] || status || '—';
}
function statusLabelSw(status) {
  const map = { draft: 'Rasimu', unpaid: 'Haijalipwa', partial: 'Imelipwa Kiasi', paid: 'Imelipwa', overdue: 'Imechelewa', cancelled: 'Imefutwa' };
  return map[status] || status || '—';
}

/** Download an invoice PDF. */
export async function downloadInvoicePDF(invoice, company, currency, opts = {}) {
  const doc = await generateInvoicePDF(invoice, company, currency, opts);
  const safeName = String(invoice.number || 'invoice').replace(/[^\w.-]+/g, '_');
  doc.save(`${safeName}.pdf`);
}

/** Open the print dialog for an invoice. */
export function printInvoice(invoice, company, currency, opts = {}) {
  const lang = opts.language || 'en';
  const t = (en, sw) => (lang === 'sw' ? sw : en);
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) {
    // Fallback: print current page
    window.print();
    return;
  }
  const rows = (invoice.items || []).map((item, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${escapeHTML(item.name || '')}</strong>${item.description ? `<br><span class="sub">${escapeHTML(item.description)}</span>` : ''}</td>
      <td class="num">${escapeHTML(String(item.qty ?? 0))}</td>
      <td class="num">${escapeHTML(formatMoney(item.unitPrice ?? 0, currency))}</td>
      <td class="num">${item.discountRate ? escapeHTML(String(item.discountRate)) + '%' : '—'}</td>
      <td class="num">${escapeHTML(formatMoney(item.total ?? 0, currency))}</td>
    </tr>`).join('');

  const totalRows = `
    <tr><td colspan="5">${t('Subtotal', 'Jumla Ndogo')}</td><td class="num">${escapeHTML(formatMoney(invoice.subtotal ?? 0, currency))}</td></tr>
    ${(invoice.itemDiscount ?? 0) ? `<tr><td colspan="5">${t('Item Discount', 'Punguzo la Bidhaa')}</td><td class="num">-${escapeHTML(formatMoney(invoice.itemDiscount, currency))}</td></tr>` : ''}
    ${(invoice.invoiceDiscount ?? 0) ? `<tr><td colspan="5">${t('Invoice Discount', 'Punguzo la Ankara')}</td><td class="num">-${escapeHTML(formatMoney(invoice.invoiceDiscount, currency))}</td></tr>` : ''}
    ${(invoice.tax ?? 0) ? `<tr><td colspan="5">${t('Tax', 'Kodi')}</td><td class="num">${escapeHTML(formatMoney(invoice.tax, currency))}</td></tr>` : ''}
    ${(invoice.shipping ?? 0) ? `<tr><td colspan="5">${t('Shipping', 'Usafirishaji')}</td><td class="num">${escapeHTML(formatMoney(invoice.shipping, currency))}</td></tr>` : ''}
    <tr class="grand"><td colspan="5">${t('GRAND TOTAL', 'JUMLA KUU')}</td><td class="num">${escapeHTML(formatMoney(invoice.grandTotal ?? 0, currency))}</td></tr>
    <tr><td colspan="5">${t('Amount Paid', 'Kiasi Kilicholipwa')}</td><td class="num">${escapeHTML(formatMoney(invoice.amountPaid ?? 0, currency))}</td></tr>
    <tr class="balance"><td colspan="5">${t('Balance Due', 'Salio')}</td><td class="num">${escapeHTML(formatMoney(invoice.balance ?? 0, currency))}</td></tr>`;

  const words = lang === 'sw'
    ? amountToWordsSwahili(invoice.grandTotal ?? 0, currency)
    : amountToWords(invoice.grandTotal ?? 0, currency);

  win.document.write(`<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${escapeHTML(invoice.number || 'Invoice')}</title>
<style>
${paletteToCss(loadBrandSync(), 'light')}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", Arial, sans-serif; color: #2B2B2B; font-size: 13px; padding: 30px; }
  .header { display: flex; justify-content: space-between; gap: 20px; border-bottom: 3px solid var(--brand); padding-bottom: 18px; margin-bottom: 20px; }
  .company h1 { color: var(--brand-ink); font-size: 20px; margin-bottom: 4px; }
  .company p { color: #5A5A5A; font-size: 11px; line-height: 1.6; }
  .title { text-align: right; }
  .title h2 { color: var(--brand-ink); font-size: 30px; letter-spacing: 2px; }
  .meta { margin-top: 8px; font-size: 11px; }
  .meta div { display: flex; justify-content: space-between; gap: 20px; padding: 2px 0; }
  .meta span:first-child { color: #8A8A8A; font-weight: 600; }
  .meta span:last-child { font-weight: 700; }
  .parties { display: flex; gap: 20px; margin-bottom: 20px; }
  .party { flex: 1; background: var(--brand-soft); border: 1px solid #E4E7E4; border-radius: 8px; padding: 14px; }
  .party h3 { color: var(--brand-ink); font-size: 10px; letter-spacing: 1px; margin-bottom: 6px; }
  .party .name { font-weight: 700; font-size: 14px; margin-bottom: 4px; }
  .party p { color: #5A5A5A; font-size: 11px; line-height: 1.6; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th { background: var(--brand); color: var(--brand-contrast); text-align: left; padding: 8px 10px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 8px 10px; border-bottom: 1px solid #E4E7E4; vertical-align: top; }
  tr:nth-child(even) td { background: #F8FAF8; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .sub { color: #8A8A8A; font-size: 11px; }
  .totals { margin-left: auto; width: 300px; }
  .totals table { margin-bottom: 0; }
  .totals td { border-bottom: 1px solid #E4E7E4; padding: 5px 10px; }
  .totals .grand td { background: var(--brand) !important; color: var(--brand-contrast); font-weight: 800; font-size: 14px; }
  .totals .balance td { font-weight: 800; color: var(--brand-ink); }
  .words { font-style: italic; color: #5A5A5A; font-size: 11px; margin-bottom: 16px; }
  .notes { font-size: 11px; color: #5A5A5A; margin-bottom: 16px; }
  .notes h4 { color: var(--brand-ink); font-size: 10px; letter-spacing: 1px; margin-bottom: 4px; }
  .footer { border-top: 1px solid #E4E7E4; margin-top: 24px; padding-top: 10px; text-align: center; color: #8A8A8A; font-size: 10px; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <div class="header">
    <div class="company">
      <h1>${escapeHTML(company.businessName || 'Business Name')}</h1>
      ${company.address ? `<p>${escapeHTML(company.address)}</p>` : ''}
      ${[company.region, company.district, company.country].filter(Boolean).length ? `<p>${escapeHTML([company.region, company.district, company.country].filter(Boolean).join(', '))}</p>` : ''}
      ${company.phone ? `<p>Tel: ${escapeHTML(company.phone)}</p>` : ''}
      ${company.email ? `<p>Email: ${escapeHTML(company.email)}</p>` : ''}
      ${company.tin ? `<p>TIN: ${escapeHTML(company.tin)}</p>` : ''}
      ${company.vrn ? `<p>VRN: ${escapeHTML(company.vrn)}</p>` : ''}
    </div>
    <div class="title">
      <h2>${t('INVOICE', 'ANKARA')}</h2>
      <div class="meta">
        <div><span>${t('Invoice No', 'Namba')}</span><span>${escapeHTML(invoice.number || '')}</span></div>
        <div><span>${t('Issue Date', 'Tarehe')}</span><span>${escapeHTML(invoice.issueDate || '')}</span></div>
        <div><span>${t('Due Date', 'Tarehe ya Kukamilika')}</span><span>${escapeHTML(invoice.dueDate || '')}</span></div>
        <div><span>${t('Status', 'Hali')}</span><span>${escapeHTML(statusLabel(invoice.status))}</span></div>
      </div>
    </div>
  </div>
  <div class="parties">
    <div class="party">
      <h3>${t('BILL TO', 'MLIPAJI')}</h3>
      <div class="name">${escapeHTML(invoice.customerName || 'Customer Name')}</div>
      ${invoice.customerAddress ? `<p>${escapeHTML(invoice.customerAddress)}</p>` : ''}
      ${invoice.customerPhone ? `<p>Tel: ${escapeHTML(invoice.customerPhone)}</p>` : ''}
      ${invoice.customerEmail ? `<p>Email: ${escapeHTML(invoice.customerEmail)}</p>` : ''}
      ${invoice.customerTin ? `<p>TIN: ${escapeHTML(invoice.customerTin)}</p>` : ''}
    </div>
    <div class="party">
      <h3>${t('SHIP TO', 'PALE UNAPELEKA')}</h3>
      <div class="name">${escapeHTML(invoice.shipToName || invoice.customerName || '—')}</div>
      ${invoice.shipToAddress ? `<p>${escapeHTML(invoice.shipToAddress)}</p>` : ''}
      ${invoice.shipToPhone ? `<p>Tel: ${escapeHTML(invoice.shipToPhone)}</p>` : ''}
    </div>
  </div>
  <table>
    <thead><tr><th>#</th><th>${t('Description', 'Maelezo')}</th><th>${t('Qty', 'Idadi')}</th><th>${t('Unit Price', 'Bei')}</th><th>${t('Disc %', 'Punguzo %')}</th><th>${t('Amount', 'Kiasi')}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="words">${t('Amount in Words:', 'Kiasi kwa Maneno:')} ${escapeHTML(words)}</div>
  <div class="totals"><table><tbody>${totalRows}</tbody></table></div>
  ${invoice.notes ? `<div class="notes"><h4>${t('NOTES', 'MAELEZO')}</h4><p>${escapeHTML(invoice.notes)}</p></div>` : ''}
  <div class="footer">${escapeHTML(company.businessName || fallbackBusinessName())}${company.website ? ' • ' + escapeHTML(company.website) : ''}</div>
  <script>window.onload = function(){ window.print(); };</script>
</body>
</html>`);
  win.document.close();
}

/* ---------------- CSV Export ---------------- */

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Export an array of objects to CSV and download. */
export function exportCSV(rows, filename) {
  if (!rows || !rows.length) return;
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(',')),
  ];
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, filename);
}

/** Export invoices to CSV. */
export function exportInvoicesCSV(invoices, currency) {
  const rows = invoices.map((inv) => ({
    'Invoice No': inv.number || '',
    'Issue Date': inv.issueDate || '',
    'Due Date': inv.dueDate || '',
    'Customer': inv.customerName || '',
    'Phone': inv.customerPhone || '',
    'Status': statusLabel(inv.status),
    'Subtotal': inv.subtotal ?? 0,
    'Discount': inv.invoiceDiscount ?? 0,
    'Tax': inv.tax ?? 0,
    'Shipping': inv.shipping ?? 0,
    'Grand Total': inv.grandTotal ?? 0,
    'Amount Paid': inv.amountPaid ?? 0,
    'Balance': inv.balance ?? 0,
    'Currency': inv.currency || 'TZS',
  }));
  exportCSV(rows, `invoices_${new Date().toISOString().slice(0, 10)}.csv`);
}

/** Export customers to CSV. */
export function exportCustomersCSV(customers) {
  const rows = customers.map((c) => ({
    'Name': c.name || '',
    'Phone': c.phone || '',
    'Email': c.email || '',
    'TIN': c.tin || '',
    'Address': c.address || '',
    'Notes': c.notes || '',
  }));
  exportCSV(rows, `customers_${new Date().toISOString().slice(0, 10)}.csv`);
}

/** Export products to CSV. */
export function exportProductsCSV(products) {
  const rows = products.map((p) => ({
    'Name': p.name || '',
    'SKU': p.sku || '',
    'Barcode': p.barcode || '',
    'Category': p.category || '',
    'Unit': p.unit || '',
    'Cost Price': p.costPrice ?? 0,
    'Selling Price': p.sellingPrice ?? 0,
    'Tax %': p.taxRate ?? 0,
    'Stock': p.stock ?? 0,
    'Status': p.status || 'active',
  }));
  exportCSV(rows, `products_${new Date().toISOString().slice(0, 10)}.csv`);
}
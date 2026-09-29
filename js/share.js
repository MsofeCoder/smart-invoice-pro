/**
 * ============================================================================
 *  SHARE — WhatsApp and native sharing
 * ============================================================================
 *
 *  Sending an invoice to a customer is the last mile of the whole app, and it
 *  has to work in three very different environments:
 *
 *    1. Mobile browser — `navigator.share()` can hand the actual PDF to
 *       WhatsApp, email, AirDrop, anything installed. This is the best result
 *       and the one worth trying first.
 *    2. Desktop browser — `navigator.share()` exists on Chrome/Edge but usually
 *       has no target that accepts files. WhatsApp Web via `wa.me` is the
 *       reliable path, and it needs no permissions.
 *    3. Anything else (or a blocked pop-up) — copy the message to the clipboard
 *       and tell the user, rather than failing silently.
 *
 *  The old behaviour was "generate a PDF and download it", which left the user
 *  to find the file, find WhatsApp, and attach it themselves.
 */

import { CONFIG, whatsappConfig, fallbackBusinessName } from './config.js';
import { formatMoney } from './currency.js';

/* ==========================================================================
   Phone numbers
   ========================================================================== */

/**
 * Turn a locally-written number into something `wa.me` accepts.
 *
 * Handles the four shapes people actually type:
 *   '+255 712 345 678'  → 255712345678
 *   '00255712345678'    → 255712345678
 *   '0712345678'        → 255712345678   (local, drop the trunk 0)
 *   '712345678'         → 255712345678   (bare national number)
 *
 * A number that already carries its country code is left alone, so this is
 * safe to run on values loaded from an existing customer record.
 */
export function normalisePhone(raw, countryCode = whatsappConfig().countryCode || '255') {
  let digits = String(raw ?? '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  if (digits.startsWith('+')) digits = digits.slice(1);
  digits = digits.replace(/^00/, '');
  if (!digits) return '';

  if (digits.startsWith(countryCode)) return digits;
  if (digits.startsWith('0')) return countryCode + digits.replace(/^0+/, '');
  // A bare national number is shorter than country code + subscriber number.
  if (digits.length <= 9) return countryCode + digits;
  return digits;
}

/* ==========================================================================
   Messages
   ========================================================================== */

/** Fill the configured template. Unknown placeholders are left visible. */
export function buildMessage(template, values) {
  return String(template || '').replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? '') : whole,
  );
}

/**
 * The default WhatsApp text for an invoice.
 * Override the wording in js/app.config.js → `whatsapp.defaultMessage`.
 */
export function invoiceMessage(invoice, company, currency, opts = {}) {
  const cfg = whatsappConfig();
  const total = formatMoney(invoice?.grandTotal ?? 0, currency);
  const business = company?.businessName || fallbackBusinessName();

  return buildMessage(opts.template || cfg.defaultMessage, {
    customer: invoice?.customerName || 'there',
    number: invoice?.number || '',
    business,
    total: String(total).replace(/^[A-Z]{3}\s*/, ''),
    currency: currency?.code || CONFIG.defaultCurrency || '',
    due: invoice?.dueDate || '',
  });
}

/** A `wa.me` deep link. Works on WhatsApp Web, Desktop and mobile apps. */
export function whatsappUrl(phone, message) {
  const number = normalisePhone(phone);
  const text = encodeURIComponent(message || '');
  // Without a number WhatsApp opens the contact picker, which is still useful.
  return number ? `https://wa.me/${number}?text=${text}` : `https://wa.me/?text=${text}`;
}

/* ==========================================================================
   PDF blobs
   ========================================================================== */

/**
 * Render an invoice to a PDF Blob.
 * `generateInvoicePDF` is imported lazily: it pulls in jsPDF and AutoTable,
 * which is a lot of code to load for a page that never exports anything.
 */
export async function invoicePdfBlob(invoice, company, currency, opts = {}) {
  const { generateInvoicePDF } = await import('./export.js');
  const doc = await generateInvoicePDF(invoice, company, currency, opts);
  return doc.output('blob');
}

export function pdfFilename(invoice) {
  const safe = String(invoice?.number || 'invoice').replace(/[^\w.-]+/g, '_');
  return `${safe}.pdf`;
}

/* ==========================================================================
   Sharing
   ========================================================================== */

/** True when this browser can hand a File to another app. */
export function canShareFiles(file) {
  if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function') return false;
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/**
 * Share an invoice to WhatsApp, with the PDF attached where the platform allows.
 *
 * @returns {Promise<{ok: boolean, via: string, reason?: string}>}
 *   `via` is one of 'native' | 'whatsapp' | 'clipboard' | 'none'.
 */
export async function shareInvoice(invoice, company, currency, opts = {}) {
  const message = opts.message || invoiceMessage(invoice, company, currency, opts);
  const phone = opts.phone || invoice?.customerPhone || '';
  const url = whatsappUrl(phone, message);

  /* 1. Native share sheet with the PDF attached. */
  if (opts.attachPdf !== false) {
    try {
      const blob = await invoicePdfBlob(invoice, company, currency, opts.pdf || {});
      const file = new File([blob], pdfFilename(invoice), { type: 'application/pdf' });
      if (canShareFiles(file)) {
        await navigator.share({
          files: [file],
          title: `Invoice ${invoice?.number || ''}`.trim(),
          text: message,
        });
        return { ok: true, via: 'native' };
      }
    } catch (err) {
      // AbortError means the user dismissed the sheet — that is a success, not
      // a failure, and must not fall through to opening WhatsApp anyway.
      if (err?.name === 'AbortError') return { ok: true, via: 'native', reason: 'dismissed' };
      // Any other failure (no jsPDF yet, canvas tainted, …) falls through to
      // the web link, which needs none of it.
    }
  }

  /* 2. WhatsApp Web / Desktop. */
  const opened = typeof window !== 'undefined' ? window.open(url, '_blank', 'noopener') : null;
  if (opened) return { ok: true, via: 'whatsapp' };

  /* 3. Pop-up blocked — give the user the text instead of nothing. */
  try {
    await navigator.clipboard.writeText(message);
    return { ok: true, via: 'clipboard' };
  } catch {
    return { ok: false, via: 'none', reason: 'Pop-up blocked and clipboard unavailable', url, message };
  }
}

/** Share a pre-built PDF file (used by the report and invoice toolbars). */
export async function shareFile(blob, filename, { title, text } = {}) {
  const file = new File([blob], filename, { type: blob.type || 'application/pdf' });
  if (canShareFiles(file)) {
    try {
      await navigator.share({ files: [file], title, text });
      return { ok: true, via: 'native' };
    } catch (err) {
      if (err?.name === 'AbortError') return { ok: true, via: 'native', reason: 'dismissed' };
    }
  }
  // No native path: fall back to a download, which at least gets the file out.
  const { downloadBlob } = await import('./utils.js');
  downloadBlob(blob, filename);
  return { ok: true, via: 'download' };
}

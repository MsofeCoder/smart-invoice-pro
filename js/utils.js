/**
 * Shared utilities
 * DOM helpers, sanitization, escaping, toasts, modals, formatting.
 */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Escape HTML to prevent XSS. Entities built via concatenation to survive formatters. */
export function escapeHTML(value) {
  const AMP = '&' + 'amp;';
  const LT = '&' + 'lt;';
  const GT = '&' + 'gt;';
  const QUOT = '&' + 'quot;';
  const APOS = '&#' + '39;';
  return String(value ?? '')
    .replace(/&/g, AMP)
    .replace(/</g, LT)
    .replace(/>/g, GT)
    .replace(/"/g, QUOT)
    .replace(/'/g, APOS);
}

/** Sanitize a string: trim, strip control chars, collapse whitespace. */
export function sanitizeString(value, maxLen = 500) {
  if (value == null) return '';
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/** Sanitize a multiline string (keeps line breaks). */
export function sanitizeMultiline(value, maxLen = 5000) {
  if (value == null) return '';
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen);
}

/** Parse a number safely; returns 0 for invalid input. */
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value == null || value === '') return 0;
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Generate a short unique id. */
export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Format a date as YYYY-MM-DD (local). */
export function toISODate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse YYYY-MM-DD into a local Date at midnight. */
export function parseISODate(str) {
  if (!str) return null;
  const [y, m, d] = String(str).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/** Human-friendly date, e.g. "2 Aug 2026". */
export function formatDate(str, locale = 'en-GB') {
  const d = parseISODate(str);
  if (!d) return '—';
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Add days to a date string. */
export function addDays(isoDate, days) {
  const d = parseISODate(isoDate) || new Date();
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** Debounce a function. */
export function debounce(fn, wait = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/** Throttle a function. */
export function throttle(fn, limit = 200) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= limit) {
      last = now;
      fn(...args);
    }
  };
}

/* ---------------- Toast notifications ---------------- */
let toastContainer = null;
function getToastContainer() {
  if (toastContainer) return toastContainer;
  if (typeof document === 'undefined') return null;
  let el = $('.toast-container');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast-container';
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  toastContainer = el;
  return el;
}

const TOAST_ICONS = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

export function toast(message, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `
    <span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span>
    <span class="toast-msg">${escapeHTML(message)}</span>
    <button class="icon-btn toast-close" aria-label="Close notification">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;
  const close = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 260);
  };
  const container = getToastContainer();
  if (!container) return el;
  $('.toast-close', el).addEventListener('click', close);
  container.appendChild(el);
  if (duration > 0) setTimeout(close, duration);
  return el;
}

/* ---------------- Modal ---------------- */
export function openModal({ title, body, footer, size = '', onOpen } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="modal ${size}">
      <div class="modal-header">
        <h3>${escapeHTML(title)}</h3>
        <button class="icon-btn modal-close" aria-label="Close dialog">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  const close = () => {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 220);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  $('.modal-close', overlay).addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  if (typeof onOpen === 'function') onOpen(overlay);
  return { overlay, close };
}

export function closeModal(overlay) {
  overlay.classList.remove('open');
  setTimeout(() => overlay.remove(), 220);
}

/* ---------------- Confirm dialog ---------------- */
export function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const { overlay, close } = openModal({
      title,
      body: `<p class="text-muted">${escapeHTML(message)}</p>`,
      footer: `
        <button class="btn btn-outline" data-action="cancel">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="confirm">${escapeHTML(confirmText)}</button>`,
      onOpen: (ov) => {
        $('[data-action="cancel"]', ov).addEventListener('click', () => { close(); resolve(false); });
        $('[data-action="confirm"]', ov).addEventListener('click', () => { close(); resolve(true); });
      },
    });
  });
}

/* ---------------- Button loading state ----------------
   Slow actions (PDF generation, backup export) otherwise look frozen. */
export function setLoading(btn, on = true) {
  if (!btn) return;
  if (on) {
    if (btn.dataset.loading === '1') return;
    btn.dataset.loading = '1';
    btn.classList.add('loading');
    btn.setAttribute('aria-busy', 'true');
    // Icon-only buttons are too small for a spinner; the .loading class alone
    // dims them and blocks a second click.
    const iconOnly = btn.classList.contains('icon-btn') || btn.classList.contains('btn-icon');
    if (!iconOnly) {
      const sp = document.createElement('span');
      sp.className = 'btn-spinner';
      sp.setAttribute('aria-hidden', 'true');
      btn.prepend(sp);
    }
  } else {
    delete btn.dataset.loading;
    btn.classList.remove('loading');
    btn.removeAttribute('aria-busy');
    const sp = $('.btn-spinner', btn);
    if (sp) sp.remove();
  }
}

/** Yield one paint so a just-added spinner is actually visible. */
function nextPaint() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
    // Fallback: rAF never fires in a background/hidden tab, and hanging here
    // would stall the action entirely.
    setTimeout(finish, 60);
  });
}

/**
 * Run an action with the button in a loading state, always restoring it.
 * Yields a frame first, because jsPDF builds the whole document synchronously
 * on the main thread — without the yield the spinner would never paint.
 */
export async function withLoading(btn, fn) {
  if (!btn) return fn();
  setLoading(btn, true);
  try {
    await nextPaint();
    return await fn();
  } finally {
    setLoading(btn, false);
  }
}

/* ---------------- Skeleton helpers ---------------- */
export function skeletonRows(count = 5, cols = 4) {
  let html = '';
  for (let i = 0; i < count; i++) {
    html += '<tr>';
    for (let c = 0; c < cols; c++) html += `<td><div class="skeleton" style="height:16px"></div></td>`;
    html += '</tr>';
  }
  return html;
}

/* ---------------- Misc ---------------- */
export function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadDataURI(dataUri, filename) {
  const a = document.createElement('a');
  a.href = dataUri;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** Validate an email address. */
export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

/** Validate a phone number (loose international). */
export function isValidPhone(value) {
  return /^[+]?[\d\s()-]{7,20}$/.test(String(value || '').trim());
}

/** Clamp a number between min and max. */
export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
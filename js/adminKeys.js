/**
 * ============================================================================
 *  ADMIN KEYS — the licence ledger's pure logic
 * ============================================================================
 *
 *  Split out of `js/admin.js` for one reason: everything here decides what a
 *  customer receives, and none of it needs a browser. `js/admin.js` is a page
 *  module — it binds DOM on load and cannot be imported under Node — so logic
 *  that lives there can only be checked by driving the real app.
 *
 *  This is the part worth checking cheaply. Handing two customers the same
 *  activation key, or minting one whose date does not match its ledger row, is
 *  a support call that costs more than the licence did.
 */

import { makeLicenseKey, verifyLicenseKey } from './licenseService.js';

const PASS_SALT = 'sip-admin-v1';

/* ==========================================================================
   Passcode
   ========================================================================== */

/**
 * FNV-1a over `salt|passcode`.
 *
 * A CHECKSUM, NOT A PASSWORD HASH. It is not per-user salted, not stretched,
 * not memory-hard, and the salt is in this file. It exists so the admin console
 * is not standing open to any end user who taps "Admin" — the same honest
 * limitation as the plan gate in `js/licenseService.js`. Anyone with devtools
 * walks past it. Never reuse this for anything that actually protects data.
 */
export function hashPasscode(pass) {
  const seed = `${PASS_SALT}|${String(pass ?? '')}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/* ==========================================================================
   The ledger
   ========================================================================== */

/** Newest first, so the ledger opens on what was issued most recently. */
export function sortKeys(entries) {
  return [...(Array.isArray(entries) ? entries : [])].sort(
    (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  );
}

/**
 * The label for one ledger row.
 *
 * "Active here" is deliberately distinct from "Activated": a key running on
 * this device is a fact this console can verify, whereas a key that was merely
 * used somewhere is only known because someone said so.
 */
export function keyStatus(entry, license = {}) {
  if (license.licenseKey && entry?.key === license.licenseKey) {
    return { label: 'Active here', cls: 'badge-green' };
  }
  if (entry?.activatedAt) return { label: 'Activated', cls: 'badge-gold' };
  return { label: 'Unused', cls: 'badge-gray' };
}

/** `YYYYMMDD` — the date form the key format and the ledger both carry. */
export function keyStamp(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** `YYYYMMDD` → `YYYY-MM-DD`, for display. `''` when it is not that shape. */
export function stampToISODate(stamp) {
  const s = String(stamp || '');
  if (!/^\d{8}$/.test(s)) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * Mint a batch of activation keys.
 *
 * THE ONE RULE THAT MATTERS: no two keys in the result — and none in the
 * ledger already — may be identical.
 *
 * A key's format carries a single issue date (`SIP-PRO-20261002-4F2A`), so the
 * date is the only free variable. A naive loop that mints `count` copies of
 * "today" produces `count` identical strings, which looks fine on screen and
 * means the second customer activates with the first customer's key. So each
 * key in a batch takes its own day, and any day already present in the ledger
 * is stepped past.
 *
 * @param {object} opts
 * @param {string} opts.planId        Plan to issue for. `free` is rejected.
 * @param {number} opts.count         How many. Clamped to `1..max`.
 * @param {Date}   opts.date          First issue date.
 * @param {string} [opts.note]        Customer or reference.
 * @param {string[]} [opts.existingKeys] Keys already issued, to avoid.
 * @param {number} [opts.max]         Batch ceiling.
 * @param {Date}   [opts.now]         Creation timestamp, injectable for tests.
 * @returns {Array<object>} Ledger entries, ready to store.
 */
export function buildKeyBatch({
  planId,
  count = 1,
  date = new Date(),
  note = '',
  existingKeys = [],
  max = 50,
  now = new Date(),
} = {}) {
  const plan = String(planId || '').toLowerCase();
  if (!plan || plan === 'free') return [];

  const ceiling = Math.max(1, Number(max) || 50);
  const wanted = Math.max(1, Math.min(ceiling, Math.floor(Number(count) || 1)));
  const start = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();

  const seen = new Set((existingKeys || []).map((k) => String(k || '').toUpperCase()));
  const batch = [];

  for (let i = 0; i < wanted; i++) {
    const when = new Date(start);
    when.setDate(when.getDate() + i);

    let key = makeLicenseKey(plan, when);
    // Step forward a day at a time past anything already issued. Bounded so a
    // pathological ledger cannot spin here forever.
    let guard = 0;
    while (seen.has(key) && guard < 400) {
      when.setDate(when.getDate() + 1);
      key = makeLicenseKey(plan, when);
      guard++;
    }
    seen.add(key);

    batch.push({
      key,
      plan,
      issuedAt: keyStamp(when),
      createdAt: now.toISOString(),
      note: String(note || ''),
      activatedAt: null,
    });
  }

  return batch;
}

/** True when a key a customer sent back is well-formed and matches a plan. */
export function inspectKey(key) {
  const check = verifyLicenseKey(key);
  if (!check.valid) return { valid: false, reason: check.reason || 'Unrecognised key' };
  return { valid: true, planId: check.planId, issuedAt: check.issuedAt, iso: stampToISODate(check.issuedAt) };
}

/* ==========================================================================
   CSV row builders
   ========================================================================== */

export function keysToRows(entries) {
  return sortKeys(entries).map((e) => ({
    Key: e.key || '',
    Plan: e.plan || '',
    Issued: stampToISODate(e.issuedAt),
    Created: e.createdAt || '',
    Note: e.note || '',
    Status: e.activatedAt ? 'Activated' : 'Unused',
    'Activated at': e.activatedAt || '',
  }));
}

export function feedbackToRows(records) {
  return (Array.isArray(records) ? records : []).map((r) => ({
    Date: r.createdAt || '',
    Rating: Number(r.rating) >= 1 && Number(r.rating) <= 5 ? Math.round(Number(r.rating)) : '',
    Topic: r.category || '',
    Feedback: r.message || '',
    Plan: r.plan || '',
    'Sent via': r.sentVia || '',
    Device: r.device || '',
  }));
}

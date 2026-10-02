/**
 * ============================================================================
 *  ADMIN CONSOLE — licence desk, activation keys, usage and feedback
 * ============================================================================
 *
 *  ---------------------------------------------------------------------------
 *  WHAT THIS IS, AND WHAT IT HONESTLY IS NOT
 *  ---------------------------------------------------------------------------
 *  There is no backend behind this app. It ships as a static site, works
 *  offline, and runs from `file://`. So this console cannot "track all users"
 *  in the server sense — it has no way to see another device.
 *
 *  What it CAN do is genuinely useful, and is what a licence desk actually
 *  needs:
 *
 *    - show the state of THIS installation (plan, usage, storage adapter),
 *    - mint activation keys for OTHER installations and keep a ledger of what
 *      was issued to whom, so the same key is not handed out twice,
 *    - verify a key a customer reads out over the phone,
 *    - read the feedback that was left on this device,
 *    - activate or release a plan here.
 *
 *  ---------------------------------------------------------------------------
 *  THE PASSCODE IS A DOOR, NOT A LOCK
 *  ---------------------------------------------------------------------------
 *  `hashPasscode()` is FNV-1a with a fixed salt — a checksum, not a password
 *  hash. It is not salted per user, not stretched, and the source is public.
 *  It exists to keep the panel out of a curious end-user's way, exactly like
 *  the plan gate in js/licenseService.js is a business nudge rather than a
 *  security boundary. Anyone with devtools can walk past both, and the note at
 *  the bottom of admin.html says so to the operator's face rather than
 *  pretending otherwise.
 *
 *  Real enforcement has to live where the user cannot reach it: the server that
 *  issues the licence, or the backend a cloud-sync adapter talks to.
 */

import { $, escapeHTML, sanitizeString, toast, confirmDialog, withLoading, formatDate, toISODate } from './utils.js';
import { getSetting, setSetting, getInvoices, getCustomers, getProducts, getPayments, pendingCount, activeAdapterId } from './storageService.js';
import { getCurrency, getDefaultCurrencyCode, formatMoney } from './currency.js';
import { CONFIG, adminConfig, appName } from './config.js';
import { exportCSV } from './export.js';
import {
  loadLicense, getLicense, currentPlan, currentPlanId, setPlan, resetLicense,
  makeLicenseKey, verifyLicenseKey, checkInvoiceQuota, FEATURE_LABELS,
} from './licenseService.js';
import {
  hashPasscode, sortKeys, keyStatus, buildKeyBatch, inspectKey,
  keysToRows, feedbackToRows, stampToISODate,
} from './adminKeys.js';
import { getFeedback, clearFeedback, summariseFeedback, RATING_LABELS, normaliseRating } from './feedback.js';
import { initShell } from './shell.js';

const AUTH_KEY = 'adminAuth';
const KEYS_KEY = 'issuedKeys';
const SESSION_FLAG = 'sip_admin_unlocked';

/* ==========================================================================
   Pure helpers
   ==========================================================================
   The passcode hash, the ledger sort, the status labels, the batch generator
   and the CSV row builders all live in js/adminKeys.js. They decide what a
   customer receives, and none of them needs a browser — so they are unit-tested
   directly instead of only through this page. */

/* ==========================================================================
   Auth
   ========================================================================== */

/** The stored hash, or the config default when the owner has never changed it. */
async function effectivePasscodeHash() {
  const auth = await getSetting(AUTH_KEY, null);
  if (auth && typeof auth.hash === 'string' && auth.hash) return auth.hash;
  return hashPasscode(adminConfig().defaultPasscode);
}

async function isDefaultPasscode() {
  const auth = await getSetting(AUTH_KEY, null);
  return !(auth && typeof auth.hash === 'string' && auth.hash);
}

function sessionUnlocked() {
  try {
    return sessionStorage.getItem(SESSION_FLAG) === '1';
  } catch {
    return false;
  }
}

function setSessionUnlocked(on) {
  try {
    if (on) sessionStorage.setItem(SESSION_FLAG, '1');
    else sessionStorage.removeItem(SESSION_FLAG);
  } catch {
    /* private mode — the console simply re-asks */
  }
}

async function showPanel() {
  $('#adminGate')?.classList.add('hidden');
  $('#adminPanel')?.classList.remove('hidden');
  await refreshAll();
}

function showGate() {
  $('#adminPanel')?.classList.add('hidden');
  $('#adminGate')?.classList.remove('hidden');
  $('#adminPass')?.focus();
}

async function attemptUnlock() {
  const input = $('#adminPass')?.value || '';
  const expected = await effectivePasscodeHash();
  if (hashPasscode(input) !== expected) {
    toast('That passcode is not right', 'error');
    const el = $('#adminPass');
    if (el) { el.value = ''; el.focus(); }
    return;
  }
  setSessionUnlocked(true);
  if (await isDefaultPasscode()) {
    toast('Console unlocked — change the default passcode below', 'warning', 6000);
  } else {
    toast('Console unlocked', 'success');
  }
  await showPanel();
}

function lockConsole() {
  setSessionUnlocked(false);
  const el = $('#adminPass');
  if (el) el.value = '';
  showGate();
  toast('Console locked', 'info');
}

/* ==========================================================================
   Overview
   ========================================================================== */

function statCard(label, value, sub = '') {
  return `
    <div class="card card-pad admin-stat">
      <div class="as-value">${escapeHTML(String(value))}</div>
      <div class="as-label">${escapeHTML(label)}</div>
      ${sub ? `<div class="as-sub">${escapeHTML(sub)}</div>` : ''}
    </div>`;
}

async function renderOverview() {
  const box = $('#adminStats');
  if (!box) return;

  const [invoices, customers, products, payments, currency, quota, pending] = await Promise.all([
    getInvoices().catch(() => []),
    getCustomers().catch(() => []),
    getProducts().catch(() => []),
    getPayments().catch(() => []),
    getDefaultCurrencyCode().then((code) => getCurrency(code)).catch(() => null),
    checkInvoiceQuota().catch(() => null),
    pendingCount().catch(() => 0),
  ]);

  const plan = currentPlan();
  const collected = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const badge = $('#adminPlanBadge');
  if (badge) badge.textContent = plan?.name || currentPlanId();

  box.innerHTML = [
    statCard('Plan', plan?.name || currentPlanId(), plan?.price ? `${plan.currency} ${Number(plan.price).toLocaleString()}/${plan.period || 'month'}` : 'No licence key needed'),
    statCard('Invoices this month', quota ? quota.used : invoices.length, quota && !quota.unlimited ? `of ${quota.limit} included` : 'unlimited'),
    statCard('Invoices on file', invoices.length, `${invoices.filter((i) => i.status === 'draft').length} draft`),
    statCard('Customers', customers.length, `${products.length} products`),
    statCard('Collected', formatMoney(collected, currency), `${payments.length} payments`),
    statCard('Storage', activeAdapterId(), pending ? `${pending} queued to sync` : 'nothing pending'),
  ].join('');
}

/* ==========================================================================
   Plan matrix
   ========================================================================== */

function renderPlanMatrix() {
  const table = $('#planMatrixTable');
  if (!table) return;
  const plans = Object.values(CONFIG.plans || {});
  if (!plans.length) return;

  // Union of every feature id, so a feature added to only one plan still shows
  // up as a missing tick on the others rather than vanishing from the table.
  const features = [...new Set(plans.flatMap((p) => p.features || []))];

  table.querySelector('thead').innerHTML =
    `<tr><th>Feature</th>${plans.map((p) => `<th class="text-center">${escapeHTML(p.name)}</th>`).join('')}</tr>`;
  table.querySelector('tbody').innerHTML = features.map((f) => `
    <tr>
      <td>${escapeHTML(FEATURE_LABELS[f] || f)}</td>
      ${plans.map((p) => `<td class="text-center">${(p.features || []).includes(f)
        ? '<span class="matrix-yes">&#10003;</span>'
        : '<span class="text-faint">&#8212;</span>'}</td>`).join('')}
    </tr>`).join('');
}

/* ==========================================================================
   Issued-key ledger
   ========================================================================== */

export async function getIssuedKeys() {
  try {
    const stored = await getSetting(KEYS_KEY, []);
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

async function saveIssuedKeys(list) {
  await setSetting(KEYS_KEY, list);
}

async function generateKeys() {
  const planId = $('#keyPlanSelect')?.value || 'pro';
  const cfg = adminConfig();
  const count = Number($('#keyCount')?.value) || 1;
  const dateStr = $('#keyDate')?.value || toISODate();
  const note = sanitizeString($('#keyNote')?.value || '', 80);

  if (planId === 'free') { toast('The Free plan needs no key', 'info'); return; }

  // The key encodes its issue date, so the date input has to be parsed into a
  // local Date rather than passed through as a string.
  const [y, m, d] = dateStr.split('-').map(Number);
  const issued = new Date(y, (m || 1) - 1, d || 1);

  const existing = await getIssuedKeys();
  const batch = buildKeyBatch({
    planId,
    count,
    date: issued,
    note,
    existingKeys: existing.map((e) => e.key),
    max: Number(cfg.maxKeysPerBatch) || 50,
  });

  if (!batch.length) { toast('Nothing to generate for that plan', 'info'); return; }

  await saveIssuedKeys([...existing, ...batch]);
  await renderLedger();
  toast(`${batch.length} key${batch.length === 1 ? '' : 's'} generated`, 'success');
  return batch;
}

async function renderLedger() {
  const body = $('#keyTableBody');
  if (!body) return;
  const [entries, license] = [await getIssuedKeys(), getLicense()];
  const summary = $('#keySummary');

  if (summary) {
    const used = entries.filter((e) => e.activatedAt).length;
    summary.textContent = entries.length
      ? `${entries.length} issued · ${used} activated · ${entries.length - used} unused`
      : '';
  }

  if (!entries.length) {
    body.innerHTML = '<tr><td colspan="6" class="text-center text-faint py-4">No keys issued from this device yet.</td></tr>';
    return;
  }

  body.innerHTML = sortKeys(entries).map((e) => {
    const status = keyStatus(e, license);
    const plan = CONFIG.plans?.[e.plan];
    return `
      <tr>
        <td><span class="key-code">${escapeHTML(e.key)}</span></td>
        <td>${escapeHTML(plan?.name || e.plan)}</td>
        <td class="text-muted">${escapeHTML(formatDate(stampToISODate(e.issuedAt)))}</td>
        <td class="text-muted">${escapeHTML(e.note || '—')}</td>
        <td><span class="badge ${status.cls}">${escapeHTML(status.label)}</span></td>
        <td>
          <div class="actions">
            <button class="icon-btn" data-key-action="copy" data-key="${escapeHTML(e.key)}" aria-label="Copy key" title="Copy">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <button class="icon-btn" data-key-action="use" data-key="${escapeHTML(e.key)}" aria-label="Activate this key here" title="Activate here">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            </button>
            <button class="icon-btn danger" data-key-action="delete" data-key="${escapeHTML(e.key)}" aria-label="Remove from ledger" title="Remove">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

/** Activate a ledger key on this device and record that it was used. */
async function activateLedgerKey(key) {
  const check = verifyLicenseKey(key);
  if (!check.valid) { toast(check.reason || 'That key is not valid', 'error'); return; }
  const result = await setPlan(check.planId, { licenseKey: key, activatedBy: 'admin' });
  if (!result.ok) { toast(result.reason || 'Could not activate', 'error'); return; }

  const list = await getIssuedKeys();
  const entry = list.find((e) => e.key === key);
  if (entry) entry.activatedAt = new Date().toISOString();
  await saveIssuedKeys(list);

  toast(`Activated ${CONFIG.plans?.[check.planId]?.name || check.planId} on this device`, 'success');
  await refreshAll();
}

/* ==========================================================================
   Verifier
   ========================================================================== */

function renderVerifyResult(key) {
  const box = $('#verifyResult');
  if (!box) return;
  if (!key) { box.innerHTML = ''; return; }

  const check = inspectKey(key);
  if (!check.valid) {
    box.innerHTML = `<div class="admin-verdict bad"><strong>Not a valid key</strong><span>${escapeHTML(check.reason || '')}</span></div>`;
    return;
  }
  const plan = CONFIG.plans?.[check.planId];
  box.innerHTML = `
    <div class="admin-verdict good">
      <strong>Valid ${escapeHTML(plan?.name || check.planId)} key</strong>
      <span>Issued ${escapeHTML(formatDate(check.iso))} · ${plan?.invoiceLimitPerMonth === null ? 'unlimited invoices' : `${plan?.invoiceLimitPerMonth} invoices/month`}</span>
      <span class="text-faint">Checksum verified. This confirms the key is well-formed — it is not a signature check.</span>
    </div>`;
}

/* ==========================================================================
   Licence panel
   ========================================================================== */

async function renderLicensePanel() {
  const state = $('#adminLicenseState');
  const license = getLicense();
  const quota = await checkInvoiceQuota();
  const plan = currentPlan();

  if (state) {
    state.innerHTML = `
      <div class="admin-verdict ${license.plan === 'free' ? '' : 'good'}">
        <strong>${escapeHTML(plan?.name || license.plan)} plan</strong>
        <span>${license.licenseKey ? `Key ${escapeHTML(license.licenseKey)}` : 'No licence key stored'}</span>
        <span class="text-faint">${license.activatedAt ? `Activated ${escapeHTML(new Date(license.activatedAt).toLocaleString())} (${escapeHTML(license.activatedBy)})` : 'Never activated'}</span>
        <span class="text-faint">${quota.unlimited ? 'Unlimited invoices this month' : `${quota.used} of ${quota.limit} invoices used this month`}</span>
      </div>`;
  }

  const select = $('#adminPlanSelect');
  if (select) {
    select.innerHTML = Object.values(CONFIG.plans || {})
      .map((p) => `<option value="${escapeHTML(p.id)}" ${p.id === license.plan ? 'selected' : ''}>${escapeHTML(p.name)}</option>`)
      .join('');
  }
  const keyInput = $('#adminKeyInput');
  if (keyInput && license.licenseKey) keyInput.value = license.licenseKey;
}

/* ==========================================================================
   Feedback inbox
   ========================================================================== */

const STAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 2.6l2.95 5.98 6.6.96-4.77 4.65 1.12 6.57L12 17.66l-5.9 3.1 1.12-6.57L2.45 9.54l6.6-.96L12 2.6z"/></svg>';

async function renderFeedbackInbox() {
  const box = $('#feedbackInbox');
  if (!box) return;
  const list = await getFeedback();
  const summary = summariseFeedback(list);

  const label = $('#feedbackSummary');
  if (label) {
    label.textContent = summary.count
      ? `${summary.count} review${summary.count === 1 ? '' : 's'} · average ${summary.average}/5`
      : '';
  }

  if (!list.length) {
    box.innerHTML = '<p class="text-faint">No reviews stored on this device yet. Reviews appear here after a user leaves one from the Feedback button.</p>';
    return;
  }

  const warnAt = Number(adminConfig().feedbackWarnThreshold) || 25;
  const warning = list.length >= warnAt
    ? `<div class="gateway-note mb-3">This device is holding ${list.length} reviews. Export them — there is no backend to sync them to.</div>`
    : '';

  box.innerHTML = warning + sortKeys(list).map((r) => {
    const rating = normaliseRating(r.rating);
    return `
      <div class="feedback-item mb-2">
        <div class="fb-stars-static" aria-label="${rating} out of 5">
          ${[1, 2, 3, 4, 5].map((n) => `<span class="${n <= rating ? 'on' : ''}">${STAR}</span>`).join('')}
        </div>
        <div class="fb-item-body">
          <strong>${escapeHTML(r.category || 'General')}${rating ? ` · ${escapeHTML(RATING_LABELS[rating])}` : ''}</strong>
          ${r.message ? `<div class="text-muted">${escapeHTML(r.message)}</div>` : ''}
          <div class="text-faint text-xs">
            ${escapeHTML(new Date(r.createdAt).toLocaleString())}
            · plan ${escapeHTML(r.plan || 'free')}
            ${r.sentVia ? ` · sent by ${escapeHTML(r.sentVia)}` : ' · not sent'}
          </div>
        </div>
      </div>`;
  }).join('');
}

/* ==========================================================================
   Wiring
   ========================================================================== */

async function refreshAll() {
  await Promise.all([
    renderOverview(),
    renderPlanMatrix(),
    renderLicensePanel(),
    renderLedger(),
    renderFeedbackInbox(),
  ]);
}

function bindEvents() {
  $('#adminUnlockBtn')?.addEventListener('click', attemptUnlock);
  $('#adminPass')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptUnlock();
  });
  $('#adminLockBtn')?.addEventListener('click', lockConsole);

  // Key generator
  $('#genKeysBtn')?.addEventListener('click', (e) => withLoading(e.currentTarget, generateKeys));
  $('#exportKeysBtn')?.addEventListener('click', async () => {
    const rows = keysToRows(await getIssuedKeys());
    if (!rows.length) { toast('No keys to export yet', 'info'); return; }
    exportCSV(rows, `activation_keys_${toISODate()}.csv`);
    toast('Ledger exported', 'success');
  });
  $('#copyLastBtn')?.addEventListener('click', async () => {
    const list = sortKeys(await getIssuedKeys());
    if (!list.length) { toast('No keys issued yet', 'info'); return; }
    copyText(list[0].key, `Copied ${list[0].key}`);
  });

  // Verifier
  $('#verifyKeyBtn')?.addEventListener('click', () => renderVerifyResult($('#verifyKeyInput')?.value || ''));
  $('#verifyKeyInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') renderVerifyResult(e.target.value || '');
  });

  // Licence control
  $('#adminActivateBtn')?.addEventListener('click', async (e) => {
    const planId = $('#adminPlanSelect')?.value;
    const licenseKey = $('#adminKeyInput')?.value || '';
    await withLoading(e.currentTarget, async () => {
      const result = await setPlan(planId, { licenseKey, activatedBy: 'admin' });
      if (!result.ok) { toast(result.reason || 'Could not activate that plan', 'error'); return; }
      const list = await getIssuedKeys();
      const entry = list.find((x) => x.key === String(licenseKey).trim().toUpperCase());
      if (entry) entry.activatedAt = new Date().toISOString();
      await saveIssuedKeys(list);
      toast(`Plan set to ${CONFIG.plans?.[planId]?.name || planId}`, 'success');
      await refreshAll();
    });
  });
  $('#adminMintBtn')?.addEventListener('click', async () => {
    const planId = $('#adminPlanSelect')?.value || 'pro';
    if (planId === 'free') { toast('The Free plan needs no key', 'info'); return; }
    const key = makeLicenseKey(planId);
    const input = $('#adminKeyInput');
    if (input) input.value = key;
    toast('Key minted — press Activate to apply it', 'info', 5000);
  });
  $('#adminDeactivateBtn')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Return to Free',
      message: 'This releases the licence on this device. Invoices and customers are untouched, but the plan limits and locked features come back.',
      confirmText: 'Return to Free',
      danger: true,
    });
    if (!ok) return;
    await resetLicense();
    toast('Back on the Free plan', 'success');
    await refreshAll();
  });

  // Ledger row actions
  $('#keyTableBody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-key-action]');
    if (!btn) return;
    const key = btn.dataset.key;
    const action = btn.dataset.keyAction;

    if (action === 'copy') { copyText(key, 'Key copied'); return; }
    if (action === 'use') { await activateLedgerKey(key); return; }
    if (action === 'delete') {
      const ok = await confirmDialog({
        title: 'Remove key',
        message: `Remove ${key} from the ledger? If it is already with a customer it will keep working — this only clears your record of it.`,
        confirmText: 'Remove',
        danger: true,
      });
      if (!ok) return;
      const list = (await getIssuedKeys()).filter((x) => x.key !== key);
      await saveIssuedKeys(list);
      await renderLedger();
      toast('Key removed from the ledger', 'success');
    }
  });

  // Feedback inbox
  $('#exportFeedbackBtn')?.addEventListener('click', async () => {
    const rows = feedbackToRows(await getFeedback());
    if (!rows.length) { toast('No reviews to export', 'info'); return; }
    exportCSV(rows, `feedback_${toISODate()}.csv`);
    toast('Reviews exported', 'success');
  });
  $('#clearFeedbackBtn')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Clear the inbox',
      message: 'Delete every review stored on this device? Export them first if you still need them — there is no backup.',
      confirmText: 'Clear',
      danger: true,
    });
    if (!ok) return;
    await clearFeedback();
    await renderFeedbackInbox();
    toast('Inbox cleared', 'success');
  });

  // Console settings
  $('#adminPassSaveBtn')?.addEventListener('click', async () => {
    const next = $('#adminNewPass')?.value || '';
    const again = $('#adminNewPass2')?.value || '';
    if (next.length < 4) { toast('Use at least 4 characters', 'error'); return; }
    if (next !== again) { toast('The two passcodes do not match', 'error'); return; }
    await setSetting(AUTH_KEY, { hash: hashPasscode(next), changedAt: new Date().toISOString() });
    const a = $('#adminNewPass'); const b = $('#adminNewPass2');
    if (a) a.value = '';
    if (b) b.value = '';
    await renderDefaultHint();
    toast('Passcode updated', 'success');
  });
  $('#adminResetBtn')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Clear console data',
      message: 'Forget the issued-key ledger and the admin passcode, returning the console to its default passcode? The app data and the active licence are not touched.',
      confirmText: 'Clear console data',
      danger: true,
    });
    if (!ok) return;
    await saveIssuedKeys([]);
    await setSetting(AUTH_KEY, null);
    await refreshAll();
    await renderDefaultHint();
    toast('Console data cleared', 'success');
  });
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message, 'success');
  } catch {
    toast('Clipboard is not available here', 'error');
  }
}

/**
 * The unlock screen shows the default passcode ONLY while it is still the
 * default. Printing it after the owner has changed it would defeat the gate;
 * hiding it before would lock a first-time operator out of their own console.
 */
async function renderDefaultHint() {
  const hint = $('#adminDefaultHint');
  if (!hint) return;
  const isDefault = await isDefaultPasscode();
  hint.textContent = isDefault
    ? `Default passcode: ${adminConfig().defaultPasscode} — change it below once you are in.`
    : 'Passcode set by the operator.';
}

async function init() {
  await initShell();
  await loadLicense();

  const dateInput = $('#keyDate');
  if (dateInput) dateInput.value = toISODate();

  const planSelect = $('#keyPlanSelect');
  if (planSelect) {
    planSelect.innerHTML = Object.values(CONFIG.plans || {})
      .map((p) => `<option value="${escapeHTML(p.id)}" ${p.id === 'pro' ? 'selected' : ''}>${escapeHTML(p.name)}</option>`)
      .join('');
  }

  bindEvents();
  await renderDefaultHint();

  if (sessionUnlocked()) await showPanel();
  else showGate();

  // Readiness flag, matching the other pages, so browser suites can wait for it.
  window.__ADMIN_READY__ = true;
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((err) => {
    console.error('Admin init failed:', err);
    toast('Failed to initialize: ' + err.message, 'error', 6000);
  });
});

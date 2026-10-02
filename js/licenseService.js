/**
 * ============================================================================
 *  LICENSE SERVICE — plan tiers, usage limits and upgrade prompts
 * ============================================================================
 *
 *  Three tiers (`free`, `pro`, `enterprise`) defined in js/app.config.js. This
 *  module is the only place that decides what a tier may do.
 *
 *  ---------------------------------------------------------------------------
 *  BE HONEST ABOUT WHAT THIS IS
 *  ---------------------------------------------------------------------------
 *  This is a purely client-side gate in an offline app. Anyone with the source
 *  can open devtools and flip `plan` to `enterprise` in one line. It is a
 *  business nudge — it makes the paid tiers discoverable and stops casual
 *  over-use — NOT a security boundary.
 *
 *  Real enforcement has to happen where the user cannot reach it: the server
 *  that issues the licence key, or the backend the cloud-sync adapter talks to
 *  (`js/storageService.js`). `verifyLicenseKey()` below is deliberately a
 *  format/checksum check, not a signature check, and is documented as such so
 *  nobody mistakes it for protection.
 *
 *  ---------------------------------------------------------------------------
 *  USAGE IS DERIVED, NOT COUNTED
 *  ---------------------------------------------------------------------------
 *  The free-tier ceiling is computed from the invoices that actually exist in
 *  the current calendar month rather than from a separate counter. A counter
 *  drifts: it double-counts when a save is retried, it survives a restore that
 *  should have reset it, and it silently disagrees with what the user can see.
 */

import { CONFIG, getPlan, planHasFeature, defaultPlanId } from './config.js';
import { getSetting, setSetting, getInvoices } from './storageService.js';

const LICENSE_SETTING_KEY = 'license';

/* ==========================================================================
   Pure helpers — exported so they can be unit-tested without a browser
   ========================================================================== */

/** `'2026-09'` for a Date, timestamp or ISO string. `''` when unparseable. */
export function toMonthKey(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
  }
  if (typeof value === 'number') return toMonthKey(new Date(value));
  const text = String(value);
  // ISO-ish strings ('2026-09-29', '2026-09-29T…') slice cleanly.
  const m = text.match(/^(\d{4})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : toMonthKey(parsed);
}

/** The month an invoice belongs to for quota purposes. */
export function invoiceMonthKey(invoice) {
  if (!invoice) return '';
  return toMonthKey(invoice.createdAt) || toMonthKey(invoice.issueDate);
}

/** How many invoices count against the quota for `monthKey`. */
export function countInvoicesInMonth(invoices, monthKey) {
  if (!Array.isArray(invoices)) return 0;
  return invoices.filter((inv) => invoiceMonthKey(inv) === monthKey).length;
}

/**
 * Decide whether another invoice may be created.
 * Pure — takes the invoice list, returns a plain object. No I/O, no throwing.
 */
export function evaluateQuota({ invoices = [], planId = defaultPlanId(), now = new Date() } = {}) {
  const plan = getPlan(planId) || getPlan(defaultPlanId());
  const limit = plan?.invoiceLimitPerMonth ?? null;
  const month = toMonthKey(now);
  const used = countInvoicesInMonth(invoices, month);
  const unlimited = limit === null || limit === undefined;

  return {
    planId: plan?.id || 'free',
    planName: plan?.name || 'Free',
    month,
    used,
    limit,
    unlimited,
    remaining: unlimited ? Infinity : Math.max(0, limit - used),
    allowed: unlimited || used < limit,
  };
}

/* ==========================================================================
   Licence keys
   ==========================================================================
   Format:  SIP-<PLAN>-<YYYYMMDD>-<CHECKSUM>
   Example: SIP-PRO-20260929-4F2A

   The checksum catches typos and obviously-invented keys. It is NOT a
   signature: it can be reproduced by anyone reading this file. Treat a
   verified key as "the user typed something plausible", nothing more.
   ========================================================================== */

const KEY_PATTERN = /^SIP-(FREE|PRO|ENTERPRISE)-(\d{8})-([0-9A-F]{4})$/;

export function licenseChecksum(plan, date) {
  const seed = `sip|${plan}|${date}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).toUpperCase().padStart(4, '0').slice(-4);
}

export function verifyLicenseKey(key) {
  const normalised = String(key || '').trim().toUpperCase();
  const match = normalised.match(KEY_PATTERN);
  if (!match) return { valid: false, reason: 'Unrecognised key format' };

  const [, planToken, dateToken, checksum] = match;
  if (licenseChecksum(planToken, dateToken) !== checksum) {
    return { valid: false, reason: 'Key failed its checksum' };
  }
  const planId = planToken.toLowerCase();
  if (!CONFIG.plans?.[planId]) return { valid: false, reason: 'Unknown plan in key' };

  return { valid: true, planId, issuedAt: dateToken };
}

/** Build a key. Exported for the test suite and for issuing keys by hand. */
export function makeLicenseKey(planId, date = new Date()) {
  const plan = String(planId || 'pro').toUpperCase();
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return `SIP-${plan}-${stamp}-${licenseChecksum(plan, stamp)}`;
}

/* ==========================================================================
   State
   ========================================================================== */

let state = {
  plan: defaultPlanId(),
  licenseKey: '',
  activatedAt: null,
  activatedBy: 'default',
};

/** Load the persisted licence. Never throws; falls back to the default plan. */
export async function loadLicense() {
  try {
    const stored = await getSetting(LICENSE_SETTING_KEY, null);
    if (stored && typeof stored === 'object') {
      const planId = CONFIG.plans?.[stored.plan] ? stored.plan : defaultPlanId();
      state = {
        plan: planId,
        licenseKey: typeof stored.licenseKey === 'string' ? stored.licenseKey : '',
        activatedAt: stored.activatedAt || null,
        activatedBy: stored.activatedBy || 'stored',
      };
    }
  } catch {
    /* storage unavailable — stay on the default plan */
  }
  return state;
}

export function getLicense() {
  return { ...state };
}

export function currentPlanId() {
  return state.plan;
}

export function currentPlan() {
  return getPlan(state.plan);
}

/** Whether the active plan includes a feature id from config. */
export function hasFeature(feature) {
  return planHasFeature(state.plan, feature);
}

export function isPaid() {
  return state.plan !== 'free';
}

/**
 * Activate a plan.
 * @param {string} planId
 * @param {object} [opts] - `{ licenseKey }` required for anything but `free`.
 */
export async function setPlan(planId, opts = {}) {
  if (!CONFIG.plans?.[planId]) {
    return { ok: false, reason: `Unknown plan "${planId}"` };
  }

  if (planId !== 'free') {
    const key = opts.licenseKey ?? state.licenseKey;
    const check = verifyLicenseKey(key);
    if (!check.valid) return { ok: false, reason: check.reason };
    if (check.planId !== planId) {
      return { ok: false, reason: `That key is for the ${check.planId} plan` };
    }
    state.licenseKey = String(key).trim().toUpperCase();
  } else {
    state.licenseKey = '';
  }

  state = {
    ...state,
    plan: planId,
    activatedAt: new Date().toISOString(),
    activatedBy: opts.activatedBy || 'user',
  };

  try {
    await setSetting(LICENSE_SETTING_KEY, state);
  } catch {
    /* in-memory state still applies for this session */
  }
  return { ok: true, plan: planId };
}

/** Return to the free tier (used by "reset all data"). */
export async function resetLicense() {
  state = { plan: defaultPlanId(), licenseKey: '', activatedAt: null, activatedBy: 'reset' };
  try {
    await setSetting(LICENSE_SETTING_KEY, state);
  } catch {
    /* ignore */
  }
  return state;
}

/* ==========================================================================
   Quota checks against live data
   ========================================================================== */

/** Evaluate the quota using the invoices currently in storage. */
export async function checkInvoiceQuota(now = new Date()) {
  let invoices = [];
  try {
    invoices = await getInvoices();
  } catch {
    // If the invoice list cannot be read we must not block the user.
    return { ...evaluateQuota({ invoices: [], planId: state.plan, now }), unknown: true };
  }
  return evaluateQuota({ invoices, planId: state.plan, now });
}

/** Convenience predicate for callers that only need a yes/no. */
export async function canCreateInvoice(now = new Date()) {
  return (await checkInvoiceQuota(now)).allowed;
}

/** Feature-gate helper that also reports the plan needed to unlock. */
export function requireFeature(feature) {
  const allowed = hasFeature(feature);
  return {
    allowed,
    feature,
    planId: state.plan,
    reason: allowed ? null : `"${feature}" is not included in the ${currentPlan()?.name || state.plan} plan`,
  };
}

/* ==========================================================================
   Feature labels and the shared UI gate
   ==========================================================================
   The label map lives here, next to the plan definitions, because two very
   different screens need it: the plan cards in Settings → Subscription (what a
   plan *includes*) and the upgrade prompt (what a locked control *needs*).
   Keeping one map is what stops "Custom brand colours" on a card and
   "brand-customisation" in a dialog from being the same feature.
   ========================================================================== */

export const FEATURE_LABELS = {
  invoices: 'Unlimited invoicing',
  customers: 'Customer records',
  products: 'Product & stock records',
  reports: 'Business reports',
  'pdf-export': 'PDF export',
  'csv-export': 'CSV export',
  'whatsapp-share': 'WhatsApp sharing',
  'brand-customisation': 'Custom brand colours',
  'custom-app-name': 'Renaming the app',
  'signature-stamp': 'Digital signature & stamp',
  'monthly-report': 'Monthly report download',
  'no-watermark': 'No watermark',
  'priority-support': 'Priority support',
  'cloud-sync': 'Cloud sync',
  'multi-user': 'Multiple users',
  'multi-branch': 'Multiple branches',
  'api-access': 'API access',
};

/** The sentence shown when a locked control is pressed. */
export function featureGateMessage(feature) {
  return `${FEATURE_LABELS[feature] || feature} is available on Pro and above.`;
}

/**
 * Gate a UI action behind a feature id.
 *
 * Every lock in the app goes through here so the wording, the modal and the
 * "which plan unlocks this" answer are identical no matter which control the
 * user happened to press. Callers get a plain boolean, so the guard reads as
 * `if (!(await gateFeature('x'))) return;` and cannot be half-applied.
 *
 * @returns {Promise<boolean>} `true` when the action may proceed.
 */
export async function gateFeature(feature) {
  if (hasFeature(feature)) return true;
  await showUpgradeModal(null, { reason: featureGateMessage(feature) });
  return false;
}

/* ==========================================================================
   Presentation
   ========================================================================== */

/**
 * The upgrade prompt.
 *
 * Built entirely in JS rather than as markup in each page: the gate fires from
 * whichever page the user happens to be on, and duplicating a modal across six
 * HTML files is how they drift out of sync.
 *
 * `openModal`/`toast` are imported lazily so this module stays importable from
 * Node tests, where there is no DOM.
 */
export async function showUpgradeModal(quota, { reason } = {}) {
  const { openModal, escapeHTML } = await import('./utils.js');

  const plans = Object.values(CONFIG.plans || {});
  const paid = plans.filter((p) => p.id !== 'free');

  const priceLabel = (plan) => {
    if (plan.price === null || plan.price === undefined) return 'Contact us';
    if (plan.price === 0) return 'Free';
    return `${plan.currency} ${Number(plan.price).toLocaleString()}/${plan.period || 'month'}`;
  };

  const planCards = paid.map((plan) => `
    <div class="card" style="padding:16px;margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px">
        <strong>${escapeHTML(plan.name)}</strong>
        <span class="chip">${escapeHTML(priceLabel(plan))}</span>
      </div>
      <div class="text-muted" style="font-size:0.85rem">
        ${plan.invoiceLimitPerMonth === null ? 'Unlimited invoices' : `${plan.invoiceLimitPerMonth} invoices / month`}
      </div>
      <ul class="upgrade-features">
        ${(plan.features || [])
          .filter((f) => CONFIG.paidFeatures?.includes(f))
          .slice(0, 5)
          .map((f) => `<li>${escapeHTML(FEATURE_LABELS[f] || f)}</li>`)
          .join('')}
      </ul>
    </div>`).join('');

  const quotaLine = quota && !quota.unlimited
    ? `<p class="text-muted">You have used <strong>${quota.used}</strong> of <strong>${quota.limit}</strong> invoices included in the ${escapeHTML(quota.planName)} plan this month.</p>`
    : `<p class="text-muted">${escapeHTML(reason || 'This feature is not available on your current plan.')}</p>`;

  return new Promise((resolve) => {
    openModal({
      title: 'Upgrade your plan',
      body: `
        ${quotaLine}
        <p class="text-muted" style="margin:12px 0 16px">Upgrade to keep invoicing without limits.</p>
        ${planCards}
        <p class="text-muted" style="font-size:0.8rem">
          Payment gateways (AzamPay, Selcom) are configured under
          <strong>Settings → Subscription</strong>.
        </p>`,
      footer: `
        <button class="btn btn-outline" data-action="dismiss">Not now</button>
        <a class="btn btn-primary" href="settings.html#subscription">View plans</a>`,
      onOpen: (ov) => {
        ov.querySelector('[data-action="dismiss"]')?.addEventListener('click', () => {
          ov.remove();
          resolve(false);
        });
      },
    });
  });
}

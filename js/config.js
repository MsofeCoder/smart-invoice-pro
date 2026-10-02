/**
 * Config access for ES modules.
 *
 * `js/app.config.js` is a classic script — it has to be, so the render-blocking
 * `brand-boot.js` can read the defaults before the first paint. Modules import
 * from here rather than reaching for `window.APP_CONFIG` directly, which keeps
 * one implementation of the storage-key helpers and one place to document the
 * load order.
 *
 * Load order in every page's <head>:
 *   css/styles.css → js/app.config.js → js/brand-boot.js
 *
 * DELIBERATELY RESILIENT: if `app.config.js` is missing this module falls back
 * to empty defaults and reports `CONFIG_LOADED === false` instead of throwing.
 * This app is an offline PWA — a missing <script> must degrade to a usable
 * app, not a white screen. `scripts/test-markup.js` asserts the tag is present
 * on every page, so the mistake is still caught, at build time rather than at
 * runtime.
 */

const raw = globalThis.APP_CONFIG;
const helpers = globalThis.AppConfig;

/** False when js/app.config.js did not run (missing <script>, or a Node test). */
export const CONFIG_LOADED = Boolean(raw && helpers);

/** Frozen configuration object. Empty when the config did not load. */
export const CONFIG = raw || {};

/* ---------------------------------------------------------------------------
   Storage helpers. Re-implemented locally when the config script is absent so
   modules never have to branch on CONFIG_LOADED just to read a theme.
--------------------------------------------------------------------------- */

const FALLBACK_PREFIX = 'app_';

export function storageKey(name) {
  return helpers ? helpers.storageKey(name) : FALLBACK_PREFIX + name;
}

export function readStorage(name) {
  if (helpers) return helpers.readStorage(name);
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(storageKey(name));
  } catch {
    return null;
  }
}

export function writeStorage(name, value) {
  if (helpers) return helpers.writeStorage(name, value);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(storageKey(name), value);
    return true;
  } catch {
    return false;
  }
}

export function removeStorage(name) {
  if (helpers) return helpers.removeStorage(name);
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(storageKey(name));
  } catch {
    /* storage blocked */
  }
}

export function getPlan(id) {
  if (helpers) return helpers.getPlan(id);
  const plans = CONFIG.plans || {};
  // Mirrors app.config.js: an unknown plan id resolves to the default plan
  // rather than null, so callers never have to null-check. The two paths have
  // to agree, or behaviour would change depending on whether the config script
  // loaded — which is exactly the kind of difference nobody tests for.
  return plans[id] || plans[CONFIG.defaultPlan] || null;
}

export function planHasFeature(planId, feature) {
  if (helpers) return helpers.planHasFeature(planId, feature);
  const plan = getPlan(planId);
  return Boolean(plan && (plan.features || []).includes(feature));
}

/* ---------------------------------------------------------------------------
   Convenience readers. Each one carries its own default so a malformed or
   missing config can never take the app down.
--------------------------------------------------------------------------- */

export function appName() {
  return CONFIG.appName || 'Invoice App';
}

export function appTagline() {
  return CONFIG.tagline || 'Business Invoicing';
}

export function appDescription() {
  return CONFIG.description || 'Offline invoicing and business management.';
}

export function appSlug() {
  return CONFIG.slug || 'invoice-app';
}

export function defaultCurrencyCode() {
  return CONFIG.defaultCurrency || 'TZS';
}

export function defaultTaxRate() {
  const n = Number(CONFIG.defaultTaxRate);
  return Number.isFinite(n) ? n : 0;
}

export function allowWhiteLabel() {
  return CONFIG.allowWhiteLabel !== false;
}

export function fallbackBusinessName() {
  return CONFIG.fallbackBusinessName || 'Your Business Name';
}

/** Plan ids in display order, always including the default plan. */
export function planList() {
  const plans = CONFIG.plans || {};
  const ids = Object.keys(plans);
  return ids.length ? ids.map((id) => plans[id]) : [];
}

export function defaultPlanId() {
  return CONFIG.defaultPlan || 'free';
}

export function paymentGateways() {
  return Array.isArray(CONFIG.paymentGateways) ? CONFIG.paymentGateways : [];
}

/** Feature ids gated behind a paid plan. Empty when the config did not load. */
export function paidFeatureList() {
  return Array.isArray(CONFIG.paidFeatures) ? CONFIG.paidFeatures : [];
}

/** Admin-console settings. Mirrors the defaults in js/app.config.js. */
export function adminConfig() {
  if (helpers && typeof helpers.adminConfig === 'function') return helpers.adminConfig();
  return CONFIG.admin || { defaultPasscode: 'admin123', maxKeysPerBatch: 50, feedbackWarnThreshold: 25 };
}

/** Feedback settings. Mirrors the defaults in js/app.config.js. */
export function feedbackConfig() {
  if (helpers && typeof helpers.feedbackConfig === 'function') return helpers.feedbackConfig();
  return CONFIG.feedback || { email: '', whatsapp: '', promptAfterInvoices: 3, categories: ['General', 'Other'] };
}

export function whatsappConfig() {
  return CONFIG.whatsapp || { countryCode: '255', defaultMessage: '' };
}

export function pdfGeometry() {
  return CONFIG.pdf || { pageSize: 'a4', orientation: 'portrait', unit: 'mm', margin: 14, logoSize: 22 };
}

export function syncConfig() {
  return CONFIG.sync || { adapter: 'local', endpoint: '', apiKey: '', autoSync: false, intervalMs: 30000 };
}

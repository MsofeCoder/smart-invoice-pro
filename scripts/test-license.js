/**
 * Monetization + sharing unit tests
 *
 * Covers the pure, browser-free half of `js/licenseService.js` and `js/share.js`:
 * quota arithmetic, licence-key round-trips, phone normalisation and message
 * templating. These are the parts that decide whether a paying customer is
 * locked out or let in, and whether a WhatsApp link points at the right number,
 * so they are worth pinning down without a browser in the loop.
 *
 * `js/app.config.js` is loaded into `globalThis` first, exactly as a page's
 * <head> would, so the modules under test see the real plans and the real
 * WhatsApp country code rather than their defensive fallbacks.
 *
 * Run: node scripts/test-license.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;

function assert(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name} \u2014 expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

function assertTrue(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${detail ? ' \u2014 ' + detail : ''}`); }
}

/* ---------- Publish the config the way a page's <head> does ---------- */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const win = {};
new Function('window', 'localStorage', fs.readFileSync(path.join(ROOT, 'js', 'app.config.js'), 'utf8'))(
  win,
  globalThis.localStorage,
);
globalThis.APP_CONFIG = win.APP_CONFIG;
globalThis.AppConfig = win.AppConfig;

const CFG = win.APP_CONFIG;

/* Dynamic imports: config.js reads globalThis.APP_CONFIG when it is evaluated,
   so the globals must already be in place. */
const url = (rel) => pathToFileURL(path.join(ROOT, 'js', rel)).href;
const {
  toMonthKey, invoiceMonthKey, countInvoicesInMonth, evaluateQuota,
  licenseChecksum, verifyLicenseKey, makeLicenseKey,
  getLicense, currentPlanId, hasFeature, isPaid,
} = await import(url('licenseService.js'));
const {
  normalisePhone, buildMessage, invoiceMessage, whatsappUrl, pdfFilename, canShareFiles,
} = await import(url('share.js'));

/* ==========================================================================
   1. Month keys
   ========================================================================== */

console.log('== toMonthKey ==');
assert('Date -> YYYY-MM', toMonthKey(new Date(2026, 8, 29)), '2026-09');
assert('single-digit month is padded', toMonthKey(new Date(2026, 0, 5)), '2026-01');
assert('ISO date string', toMonthKey('2026-09-29'), '2026-09');
assert('ISO datetime string', toMonthKey('2026-09-29T14:03:00.000Z'), '2026-09');
assert('timestamp number', toMonthKey(new Date(2026, 8, 29).getTime()), '2026-09');
assert('empty string', toMonthKey(''), '');
assert('null', toMonthKey(null), '');
assert('undefined', toMonthKey(undefined), '');
assert('garbage', toMonthKey('not-a-date'), '');
assert('invalid Date', toMonthKey(new Date('nope')), '');

console.log('\n== invoiceMonthKey ==');
assert('prefers createdAt', invoiceMonthKey({ createdAt: '2026-09-01', issueDate: '2026-08-01' }), '2026-09');
assert('falls back to issueDate', invoiceMonthKey({ issueDate: '2026-08-01' }), '2026-08');
assert('createdAt present but unparseable falls back', invoiceMonthKey({ createdAt: 'x', issueDate: '2026-07-02' }), '2026-07');
assert('null invoice', invoiceMonthKey(null), '');
assert('empty invoice', invoiceMonthKey({}), '');

console.log('\n== countInvoicesInMonth ==');
const INVOICES = [
  { createdAt: '2026-09-01T08:00:00Z' },
  { createdAt: '2026-09-30T23:00:00Z' },
  { createdAt: '2026-08-31T23:59:00Z' },
  { issueDate: '2026-09-15' },
  {},
];
assert('counts September', countInvoicesInMonth(INVOICES, '2026-09'), 3);
assert('counts August', countInvoicesInMonth(INVOICES, '2026-08'), 1);
assert('no matches', countInvoicesInMonth(INVOICES, '2026-01'), 0);
assert('non-array is safe', countInvoicesInMonth(null, '2026-09'), 0);

/* ==========================================================================
   2. Quota evaluation
   ========================================================================== */

console.log('\n== evaluateQuota (free plan, limit 10) ==');
const NOW = new Date(2026, 8, 15); // 2026-09-15
const sep = (n) => Array.from({ length: n }, (_, i) => ({ createdAt: `2026-09-${String(i + 1).padStart(2, '0')}` }));

let q = evaluateQuota({ invoices: [], planId: 'free', now: NOW });
assert('plan id', q.planId, 'free');
assert('month', q.month, '2026-09');
assert('limit', q.limit, 10);
assert('used', q.used, 0);
assert('remaining', q.remaining, 10);
assert('allowed with none used', q.allowed, true);

q = evaluateQuota({ invoices: sep(9), planId: 'free', now: NOW });
assert('allowed at 9 of 10', q.allowed, true);
assert('remaining at 9 of 10', q.remaining, 1);

q = evaluateQuota({ invoices: sep(10), planId: 'free', now: NOW });
assert('blocked at exactly 10', q.allowed, false);
assert('remaining floors at 0', q.remaining, 0);

q = evaluateQuota({ invoices: sep(14), planId: 'free', now: NOW });
assert('blocked past the limit', q.allowed, false);
assert('remaining never goes negative', q.remaining, 0);

console.log('\n== evaluateQuota (pro plan, unlimited) ==');
q = evaluateQuota({ invoices: sep(99), planId: 'pro', now: NOW });
assert('pro plan id', q.planId, 'pro');
assert('pro limit is null', q.limit, null);
assert('pro is unlimited', q.unlimited, true);
assert('pro always allowed', q.allowed, true);
assert('pro remaining is Infinity', q.remaining, Infinity);

console.log('\n== evaluateQuota (edge cases) ==');
q = evaluateQuota({ invoices: sep(10), planId: 'free', now: new Date(2026, 9, 1) });
assert('quota resets in a new month', q.allowed, true);
assert('new month counts zero', q.used, 0);

q = evaluateQuota({ invoices: sep(10), planId: 'platinum', now: NOW });
assert('unknown plan falls back to the default plan', q.planId, 'free');
assert('unknown plan still enforces the free limit', q.allowed, false);

q = evaluateQuota();
assert('no arguments is safe', q.allowed, true);
assert('defaults to the free plan', q.planId, 'free');

/* ==========================================================================
   3. Licence keys
   ========================================================================== */

console.log('\n== Licence key round-trip ==');
const ISSUED = new Date(2026, 8, 29);
for (const planId of ['free', 'pro', 'enterprise']) {
  const key = makeLicenseKey(planId, ISSUED);
  const check = verifyLicenseKey(key);
  assertTrue(`${planId}: key verifies`, check.valid === true, check.reason);
  assert(`${planId}: key resolves to the plan`, check.planId, planId);
  assert(`${planId}: key carries the issue date`, check.issuedAt, '20260929');
}
assertTrue('key shape is SIP-<PLAN>-<YYYYMMDD>-<CHECKSUM>', /^SIP-PRO-\d{8}-[0-9A-F]{4}$/.test(makeLicenseKey('pro', ISSUED)), makeLicenseKey('pro', ISSUED));

console.log('\n== Licence key rejection ==');
assert('empty key', verifyLicenseKey('').valid, false);
assert('null key', verifyLicenseKey(null).valid, false);
assert('wrong prefix', verifyLicenseKey('XYZ-PRO-20260929-1234').valid, false);
assert('unknown plan token', verifyLicenseKey('SIP-GOLD-20260929-1234').valid, false);
assert('short date', verifyLicenseKey('SIP-PRO-260929-1234').valid, false);
assert('short checksum', verifyLicenseKey('SIP-PRO-20260929-12').valid, false);
const goodKey = makeLicenseKey('pro', ISSUED);
const tampered = goodKey.slice(0, -4) + (goodKey.endsWith('0000') ? '1111' : '0000');
assert('tampered checksum is rejected', verifyLicenseKey(tampered).valid, false);
assertTrue('rejection carries a reason', typeof verifyLicenseKey('nope').reason === 'string' && verifyLicenseKey('nope').reason.length > 0);
assertTrue('lowercase input is normalised', verifyLicenseKey(goodKey.toLowerCase()).valid === true);
assertTrue('surrounding whitespace is tolerated', verifyLicenseKey(`  ${goodKey}  `).valid === true);

console.log('\n== Checksum ==');
assert('checksum is 4 hex chars', /^[0-9A-F]{4}$/.test(licenseChecksum('PRO', '20260929')), true);
assert('checksum is deterministic', licenseChecksum('PRO', '20260929'), licenseChecksum('PRO', '20260929'));
assertTrue('checksum varies with the plan', licenseChecksum('PRO', '20260929') !== licenseChecksum('FREE', '20260929'));
assertTrue('checksum varies with the date', licenseChecksum('PRO', '20260929') !== licenseChecksum('PRO', '20260930'));

console.log('\n== Default licence state (nothing activated) ==');
assert('starts on the default plan', currentPlanId(), CFG.defaultPlan);
assert('is not paid', isPaid(), false);
assertTrue('free includes invoicing', hasFeature('invoices'));
assertTrue('free excludes brand customisation', !hasFeature('brand-customisation'));
assertTrue('getLicense returns a copy, not the live object', getLicense() !== getLicense());
assertTrue('a key is NOT trusted without activation', getLicense().licenseKey === '', getLicense().licenseKey);

/* ==========================================================================
   4. Phone normalisation
   ========================================================================== */

console.log('\n== normalisePhone (country code 255) ==');
assert('already international', normalisePhone('255712345678'), '255712345678');
assert('plus-prefixed', normalisePhone('+255712345678'), '255712345678');
assert('plus with spaces', normalisePhone('+255 712 345 678'), '255712345678');
assert('leading 00', normalisePhone('00255712345678'), '255712345678');
assert('local trunk 0', normalisePhone('0712345678'), '255712345678');
assert('bare national number', normalisePhone('712345678'), '255712345678');
assert('hyphens and parens are stripped', normalisePhone('0712-345-678'), '255712345678');
assert('empty string', normalisePhone(''), '');
assert('null', normalisePhone(null), '');
assert('undefined', normalisePhone(undefined), '');
assert('no digits at all', normalisePhone('call me'), '');
assert('multiple leading zeros collapse', normalisePhone('000712345678'), '255712345678');

console.log('\n== normalisePhone (other country codes) ==');
assert('Kenya from a local number', normalisePhone('0712345678', '254'), '254712345678');
assert('Kenya already international', normalisePhone('+254712345678', '254'), '254712345678');
assert('a foreign number is left intact', normalisePhone('+447700900123', '255'), '447700900123');

/* ==========================================================================
   5. Messages
   ========================================================================== */

console.log('\n== buildMessage ==');
assert('fills a placeholder', buildMessage('Hi {customer}', { customer: 'Asha' }), 'Hi Asha');
assert('fills several placeholders', buildMessage('{a}-{b}', { a: '1', b: '2' }), '1-2');
assert('unknown placeholders are left visible', buildMessage('Hi {nobody}', { customer: 'x' }), 'Hi {nobody}');
assert('empty template', buildMessage('', { a: 1 }), '');
assert('null template', buildMessage(null, {}), '');
assert('null value renders empty', buildMessage('[{a}]', { a: null }), '[]');
assert('numeric value', buildMessage('{n}', { n: 42 }), '42');

console.log('\n== invoiceMessage ==');
const invoice = { number: 'INV-0007', customerName: 'Asha Juma', customerPhone: '0712345678', grandTotal: 120000, dueDate: '2026-10-15' };
const company = { businessName: 'Kilimo Bora Ltd' };
const currency = { code: 'TZS', symbol: 'TZS', decimals: 2 };
const msg = invoiceMessage(invoice, company, currency);
assertTrue('mentions the customer', msg.includes('Asha Juma'), msg);
assertTrue('mentions the invoice number', msg.includes('INV-0007'), msg);
assertTrue('mentions the business', msg.includes('Kilimo Bora Ltd'), msg);
assertTrue('mentions the currency code', msg.includes('TZS'), msg);
assertTrue('mentions the amount', msg.includes('120,000.00'), msg);
assertTrue('mentions the due date', msg.includes('2026-10-15'), msg);
assertTrue('leaves no unfilled placeholders', !/\{[a-z]+\}/.test(msg), msg);

assertTrue('a custom template wins', invoiceMessage(invoice, company, currency, { template: 'Pay {total} now' }).startsWith('Pay '), invoiceMessage(invoice, company, currency, { template: 'Pay {total} now' }));
assertTrue('a missing business falls back to config', invoiceMessage(invoice, {}, currency).includes(CFG.fallbackBusinessName));
assertTrue('a missing customer name degrades gracefully', invoiceMessage({}, company, currency).includes('there'));
assertTrue('a missing total does not throw', typeof invoiceMessage({}, {}, {}) === 'string');

/* ==========================================================================
   6. WhatsApp URLs
   ========================================================================== */

console.log('\n== whatsappUrl ==');
const link = whatsappUrl('0712345678', 'Hello there');
assertTrue('points at wa.me with the normalised number', link.startsWith('https://wa.me/255712345678?text='), link);
assertTrue('encodes the message', link.includes(encodeURIComponent('Hello there')), link);
assertTrue('encodes newlines', whatsappUrl('0712345678', 'a\nb').includes('%0A'));
assertTrue('no number still produces a usable link', whatsappUrl('', 'hi').startsWith('https://wa.me/?text='), whatsappUrl('', 'hi'));

/* ==========================================================================
   7. PDF filename + share capability
   ========================================================================== */

console.log('\n== pdfFilename ==');
assert('invoice number', pdfFilename({ number: 'INV-0007' }), 'INV-0007.pdf');
assert('path separators are neutralised', pdfFilename({ number: 'a/b' }), 'a_b.pdf');
assert('spaces are neutralised', pdfFilename({ number: 'INV 0007' }), 'INV_0007.pdf');
assert('missing number', pdfFilename({}), 'invoice.pdf');
assert('null invoice', pdfFilename(null), 'invoice.pdf');

console.log('\n== canShareFiles (no navigator in Node) ==');
assert('is false without a navigator', canShareFiles({}), false);

/* ==========================================================================
   Result
   ========================================================================== */

console.log(`\n${'-'.repeat(52)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log(`${'-'.repeat(52)}\n`);
process.exit(fail ? 1 : 0);

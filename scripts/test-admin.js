/**
 * Admin console + feedback unit tests
 *
 * The browser-free half of the two newest features: the activation-key ledger
 * (`js/adminKeys.js`) and the review form's pure helpers (`js/feedback.js`).
 *
 * Both are worth pinning down without a browser in the loop, because both
 * decide something the user cannot see going wrong:
 *
 *   - Two customers handed the SAME activation key is invisible on screen and
 *     only surfaces as a support call. `buildKeyBatch()` is the one function
 *     that can cause it, so it is tested hardest here.
 *   - A review's rating is stored as typed and rendered as stars; a rating that
 *     survives one and not the other shows a customer a review they did not
 *     write.
 *
 * `js/app.config.js` is loaded into `globalThis` first, exactly as a page's
 * <head> would, so the modules under test see the real plans rather than their
 * defensive fallbacks.
 *
 * Run: node scripts/test-admin.js
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

const url = (rel) => pathToFileURL(path.join(ROOT, 'js', rel)).href;
const {
  hashPasscode, sortKeys, keyStatus, keyStamp, stampToISODate,
  buildKeyBatch, inspectKey, keysToRows, feedbackToRows,
} = await import(url('adminKeys.js'));
const { verifyLicenseKey, makeLicenseKey } = await import(url('licenseService.js'));
const {
  normaliseRating, summariseFeedback, buildFeedbackMessage,
  feedbackMailtoUrl, feedbackWhatsappUrl, RATING_LABELS,
} = await import(url('feedback.js'));

/* ==========================================================================
   1. Passcode hashing
   ========================================================================== */

console.log('== hashPasscode ==');
const h = hashPasscode('admin123');
assertTrue('produces 8 hex characters', /^[0-9a-f]{8}$/.test(h), h);
assert('is deterministic', hashPasscode('admin123'), h);
assertTrue('varies with the passcode', hashPasscode('admin124') !== h);
assertTrue('never returns the plaintext', h !== 'admin123');
assert('empty string is safe', typeof hashPasscode(''), 'string');
assert('null is safe', typeof hashPasscode(null), 'string');
assert('undefined is safe', typeof hashPasscode(undefined), 'string');
assert('empty and undefined agree', hashPasscode(''), hashPasscode(undefined));
assertTrue('is case sensitive', hashPasscode('Admin123') !== h);
assertTrue('a long passphrase still hashes', /^[0-9a-f]{8}$/.test(hashPasscode('x'.repeat(400))));

/* ==========================================================================
   2. Date stamps
   ========================================================================== */

console.log('\n== keyStamp / stampToISODate ==');
assert('pads month and day', keyStamp(new Date(2026, 9, 2)), '20261002');
assert('double-digit month', keyStamp(new Date(2026, 11, 31)), '20261231');
assert('january first', keyStamp(new Date(2026, 0, 1)), '20260101');
assertTrue('a non-Date falls back to now', /^\d{8}$/.test(keyStamp('nope')));
assertTrue('an invalid Date falls back to now', /^\d{8}$/.test(keyStamp(new Date('nope'))));

assert('stamp to ISO', stampToISODate('20261002'), '2026-10-02');
assert('rejects a short stamp', stampToISODate('2026'), '');
assert('rejects non-digits', stampToISODate('abcdefgh'), '');
assert('null stamp', stampToISODate(null), '');
assert('undefined stamp', stampToISODate(undefined), '');
assert('empty stamp', stampToISODate(''), '');

/* ==========================================================================
   3. Ledger sorting and status
   ========================================================================== */

console.log('\n== sortKeys ==');
const ENTRIES = [
  { key: 'A', createdAt: '2026-10-01T10:00:00.000Z' },
  { key: 'C', createdAt: '2026-10-03T10:00:00.000Z' },
  { key: 'B', createdAt: '2026-10-02T10:00:00.000Z' },
];
assert('newest first', sortKeys(ENTRIES).map((e) => e.key).join(''), 'CBA');
assert('does not mutate the input', ENTRIES.map((e) => e.key).join(''), 'ACB');
assert('non-array is safe', sortKeys(null).length, 0);
assert('missing createdAt does not throw', sortKeys([{ key: 'x' }, { key: 'y', createdAt: '2026-01-01' }]).length, 2);

console.log('\n== keyStatus ==');
assert('unused by default', keyStatus({ key: 'SIP-PRO-20261002-AAAA' }, {}).label, 'Unused');
assert('activated when it carries a date',
  keyStatus({ key: 'K', activatedAt: '2026-10-02T00:00:00Z' }, {}).label, 'Activated');
assert('active here when it matches the live licence',
  keyStatus({ key: 'K' }, { licenseKey: 'K' }).label, 'Active here');
// Precedence matters: a key running on this device is a fact, and must not be
// reported as the weaker "Activated" just because both are true.
assert('active here outranks activated',
  keyStatus({ key: 'K', activatedAt: '2026-10-02T00:00:00Z' }, { licenseKey: 'K' }).label, 'Active here');
assert('a different live key does not claim the row',
  keyStatus({ key: 'K' }, { licenseKey: 'OTHER' }).label, 'Unused');
assert('null entry is safe', keyStatus(null, {}).label, 'Unused');
assertTrue('every status carries a badge class', ['badge-green', 'badge-gold', 'badge-gray']
  .includes(keyStatus({ key: 'K' }, {}).cls));

/* ==========================================================================
   4. Key batch generation — the part that must never duplicate
   ========================================================================== */

console.log('\n== buildKeyBatch: shape ==');
const NOW = new Date(2026, 9, 2, 12, 0, 0);
const base = { planId: 'pro', count: 1, date: new Date(2026, 9, 2), note: 'Kilimo Bora', max: 50, now: NOW };

let batch = buildKeyBatch(base);
assert('one key for count 1', batch.length, 1);
assert('plan is echoed', batch[0].plan, 'pro');
assert('issue stamp matches the date', batch[0].issuedAt, '20261002');
assert('note is carried', batch[0].note, 'Kilimo Bora');
assert('createdAt comes from the injected clock', batch[0].createdAt, NOW.toISOString());
assert('a fresh key is not yet activated', batch[0].activatedAt, null);
assertTrue('the key verifies', verifyLicenseKey(batch[0].key).valid === true, batch[0].key);
assert('the key is for the requested plan', verifyLicenseKey(batch[0].key).planId, 'pro');
assert('the key carries the ledger stamp', verifyLicenseKey(batch[0].key).issuedAt, batch[0].issuedAt);

console.log('\n== buildKeyBatch: no duplicates ==');
for (const count of [2, 5, 20, 50]) {
  const many = buildKeyBatch({ ...base, count });
  const keys = many.map((e) => e.key);
  assert(`${count} keys are all distinct`, new Set(keys).size, count);
  assertTrue(`${count} keys all verify`, keys.every((k) => verifyLicenseKey(k).valid), keys.find((k) => !verifyLicenseKey(k).valid) || '');
  assertTrue(`${count} ledger stamps match their keys`,
    many.every((e) => verifyLicenseKey(e.key).issuedAt === e.issuedAt));
}
// The same call twice must not re-mint the first batch's keys.
const first = buildKeyBatch({ ...base, count: 3 });
const second = buildKeyBatch({ ...base, count: 3, existingKeys: first.map((e) => e.key) });
assert('a second batch avoids the first', second.filter((e) => first.some((f) => f.key === e.key)).length, 0);
assertTrue('the second batch is still distinct', new Set(second.map((e) => e.key)).size === 3);

console.log('\n== buildKeyBatch: refusals and clamping ==');
assert('free needs no key', buildKeyBatch({ ...base, planId: 'free' }).length, 0);
assert('an empty plan is refused', buildKeyBatch({ ...base, planId: '' }).length, 0);
assert('a missing plan is refused', buildKeyBatch({ ...base, planId: undefined }).length, 0);
assert('an unknown plan still mints (the key format is the check)', buildKeyBatch({ ...base, planId: 'platinum' }).length, 1);
assertTrue('an unknown plan produces an INVALID key',
  !verifyLicenseKey(buildKeyBatch({ ...base, planId: 'platinum' })[0].key).valid);

assert('count clamps up to 1', buildKeyBatch({ ...base, count: 0 }).length, 1);
assert('a negative count clamps to 1', buildKeyBatch({ ...base, count: -5 }).length, 1);
assert('count clamps down to max', buildKeyBatch({ ...base, count: 999, max: 5 }).length, 5);
assert('a missing max defaults to 50', buildKeyBatch({ ...base, count: 999 }).length, 50);
assert('a fractional count floors', buildKeyBatch({ ...base, count: 3.7 }).length, 3);
assert('a garbage count is treated as 1', buildKeyBatch({ ...base, count: 'lots' }).length, 1);

assertTrue('an invalid date falls back to today',
  /^\d{8}$/.test(buildKeyBatch({ ...base, date: 'nope' })[0].issuedAt));
assertTrue('a missing note becomes an empty string', buildKeyBatch({ ...base, note: undefined })[0].note === '');

console.log('\n== buildKeyBatch: every plan ==');
for (const planId of ['pro', 'enterprise']) {
  const b = buildKeyBatch({ ...base, planId, count: 4 });
  assert(`${planId}: 4 distinct keys`, new Set(b.map((e) => e.key)).size, 4);
  assertTrue(`${planId}: every key resolves to the plan`,
    b.every((e) => verifyLicenseKey(e.key).planId === planId));
  assertTrue(`${planId}: keys look like SIP-<PLAN>-<YYYYMMDD>-<CHECKSUM>`,
    b.every((e) => new RegExp(`^SIP-${planId.toUpperCase()}-\\d{8}-[0-9A-F]{4}$`).test(e.key)), b[0].key);
}

/* ==========================================================================
   5. Key inspection
   ========================================================================== */

console.log('\n== inspectKey ==');
const goodKey = makeLicenseKey('pro', new Date(2026, 9, 2));
const good = inspectKey(goodKey);
assertTrue('a real key is valid', good.valid === true, good.reason);
assert('resolves the plan', good.planId, 'pro');
assert('carries the stamp', good.issuedAt, '20261002');
assert('offers a display date', good.iso, '2026-10-02');

assert('a garbage key is invalid', inspectKey('nope').valid, false);
assert('an empty key is invalid', inspectKey('').valid, false);
assert('null is invalid', inspectKey(null).valid, false);
assertTrue('an invalid key explains why', typeof inspectKey('nope').reason === 'string' && inspectKey('nope').reason.length > 0);
assert('a tampered key is invalid', inspectKey(`${goodKey.slice(0, -4)}0000`).valid, false);
assertTrue('lowercase input still verifies', inspectKey(goodKey.toLowerCase()).valid === true);

/* ==========================================================================
   6. CSV row builders
   ========================================================================== */

console.log('\n== keysToRows ==');
const rows = keysToRows([
  { key: 'SIP-PRO-20261001-AAAA', plan: 'pro', issuedAt: '20261001', createdAt: '2026-10-01T09:00:00Z', note: 'A', activatedAt: null },
  { key: 'SIP-PRO-20261002-BBBB', plan: 'pro', issuedAt: '20261002', createdAt: '2026-10-02T09:00:00Z', note: '', activatedAt: '2026-10-03T09:00:00Z' },
]);
assert('newest row first', rows[0].Key, 'SIP-PRO-20261002-BBBB');
assert('stamp is rendered as a date', rows[0].Issued, '2026-10-02');
assert('an activated key reports Activated', rows[0].Status, 'Activated');
assert('an unused key reports Unused', rows[1].Status, 'Unused');
assert('a carried note survives the export', rows[1].Note, 'A');
// `rows[0]` is the newer of the two and is the one with no note.
assert('a missing note becomes empty', rows[0].Note, '');
assertTrue('the export has a stable header set',
  JSON.stringify(Object.keys(rows[0])) === JSON.stringify(['Key', 'Plan', 'Issued', 'Created', 'Note', 'Status', 'Activated at']));
assert('an empty ledger produces no rows', keysToRows([]).length, 0);
assert('a non-array is safe', keysToRows(null).length, 0);

console.log('\n== feedbackToRows ==');
const fbRows = feedbackToRows([
  { createdAt: '2026-10-02T08:00:00Z', rating: 4, category: 'Feature request', message: 'Bulk reminders', plan: 'free', sentVia: 'whatsapp', device: 'UA' },
  { createdAt: '2026-10-01T08:00:00Z', rating: 0, category: '', message: '', plan: '', sentVia: null, device: '' },
]);
assert('the rating is exported', fbRows[0].Rating, 4);
assert('the topic is exported', fbRows[0].Topic, 'Feature request');
assert('the message is exported', fbRows[0].Feedback, 'Bulk reminders');
assert('how it was sent is exported', fbRows[0]['Sent via'], 'whatsapp');
// An unrated review must export as blank, not as the literal string "0" —
// otherwise an average computed from the CSV reads as a one-star review.
assert('an unrated review exports blank', fbRows[1].Rating, '');
assert('a missing topic is blank', fbRows[1].Topic, '');
assert('a non-array is safe', feedbackToRows(null).length, 0);

/* ==========================================================================
   7. Feedback pure helpers
   ========================================================================== */

console.log('\n== normaliseRating ==');
assert('1', normaliseRating(1), 1);
assert('5', normaliseRating(5), 5);
assert('a numeric string', normaliseRating('4'), 4);
assert('rounds to the nearest star', normaliseRating(3.6), 4);
assert('0 means unrated', normaliseRating(0), 0);
assert('above 5 is rejected', normaliseRating(6), 0);
assert('negative is rejected', normaliseRating(-1), 0);
assert('null', normaliseRating(null), 0);
assert('undefined', normaliseRating(undefined), 0);
assert('garbage', normaliseRating('great'), 0);
assert('NaN', normaliseRating(NaN), 0);

console.log('\n== RATING_LABELS ==');
for (const n of [1, 2, 3, 4, 5]) {
  assertTrue(`star ${n} has a word`, typeof RATING_LABELS[n] === 'string' && RATING_LABELS[n].length > 0);
}
assertTrue('there is no label for an unrated review', !RATING_LABELS[0]);

console.log('\n== summariseFeedback ==');
let s = summariseFeedback([
  { rating: 5, createdAt: '2026-10-01T00:00:00Z' },
  { rating: 3, createdAt: '2026-10-02T00:00:00Z' },
]);
assert('counts every review', s.count, 2);
assert('averages the ratings', s.average, 4);
assert('counts the rated ones', s.rated, 2);
assert('reports the newest date', s.lastAt, '2026-10-02T00:00:00Z');

s = summariseFeedback([{ rating: 5 }, { rating: 0 }]);
assert('an unrated review is not averaged in', s.average, 5);
assert('but it is still counted', s.count, 2);
assert('and is excluded from rated', s.rated, 1);

s = summariseFeedback([]);
assert('an empty list averages to 0', s.average, 0);
assert('an empty list has no last date', s.lastAt, null);
s = summariseFeedback(null);
assert('a non-array is safe', s.count, 0);

// The average is rounded to one decimal so the admin inbox reads "4.3/5" and
// not "4.333333333333333/5".
s = summariseFeedback([{ rating: 4 }, { rating: 4 }, { rating: 5 }]);
assert('the average is rounded to one decimal', s.average, 4.3);

console.log('\n== buildFeedbackMessage ==');
const rec = { rating: 4, category: 'Feature request', message: 'Bulk reminders please', device: 'TestUA/1.0' };
const meta = { appName: 'Smart Invoice Pro', planName: 'Pro', email: '', whatsapp: '' };
const msg = buildFeedbackMessage(rec, meta);
assertTrue('names the app', msg.includes('Smart Invoice Pro'), msg);
assertTrue('leads with the verdict', msg.includes('4/5 — Good'), msg);
assertTrue('includes the topic', msg.includes('Feature request'), msg);
assertTrue('includes the words', msg.includes('Bulk reminders please'), msg);
assertTrue('includes the plan', msg.includes('Plan: Pro'), msg);
assertTrue('includes the device', msg.includes('TestUA/1.0'), msg);
assertTrue('an unrated review says so', buildFeedbackMessage({ message: 'x' }, meta).includes('No rating'));
assertTrue('a missing message still composes', typeof buildFeedbackMessage({ rating: 5 }, meta) === 'string');
assertTrue('no meta at all still composes', typeof buildFeedbackMessage(rec) === 'string');

console.log('\n== feedbackMailtoUrl ==');
const mail = feedbackMailtoUrl(rec, { ...meta, email: 'support@example.com' });
assertTrue('is a mailto link', mail.startsWith('mailto:'), mail.slice(0, 40));
assertTrue('addresses the configured support inbox', mail.includes('support%40example.com'), mail.slice(0, 60));
assertTrue('carries a subject', mail.includes('subject='));
assertTrue('carries the body', mail.includes('body='));
const mailNoTo = feedbackMailtoUrl(rec, meta);
assertTrue('with no configured address the user still gets a usable link',
  mailNoTo.startsWith('mailto:?subject='), mailNoTo.slice(0, 40));

console.log('\n== feedbackWhatsappUrl ==');
const wa = feedbackWhatsappUrl(rec, { ...meta, whatsapp: '255712345678' });
assertTrue('points at wa.me with the vendor number', wa.startsWith('https://wa.me/255712345678?text='), wa.slice(0, 50));
assertTrue('encodes the review', wa.includes(encodeURIComponent('4/5 — Good')), wa.slice(0, 80));
const waNoNumber = feedbackWhatsappUrl(rec, meta);
assertTrue('with no number it opens the contact picker',
  waNoNumber.startsWith('https://wa.me/?text='), waNoNumber.slice(0, 40));
// A locally-formatted vendor number must still reach the right account.
assertTrue('a local vendor number is normalised',
  feedbackWhatsappUrl(rec, { whatsapp: '0712345678' }).startsWith('https://wa.me/255712345678'), '');

/* ==========================================================================
   8. The config the features read
   ========================================================================== */

console.log('\n== config blocks ==');
assertTrue('config declares the feedback block', Boolean(CFG.feedback));
assertTrue('config declares the admin block', Boolean(CFG.admin));
assertTrue('the admin passcode is a non-empty string',
  typeof CFG.admin.defaultPasscode === 'string' && CFG.admin.defaultPasscode.length >= 4);
assertTrue('the batch ceiling is a sane number',
  Number.isInteger(CFG.admin.maxKeysPerBatch) && CFG.admin.maxKeysPerBatch > 0);
assertTrue('feedback categories are a non-empty list',
  Array.isArray(CFG.feedback.categories) && CFG.feedback.categories.length > 0);
assertTrue('the feedback prompt threshold is a number',
  Number.isFinite(CFG.feedback.promptAfterInvoices) && CFG.feedback.promptAfterInvoices > 0);
// Blank by default, deliberately: the template must not ship an invented
// support address that quietly swallows a customer's review.
assert('no support email ships in the template', CFG.feedback.email, '');
assert('no vendor WhatsApp number ships in the template', CFG.feedback.whatsapp, '');
assertTrue('gateways/adminConfig are exposed through AppConfig',
  typeof win.AppConfig.adminConfig === 'function' && typeof win.AppConfig.feedbackConfig === 'function');
assert('AppConfig.adminConfig returns the admin block', win.AppConfig.adminConfig().defaultPasscode, CFG.admin.defaultPasscode);

/* ==========================================================================
   Result
   ========================================================================== */

console.log(`\n${'-'.repeat(52)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log(`${'-'.repeat(52)}\n`);
process.exit(fail ? 1 : 0);

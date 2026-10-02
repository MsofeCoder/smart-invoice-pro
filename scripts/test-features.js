/**
 * Feature suite — plan gates, feedback, inline customers and the admin console.
 *
 * These four features share a failure mode: they break QUIETLY. A gate wired to
 * the wrong control still renders, still saves, and simply never asks anyone to
 * pay. A feedback form that writes to the wrong setting key still shows a
 * thank-you. An admin console that mints the same key twice looks perfect until
 * two customers activate with it.
 *
 * None of that raises an error, so none of it can be caught by reading code.
 * Everything here drives the real app in a real browser.
 *
 * What this covers:
 *   A. Free-plan gates: the app name, the signature/stamp uploaders and the
 *      monthly report download are locked, and pressing one opens the upgrade
 *      prompt. The logo, the Business Name and the daily/weekly/yearly exports
 *      are NOT locked.
 *   B. Pro unlocks all three, and nothing else changes.
 *   C. The feedback form: rating widget, keyboard access, local persistence,
 *      the send stage, and the one-shot dashboard nudge.
 *   D. Inline customer creation: the "+ New" form writes to the customer
 *      database, selects the new record, and a plain invoice save auto-creates
 *      the customer.
 *   E. The admin console: passcode gate, overview, key generation (distinct
 *      keys), verification, activation, the ledger and the feedback inbox.
 *   F. The console stays clean throughout.
 *
 * Run via `npm run test:features`, or `npm run test:e2e` for the whole set.
 */
import { CONFIG, connect, createReporter, sleep } from './lib/cdp.js';

const { origin } = CONFIG;
const r = createReporter('Features');
const { send, evaluate, goto, shot, errors, netFails } = await connect();

/* If a check throws, print what we have before dying.
 *
 * The reporter only writes its summary in `finish()`, so a mid-suite throw —
 * a null element, a page that navigated out from under us — otherwise discards
 * every result gathered up to that point. The first run of this file died on a
 * null lookup in section C and took sections A and B's results with it, which
 * turned a one-line fix into a bisect. */
const bail = (err) => {
  console.error(`\n  suite aborted: ${err?.stack || err}`);
  r.finish();
  process.exit(1);
};
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);

await send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

/* Grant the clipboard, which a real tap would grant implicitly.
 *
 * Headless Chrome refuses `navigator.clipboard.writeText` with NotAllowedError
 * ("Write permission denied") because there is no user gesture and the
 * permission is ungranted. A real tap on the Copy button supplies both. Without
 * this the suite would exercise only the degraded path and never the one that
 * almost every user actually gets. */
await send('Browser.grantPermissions', {
  origin,
  permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
});

/**
 * Poll an expression until it is truthy.
 *
 * Never a fixed sleep: on a fresh install the dashboard seeds its sample data
 * first, which blocks the main thread for seconds, so `__APP_READY__` can land
 * anywhere between ~2 s and ~9 s depending on the machine.
 */
const waitFor = async (expr, { tries = 100, gap = 250 } = {}) => {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await evaluate(expr);
      if (v) return v;
    } catch {
      /* mid-navigation — the document is being replaced */
    }
    await sleep(gap);
  }
  return null;
};

/** Navigate and wait for the page's own readiness flag. */
const open = async (page, flag = 'window.__APP_READY__') => {
  await goto(page);
  await waitFor(flag);
  await sleep(300);
};

/**
 * Record the guided tour as seen, then reload onto a plain dashboard.
 *
 * On a fresh install the tour opens itself ~1.5 s after `initShell()` resolves.
 * Its dimming panels swallow pointer events, so in the real app it is simply
 * impossible to reach the Feedback launcher while it is up — but this suite
 * clicks elements through `evaluate()`, which ignores the overlay entirely.
 *
 * The tour also installs a DOCUMENT-level keydown handler
 * (`document.addEventListener('keydown', tour.onKey)`), and ArrowRight there
 * means "next step" — which navigates across pages. So an ArrowRight aimed at
 * the star widget gets taken by the tour, the tour walks to another page, the
 * document is replaced, and the feedback modal goes with it. The symptom is a
 * null `#fbRatingWord` several assertions later, which points nowhere useful.
 *
 * Section C is the only place that opens the dashboard on a fresh install, so
 * it is the only place this is needed.
 */
const neutraliseTour = async () => {
  // Navigate first: this is called right after storage is cleared, when the
  // browser is still sitting on about:blank and there is nothing to import.
  await goto('index.html');
  await waitFor('window.__APP_READY__');
  await evaluate(`(async () => { (await import('./js/onboarding.js')).markOnboardingSeen(); return true; })()`);
  await goto('index.html');
  await waitFor('window.__APP_READY__');
  await sleep(300);
};

/* ---- helpers that reach into the app's own modules ---- */
const setPlan = (plan) => `(async () => {
  const m = await import('./js/licenseService.js');
  const key = m.makeLicenseKey('${plan}');
  return JSON.stringify(await m.setPlan('${plan}', { licenseKey: key }));
})()`;
const RESET_PLAN = `(async () => { const m = await import('./js/licenseService.js'); await m.resetLicense(); return true; })()`;
const READ_SETTING = (key) => `(async () => {
  const m = await import('./js/storageService.js');
  return JSON.stringify(await m.getSetting(${JSON.stringify(key)}, null));
})()`;
const WRITE_SETTING = (key, value) => `(async () => {
  const m = await import('./js/storageService.js');
  await m.setSetting(${JSON.stringify(key)}, ${JSON.stringify(value)});
  return true;
})()`;
const CUSTOMERS = `(async () => {
  const m = await import('./js/storageService.js');
  return JSON.stringify((await m.getCustomers()).map((c) => ({ id: c.id, name: c.name, phone: c.phone, email: c.email })));
})()`;
const INVOICES = `(async () => {
  const m = await import('./js/storageService.js');
  return JSON.stringify((await m.getInvoices()).map((i) => ({ id: i.id, number: i.number, customerId: i.customerId, customerName: i.customerName })));
})()`;
const MODAL = `JSON.stringify({
  open: !!document.querySelector('.modal-overlay'),
  title: (document.querySelector('.modal-header h3') || {}).textContent || '',
  body: (document.querySelector('.modal-body') || {}).textContent || '',
})`;
const TOASTS = `JSON.stringify([...document.querySelectorAll('.toast')].map((t) => t.className + '|' + (t.querySelector('.toast-msg') || {}).textContent))`;
const closeModal = `document.querySelector('.modal-overlay .modal-close')?.click(); true`;

const modal = async () => JSON.parse(await evaluate(MODAL));
const toasts = async () => JSON.parse(await evaluate(TOASTS));

/* ==========================================================================
   A. Free-plan gates
   ========================================================================== */

r.section('A. Free-plan gates');

/* Land on the dashboard FIRST, before anything else.
 *
 * Sample data seeds only from index.html (`app.js` → `seedSampleData`), and only
 * when the invoice table is empty. Every "the download happened" assertion below
 * is meaningless without it: `exportCSV` returns early on zero rows, so a BLOCKED
 * export and an ALLOWED one both produce no download at all. Opening
 * settings.html directly made the monthly-block check below pass for the wrong
 * reason — it would have passed with the gate ripped out entirely. */
await neutraliseTour();
const seeded = JSON.parse(await evaluate(INVOICES));
r.check('the sample ledger seeded on first run', seeded.length >= 6, String(seeded.length));

await open('settings.html');

const freeLocks = JSON.parse(await evaluate(`(() => {
  const field = (sel) => { const el = document.querySelector(sel); return el ? el.closest('.field') : null; };
  const locked = (sel) => {
    const el = document.querySelector(sel);
    return !!el && el.classList.contains('is-locked');
  };
  return JSON.stringify({
    nameLocked: locked('#brandAppName'),
    nameReadonly: document.querySelector('#brandAppName').hasAttribute('readonly'),
    nameTag: !!field('#brandAppName')?.querySelector('.pro-tag'),
    taglineLocked: locked('#brandAppTagline'),
    taglineReadonly: document.querySelector('#brandAppTagline').hasAttribute('readonly'),
    signatureLocked: locked('#setSignatureInput'),
    signatureTag: !!field('#setSignatureInput')?.querySelector('.pro-tag'),
    stampLocked: locked('#setStampInput'),
    logoLocked: locked('#setLogoInput'),
    logoTag: !!field('#setLogoInput')?.querySelector('.pro-tag'),
    businessLocked: locked('#setBusinessName'),
    businessReadonly: document.querySelector('#setBusinessName').hasAttribute('readonly'),
    tagAriaHidden: field('#brandAppName')?.querySelector('.pro-tag')?.getAttribute('aria-hidden') || '',
    nameDescribedBy: document.querySelector('#brandAppName').getAttribute('aria-describedby') || '',
    noteText: field('#brandAppName')?.querySelector('.sr-only')?.textContent || '',
  });
})()`));

r.eq('free: the app name is locked', freeLocks.nameLocked, true);
r.eq('free: the app name is read-only', freeLocks.nameReadonly, true);
r.eq('free: the app name carries a Pro tag', freeLocks.nameTag, true);
r.eq('free: the app tagline is locked', freeLocks.taglineLocked, true);
r.eq('free: the app tagline is read-only', freeLocks.taglineReadonly, true);
r.eq('free: the signature uploader is locked', freeLocks.signatureLocked, true);
r.eq('free: the signature uploader carries a Pro tag', freeLocks.signatureTag, true);
r.eq('free: the stamp uploader is locked', freeLocks.stampLocked, true);
// The logo and the Business Name are NOT part of the paid tier. Locking them
// would make the free plan useless rather than tempting.
r.eq('free: the logo uploader is NOT locked', freeLocks.logoLocked, false);
r.eq('free: the logo uploader has no Pro tag', freeLocks.logoTag, false);
r.eq('free: the Business Name is NOT locked', freeLocks.businessLocked, false);
r.eq('free: the Business Name is NOT read-only', freeLocks.businessReadonly, false);

// The Pro tag is a DESCRIPTION, not part of the name.
//
// It sits inside the <label>, so without care it becomes part of the control's
// accessible name and the field is announced as "App Name Pro" — which is the
// name of nothing. `test-a11y.js` asserts the name itself; these assert the
// mechanism that keeps it clean, so a regression is caught in both places.
r.eq('free: the Pro tag is hidden from the accessible name', freeLocks.tagAriaHidden, 'true');
r.check('free: the Pro qualifier is delivered as a description',
  freeLocks.nameDescribedBy.includes('pro-note'), freeLocks.nameDescribedBy);
r.check('free: the description says why the field will not accept input',
  freeLocks.noteText.length > 0, freeLocks.noteText.slice(0, 60));

// Pressing the locked control must produce the upgrade prompt — a lock the user
// cannot act on is just a broken field.
await evaluate(`document.querySelector('#brandAppName').click()`);
await sleep(500);
const namePrompt = await modal();
r.eq('free: pressing the app name opens a modal', namePrompt.open, true);
r.eq('free: the prompt is the upgrade prompt', namePrompt.title, 'Upgrade your plan');
r.check('free: the prompt names the locked feature',
  namePrompt.body.includes('Renaming the app'), namePrompt.body.slice(0, 90));
r.check('free: the prompt lists what Pro adds',
  (await evaluate(`document.querySelectorAll('.upgrade-features li').length`)) > 0);
await evaluate(closeModal);
await sleep(300);

// The monthly report is the third gate, and it is period-specific: the figures
// stay readable, only the download is gated.
await open('reports.html');
await evaluate(`document.querySelector('.tab[data-period="monthly"]').click()`);
await sleep(300);

const monthlyLocks = JSON.parse(await evaluate(`JSON.stringify({
  tabLocked: document.querySelector('.tab[data-period="monthly"]').classList.contains('is-locked'),
  pdfLocked: document.querySelector('#exportPdfBtn').classList.contains('is-locked'),
  csvLocked: document.querySelector('#exportCsvBtn').classList.contains('is-locked'),
  summaryRendered: document.querySelector('#reportSummary').children.length > 0,
})`));
r.eq('free: the Monthly tab is marked', monthlyLocks.tabLocked, true);
r.eq('free: the PDF export is marked', monthlyLocks.pdfLocked, true);
r.eq('free: the CSV export is marked', monthlyLocks.csvLocked, true);
// Viewing a monthly report is free — only taking it off the device is not.
r.eq('free: the monthly figures still render', monthlyLocks.summaryRendered, true);

// Count real downloads so "blocked" means nothing was written to disk, not just
// that a dialog appeared.
await evaluate(`(() => {
  window.__downloads = 0;
  const original = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute('download')) window.__downloads++;
    return original.apply(this, arguments);
  };
  return true;
})()`);

// Establish the BASELINE first: same page, same free plan, a daily export must
// actually reach the disk. Measured before the block, because "no download
// happened" is only evidence of a working gate if a download demonstrably
// happens otherwise — on this page, through this button, with this ledger.
await evaluate(`document.querySelector('.tab[data-period="daily"]').click()`);
await sleep(400);
r.eq('free: the Daily tab is NOT marked',
  await evaluate(`document.querySelector('.tab[data-period="daily"]').classList.contains('is-locked')`), false);
r.eq('free: the Daily PDF export is NOT marked',
  await evaluate(`document.querySelector('#exportPdfBtn').classList.contains('is-locked')`), false);
await evaluate(`document.querySelector('#exportCsvBtn').click()`);
await sleep(900);
r.eq('free: the daily CSV download is allowed (baseline)',
  await evaluate('window.__downloads'), 1);

// Now the gate. Back to Monthly, same button, same ledger — the only difference
// is the period, so the only thing that can account for the difference in
// outcome is the gate.
await evaluate(`document.querySelector('.tab[data-period="monthly"]').click()`);
await sleep(400);
await evaluate('window.__downloads = 0; true');
await evaluate(`document.querySelector('#exportCsvBtn').click()`);
await sleep(900);
const monthlyPrompt = await modal();
r.eq('free: the monthly CSV download is blocked', await evaluate('window.__downloads'), 0);
r.eq('free: a modal was shown instead', monthlyPrompt.open, true);
r.check('free: the prompt explains it is the monthly download',
  monthlyPrompt.body.includes('Monthly report download'), monthlyPrompt.body.slice(0, 90));
await evaluate(closeModal);
await sleep(300);

/* ==========================================================================
   B. Pro unlocks the gates
   ========================================================================== */

r.section('B. Pro unlocks the gates');
r.check('setPlan(pro) succeeded', JSON.parse(await evaluate(setPlan('pro'))).ok === true);

await open('settings.html');
const proLocks = JSON.parse(await evaluate(`(() => {
  const el = document.querySelector('#brandAppName');
  return JSON.stringify({
    nameLocked: el.classList.contains('is-locked'),
    nameReadonly: el.hasAttribute('readonly'),
    signatureLocked: document.querySelector('#setSignatureInput').classList.contains('is-locked'),
    proTags: document.querySelectorAll('.pro-tag').length,
  });
})()`));
r.eq('pro: the app name is unlocked', proLocks.nameLocked, false);
r.eq('pro: the app name is editable', proLocks.nameReadonly, false);
r.eq('pro: the signature uploader is unlocked', proLocks.signatureLocked, false);
r.eq('pro: no Pro tags remain', proLocks.proTags, 0);

await open('reports.html');
await evaluate(`document.querySelector('.tab[data-period="monthly"]').click()`);
await sleep(300);
const proMonthly = JSON.parse(await evaluate(`JSON.stringify({
  tab: document.querySelector('.tab[data-period="monthly"]').classList.contains('is-locked'),
  pdf: document.querySelector('#exportPdfBtn').classList.contains('is-locked'),
})`));
r.eq('pro: the Monthly tab is unlocked', proMonthly.tab, false);
r.eq('pro: the monthly PDF export is unlocked', proMonthly.pdf, false);

/* ==========================================================================
   C. Feedback & rating
   ========================================================================== */

r.section('C. Feedback & rating');
await evaluate(RESET_PLAN);
await neutraliseTour();

// Assert the tour really is gone. If this ever regresses, it should fail HERE
// and say so, rather than surfacing as a confusing null element further down.
r.eq('the dashboard is free of the first-run tour',
  await evaluate(`!document.querySelector('.tour-root')`), true);

r.eq('every page carries a Feedback launcher',
  await evaluate(`!!document.querySelector('#feedbackBtn[data-action="feedback"]')`), true);

await evaluate(`document.querySelector('#feedbackBtn').click()`);
await sleep(500);
const form = JSON.parse(await evaluate(`JSON.stringify({
  open: !!document.querySelector('.modal-overlay'),
  title: (document.querySelector('.modal-header h3') || {}).textContent || '',
  stars: document.querySelectorAll('#fbStars .star-btn').length,
  categories: document.querySelectorAll('#fbCategory option').length,
  hasMessage: !!document.querySelector('#fbMessage'),
  role: (document.querySelector('#fbStars') || {}).getAttribute?.('role') || '',
})`));
r.eq('the feedback form opens', form.open, true);
r.eq('the form is titled', form.title, 'Feedback & rating');
r.eq('there are five stars', form.stars, 5);
r.check('the topic list is populated from config', form.categories >= 4, String(form.categories));
r.eq('there is a message box', form.hasMessage, true);
r.eq('the star group is an ARIA radiogroup', form.role, 'radiogroup');

// Rating: click the fourth star and check the widget and the word both move.
await evaluate(`document.querySelector('#fbStars [data-star="4"]').click()`);
await sleep(250);
const rated = JSON.parse(await evaluate(`JSON.stringify({
  on: document.querySelectorAll('#fbStars .star-btn.is-on').length,
  checked: document.querySelector('#fbStars [data-star="4"]').getAttribute('aria-checked'),
  word: (document.querySelector('#fbRatingWord') || {}).textContent || '',
  tabbable: document.querySelectorAll('#fbStars .star-btn[tabindex="0"]').length,
})`));
r.eq('four stars light up', rated.on, 4);
r.eq('the fourth star is checked', rated.checked, 'true');
r.eq('the rating is spelled out', rated.word, '4/5 — Good');
// Roving tabindex: a five-button group where every button is tabbable is five
// extra presses to get past, so only the checked star may hold the tab stop.
r.eq('exactly one star holds the tab stop', rated.tabbable, 1);

// Keyboard: arrows must move AND select, per the ARIA radio pattern.
r.eq('the star widget took the arrow key', await evaluate(`(() => {
  const el = document.querySelector('#fbStars [data-star="4"]');
  if (!el) return false;
  el.focus();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  return true;
})()`), true);
await sleep(250);
r.eq('ArrowRight selects the fifth star',
  await evaluate(`document.querySelectorAll('#fbStars .star-btn.is-on').length`), 5);
r.eq('and the word follows',
  await evaluate(`(document.querySelector('#fbRatingWord') || {}).textContent || ''`), '5/5 — Excellent');

// Fill in the rest and save.
await evaluate(`(() => {
  document.querySelector('#fbCategory').value = 'Feature request';
  document.querySelector('#fbMessage').value = 'Bulk invoice reminders would save me a lot of time.';
  return true;
})()`);
await evaluate(`document.querySelector('[data-fb="save"]').click()`);
await sleep(700);

const sent = JSON.parse(await evaluate(`JSON.stringify({
  thanks: !!document.querySelector('.fb-thanks'),
  whatsapp: !!document.querySelector('[data-fb="whatsapp"]'),
  email: !!document.querySelector('[data-fb="email"]'),
  copy: !!document.querySelector('[data-fb="copy"]'),
  body: (document.querySelector('.modal-body') || {}).textContent || '',
})`));
r.eq('saving moves to the thank-you stage', sent.thanks, true);
r.eq('the send stage offers WhatsApp', sent.whatsapp, true);
r.eq('the send stage offers email', sent.email, true);
r.eq('the send stage offers copy', sent.copy, true);
r.check('the send stage says the review is stored', sent.body.includes('saved on this device'), sent.body.slice(0, 80));

// It must actually be in storage — a thank-you that stored nothing is the
// worst version of this bug, because the user believes they were heard.
const stored = JSON.parse(await evaluate(READ_SETTING('feedback')));
r.eq('the review is stored', Array.isArray(stored) && stored.length, 1);
r.eq('the rating persisted', stored?.[0]?.rating, 5);
r.eq('the topic persisted', stored?.[0]?.category, 'Feature request');
r.check('the words persisted', (stored?.[0]?.message || '').includes('Bulk invoice reminders'));
r.eq('an unsent review is marked unsent', stored?.[0]?.sentVia, null);
r.check('the review records the plan it came from', typeof stored?.[0]?.plan === 'string');
r.check('the review records a device string', typeof stored?.[0]?.device === 'string');

// The composed message is what a human reads on WhatsApp — check it is complete.
const composed = await evaluate(`(async () => {
  const m = await import('./js/feedback.js');
  const s = await import('./js/storageService.js');
  const list = await s.getSetting('feedback', []);
  return m.buildFeedbackMessage(list[0], { appName: 'Smart Invoice Pro', planName: 'Free' });
})()`);
r.check('the composed review leads with the verdict', composed.includes('5/5 — Excellent'), composed.slice(0, 60));
r.check('the composed review includes the words', composed.includes('Bulk invoice reminders'), '');
r.check('the composed review names the plan', composed.includes('Plan: Free'), '');

// A refused clipboard must NOT be recorded as sent.
//
// The whole promise of this feature is that the user is told the truth about
// where their words are, so "sent by clipboard" when nothing was copied is the
// one lie it must not tell. `file://` installs and older Android browsers hit
// this path for real — it is not a hypothetical.
await evaluate(`(() => {
  window.__clipboard = navigator.clipboard;
  window.__exec = document.execCommand;
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  document.execCommand = () => false;
  return true;
})()`);
await evaluate(`document.querySelector('[data-fb="copy"]').click()`);
await sleep(600);
r.eq('a refused clipboard is not recorded as sent',
  JSON.parse(await evaluate(READ_SETTING('feedback')))?.[0]?.sentVia, null);
r.check('and the user is told the copy did not happen',
  (await toasts()).some((t) => t.startsWith('toast error')), JSON.stringify(await toasts()));

// Put the clipboard back and copy for real.
await evaluate(`(() => {
  Object.defineProperty(navigator, 'clipboard', { value: window.__clipboard, configurable: true });
  document.execCommand = window.__exec;
  return true;
})()`);

// Sending marks the record, so the admin inbox can tell an answered review from
// one that is still sitting on the phone.
await evaluate(`document.querySelector('[data-fb="copy"]').click()`);
await sleep(600);
const afterSend = JSON.parse(await evaluate(READ_SETTING('feedback')));
r.eq('sending records how it left the device', afterSend?.[0]?.sentVia, 'clipboard');

await evaluate(closeModal);
await sleep(400);

// Re-opening shows the review, so a second submission cannot look like the
// first one silently vanished.
await evaluate(`document.querySelector('#feedbackBtn').click()`);
await sleep(600);
r.check('re-opening lists the previous review',
  (await evaluate(`document.querySelectorAll('#fbRecent .feedback-item').length`)) >= 1);
await evaluate(closeModal);
await sleep(300);

// The one-shot nudge: it must NOT appear before the tour has been seen, and it
// must appear exactly once after.
await evaluate(`(async () => {
  const m = await import('./js/storageService.js');
  await m.setSetting('onboardingSeen', true);
  await m.setSetting('feedbackAsked', false);
  return true;
})()`);
await open('index.html');
r.check('the dashboard offers the one-time nudge',
  await evaluate(`!!document.querySelector('#feedbackNudge')`), '');
r.eq('the nudge is appended last, so it cannot push the primary action down',
  await evaluate(`document.querySelector('#content').lastElementChild.id`), 'feedbackNudge');
r.eq('asking once is recorded', JSON.parse(await evaluate(READ_SETTING('feedbackAsked'))), true);
await open('index.html');
r.eq('the nudge never returns', await evaluate(`!!document.querySelector('#feedbackNudge')`), false);

// A fresh install must never see the nudge — it would fight the guided tour.
await evaluate(WRITE_SETTING('feedbackAsked', false));
await evaluate(WRITE_SETTING('onboardingSeen', false));
await open('index.html');
r.eq('no nudge before the tour has been seen', await evaluate(`!!document.querySelector('#feedbackNudge')`), false);
// The tour is up again now (that is the point of the check above). Record it as
// seen so it cannot follow us into section D.
await evaluate(`(async () => { (await import('./js/onboarding.js')).markOnboardingSeen(); return true; })()`);

/* ==========================================================================
   D. Inline customer creation
   ========================================================================== */

r.section('D. Inline customer creation');
r.check('setPlan(pro) succeeded', JSON.parse(await evaluate(setPlan('pro'))).ok === true);

await open('invoice.html?new=1');
const before = JSON.parse(await evaluate(CUSTOMERS));

r.eq('the editor offers the inline new-customer control',
  await evaluate(`!!document.querySelector('#invNewCustomerBtn')`), true);

await evaluate(`document.querySelector('#invNewCustomerBtn').click()`);
await sleep(500);
const ncForm = JSON.parse(await evaluate(`JSON.stringify({
  open: !!document.querySelector('.modal-overlay'),
  title: (document.querySelector('.modal-header h3') || {}).textContent || '',
  fields: ['#ncName', '#ncPhone', '#ncEmail', '#ncTin', '#ncAddress'].filter((s) => !!document.querySelector(s)).length,
})`));
r.eq('the new-customer form opens', ncForm.open, true);
r.eq('it is titled for the job', ncForm.title, 'New customer');
r.eq('it offers all five customer fields', ncForm.fields, 5);

// A blank name must be refused — the customer database is the one place a
// nameless row is impossible to clean up.
await evaluate(`document.querySelector('[data-action="save"]').click()`);
await sleep(400);
r.check('a nameless customer is refused',
  (await toasts()).some((t) => t.startsWith('toast error')), JSON.stringify(await toasts()));
r.eq('and no customer was created', JSON.parse(await evaluate(CUSTOMERS)).length, before.length);

await evaluate(`(() => {
  document.querySelector('#ncName').value = 'Bahari Fisheries';
  document.querySelector('#ncPhone').value = '0712 999 888';
  document.querySelector('#ncEmail').value = 'orders@baharifisheries.co.tz';
  document.querySelector('#ncTin').value = '777-888-999';
  document.querySelector('#ncAddress').value = 'Kivukoni, Dar es Salaam';
  return true;
})()`);
await evaluate(`document.querySelector('[data-action="save"]').click()`);
await sleep(900);

const after = JSON.parse(await evaluate(CUSTOMERS));
r.eq('the customer was written to the customer database', after.length, before.length + 1);
const created = after.find((c) => c.name === 'Bahari Fisheries');
r.check('the new customer exists', !!created, JSON.stringify(after.map((c) => c.name)));
r.eq('its phone was stored', created?.phone, '0712 999 888');
r.eq('its email was stored', created?.email, 'orders@baharifisheries.co.tz');

const picked = JSON.parse(await evaluate(`JSON.stringify({
  select: document.querySelector('#invCustomer').value,
  name: document.querySelector('#invCustomerName').value,
  phone: document.querySelector('#invCustomerPhone').value,
  email: document.querySelector('#invCustomerEmail').value,
  tin: document.querySelector('#invCustomerTin').value,
  address: document.querySelector('#invCustomerAddress').value,
  inSelect: [...document.querySelectorAll('#invCustomer option')].some((o) => o.textContent === 'Bahari Fisheries'),
})`));
r.eq('the new customer is selected on the invoice', picked.select, created?.id);
r.eq('the name field is filled', picked.name, 'Bahari Fisheries');
r.eq('the phone field is filled', picked.phone, '0712 999 888');
r.eq('the email field is filled', picked.email, 'orders@baharifisheries.co.tz');
r.eq('the TIN field is filled', picked.tin, '777-888-999');
r.eq('the address field is filled', picked.address, 'Kivukoni, Dar es Salaam');
r.eq('it appears in the customer dropdown', picked.inSelect, true);

// Save the invoice and confirm the link survived the round trip.
await evaluate(`(() => {
  const price = document.querySelector('#itemsBody tr:last-child .line-price');
  const name = document.querySelector('#itemsBody tr:last-child .line-name');
  if (name) name.value = 'Fresh tilapia, 10kg';
  if (price) price.value = '45000';
  return true;
})()`);
await evaluate(`document.querySelector('#saveInvoiceBtn').click()`);
await sleep(1600);

const invoices = JSON.parse(await evaluate(INVOICES));
const savedInv = invoices.find((i) => i.customerName === 'Bahari Fisheries');
r.check('the invoice was saved', !!savedInv, JSON.stringify(invoices.slice(-3)));
r.eq('the saved invoice links to the new customer', savedInv?.customerId, created?.id);

// ---- the automatic half: typing a brand-new name and saving creates them ----
const beforeAuto = JSON.parse(await evaluate(CUSTOMERS));
await open('invoice.html?new=1');
await evaluate(`(() => {
  document.querySelector('#invCustomer').value = '';
  document.querySelector('#invCustomerName').value = 'Serengeti Safaris Ltd';
  document.querySelector('#invCustomerPhone').value = '0755 123 000';
  document.querySelector('#invCustomerEmail').value = 'bookings@serengetisafaris.co.tz';
  const name = document.querySelector('#itemsBody tr:last-child .line-name');
  const price = document.querySelector('#itemsBody tr:last-child .line-price');
  if (name) name.value = 'Safari package';
  if (price) price.value = '900000';
  return true;
})()`);
await evaluate(`document.querySelector('#saveInvoiceBtn').click()`);
await sleep(1600);

const afterAuto = JSON.parse(await evaluate(CUSTOMERS));
r.eq('saving the invoice created the customer automatically', afterAuto.length, beforeAuto.length + 1);
const auto = afterAuto.find((c) => c.name === 'Serengeti Safaris Ltd');
r.check('the auto-created customer exists', !!auto, JSON.stringify(afterAuto.map((c) => c.name)));
r.eq('its phone came from the invoice', auto?.phone, '0755 123 000');

const autoInv = JSON.parse(await evaluate(INVOICES)).find((i) => i.customerName === 'Serengeti Safaris Ltd');
r.eq('the invoice links to the auto-created customer', autoInv?.customerId, auto?.id);

// Saving the SAME invoice again must not clone the customer — the failure mode
// that would fill the customer list with duplicates of one person.
await evaluate(`(async () => {
  const m = await import('./js/storageService.js');
  const inv = (await m.getInvoices()).find((i) => i.customerName === 'Serengeti Safaris Ltd');
  location.href = 'invoice.html?id=' + encodeURIComponent(inv.id);
  return true;
})()`);
await waitFor('window.__APP_READY__');
await sleep(900);
await evaluate(`document.querySelector('#saveInvoiceBtn').click()`);
await sleep(1500);
r.eq('re-saving an invoice does not duplicate the customer',
  JSON.parse(await evaluate(CUSTOMERS)).filter((c) => c.name === 'Serengeti Safaris Ltd').length, 1);

/* ==========================================================================
   E. Admin console
   ========================================================================== */

r.section('E. Admin console');
await evaluate(RESET_PLAN);
// CDP's clearDataForOrigin has no "session storage" type — sessionStorage is
// per-tab and is not covered by 'all'. The console remembers its unlock in
// sessionStorage, so it has to be cleared explicitly or the gate would already
// be open. Done here, while still on the same origin.
await evaluate(`(() => { try { sessionStorage.removeItem('sip_admin_unlocked'); } catch { /* blocked */ } return true; })()`);
await open('admin.html', 'window.__ADMIN_READY__');

r.eq('the console opens behind a passcode gate',
  await evaluate(`!document.querySelector('#adminGate').classList.contains('hidden')`), true);
r.eq('the panel is hidden until unlocked',
  await evaluate(`document.querySelector('#adminPanel').classList.contains('hidden')`), true);
r.check('the gate shows the default passcode while it is still the default',
  (await evaluate(`document.querySelector('#adminDefaultHint').textContent`)).includes('admin123'));

// A wrong passcode must not open it.
await evaluate(`(() => { document.querySelector('#adminPass').value = 'not-the-passcode'; document.querySelector('#adminUnlockBtn').click(); return true; })()`);
await sleep(600);
r.eq('a wrong passcode leaves the panel hidden',
  await evaluate(`document.querySelector('#adminPanel').classList.contains('hidden')`), true);
r.check('a wrong passcode says so',
  (await toasts()).some((t) => t.startsWith('toast error')), JSON.stringify(await toasts()));

await evaluate(`(() => { document.querySelector('#adminPass').value = 'admin123'; document.querySelector('#adminUnlockBtn').click(); return true; })()`);
await sleep(900);
r.eq('the right passcode reveals the panel',
  await evaluate(`document.querySelector('#adminPanel').classList.contains('hidden')`), false);
r.eq('the gate is dismissed',
  await evaluate(`document.querySelector('#adminGate').classList.contains('hidden')`), true);

// Overview: the sample data means these are all non-zero.
const overview = JSON.parse(await evaluate(`JSON.stringify({
  stats: document.querySelectorAll('#adminStats .admin-stat').length,
  values: [...document.querySelectorAll('#adminStats .as-value')].map((e) => e.textContent),
  badge: (document.querySelector('#adminPlanBadge') || {}).textContent || '',
})`));
r.eq('the overview renders six figures', overview.stats, 6);
r.check('it reports the plan', overview.badge.length > 0, overview.badge);
r.check('it reports invoices on file', overview.values.some((v) => Number(v) >= 6), overview.values.join(' | '));

// Plan matrix: every plan gets a column, and the gated features must be ticked
// on Pro and blank on Free.
const matrix = JSON.parse(await evaluate(`(() => {
  const head = [...document.querySelectorAll('#planMatrixTable thead th')].map((t) => t.textContent.trim());
  const rows = [...document.querySelectorAll('#planMatrixTable tbody tr')].map((tr) => ({
    label: tr.children[0].textContent.trim(),
    cells: [...tr.children].slice(1).map((td) => td.textContent.trim()),
  }));
  return JSON.stringify({ head, rows });
})()`));
r.check('the matrix has a Feature column plus one per plan', matrix.head.length >= 4, matrix.head.join(' | '));
r.check('the matrix lists every feature', matrix.rows.length >= 15, String(matrix.rows.length));
const renameRow = matrix.rows.find((row) => row.label === 'Renaming the app');
r.check('the matrix has a row for the app-name gate', !!renameRow, matrix.rows.map((x) => x.label).join(','));
r.eq('the app-name gate is ticked on Pro', renameRow?.cells[1], '\u2713');
r.eq('the app-name gate is blank on Free', renameRow?.cells[0], '\u2014');
const sigRow = matrix.rows.find((row) => row.label === 'Digital signature & stamp');
r.eq('the signature gate is ticked on Pro', sigRow?.cells[1], '\u2713');
const monthlyRow = matrix.rows.find((row) => row.label === 'Monthly report download');
r.eq('the monthly gate is ticked on Pro', monthlyRow?.cells[1], '\u2713');

// Key generation — the part that must never hand out duplicates.
await evaluate(`(() => {
  document.querySelector('#keyPlanSelect').value = 'pro';
  document.querySelector('#keyCount').value = '4';
  document.querySelector('#keyNote').value = 'Bahari Fisheries';
  return true;
})()`);
await evaluate(`document.querySelector('#genKeysBtn').click()`);
await sleep(1200);

const ledger = JSON.parse(await evaluate(`(async () => {
  const m = await import('./js/storageService.js');
  return JSON.stringify(await m.getSetting('issuedKeys', []));
})()`));
r.eq('four keys were issued', ledger.length, 4);
r.eq('every key is distinct', new Set(ledger.map((k) => k.key)).size, 4);
r.check('every key is well formed',
  ledger.every((k) => /^SIP-PRO-\d{8}-[0-9A-F]{4}$/.test(k.key)), JSON.stringify(ledger.map((k) => k.key)));
r.check('every key verifies', await evaluate(`(async () => {
  const m = await import('./js/licenseService.js');
  const s = await import('./js/storageService.js');
  const list = await s.getSetting('issuedKeys', []);
  return list.every((e) => m.verifyLicenseKey(e.key).valid);
})()`), '');
r.check('each ledger stamp matches its own key', await evaluate(`(async () => {
  const m = await import('./js/licenseService.js');
  const s = await import('./js/storageService.js');
  const list = await s.getSetting('issuedKeys', []);
  return list.every((e) => m.verifyLicenseKey(e.key).issuedAt === e.issuedAt);
})()`), '');
r.eq('the note was recorded', ledger[0]?.note, 'Bahari Fisheries');
r.eq('the ledger rows rendered', await evaluate(`document.querySelectorAll('#keyTableBody tr').length`), 4);
r.check('the ledger summarises itself',
  (await evaluate(`document.querySelector('#keySummary').textContent`)).includes('4 issued'), '');

// A second batch must not re-mint the first.
await evaluate(`document.querySelector('#genKeysBtn').click()`);
await sleep(1200);
const ledger2 = JSON.parse(await evaluate(`(async () => {
  const m = await import('./js/storageService.js');
  return JSON.stringify(await m.getSetting('issuedKeys', []));
})()`));
r.eq('a second batch adds four more', ledger2.length, 8);
r.eq('nothing in the ledger repeats', new Set(ledger2.map((k) => k.key)).size, 8);

// Verify panel.
await evaluate(`(() => {
  document.querySelector('#verifyKeyInput').value = '${ledger[0].key}';
  document.querySelector('#verifyKeyBtn').click();
  return true;
})()`);
await sleep(400);
const goodVerdict = await evaluate(`document.querySelector('#verifyResult').textContent`);
r.check('a real key verifies', goodVerdict.includes('Valid'), goodVerdict.slice(0, 80));
r.check('the verdict names the plan', goodVerdict.includes('Pro'), goodVerdict.slice(0, 80));
await evaluate(`(() => {
  document.querySelector('#verifyKeyInput').value = 'SIP-PRO-20261002-0000';
  document.querySelector('#verifyKeyBtn').click();
  return true;
})()`);
await sleep(400);
r.check('a tampered key is rejected',
  (await evaluate(`document.querySelector('#verifyResult').textContent`)).includes('Not a valid key'), '');

// Activate a ledger key on this device.
await evaluate(`document.querySelector('[data-key-action="use"][data-key="${ledger[0].key}"]').click()`);
await sleep(1200);
r.eq('the ledger key activated this device',
  await evaluate(`(async () => { const m = await import('./js/licenseService.js'); return m.currentPlanId(); })()`), 'pro');
const ledger3 = JSON.parse(await evaluate(`(async () => {
  const m = await import('./js/storageService.js');
  return JSON.stringify(await m.getSetting('issuedKeys', []));
})()`));
r.check('the ledger records the activation',
  !!ledger3.find((k) => k.key === ledger[0].key)?.activatedAt, '');
r.check('the row reports it as active here',
  (await evaluate(`document.querySelector('#keyTableBody').textContent`)).includes('Active here'), '');

// Feedback inbox: the review left in section C must be readable here.
const inbox = await evaluate(`document.querySelector('#feedbackInbox').textContent`);
r.check('the inbox lists the review', inbox.includes('Feature request'), inbox.slice(0, 120));
r.check('the inbox shows the words', inbox.includes('Bulk invoice reminders'), '');
r.check('the inbox summarises the rating',
  (await evaluate(`document.querySelector('#feedbackSummary').textContent`)).includes('5/5'), '');

// Passcode change: the old code must stop working and the new one must work.
await evaluate(`(() => {
  document.querySelector('#adminNewPass').value = 'tembo2026';
  document.querySelector('#adminNewPass2').value = 'tembo2026';
  document.querySelector('#adminPassSaveBtn').click();
  return true;
})()`);
await sleep(800);
r.check('the passcode was saved',
  (await toasts()).some((t) => t.includes('Passcode updated')), JSON.stringify(await toasts()));

await evaluate(`document.querySelector('#adminLockBtn').click()`);
await sleep(500);
r.eq('locking re-shows the gate',
  await evaluate(`!document.querySelector('#adminGate').classList.contains('hidden')`), true);
r.eq('the default-passcode hint is gone once it has been changed',
  await evaluate(`document.querySelector('#adminDefaultHint').textContent`), 'Passcode set by the operator.');

await evaluate(`(() => { document.querySelector('#adminPass').value = 'admin123'; document.querySelector('#adminUnlockBtn').click(); return true; })()`);
await sleep(600);
r.eq('the OLD passcode no longer works',
  await evaluate(`document.querySelector('#adminPanel').classList.contains('hidden')`), true);

await evaluate(`(() => { document.querySelector('#adminPass').value = 'tembo2026'; document.querySelector('#adminUnlockBtn').click(); return true; })()`);
await sleep(900);
r.eq('the NEW passcode works',
  await evaluate(`document.querySelector('#adminPanel').classList.contains('hidden')`), false);

/* ==========================================================================
   F. Console hygiene
   ========================================================================== */

r.section('F. Console hygiene');
const errs = errors();
r.eq('the console stayed clean', errs.length, 0);
if (errs.length) console.log('   ', JSON.stringify(errs.slice(0, 4)));
// A feature that only works by reaching the network would break the offline
// promise, so a failed request is a failure here too.
const failed = netFails();
r.eq('no requests failed', failed.length, 0);
if (failed.length) console.log('   ', JSON.stringify(failed.slice(0, 4)));

/* ==========================================================================
   Leave the app in a clean state for the next suite
   ========================================================================== */
await evaluate(RESET_PLAN);

await shot('features-final.png');

const ok = r.finish();
process.exit(ok ? 0 : 1);

/**
 * Onboarding guide suite — the first-run walkthrough and the built-in manual.
 *
 * The guide is the first thing a new client ever sees, and it is the one screen
 * with no fallback: if the spotlight lands off-target, if the cross-page hop
 * drops the user on the wrong step, or if the tour re-opens on every launch, the
 * app *looks* broken before a single invoice has been raised. None of that
 * raises an error, so it is all asserted here by driving the real app.
 *
 * What this covers:
 *   A. A fresh install opens the tour by itself, on the right step.
 *   B. The tour advances, goes back, jumps by dot, and carries itself across
 *      pages via `?tour=` — then cleans the parameter out of the URL.
 *   C. Dismissing it records the seen flag, so it never nags twice, and the
 *      sidebar launcher stops pulsing.
 *   D. The manual opens from the Guide button, lists every step, and can launch
 *      the interactive tour.
 *   E. The re-entry affordance restarts the tour, every step's anchor actually
 *      exists on the page it belongs to, and a step that points into a view the
 *      page does not show by default (the invoice editor) opens that view.
 *   F. It survives reduced motion, a phone viewport and dark mode.
 *   G. The console stays clean throughout.
 *
 * Run via `npm run test:onboarding`, or `npm run test:e2e` for the whole set.
 */
import { CONFIG, connect, createReporter, sleep } from './lib/cdp.js';

const { origin } = CONFIG;
const r = createReporter('Onboarding');
const { send, evaluate, goto, shot, errors } = await connect();

await send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

/**
 * Poll an expression until it is truthy.
 *
 * The tour cannot be waited for with a fixed sleep. On a fresh install the
 * dashboard seeds its sample data first, which blocks the main thread for
 * several seconds, and only then does the 1.5 s first-run timer get a chance to
 * fire — so the tour appears anywhere between ~1.5 s and ~8 s depending on the
 * machine. Polling is the only honest way to assert it.
 */
const waitFor = async (expr, { tries = 80, gap = 250 } = {}) => {
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

/** Everything the suite needs to know about the tour, in one round trip. */
const TOUR_STATE = `(() => {
  const root = document.querySelector('.tour-root');
  if (!root) return null;
  const q = (s) => root.querySelector(s);
  return JSON.stringify({
    open: root.classList.contains('open'),
    title: (q('.tour-title') || {}).textContent || '',
    body: (q('.tour-body') || {}).textContent || '',
    badge: (q('.tour-step-badge') || {}).textContent || '',
    pageBadge: (q('.tour-page-badge') || {}).textContent || '',
    pageBadgeShown: !!q('.tour-page-badge') && q('.tour-page-badge').style.display !== 'none',
    dots: root.querySelectorAll('.tour-dot').length,
    activeDot: [...root.querySelectorAll('.tour-dot')].findIndex((d) => d.classList.contains('active')),
    nextLabel: (q('[data-tour-action="next"]') || {}).textContent || '',
    prevDisabled: !!(q('[data-tour-action="prev"]') || {}).disabled,
    art: !!q('.tour-art svg'),
    blocks: root.querySelectorAll('.tour-block').length,
  });
})()`;

const tourState = async () => {
  const raw = await evaluate(TOUR_STATE);
  return raw ? JSON.parse(raw) : null;
};

const waitForTour = () => waitFor(`!!document.querySelector('.tour-root.open')`, { tries: 80, gap: 250 });
const tourGone = () => waitFor(`!document.querySelector('.tour-root')`, { tries: 40, gap: 150 });
const click = (sel) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
const key = (k) => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`);
const seenFlag = () => waitFor(
  `(async () => (await import('./js/storageService.js')).getSetting('onboardingSeen', null))()`,
  { tries: 30, gap: 150 },
);

/**
 * The card is positioned immediately, but a target below the fold is first
 * brought into view with a smooth scroll (or the page finishes opening a view),
 * so a spotlight measurement is only meaningful once that has settled.
 */
const SETTLE = 1000;

/* ==========================================================================
   A. First run
   ========================================================================== */
r.section('A. A fresh install opens the tour');

await goto('index.html', 1200);
const ready = await waitFor(`window.__APP_READY__ === true`, { tries: 80, gap: 250 });
r.check('the dashboard reaches readiness', ready === true, ready);

const opened = await waitForTour();
r.check('the tour opens itself on a fresh install', !!opened, opened);

const first = await tourState();
r.check('the first step is the welcome card', first?.title === 'Welcome aboard', first?.title);
r.check('the welcome step is centred (no spotlight to point at)',
  (await evaluate(`(() => { const g = document.querySelector('.tour-glow'); return !!g && g.classList.contains('hidden'); })()`)) === true);
r.check('the card carries an illustration', first?.art === true, first?.art);
r.check('the progress shows every step', first?.dots === 9, first?.dots);
r.check('the step counter reads 1 / 9', first?.badge === '1 / 9', first?.badge);
r.check('Back is disabled on the first step', first?.prevDisabled === true, first?.prevDisabled);
r.check('the primary action says Next', first?.nextLabel === 'Next', first?.nextLabel);
r.check('the dimming is drawn as four panels (so the spotlight stays clickable)',
  first?.blocks === 4, first?.blocks);
r.check('the page is locked against scrolling behind the tour',
  (await evaluate(`document.documentElement.classList.contains('tour-active')`)) === true);

await shot('onboarding-01-welcome.png');

/* ==========================================================================
   B. Navigation + the cross-page hop
   ========================================================================== */
r.section('B. The tour walks across pages');

await click('[data-tour-action="next"]');
const hopped = await waitFor(
  `location.pathname.endsWith('settings.html') && !!document.querySelector('.tour-root.open')`,
  { tries: 80, gap: 250 },
);
r.check('Next crosses to the page the step lives on', !!hopped, hopped);
await sleep(SETTLE);

const step2 = await tourState();
r.check('the cross-page step is step 1 — business details',
  step2?.title === 'Your business details', step2?.title);
r.check('the step counter advanced to 2 / 9', step2?.badge === '2 / 9', step2?.badge);
r.check('Back is now available', step2?.prevDisabled === false, step2?.prevDisabled);

const spot = JSON.parse(await evaluate(`(() => {
  const glow = document.querySelector('.tour-glow');
  const target = document.querySelector('[data-tour="business-info"]');
  if (!glow || !target) return 'null';
  const g = glow.getBoundingClientRect();
  const t = target.getBoundingClientRect();
  return JSON.stringify({
    gw: Math.round(g.width), gh: Math.round(g.height),
    onTarget: Math.abs(g.left - t.left) < 40 && Math.abs(g.top - t.top) < 40,
  });
})()`) || 'null');
r.check('the spotlight frames the business-details panel',
  !!spot && spot.gw > 100 && spot.gh > 20 && spot.onTarget, JSON.stringify(spot));

const url = await evaluate(`location.pathname + location.search`);
r.check('the ?tour= hand-off is stripped from the URL', url === '/settings.html', url);

await shot('onboarding-02-settings-spotlight.png');

/* Keyboard: arrow keys move within a page (step 1 -> step 2 -> step 1). */
await key('ArrowRight');
await sleep(600);
const afterArrow = await tourState();
r.check('the right-arrow key advances the tour',
  afterArrow?.title === 'Make it look like you', afterArrow?.title);

await key('ArrowLeft');
await sleep(600);
const afterLeft = await tourState();
r.check('the left-arrow key goes back a step',
  afterLeft?.title === 'Your business details', afterLeft?.title);

/* The buttons move too. */
await click('[data-tour-action="next"]');
await sleep(500);
const step3 = await tourState();
r.check('Next moves within the same page', step3?.title === 'Make it look like you', step3?.title);

await click('[data-tour-action="prev"]');
await sleep(500);
const backAgain = await tourState();
r.check('Back returns to the previous step', backAgain?.title === 'Your business details', backAgain?.title);

/* A dot is a jump: dot 0 is the dashboard welcome, so it must hop back. */
await click('.tour-dot[data-tour-index="0"]');
const backHome = await waitFor(
  `location.pathname.endsWith('index.html') && !!document.querySelector('.tour-root.open')`,
  { tries: 80, gap: 250 },
);
r.check('a progress dot jumps straight to that step', !!backHome, backHome);
const homeState = await tourState();
r.check('the dot jump landed on the welcome step', homeState?.title === 'Welcome aboard', homeState?.title);

/* ==========================================================================
   C. Dismissal + persistence
   ========================================================================== */
r.section('C. Dismissing it makes it stay dismissed');

await key('Escape');
const closed = await tourGone();
r.check('Escape closes the tour', !!closed, closed);
r.check('closing records the seen flag', (await seenFlag()) === true);
r.check('the scroll lock is released',
  (await evaluate(`document.documentElement.classList.contains('tour-active')`)) === false);

await goto('index.html', 1400);
await waitFor(`window.__APP_READY__ === true`, { tries: 80, gap: 250 });
await sleep(2500); // well past the first-run timer — it must NOT fire again
r.check('a returning visit does not re-open the tour',
  (await evaluate(`!document.querySelector('.tour-root')`)) === true);
r.check('the launcher stops pulsing once the tour has been seen',
  (await evaluate(`!document.querySelector('.guide-card.is-new')`)) === true);
r.check('the sidebar Guide button is present',
  (await evaluate(`!!document.querySelector('#helpBtn')`)) === true);

/* ==========================================================================
   D. The manual
   ========================================================================== */
r.section('D. The manual (Guide button)');

await click('#helpBtn');
await waitFor(`!!document.querySelector('.help-overlay.open')`, { tries: 40, gap: 150 });
const help = JSON.parse(await evaluate(`(() => {
  const p = document.querySelector('.help-overlay');
  if (!p) return 'null';
  const body = p.querySelector('.help-body');
  return JSON.stringify({
    open: p.classList.contains('open'),
    steps: p.querySelectorAll('.help-step').length,
    numbers: [...p.querySelectorAll('.help-step-num')].map((n) => n.textContent),
    scrollable: !!body && body.scrollHeight > body.clientHeight,
    hasNote: !!p.querySelector('.help-note'),
    lock: document.documentElement.classList.contains('help-active'),
    title: (p.querySelector('#helpTitle') || {}).textContent || '',
  });
})()`) || 'null');
r.check('the Guide button opens the manual', help?.open === true, JSON.stringify(help));
r.check('the manual lists all 9 steps', help?.steps === 9, help?.steps);
r.check('the manual numbers its steps 1..9',
  help?.numbers?.join(',') === '1,2,3,4,5,6,7,8,9', help?.numbers?.join(','));
r.check('the manual is scrollable on a laptop viewport', help?.scrollable === true, help?.scrollable);
r.check('the manual carries the "stays on your device" note', help?.hasNote === true);
r.check('the manual locks the page behind it', help?.lock === true);
r.check('the manual has a title', help?.title === 'How to use this app', help?.title);

await shot('onboarding-03-manual.png');

/* The manual can launch the interactive tour. */
await click('[data-help-action="tour"]');
const fromManual = await waitForTour();
r.check('the manual can start the guided tour', !!fromManual, fromManual);
const manualTour = await tourState();
r.check('that tour starts from the beginning', manualTour?.title === 'Welcome aboard', manualTour?.title);
await key('Escape');
await tourGone();

/* The scrim (not the drawer) dismisses the manual. */
await click('#helpBtn');
await waitFor(`!!document.querySelector('.help-overlay.open')`, { tries: 40, gap: 150 });
await evaluate(`(() => { document.querySelector('.help-overlay').click(); return true; })()`);
const dismissed = await waitFor(`!document.querySelector('.help-overlay')`, { tries: 40, gap: 150 });
r.check('clicking the scrim closes the manual', !!dismissed, dismissed);

/* ==========================================================================
   E. Re-entry, anchors, and opening the view a step points into
   ========================================================================== */
r.section('E. Re-entry and anchors');

await goto('customers.html', 1400);
await waitFor(`window.__APP_READY__ === true`, { tries: 80, gap: 250 });
await click('[data-tour-start]');
const restarted = await waitForTour();
r.check('the page affordance restarts the tour', !!restarted, restarted);
await key('Escape');
await tourGone();

/* The URL a step produces when the tour carries itself there. `&view=list` and
   `&new=1` are the page states the two invoice steps need. */
const PAGE_STEPS = [
  ['index.html', 'welcome', 'Welcome aboard', null, ''],
  ['settings.html', 'business', 'Your business details', '[data-tour="business-info"]', ''],
  ['settings.html', 'logo', 'Make it look like you', '[data-tour="brand-panel"]', ''],
  ['settings.html', 'backup', 'One last thing', '[data-tour="data-tools"]', ''],
  ['products.html', 'products', 'Add what you sell', '[data-tour="product-list"]', ''],
  ['customers.html', 'customers', 'Add your customers', '[data-tour="customer-list"]', ''],
  ['invoice.html', 'new-invoice', 'Create your first invoice', '[data-tour="new-invoice"]', '&view=list'],
  ['invoice.html', 'invoice-actions', 'Save, download and send', '[data-tour="invoice-actions"]', '&new=1'],
  ['reports.html', 'reports', 'See how the business is doing', '[data-tour="report-summary"]', ''],
];

for (const [page, id, expect, target, query] of PAGE_STEPS) {
  await goto(`${page}?tour=${id}${query}`, 1400);
  const live = await waitForTour();
  const state = live ? await tourState() : null;
  r.check(`${page}: the "${id}" step resumes from a deep link`,
    !!state && state.title.startsWith(expect), state?.title || '(no tour)');
  await sleep(SETTLE);
  if (target) {
    const anchored = await evaluate(`(() => {
      const glow = document.querySelector('.tour-glow');
      const el = document.querySelector(${JSON.stringify(target)});
      if (!glow || !el) return false;
      const g = glow.getBoundingClientRect();
      return g.width > 20 && g.height > 10;
    })()`);
    r.check(`${page}: "${id}" spotlights ${target}`, anchored === true, anchored);
  }
  await key('Escape');
  await tourGone();
}

/* The actions step points at buttons that only exist in the invoice EDITOR,
   which the page does not open by default. The tour has to take the user there,
   and Back has to bring them out again. */
await goto('invoice.html?tour=new-invoice&view=list', 1600);
await waitForTour();
await click('[data-tour-action="next"]');
const intoEditor = await waitFor(
  `!!document.querySelector('.tour-root.open') && !document.querySelector('#editorView').classList.contains('hidden')`,
  { tries: 80, gap: 250 },
);
r.check('walking to the actions step opens the invoice editor', !!intoEditor, intoEditor);
await sleep(SETTLE);
const actionsSpot = JSON.parse(await evaluate(`(() => {
  const glow = document.querySelector('.tour-glow');
  if (!glow) return 'null';
  const g = glow.getBoundingClientRect();
  return JSON.stringify({ w: Math.round(g.width), h: Math.round(g.height) });
})()`) || 'null');
r.check('the spotlight lands on the editor actions',
  !!actionsSpot && actionsSpot.w > 20 && actionsSpot.h > 10, JSON.stringify(actionsSpot));

await click('[data-tour-action="prev"]');
const backToList = await waitFor(
  `!!document.querySelector('.tour-root.open') && document.querySelector('#editorView').classList.contains('hidden')`,
  { tries: 80, gap: 250 },
);
r.check('going Back returns to the invoice list', !!backToList, backToList);
await key('Escape');
await tourGone();

/* ==========================================================================
   F. Reduced motion, phone, dark
   ========================================================================== */
r.section('F. Reduced motion, phone and dark mode');

await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await goto('customers.html?tour=customers', 1400);
const reduced = await waitForTour();
r.check('the tour opens with reduced motion enabled', !!reduced, reduced);

const phone = JSON.parse(await evaluate(`(() => {
  const card = document.querySelector('.tour-card');
  if (!card) return 'null';
  const rect = card.getBoundingClientRect();
  const glow = document.querySelector('.tour-glow');
  const g = glow ? glow.getBoundingClientRect() : null;
  return JSON.stringify({
    inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
    w: Math.round(rect.width),
    glowOnTarget: !!g && g.width > 20,
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
  });
})()`) || 'null');
r.check('the card fits inside a 390px phone viewport', phone?.inViewport === true, JSON.stringify(phone));
r.check('the card is sized to the phone, not overflowing it', phone?.w <= 390, phone?.w);
r.check('no horizontal page overflow while the tour is open', phone?.pageOverflow <= 1, phone?.pageOverflow);

await evaluate(`document.documentElement.setAttribute('data-theme','dark')`);
await sleep(300);
r.check('the tour survives a dark-mode repaint',
  (await evaluate(`!!document.querySelector('.tour-root.open')`)) === true);
await shot('onboarding-04-phone-dark.png');

await send('Emulation.setEmulatedMedia', { features: [] });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

/* ==========================================================================
   G. Console
   ========================================================================== */
r.section('G. Console');
r.check('no console errors during the whole run', errors().length === 0, JSON.stringify(errors()).slice(0, 300));

const ok = r.finish();
process.exit(ok ? 0 : 1);

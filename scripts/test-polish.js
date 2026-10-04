/**
 * interaction polish verification.
 *
 * The polish layer is pure CSS, so a typo fails silently: the button still
 * works, it just stops feeling responsive. These checks assert the effects are
 * actually applied and actually fire — computed background layers, the ripple
 * node and its stacking order, the loading state contract, and that
 * prefers-reduced-motion genuinely neutralises the motion.
 *
 * Run via `npm run test:polish`, or `npm run test:e2e` for the whole set.
 */
import { CONFIG, connect, createReporter, sleep } from './lib/cdp.js';

const r = createReporter('Polish');
const { send, evaluate, goto } = await connect();

/** Poll until an expression is truthy — the app boots asynchronously. */
const waitFor = async (expr, tries = 60, gap = 250) => {
  for (let i = 0; i < tries; i++) {
    try {
      if (await evaluate(expr)) return true;
    } catch { /* mid-navigation */ }
    await sleep(gap);
  }
  return false;
};

await send('Storage.clearDataForOrigin', { origin: CONFIG.origin, storageTypes: 'all' });
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 980, deviceScaleFactor: 1, mobile: false });
await goto('index.html', 3600);
await evaluate(`(async () => { const db = await import('./js/db.js'); await db.seedSampleData(); })()`);
await goto('index.html', 2000);

/* Two things about a fresh install would otherwise defeat every interaction
   check below, and both are silent:

     1. initShell() runs asynchronously, and the ripple delegate is only
        attached once it has. Pressing before then simply produces no ripple.
     2. The onboarding tour opens itself on a fresh install, and its dimming
        panels swallow pointer events — so a click aimed at a button lands on
        the overlay instead.

   Wait for readiness, record the tour as seen, then reload onto a plain page. */
await waitFor(`window.__APP_READY__ === true`);
await evaluate(`(async () => { (await import('./js/onboarding.js')).markOnboardingSeen(); return true; })()`);
await goto('index.html', 3000);
await waitFor(`window.__APP_READY__ === true`);
await sleep(300);
r.check('the page is interactive and free of the first-run tour',
  (await evaluate(`window.__APP_READY__ === true && !document.querySelector('.tour-root')`)) === true);

/* ---------- Shine sweep is a two-layer background that animates on hover ---------- */
r.section('Button shine');
// Count top-level layers by paren depth — splitting on '),' is wrong because
// it also matches inside `rgb(60, 162, 65)`.
const bg = await evaluate(`(() => {
  const cs = getComputedStyle(document.querySelector('.btn-primary'));
  const img = cs.backgroundImage;
  let depth = 0, layers = 1;
  for (const ch of img) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) layers++;
  }
  return JSON.stringify({ layers, img, pos: cs.backgroundPosition, size: cs.backgroundSize });
})()`);
const b = JSON.parse(bg);
r.eq('primary button has 2 background layers', b.layers, 2);
r.check('shine layer is the white sweep', /rgba\(255, 255, 255/.test(b.img), b.img.slice(0, 60));
r.check('base layer is the brand gradient', /linear-gradient\(135deg/.test(b.img), b.img.slice(-70));
r.check('shine layer parked off-canvas', /-50%/.test(b.pos), b.pos);

/* Bring the button into view before clicking it. A synthetic mouse event at an
   off-screen point hits nothing at all — and the dashboard's first .btn-primary
   now sits just below a 980px fold, so this is not a theoretical concern. */
await evaluate(`(() => { document.querySelector('.btn-primary').scrollIntoView({ block: 'center' }); return true; })()`);
await sleep(400);
const rect = JSON.parse(
  await evaluate(`(() => { const b = document.querySelector('.btn-primary'); const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width/2, y: r.top + r.height/2, onScreen: r.top >= 0 && r.bottom <= innerHeight }); })()`),
);
r.check('the primary button is on screen to click', rect.onScreen === true, JSON.stringify(rect));
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, buttons: 0 });
await sleep(700);
const hovered = await evaluate(`getComputedStyle(document.querySelector('.btn-primary')).backgroundPosition`);
r.check('shine sweeps to the far side on hover', /150%/.test(hovered), hovered);
const lifted = await evaluate(`getComputedStyle(document.querySelector('.btn-primary')).transform`);
const noHover = await evaluate(`matchMedia('(hover: none)').matches`);
r.check('button obeys the device hover policy', noHover ? lifted === 'none' : lifted !== 'none', `hover:none=${noHover}, transform=${lifted}`);

/* ---------- Ripple ---------- */
r.section('Ripple');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
await sleep(60);
r.check('ripple node created on press', (await evaluate(`document.querySelectorAll('.btn-primary .ripple').length`)) > 0, 'count');
r.eq('ripple is behind the label (z-index -1)', await evaluate(`getComputedStyle(document.querySelector('.btn-primary .ripple')).zIndex`), '-1');
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
await sleep(900);
r.eq('ripple cleans itself up', await evaluate(`document.querySelectorAll('.btn-primary .ripple').length`), 0);

/* ---------- Loading state ---------- */
r.section('Loading state');
const load = await evaluate(`(async () => {
  const u = await import('./js/utils.js');
  const b = document.querySelector('.btn-primary');
  u.setLoading(b, true);
  const on = { spinner: !!b.querySelector('.btn-spinner'), busy: b.getAttribute('aria-busy'), cls: b.classList.contains('loading') };
  u.setLoading(b, false);
  const off = { spinner: !!b.querySelector('.btn-spinner'), busy: b.getAttribute('aria-busy') };
  return JSON.stringify({ on, off });
})()`);
const L = JSON.parse(load);
r.check('spinner inserted', L.on.spinner === true, L.on.spinner);
r.eq('aria-busy set', L.on.busy, 'true');
r.check('loading class applied', L.on.cls === true, L.on.cls);
r.check('spinner removed on restore', L.off.spinner === false, L.off.spinner);
r.eq('aria-busy cleared', L.off.busy, null);

/* ---------- Switch, checkbox, tooltip, spinner ---------- */
r.section('Components');
await goto('settings.html', 2800);
const sw = await evaluate(`(() => {
  const s = document.querySelector('#setDarkMode')?.closest('.switch');
  if (!s) return JSON.stringify({ skip: true });
  return JSON.stringify({
    trackShadow: getComputedStyle(s.querySelector('.slider')).boxShadow,
    radius: getComputedStyle(s.querySelector('.slider')).borderRadius
  });
})()`);
const S = JSON.parse(sw);
r.check('switch track is recessed', /inset/.test(S.trackShadow || ''), S.trackShadow);

const tip = await evaluate(`(() => {
  const t = document.querySelector('.contrast-pill.tip');
  if (!t) return JSON.stringify({ skip: true });
  const cs = getComputedStyle(t, '::after');
  return JSON.stringify({ content: cs.content, hasTip: t.hasAttribute('data-tip'), label: t.getAttribute('aria-label') });
})()`);
const T = JSON.parse(tip);
r.check('contrast pill has a tooltip', T.hasTip === true && /WCAG/.test(T.content || ''), T.content);
r.check('tooltip text is also the aria-label', /WCAG/.test(T.label || ''), (T.label || '').slice(0, 60));

/* A centred tooltip needs ~120px of clearance each side (max-width 240px).
   Anything closer to the right edge than that must use the anchored variant,
   or it renders off-screen — which is exactly what happened on the contrast
   pills until .tip-end was added. */
r.section('Tooltip containment');
const tips = JSON.parse(
  await evaluate(`JSON.stringify({
    vw: window.innerWidth,
    items: Array.from(document.querySelectorAll('.tip')).map((el) => {
      const r = el.getBoundingClientRect();
      return { right: r.right, anchored: el.classList.contains('tip-end') };
    })
  })`),
);
r.check('found tooltips to check', tips.items.length > 0, tips.items.length);
const stranded = tips.items.filter((t) => tips.vw - t.right < 120 && !t.anchored);
r.check('tips near the right edge are right-anchored', stranded.length === 0, JSON.stringify(stranded));

await goto('invoice.html', 2800);
const cb = await evaluate(`(() => {
  const c = document.querySelector('.checkbox input[type="checkbox"]');
  if (!c) return JSON.stringify({ skip: true });
  const cs = getComputedStyle(c);
  return JSON.stringify({ appearance: cs.appearance || cs.webkitAppearance, w: cs.width, r: cs.borderRadius });
})()`);
const C = JSON.parse(cb);
if (!C.skip) {
  r.eq('checkbox is custom-styled (appearance none)', C.appearance, 'none');
  r.eq('checkbox sized 20px', C.w, '20px');
}
r.check('spinner utility defined', (await evaluate(`(() => {
  const d = document.createElement('div'); d.className = 'spinner'; document.body.appendChild(d);
  const anim = getComputedStyle(d).animationName; d.remove(); return anim;
})()`)) === 'spin', 'spin');

/* ---------- Reduced motion neutralises everything ---------- */
r.section('Reduced motion');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await goto('index.html', 2600);
r.eq('ripple disabled under reduced motion', await evaluate(`(() => {
  const b = document.querySelector('.btn-primary');
  const r = b.getBoundingClientRect();
  b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
  return document.querySelectorAll('.btn-primary .ripple').length;
})()`), 0);
const dur = await evaluate(`getComputedStyle(document.querySelector('.btn-primary')).transitionDuration`);
r.check('transitions collapsed under reduced motion', /0\.0000|0s|1e-05/.test(dur) || parseFloat(dur) < 0.01, dur);
await send('Emulation.setEmulatedMedia', { features: [] });

const ok = r.finish();
process.exit(ok ? 0 : 1);

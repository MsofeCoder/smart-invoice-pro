/**
 * accessibility verification.
 *
 * The brand customizer is a hand-rolled radio group, which is exactly the kind
 * of widget that looks fine with a mouse and is completely unusable with a
 * keyboard or screen reader. These checks drive it with real key events.
 *
 * Run via `npm run test:e2e`, or standalone against a running pair:
 *     node scripts/test-a11y.js
 */
import fs from 'node:fs';
import { CONFIG, connect, createReporter, sleep } from './lib/cdp.js';

const r = createReporter('A11y');
fs.mkdirSync(CONFIG.shots, { recursive: true });

const { send, evaluate, shot } = await connect();

const key = async (k, code) => {
  const vk = { ArrowRight: 39, ArrowLeft: 37, ArrowDown: 40, ArrowUp: 38, Tab: 9, Enter: 13, ' ': 32 }[k] || 0;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  await sleep(350);
};

/* Start from a known state: default preset, light theme. */
await send('Storage.clearDataForOrigin', { origin: CONFIG.origin, storageTypes: 'all' });
await send('Page.navigate', { url: `${CONFIG.origin}/settings.html` });
await send('Page.bringToFront');
await sleep(3600);

/* ---------- Radio group semantics ---------- */
r.section('Preset radio group');
const roles = JSON.parse(
  await evaluate(`JSON.stringify({
    group: document.querySelector('#brandPresets').getAttribute('role'),
    radios: document.querySelectorAll('#brandPresets [role="radio"]').length,
    tabbable: document.querySelectorAll('#brandPresets [role="radio"][tabindex="0"]').length,
    checked: document.querySelectorAll('#brandPresets [aria-checked="true"]').length
  })`),
);
r.eq('presets have radiogroup role', roles.group, 'radiogroup');
r.eq('all 12 presets are radios', roles.radios, 12);
r.eq('exactly one preset is tabbable (roving tabindex)', roles.tabbable, 1);
r.eq('exactly one preset is checked', roles.checked, 1);

/* ---------- Arrow-key navigation ---------- */
await evaluate(`document.querySelector('#brandPresets [tabindex="0"]').focus()`);
const before = await evaluate(`document.querySelector('#brandPresets .swatch.active')?.dataset.preset`);
await key('ArrowRight', 'ArrowRight');
await key('ArrowRight', 'ArrowRight');
const af = JSON.parse(
  await evaluate(`JSON.stringify({
    active: document.querySelector('#brandPresets .swatch.active')?.dataset.preset,
    checked: document.querySelectorAll('#brandPresets [aria-checked="true"]').length,
    tabbable: document.querySelectorAll('#brandPresets [role="radio"][tabindex="0"]').length,
    brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()
  })`),
);
r.check('ArrowRight moves the selection', af.active !== before, `${before} -> ${af.active}`);
r.eq('still exactly one checked after arrow nav', af.checked, 1);
r.eq('roving tabindex preserved', af.tabbable, 1);
r.check('brand actually changed via keyboard', /^#/.test(af.brand), af.brand);

/* ArrowLeft must wrap back, not dead-end. */
const beforeBack = af.active;
await key('ArrowLeft', 'ArrowLeft');
const back = await evaluate(`document.querySelector('#brandPresets .swatch.active')?.dataset.preset`);
r.check('ArrowLeft reverses the selection', back !== beforeBack, `${beforeBack} -> ${back}`);

/* ---------- Sidebar style radio group ---------- */
r.section('Sidebar style radio group');
await evaluate(`document.querySelector('#brandSidebar [tabindex="0"]').focus()`);
const sbBefore = await evaluate(`document.querySelector('#brandSidebar button.active')?.dataset.sidebar`);
await key('ArrowRight', 'ArrowRight');
const sbAfter = await evaluate(`document.querySelector('#brandSidebar button.active')?.dataset.sidebar`);
r.check('sidebar style arrow nav works', sbAfter !== sbBefore, `${sbBefore} -> ${sbAfter}`);
r.eq(
  'sidebar group keeps a single tabbable item',
  await evaluate(`document.querySelectorAll('#brandSidebar [tabindex="0"]').length`),
  1,
);

/* ---------- Accessible names ----------
   A name can come from aria-label, a <label for>, or a wrapping <label>. Any of
   the three is valid, so resolve the name rather than demanding one mechanism. */
r.section('Accessible names');
const NAMES = await evaluate(`(() => {
  /* Text with aria-hidden subtrees removed.
   *
   * This is the accessible-name algorithm's own rule, and using raw textContent
   * instead makes the suite lie: a decorative tag marked aria-hidden="true"
   * still contributes its text to textContent, so a gated field would be
   * reported as "App Name Pro" — a name no browser ever announces. aria-hidden
   * content is exactly the content a screen reader does not read out. */
  const visibleText = (node) => {
    if (!node) return '';
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    if (node.getAttribute('aria-hidden') === 'true') return '';
    return [...node.childNodes].map(visibleText).join('');
  };
  const nameOf = (el) => {
    if (!el) return null;
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const t = labelledby.split(/\\s+/).map((id) => visibleText(document.getElementById(id))).join(' ').trim();
      if (t) return t;
    }
    if (el.id) {
      const forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (forLabel && visibleText(forLabel).trim()) return visibleText(forLabel).trim();
    }
    const wrapping = el.closest('label');
    if (wrapping && visibleText(wrapping).trim()) return visibleText(wrapping).trim();
    // Buttons take their name from their own text.
    if (el.tagName === 'BUTTON') {
      const t = visibleText(el).trim();
      if (t) return t;
    }
    return null;
  };
  const out = {};
  for (const id of [
    'brandPrimary', 'brandAccent', 'brandPrimaryHex', 'brandAccentHex',
    'brandRadius', 'brandAppName', 'brandAppTagline', 'brandReset',
    'setBusinessName', 'setAddress', 'setRegion', 'setDistrict', 'setCountry',
    'setPhone', 'setEmail', 'setWebsite', 'setTin', 'setVrn', 'setRegNumber',
    'setWhatsapp', 'setLogoInput', 'setSignatureInput', 'setStampInput',
    'setDefaultCurrency', 'setLanguage',
    'setDefaultTax', 'setInvoicePrefix', 'setNumberFormat', 'setInvoiceFooter',
    'setBankName', 'setBankAccountName', 'setBankAccountNumber', 'setMobileMoney',
    'setDarkMode'
  ]) out[id] = nameOf(document.getElementById(id));
  out.__groups = {
    presets: nameOf(document.getElementById('brandPresets')),
    sidebar: nameOf(document.getElementById('brandSidebar'))
  };
  return JSON.stringify(out);
})()`);
const nm = JSON.parse(NAMES);

const nameless = Object.entries(nm).filter(([k, v]) => !k.startsWith('__') && !v).map(([k]) => k);
r.check('every settings control has an accessible name', nameless.length === 0, nameless.join(', '));
r.eq('colour input named', nm.brandPrimary, 'Primary brand color');
r.eq('app-name input named', nm.brandAppName, 'App Name');
r.eq('business-name input named', nm.setBusinessName, 'Business Name');
/* The signature and stamp uploaders are Pro-gated, so on the free plan they
   carry a "Pro" tag. That tag must stay OUT of the accessible name — it is a
   qualifier, and it is delivered through aria-describedby instead. Asserting the
   exact names here is what stops it leaking back in. */
r.eq('signature input named', nm.setSignatureInput, 'Digital Signature');
r.eq('stamp input named', nm.setStampInput, 'Company Stamp');
r.eq('dark-mode switch named', nm.setDarkMode, 'Dark mode');
r.eq('preset group named', nm.__groups.presets, 'Brand color presets');
r.eq('sidebar group named', nm.__groups.sidebar, 'Sidebar style');

/* No orphan <label> elements: a label with no control is invalid and announces
   nothing. Group headings must be spans (or use aria-labelledby). */
r.eq(
  'no orphan <label> elements',
  await evaluate(`Array.from(document.querySelectorAll('label'))
    .filter((l) => !l.control && !l.querySelector('input,select,textarea')).length`),
  0,
);

/* ---------- Custom brand must not strand the keyboard ----------
   Regression guard: with a custom (non-preset) palette, no swatch is "active".
   If tabindex="0" were only applied to the active swatch, the whole group would
   become unreachable by keyboard. */
r.section('Keyboard reachable with a custom palette');
await evaluate(
  `(() => { const el = document.querySelector('#brandPrimaryHex'); el.value = '#7B1FA2'; el.dispatchEvent(new Event('change')); return true; })()`,
);
await sleep(700);
const custom = JSON.parse(
  await evaluate(`JSON.stringify({
    active: document.querySelectorAll('#brandPresets .swatch.active').length,
    tabbable: document.querySelectorAll('#brandPresets [role="radio"][tabindex="0"]').length,
    brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()
  })`),
);
r.eq('custom palette clears active swatch', custom.active, 0);
r.eq('custom palette leaves the group keyboard-reachable', custom.tabbable, 1);
r.eq('custom palette applied', custom.brand, '#7B1FA2');

const focusable = await evaluate(`(() => {
  const el = document.querySelector('#brandPresets [tabindex="0"]');
  el.focus();
  return document.activeElement === el;
})()`);
r.check('focus() lands on the fallback swatch', focusable === true, focusable);

await shot('24-brand-customizer-default.png');

const ok = r.finish();
process.exit(ok ? 0 : 1);

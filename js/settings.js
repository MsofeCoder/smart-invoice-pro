/**
 * Settings module
 * Business profile, preferences, bank/mobile money, logo, backup/restore/reset.
 */
import { $, $$, escapeHTML, validateNumberInputs, sanitizeString, toNumber, toast, confirmDialog, readFileAsDataURL, readFileAsText, downloadBlob, debounce, initials, withLoading } from './utils.js';
import {
  getSetting, setSetting, bulkSetSettings, exportAllData, importAllData, clear,
} from './storageService.js';
import { getCurrencies, saveCurrencies, getDefaultCurrencyCode, setDefaultCurrencyCode } from './currency.js';
import { initShell, refreshBrand, getActiveBrand } from './shell.js';
import {
  CONFIG, readStorage, writeStorage, removeStorage, appSlug, paymentGateways, allowWhiteLabel,
} from './config.js';
import {
  loadLicense, getLicense, setPlan, makeLicenseKey, checkInvoiceQuota, resetLicense,
  hasFeature, gateFeature, featureGateMessage, FEATURE_LABELS,
} from './licenseService.js';
import {
  PRESETS, SIDEBAR_STYLES, DEFAULT_BRAND, RADIUS_MIN, RADIUS_MAX,
  normalizeBrand, matchPreset, buildPalette, applyPalette, saveBrand,
  contrastRatio, contrastGrade, currentTheme,
  resolveAppName, resolveAppTagline,
} from './brand.js';

let state = {
  company: {},
  currencies: [],
  defaultCurrency: 'TZS',
  language: 'en',
  logoDataUrl: null,
  signatureDataUrl: null,
  stampDataUrl: null,
};

/* ================= Brand & Appearance ================= */

let brandState = { ...DEFAULT_BRAND };

/** Sidebar background is a gradient, so contrast is measured against its mid stop. */
function sidebarSampleBg(vars, sidebarStyle) {
  if (sidebarStyle === 'light') return currentTheme() === 'dark' ? '#1B211B' : '#FFFFFF';
  return vars['--brand-dark'];
}

/**
 * Arrow-key navigation for a radiogroup built from buttons (WAI-ARIA radio pattern).
 * Without this, role="radio" is a lie: keyboard users expect arrows to move and select.
 * Only the selected item stays in the tab order (roving tabindex).
 */
function bindRadioKeys(wrap, itemSelector) {
  if (!wrap) return;
  wrap.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
    const items = $$(itemSelector, wrap);
    const idx = items.indexOf(document.activeElement);
    if (idx === -1) return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = items[(idx + dir + items.length) % items.length];
    next.focus();
    next.click();
  });
}

/**
 * Selecting an item re-renders the whole group, which replaces every button and
 * silently drops focus to <body>. Arrow keys would then work exactly once, and
 * a screen-reader user would be dumped out of the group. Snapshot which item
 * held focus before the repaint so it can be restored afterwards.
 *
 * Returns the key of the focused item, or null when focus was outside the group.
 */
function captureFocus(wrap, key) {
  if (!wrap.contains(document.activeElement)) return null;
  return document.activeElement.dataset[key] ?? '';
}

function restoreFocus(wrap, key, focusedKey) {
  if (focusedKey === null) return;
  const items = $$(`[data-${key}]`, wrap);
  const target =
    items.find((el) => el.dataset[key] === focusedKey) ||
    items.find((el) => el.tabIndex === 0);
  if (target) target.focus();
}

function renderPresets() {
  const wrap = $('#brandPresets');
  if (!wrap) return;
  const focusedKey = captureFocus(wrap, 'preset');
  // A custom palette matches no preset. Per the ARIA radio pattern the group must
  // still be reachable, so the first item takes tabindex="0" when nothing matches —
  // otherwise keyboard users cannot tab into the preset picker at all.
  const anyActive = PRESETS.some((p) => p.id === brandState.preset);
  wrap.innerHTML = PRESETS.map((p, i) => {
    const active = brandState.preset === p.id;
    const tabbable = active || (!anyActive && i === 0);
    return `<button type="button" class="swatch${active ? ' active' : ''}" data-preset="${escapeHTML(p.id)}"
      role="radio" aria-checked="${active}" tabindex="${tabbable ? '0' : '-1'}" title="${escapeHTML(p.name)}">
      <span class="sw-bar"><i style="background:${escapeHTML(p.primary)}"></i><i style="background:${escapeHTML(p.accent)}"></i></span>
      <span class="sw-name">${escapeHTML(p.name)}
        <span class="sw-check" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
      </span>
    </button>`;
  }).join('');
  $$('[data-preset]', wrap).forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = PRESETS.find((x) => x.id === btn.dataset.preset);
      if (!p) return;
      brandState.primary = p.primary;
      brandState.accent = p.accent;
      brandState.preset = p.id;
      syncBrandInputs();
      commitBrand();
    });
  });
  restoreFocus(wrap, 'preset', focusedKey);
}

function renderSidebarStyles() {
  const wrap = $('#brandSidebar');
  if (!wrap) return;
  const focusedKey = captureFocus(wrap, 'sidebar');
  wrap.innerHTML = SIDEBAR_STYLES.map((s) => {
    const active = brandState.sidebar === s.id;
    return `<button type="button" class="${active ? 'active' : ''}" data-sidebar="${escapeHTML(s.id)}"
      role="radio" aria-checked="${active}" tabindex="${active ? '0' : '-1'}" title="${escapeHTML(s.hint)}">${escapeHTML(s.name)}</button>`;
  }).join('');
  $$('[data-sidebar]', wrap).forEach((btn) => {
    btn.addEventListener('click', () => {
      brandState.sidebar = btn.dataset.sidebar;
      renderSidebarStyles();
      commitBrand();
    });
  });
  restoreFocus(wrap, 'sidebar', focusedKey);
}

function renderPreviewMeta() {
  const name = resolveAppName(brandState, state.company);
  const tag = resolveAppTagline(brandState);
  const t = $('#bpTitle'); if (t) t.textContent = name;
  const s = $('#bpSub'); if (s) s.textContent = tag;
  const l = $('#bpLogo'); if (l) l.textContent = initials(state.company?.businessName) || 'CI';
}

function renderContrast() {
  const wrap = $('#brandContrast');
  if (!wrap) return;
  const vars = buildPalette(brandState, currentTheme());
  const surface = currentTheme() === 'dark' ? '#1B211B' : '#FFFFFF';
  const rows = [
    { label: 'Brand text on page', fg: vars['--brand-ink'], bg: surface },
    { label: 'Text on primary fill', fg: vars['--brand-contrast'], bg: vars['--brand'] },
    { label: 'Text on accent fill', fg: vars['--gold-contrast'], bg: vars['--gold'] },
    { label: 'Sidebar navigation', fg: vars['--sidebar-fg'], bg: sidebarSampleBg(vars, brandState.sidebar) },
  ];
  wrap.innerHTML = rows.map((r) => {
    const ratio = contrastRatio(r.fg, r.bg);
    const g = contrastGrade(ratio);
    // "AAA 8.2:1" is meaningless without the threshold, so spell it out on hover
    // and expose the same sentence to screen readers.
    const explain = `${r.label}: ${ratio.toFixed(2)}:1. WCAG needs 4.5:1 for normal text (AA) and 7:1 for AAA.`;
    return `<div class="contrast-item">
      <span class="ci-sample" style="background:${escapeHTML(r.bg)};color:${escapeHTML(r.fg)}">Aa</span>
      <span class="ci-label">${escapeHTML(r.label)}</span>
      <span class="contrast-pill tip tip-end ${g.level}" data-tip="${escapeHTML(explain)}"
        aria-label="${escapeHTML(explain)}">${g.label} ${ratio.toFixed(1)}:1</span>
    </div>`;
  }).join('');
}

function syncBrandInputs() {
  const set = (sel, val) => { const el = $(sel); if (el) el.value = val; };
  set('#brandPrimary', brandState.primary);
  set('#brandPrimaryHex', brandState.primary);
  set('#brandAccent', brandState.accent);
  set('#brandAccentHex', brandState.accent);
  set('#brandRadius', String(brandState.radius));
  set('#brandAppName', brandState.appName);
  set('#brandAppTagline', brandState.appTagline);
  const rv = $('#brandRadiusVal');
  if (rv) rv.textContent = `${brandState.radius}px`;
  renderPresets();
  renderSidebarStyles();
  renderPreviewMeta();
  renderContrast();
}

/** Reflect the white-label name in the sidebar and the tab title, live. */
function applyIdentity() {
  const name = resolveAppName(brandState, state.company);
  const tag = resolveAppTagline(brandState);
  const nameEl = $('#sidebarBrandName'); if (nameEl) nameEl.textContent = name;
  const subEl = $('#sidebarBrandSub'); if (subEl) subEl.textContent = tag;
  const sep = document.title.indexOf(' — ');
  const base = sep !== -1 ? document.title.slice(0, sep) : document.title;
  document.title = `${base} — ${name}`;
  renderPreviewMeta();
}

/**
 * Apply instantly (WYSIWYG) and persist. Theming is a visual, exploratory
 * choice — making the user hit "Save" to see it would be hostile.
 */
const commitBrand = debounce(async () => {
  brandState = normalizeBrand(brandState);
  refreshBrand(brandState);
  renderContrast();
  applyIdentity();
  try {
    await saveBrand(brandState);
    window.__BRAND__ = brandState;
  } catch (err) {
    toast('Could not save appearance: ' + err.message, 'error');
  }
}, 200);

function bindBrandControls() {
  const pair = (colorSel, hexSel, key) => {
    const colorEl = $(colorSel);
    const hexEl = $(hexSel);
    if (colorEl) {
      colorEl.addEventListener('input', () => {
        brandState[key] = colorEl.value.toUpperCase();
        brandState.preset = matchPreset(brandState.primary, brandState.accent);
        if (hexEl) hexEl.value = brandState[key];
        renderPresets();
        commitBrand();
      });
    }
    if (hexEl) {
      const applyHex = () => {
        const v = hexEl.value.trim();
        if (!/^#?[0-9a-fA-F]{6}$/.test(v)) {
          hexEl.value = brandState[key];
          return;
        }
        const norm = (v.startsWith('#') ? v : '#' + v).toUpperCase();
        brandState[key] = norm;
        brandState.preset = matchPreset(brandState.primary, brandState.accent);
        if (colorEl) colorEl.value = norm;
        hexEl.value = norm;
        renderPresets();
        commitBrand();
      };
      hexEl.addEventListener('change', applyHex);
      hexEl.addEventListener('blur', applyHex);
    }
  };
  pair('#brandPrimary', '#brandPrimaryHex', 'primary');
  pair('#brandAccent', '#brandAccentHex', 'accent');

  const radius = $('#brandRadius');
  if (radius) {
    radius.addEventListener('input', () => {
      brandState.radius = Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, Number(radius.value) || 0));
      const rv = $('#brandRadiusVal');
      if (rv) rv.textContent = `${brandState.radius}px`;
      commitBrand();
    });
  }

  const nameEl = $('#brandAppName');
  if (nameEl) nameEl.addEventListener('input', () => { brandState.appName = nameEl.value; commitBrand(); });
  const tagEl = $('#brandAppTagline');
  if (tagEl) tagEl.addEventListener('input', () => { brandState.appTagline = tagEl.value; commitBrand(); });

  $('#brandReset')?.addEventListener('click', async () => {
    brandState = { ...DEFAULT_BRAND };
    syncBrandInputs();
    refreshBrand(brandState);
    applyIdentity();
    try {
      await saveBrand(brandState);
      window.__BRAND__ = brandState;
      toast('Appearance reset to default', 'success');
    } catch (err) {
      toast('Reset failed: ' + err.message, 'error');
    }
  });

  // Dark mode re-derives the palette, so refresh the readout with it.
  $('#themeToggle')?.addEventListener('click', () => setTimeout(renderContrast, 0));
}

function initBrandUI() {
  brandState = { ...getActiveBrand() };
  syncBrandInputs();
  bindBrandControls();
  // Bound once — the wrappers persist across re-renders, only their children change.
  bindRadioKeys($('#brandPresets'), '[data-preset]');
  bindRadioKeys($('#brandSidebar'), '[data-sidebar]');
}

/**
 * Read a logo file and normalise it to a PNG data URL.
 *
 * The PDF builder embeds the stored bytes verbatim, so the format matters:
 *   - an SVG has no raster form jsPDF can consume, so it silently disappears
 *     from the PDF (the preview still shows it — the worst kind of mismatch),
 *   - a JPEG or WebP is re-encoded and can bloat the PDF by an order of
 *     magnitude (a 6 KB logo produced a 128 KB PDF).
 *
 * Rasterising once, at upload, into a size-bounded PNG keeps the preview, the
 * PDF and the print sheet identical and small, and preserves transparency.
 * Falls back to the raw data URL if the browser cannot decode the image.
 */
async function readImageAsPng(file) {
  const raw = await readFileAsDataURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Image could not be decoded'));
      el.src = raw;
    });
    // The PDF draws the logo at 22 mm; 512 px is ~590 dpi, far past what any
    // printer resolves, and it caps the stored base64 at a sane size.
    const MAX = 512;
    const srcW = img.naturalWidth || img.width || 300;
    const srcH = img.naturalHeight || img.height || 150;
    const scale = Math.min(1, MAX / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return raw;
    ctx.drawImage(img, 0, 0, w, h);
    const png = canvas.toDataURL('image/png');
    // An implausibly short result means the draw produced nothing useful.
    return png && png.length > 128 ? png : raw;
  } catch {
    return raw;
  }
}

/** Redraw all three artwork previews from `state`. */
function renderArtwork() {
  const draw = (preview, value, empty, label) => {
    const box = $(preview);
    if (!box) return;
    box.innerHTML = value
      ? `<img src="${value}" alt="${label}">`
      : `<span class="text-faint text-xs">${empty}</span>`;
  };
  draw('#setLogoPreview', state.logoDataUrl, 'No logo', 'Logo');
  draw('#setSignaturePreview', state.signatureDataUrl, 'None', 'Signature');
  draw('#setStampPreview', state.stampDataUrl, 'None', 'Stamp');
}

/**
 * Mark a control as locked by the current plan.
 *
 * Locked, never hidden. A feature the user cannot see is a feature they will
 * never upgrade for, and discoverability is the entire point of a free tier —
 * so the control keeps its place in the form (the layout does not jump when a
 * plan is activated) and gains a "Pro" tag beside its label.
 */
function markLocked(el, feature) {
  el.classList.add('is-locked');
  const field = el.closest('.field');
  if (!field) return;
  field.classList.add('is-locked');
  const label = field.querySelector('label, .field-label');
  if (!label || label.querySelector('.pro-tag')) return;

  const msg = featureGateMessage(feature);

  // The visible tag is aria-hidden, and it has to be.
  //
  // It sits INSIDE the <label>, and a control's accessible name is computed
  // from its label's text — so a plain tag here renames the field to
  // "App Name Pro". That is not the name of the field, and it silently breaks
  // the contract `test-a11y.js` enforces. A field's name is its name; "Pro" is
  // a qualifier, and a qualifier is a description.
  label.insertAdjacentHTML(
    'beforeend',
    ` <span class="pro-tag" aria-hidden="true" title="${escapeHTML(msg)}">Pro</span>`,
  );

  // So the qualifier is delivered as a description instead, which is what
  // aria-describedby is for. A screen reader now announces
  // "App Name, available on the Pro plan, read only" — the name stays intact
  // and the reason the field will not accept input is still conveyed.
  const noteId = `${el.id || 'locked'}-pro-note`;
  if (!document.getElementById(noteId)) {
    const note = document.createElement('span');
    note.id = noteId;
    note.className = 'sr-only';
    note.textContent = msg;
    field.appendChild(note);
  }
  const refs = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
  if (!refs.includes(noteId)) el.setAttribute('aria-describedby', [...refs, noteId].join(' '));
}

/**
 * Wire one artwork uploader: a file input, a preview box and a Remove button.
 *
 * The three of them (logo, signature, stamp) differ only in their element ids,
 * their empty-state wording, which `state` key they write and whether the plan
 * gates them, and they all need the same guards — so they share one binder
 * rather than three near-identical listeners.
 *
 * `feature` is optional. The logo is free on every plan; the signature and the
 * stamp are Pro, so their pickers stay shut and route the press to the upgrade
 * prompt. Existing artwork is still previewed — a lapsed Pro user's signature
 * is not deleted, it just cannot be replaced.
 */
function bindArtworkUploader({ input, remove, empty, label, key, feature = null }) {
  const inputEl = $(input);
  if (!inputEl) return;

  if (feature && !hasFeature(feature)) {
    markLocked(inputEl, feature);
    $(remove)?.setAttribute('disabled', 'disabled');
    // preventDefault on the click stops the file picker opening at all, so the
    // gate is the first thing the user meets rather than a rejection after
    // they have chosen a file.
    inputEl.addEventListener('click', (e) => {
      e.preventDefault();
      gateFeature(feature);
    });
    return;
  }

  inputEl.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast(`${label} must be under 2MB`, 'error'); return; }
    try {
      state[key] = await readImageAsPng(file);
      renderArtwork();
      toast(`${label} selected — click Save Settings to apply`, 'info');
    } catch {
      toast(`Failed to read ${label.toLowerCase()}`, 'error');
    }
  });

  $(remove)?.addEventListener('click', () => {
    state[key] = null;
    renderArtwork();
    inputEl.value = '';
  });
}

/**
 * Reflect the active plan across the Settings screen.
 *
 * Runs after `loadLicense()`, because the plan is what decides the answer.
 *
 * The App Name and App Tagline are locked together: they are one white-label
 * identity control (the tagline is the line printed under the name), so letting
 * a free user rename half of it would be arbitrary. The Business Name below is
 * NOT locked — that is the customer's own data, printed on their invoices,
 * and taking it hostage would make the free tier useless rather than tempting.
 *
 * Inputs are made read-only rather than disabled: a disabled input leaves the
 * tab order and announces nothing, whereas read-only keeps it reachable so a
 * keyboard or screen-reader user can get to the upgrade prompt.
 */
function applyPlanLocks() {
  if (hasFeature('custom-app-name')) return;

  for (const selector of ['#brandAppName', '#brandAppTagline']) {
    const el = $(selector);
    if (!el) continue;
    markLocked(el, 'custom-app-name');
    el.setAttribute('readonly', 'readonly');
    el.setAttribute('aria-readonly', 'true');
    const unlock = (e) => {
      e.preventDefault();
      el.blur();
      gateFeature('custom-app-name');
    };
    el.addEventListener('click', unlock);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') unlock(e);
    });
  }

  // The signature and stamp uploaders carry their gate into the binder, so the
  // lock badge and the blocked picker live in one place. See
  // bindArtworkUploader().
}

async function loadSettings() {
  const [company, currencies, defaultCurrency, language, logoDataUrl, signatureDataUrl, stampDataUrl] = await Promise.all([
    getSetting('company', {}),
    getCurrencies(),
    getDefaultCurrencyCode(),
    getSetting('language', 'en'),
    getSetting('logoDataUrl', null),
    getSetting('signatureDataUrl', null),
    getSetting('stampDataUrl', null),
  ]);
  state.company = company || {};
  state.currencies = currencies;
  state.defaultCurrency = defaultCurrency || 'TZS';
  state.language = language || 'en';
  state.logoDataUrl = logoDataUrl || null;
  state.signatureDataUrl = signatureDataUrl || null;
  state.stampDataUrl = stampDataUrl || null;
}

function populateForm() {
  const c = state.company;
  $('#setBusinessName').value = c.businessName || '';
  $('#setAddress').value = c.address || '';
  $('#setRegion').value = c.region || '';
  $('#setDistrict').value = c.district || '';
  $('#setCountry').value = c.country || '';
  $('#setPhone').value = c.phone || '';
  $('#setEmail').value = c.email || '';
  $('#setWebsite').value = c.website || '';
  $('#setTin').value = c.tin || '';
  $('#setVrn').value = c.vrn || '';
  $('#setRegNumber').value = c.regNumber || '';
  $('#setWhatsapp').value = c.whatsapp || '';
  $('#setBankName').value = c.bankName || '';
  $('#setBankAccountName').value = c.bankAccountName || '';
  $('#setBankAccountNumber').value = c.bankAccountNumber || '';
  $('#setMobileMoney').value = c.mobileMoney || '';
  $('#setDefaultTax').value = c.defaultTaxRate ?? 18;
  $('#setInvoicePrefix').value = c.invoicePrefix || 'INV-';
  $('#setNumberFormat').value = c.invoiceNumberFormat || 'INV-{n}';
  $('#setInvoiceFooter').value = c.invoiceFooter || 'Thank you for your business!';
  $('#setLanguage').value = state.language;
  $('#setDarkMode').checked = (readStorage('theme') || 'light') === 'dark';

  // Currency select
  const curSel = $('#setDefaultCurrency');
  curSel.innerHTML = state.currencies
    .map((cur) => `<option value="${escapeHTML(cur.code)}" ${cur.code === state.defaultCurrency ? 'selected' : ''}>${escapeHTML(cur.code)} — ${escapeHTML(cur.name)}</option>`)
    .join('');

  // Logo / signature / stamp previews
  renderArtwork();
}

async function saveSettings() {
  if (!validateNumberInputs()) return;
  const company = {
    businessName: sanitizeString($('#setBusinessName').value, 200),
    address: sanitizeString($('#setAddress').value, 300),
    region: sanitizeString($('#setRegion').value, 100),
    district: sanitizeString($('#setDistrict').value, 100),
    country: sanitizeString($('#setCountry').value, 100),
    phone: sanitizeString($('#setPhone').value, 50),
    email: sanitizeString($('#setEmail').value, 200),
    website: sanitizeString($('#setWebsite').value, 200),
    tin: sanitizeString($('#setTin').value, 50),
    vrn: sanitizeString($('#setVrn').value, 50),
    regNumber: sanitizeString($('#setRegNumber').value, 50),
    whatsapp: sanitizeString($('#setWhatsapp').value, 50),
    bankName: sanitizeString($('#setBankName').value, 100),
    bankAccountName: sanitizeString($('#setBankAccountName').value, 200),
    bankAccountNumber: sanitizeString($('#setBankAccountNumber').value, 100),
    mobileMoney: sanitizeString($('#setMobileMoney').value, 100),
    defaultTaxRate: toNumber($('#setDefaultTax').value),
    invoicePrefix: sanitizeString($('#setInvoicePrefix').value, 20),
    invoiceNumberFormat: sanitizeString($('#setNumberFormat').value, 50),
    invoiceFooter: sanitizeString($('#setInvoiceFooter').value, 200),
  };
  const language = $('#setLanguage').value;
  const defaultCurrency = $('#setDefaultCurrency').value;
  const darkMode = $('#setDarkMode').checked;

  try {
    await bulkSetSettings({
      company,
      language,
      defaultCurrency,
      logoDataUrl: state.logoDataUrl,
      signatureDataUrl: state.signatureDataUrl,
      stampDataUrl: state.stampDataUrl,
    });
    await setDefaultCurrencyCode(defaultCurrency);
    if (darkMode) {
      document.documentElement.setAttribute('data-theme', 'dark');
      writeStorage('theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      writeStorage('theme', 'light');
    }
    toast('Settings saved', 'success');
    // Business name feeds the white-label app name when no override is set.
    applyIdentity();
  } catch (err) {
    toast('Failed to save settings: ' + err.message, 'error');
  }
}

async function handleBackup(btn = null) {
  try {
    await withLoading(btn, async () => {
      const data = await exportAllData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      // Filename follows the configured slug, so a white-labelled build exports
      // its own name rather than the template's.
      downloadBlob(blob, `${appSlug()}_backup_${new Date().toISOString().slice(0, 10)}.json`);
    });
    toast('Backup downloaded', 'success');
  } catch (err) {
    toast('Backup failed: ' + err.message, 'error');
  }
}

async function handleRestore(file) {
  try {
    const text = await readFileAsText(file);
    const payload = JSON.parse(text);
    const counts = await importAllData(payload);
    toast(`Restored: ${counts.invoices} invoices, ${counts.customers} customers, ${counts.products} products`, 'success', 5000);
    setTimeout(() => location.reload(), 1200);
  } catch (err) {
    toast('Restore failed: ' + err.message, 'error');
  }
}

async function handleReset() {
  const ok = await confirmDialog({
    title: 'Reset All Data',
    message: 'This will permanently delete ALL invoices, customers, products and payments. This cannot be undone. Continue?',
    confirmText: 'Delete Everything',
    danger: true,
  });
  if (!ok) return;
  try {
    await Promise.all([
      clear('settings'),
      clear('customers'),
      clear('products'),
      clear('invoices'),
      clear('payments'),
      clear('syncQueue'),
    ]);
    removeStorage('theme');
    removeStorage('brand');
    // Clearing the settings store already drops the stored licence, but doing
    // it explicitly keeps the intent visible and survives any future change to
    // what "reset" clears. Must run AFTER the clear, or it would be wiped too.
    await resetLicense();
    toast('All data cleared', 'success');
    setTimeout(() => location.reload(), 1000);
  } catch (err) {
    toast('Reset failed: ' + err.message, 'error');
  }
}

/* ================= Subscription, plans & payment gateways =================
   UI placeholders. Nothing here charges anyone: `enabled` is false for every
   gateway in js/app.config.js until real credentials and a server-side callback
   exist. See the warning rendered next to the gateway list.

   Feature labels come from js/licenseService.js so the plan cards and the
   upgrade prompt can never describe the same feature two different ways. */

function planPriceLabel(plan) {
  if (plan.price === null || plan.price === undefined) return 'Contact us';
  if (plan.price === 0) return 'Free';
  return `${Number(plan.price).toLocaleString()} <small>${escapeHTML(plan.currency)} / ${escapeHTML(plan.period || 'month')}</small>`;
}

function planLimitLabel(plan) {
  return plan.invoiceLimitPerMonth === null
    ? 'Unlimited invoices'
    : `Up to ${plan.invoiceLimitPerMonth} invoices / month`;
}

function renderPlans() {
  const grid = $('#planGrid');
  const select = $('#licensePlanSelect');
  const plans = Object.values(CONFIG.plans || {});
  if (!plans.length) return;

  if (grid) {
    grid.innerHTML = plans.map((plan) => `
      <div class="plan-card" data-plan="${escapeHTML(plan.id)}">
        <div class="plan-name">${escapeHTML(plan.name)}</div>
        <div class="plan-price">${planPriceLabel(plan)}</div>
        <div class="text-muted" style="font-size:0.82rem">${escapeHTML(planLimitLabel(plan))}</div>
        <ul>${(plan.features || []).slice(0, 5).map((f) => `<li>${escapeHTML(FEATURE_LABELS[f] || f)}</li>`).join('')}</ul>
        <button class="btn btn-outline btn-block plan-cta" data-select-plan="${escapeHTML(plan.id)}">
          Choose ${escapeHTML(plan.name)}
        </button>
      </div>`).join('');
  }

  if (select) {
    select.innerHTML = plans
      .map((p) => `<option value="${escapeHTML(p.id)}">${escapeHTML(p.name)}</option>`)
      .join('');
  }
}

function renderGateways() {
  const list = $('#gatewayList');
  if (!list) return;
  const gateways = paymentGateways();
  if (!gateways.length) {
    list.innerHTML = '<p class="text-muted">No payment gateways are configured for this build.</p>';
    return;
  }
  list.innerHTML = gateways.map((g) => {
    // The sandbox/live flag is surfaced rather than left in config: it is the
    // difference between a test payment and a real one.
    const modeLabel = g.mode === 'live' ? 'Live' : 'Sandbox';
    return `
    <div class="gateway">
      <div class="gateway-mark" aria-hidden="true">${escapeHTML(String(g.name || '?').slice(0, 2).toUpperCase())}</div>
      <div class="gateway-body">
        <strong>${escapeHTML(g.name)}</strong>
        <div class="gateway-methods">${escapeHTML((g.methods || []).join(' · '))}</div>
        <div class="gateway-methods">${escapeHTML(g.tagline || '')}</div>
      </div>
      <div class="gateway-status">
        <span class="badge ${g.enabled ? 'badge-green' : 'badge-gray'}">${g.enabled ? 'Enabled' : 'Not connected'}</span>
        <span class="badge ${g.mode === 'live' ? 'badge-green' : 'badge-gray'}">${escapeHTML(modeLabel)}</span>
      </div>
    </div>`;
  }).join('');
}

/** Repaint the plan badge, usage meter and current-plan highlight. */
async function refreshSubscriptionUI() {
  const quota = await checkInvoiceQuota();
  const license = getLicense();

  const badge = $('#planBadge');
  if (badge) badge.textContent = quota.planName;

  const meter = $('#quotaMeter');
  const fill = meter ? meter.querySelector('span') : null;
  const text = $('#quotaText');
  if (meter && fill) {
    if (quota.unlimited) {
      fill.style.width = '100%';
      meter.classList.remove('is-full', 'is-over');
      meter.removeAttribute('aria-valuemax');
      meter.removeAttribute('aria-valuenow');
      if (text) text.textContent = `${quota.used} invoices this month — unlimited on the ${quota.planName} plan.`;
    } else {
      const pct = quota.limit ? Math.min(100, (quota.used / quota.limit) * 100) : 0;
      fill.style.width = `${pct}%`;
      meter.classList.toggle('is-full', quota.used >= quota.limit);
      meter.setAttribute('aria-valuemax', String(quota.limit));
      meter.setAttribute('aria-valuenow', String(quota.used));
      if (text) {
        text.textContent = `${quota.used} of ${quota.limit} invoices used this month — ${quota.remaining} left.`;
      }
    }
  }

  $$('#planGrid .plan-card').forEach((card) => {
    card.classList.toggle('current', card.dataset.plan === license.plan);
  });

  const select = $('#licensePlanSelect');
  if (select && license.plan) select.value = license.plan;
  const keyInput = $('#licenseKeyInput');
  if (keyInput && license.licenseKey) keyInput.value = license.licenseKey;
}

function bindSubscriptionControls() {
  $('#planGrid')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-select-plan]');
    if (!btn) return;
    const select = $('#licensePlanSelect');
    if (select) select.value = btn.dataset.selectPlan;
    $('#licenseKeyInput')?.focus();
  });

  $('#activateLicenseBtn')?.addEventListener('click', async (e) => {
    const planId = $('#licensePlanSelect')?.value;
    const licenseKey = $('#licenseKeyInput')?.value || '';
    await withLoading(e.currentTarget, async () => {
      const result = await setPlan(planId, { licenseKey });
      if (!result.ok) { toast(result.reason || 'Could not activate that plan', 'error'); return; }
      toast(`Plan set to ${planId}`, 'success');
      await refreshSubscriptionUI();
    });
  });

  // Convenience for a template with no licence server: mint a key locally.
  $('#generateKeyBtn')?.addEventListener('click', () => {
    const planId = $('#licensePlanSelect')?.value || 'pro';
    if (planId === 'free') { toast('The free plan needs no key', 'info'); return; }
    const key = makeLicenseKey(planId);
    const input = $('#licenseKeyInput');
    if (input) input.value = key;
    toast('Key generated — click Activate plan', 'info', 5000);
  });
}

function initSubscriptionUI() {
  if (!allowWhiteLabel() && !$('#planGrid')) return;
  renderPlans();
  renderGateways();
  bindSubscriptionControls();
  refreshSubscriptionUI();
}

async function init() {
  await initShell();
  // The plan decides which controls are usable, so it is loaded before any of
  // them is wired — a lock applied after binding would leave the first click
  // unguarded.
  await loadLicense();
  await loadSettings();
  populateForm();
  initBrandUI();
  initSubscriptionUI();
  applyPlanLocks();

  $('#saveSettingsBtn')?.addEventListener('click', saveSettings);
  $('#backupBtn')?.addEventListener('click', (e) => handleBackup(e.currentTarget));
  $('#restoreBtn')?.addEventListener('click', () => $('#restoreFile')?.click());
  $('#restoreFile')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleRestore(file);
    e.target.value = '';
  });
  $('#resetBtn')?.addEventListener('click', handleReset);
  $('#saveSettingsBtn')?.addEventListener('click', () => refreshSubscriptionUI());

  // Uploaded artwork — one binder for the logo, the signature and the stamp.
  // Only the logo is free; the other two carry their plan gate into the binder.
  bindArtworkUploader({ input: '#setLogoInput', remove: '#setLogoRemove', empty: 'No logo', label: 'Logo', key: 'logoDataUrl' });
  bindArtworkUploader({ input: '#setSignatureInput', remove: '#setSignatureRemove', empty: 'None', label: 'Signature', key: 'signatureDataUrl', feature: 'signature-stamp' });
  bindArtworkUploader({ input: '#setStampInput', remove: '#setStampRemove', empty: 'None', label: 'Stamp', key: 'stampDataUrl', feature: 'signature-stamp' });
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((err) => {
    console.error('Settings init failed:', err);
    toast('Failed to initialize: ' + err.message, 'error', 6000);
  });
});
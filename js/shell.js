/**
 * Shared app shell.
 * Theme, sidebar, currency selector, PWA install, service worker,
 * connectivity, logo, theme toggle, FAB, keyboard shortcuts.
 * Every page imports and calls initShell().
 *
 * Identity (app name, tagline, PWA manifest) is never hard-coded here — it is
 * resolved from the saved Business Settings with js/app.config.js as the
 * fallback, so the same build can be white-labelled per client.
 */
import { $, escapeHTML, toast, initials } from './utils.js';
import { getSetting, setSetting, initStorage, pendingCount, activeAdapterId } from './storageService.js';
import { getCurrencies, getDefaultCurrencyCode, setDefaultCurrencyCode } from './currency.js';
import { readStorage, writeStorage } from './config.js';
import {
  loadBrand, applyPalette, currentTheme,
  resolveAppName, resolveAppTagline, DEFAULT_BRAND,
} from './brand.js';
import { initOnboarding } from './onboarding.js';
import { initFeedback } from './feedback.js';

/* ================= Brand + Theme =================
   brand-boot.js has already applied the cached palette before first paint.
   Here we reconcile with the authoritative IndexedDB copy and wire up the
   dynamic bits (app name, title, PWA chrome). */

let activeBrand = { ...DEFAULT_BRAND };

/** The white-label name currently in effect, for messages that need it. */
let resolvedName = '';

/** Re-apply the current brand for whichever theme is active. */
export function refreshBrand(brand = activeBrand) {
  activeBrand = brand;
  applyPalette(activeBrand, currentTheme());
  return activeBrand;
}

export function getActiveBrand() {
  return activeBrand;
}

/** Push the white-label name into the sidebar, the document title and the PWA manifest. */
async function applyAppIdentity() {
  const company = await getSetting('company', {});
  const name = resolveAppName(activeBrand, company);
  const tagline = resolveAppTagline(activeBrand);
  resolvedName = name;

  const nameEl = $('#sidebarBrandName');
  const subEl = $('#sidebarBrandSub');
  if (nameEl) nameEl.textContent = name;
  if (subEl) subEl.textContent = tagline;

  // brand-boot.js already stamped these before first paint; repeating it here
  // covers the case where the business name only arrives from IndexedDB now.
  const logoEl = document.querySelector('#sidebarLogo .logo-fallback');
  if (logoEl && !$('#sidebarLogo img')) logoEl.textContent = initials(company?.businessName || name);

  // "Dashboard — <brand>". Idempotent: re-running must not stack separators.
  const title = document.title || '';
  const sep = title.indexOf(' — ');
  const page = sep === -1 ? title : title.slice(0, sep);
  if (page && name) document.title = `${page} — ${name}`;

  const desc = document.querySelector('meta[name="description"]');
  if (desc && tagline) desc.setAttribute('content', `${name} — ${tagline}`);

  await applyPwaIdentity(name, tagline);
}

/* ================= PWA identity =================
   The browser reads manifest.json before any JavaScript runs, so the file on
   disk can only ever hold the template defaults. Re-pointing the <link> at a
   Blob URL built from the live settings means a re-install picks up the
   business's own name.

   Two honest limitations, both worth knowing:
     - An app that is ALREADY installed keeps the name it was installed with.
       Only a fresh install reads the new manifest.
     - Under file:// the manifest cannot be fetched at all; the static defaults
       are used and this is skipped silently. */
let manifestBlobUrl = null;

async function applyPwaIdentity(name, tagline) {
  const link = document.querySelector('link[rel="manifest"]');
  if (!link || !name) return;
  try {
    const base = await (await fetch('manifest.json', { cache: 'no-cache' })).json();
    const shortName = name.length > 12 ? name.slice(0, 12).trim() : name;

    /* A Blob URL *is* the manifest's own URL, so every relative URL inside it
       would resolve against `blob:https://host/uuid` — which has no path, so
       start_url, scope and every icon become unusable and the install silently
       degrades. Resolve them against the document instead before serialising.
       (The static manifest.json on disk is unaffected and still uses relative
       paths, so it works from any sub-path.) */
    const abs = (u) => (typeof u === 'string' && u ? new URL(u, document.baseURI).href : u);
    const manifest = {
      ...base,
      name,
      short_name: shortName,
      description: tagline ? `${name} — ${tagline}` : base.description,
      start_url: abs(base.start_url),
      scope: abs(base.scope),
      icons: (base.icons || []).map((i) => ({ ...i, src: abs(i.src) })),
      shortcuts: (base.shortcuts || []).map((s) => ({
        ...s,
        url: abs(s.url),
        icons: (s.icons || []).map((i) => ({ ...i, src: abs(i.src) })),
      })),
    };
    const next = URL.createObjectURL(
      new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/manifest+json' }),
    );
    link.href = next;
    if (manifestBlobUrl) URL.revokeObjectURL(manifestBlobUrl);
    manifestBlobUrl = next;
  } catch {
    /* offline, file://, or a blocked fetch — the static manifest still works */
  }
}

export async function initBrand() {
  activeBrand = await loadBrand();
  refreshBrand(activeBrand);
  await applyAppIdentity();
  return activeBrand;
}

function initTheme() {
  // brand-boot.js already set data-theme; this is the belt-and-braces path
  // for the rare case the boot script was blocked.
  const saved = readStorage('theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcons(saved);
}

function updateThemeIcons(theme) {
  const moon = $('#themeIconM');
  const sun = $('#themeIconS');
  if (!moon || !sun) return;
  moon.style.display = theme === 'dark' ? 'block' : 'none';
  sun.style.display = theme === 'dark' ? 'none' : 'block';
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  writeStorage('theme', next);
  updateThemeIcons(next);
  // Dark mode needs its own derived shades — a brand tuned for white
  // backgrounds is too dark to read on a near-black surface.
  refreshBrand();
}

/* ================= Print =================
   Printing is paper. A dark-mode session would otherwise print near-white text
   on a slate block. The print stylesheet (section 27 of css/styles.css) resets
   the structural scale, but it cannot reach the BRAND tokens: js/brand.js writes
   those inline on <html>, and an inline custom property outranks every selector.
   So re-derive the light palette for the duration of the print job and restore
   the on-screen one afterwards.

   `beforeprint` covers both Ctrl/Cmd+P and an explicit window.print(), in every
   current browser. The invoice PDF/print path (js/export.js → printInvoice)
   opens its own window with the light palette already forced, so it needs none
   of this — this is for printing the app's own pages. */
let printRestoreTheme = null;

function initPrintPalette() {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('beforeprint', () => {
    printRestoreTheme = currentTheme();
    if (printRestoreTheme === 'dark') applyPalette(activeBrand, 'light');
  });
  window.addEventListener('afterprint', () => {
    if (printRestoreTheme === 'dark') applyPalette(activeBrand, 'dark');
    printRestoreTheme = null;
  });
}

/* ================= Ripple =================
   Press feedback on the prominent action buttons. Delegated from the document
   so it also covers markup rendered later (table rows, modals, toasts) without
   every module having to opt in. */
const RIPPLE_TARGET = '.btn-primary, .btn-gold, .btn-success, .btn-danger, .fab';

function initRipple() {
  // Respect the OS setting — the CSS reduced-motion block kills the animation
  // anyway, but skipping the work avoids leaving dead nodes behind.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  document.addEventListener('pointerdown', (e) => {
    const btn = e.target instanceof Element ? e.target.closest(RIPPLE_TARGET) : null;
    if (!btn || btn.disabled || btn.classList.contains('loading')) return;

    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const span = document.createElement('span');
    span.className = 'ripple';
    span.style.width = `${size}px`;
    span.style.height = `${size}px`;
    span.style.left = `${e.clientX - rect.left - size / 2}px`;
    span.style.top = `${e.clientY - rect.top - size / 2}px`;
    span.addEventListener('animationend', () => span.remove(), { once: true });
    btn.appendChild(span);
  });
}

/* ================= Sidebar (mobile) ================= */
function initSidebar() {
  const sidebar = $('#sidebar');
  const backdrop = $('#sidebarBackdrop');
  const menuBtn = $('#menuBtn');
  if (!sidebar) return;

  const open = () => {
    sidebar.classList.add('open');
    if (backdrop) backdrop.classList.add('open');
  };
  const close = () => {
    sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
  };

  if (menuBtn) menuBtn.addEventListener('click', open);
  if (backdrop) backdrop.addEventListener('click', close);
  if (menuBtn) menuBtn.style.display = '';
}

/* ================= Currency selector ================= */
export async function initCurrencySelect() {
  const select = $('#currencySelect');
  if (!select) return;
  const currencies = await getCurrencies();
  const current = await getDefaultCurrencyCode();
  select.innerHTML = currencies
    .map((c) => `<option value="${escapeHTML(c.code)}" ${c.code === current ? 'selected' : ''}>${escapeHTML(c.code)} — ${escapeHTML(c.name)}</option>`)
    .join('');
  select.addEventListener('change', async (e) => {
    await setDefaultCurrencyCode(e.target.value);
    toast(`Currency switched to ${e.target.value}`, 'success');
    if (window.__onCurrencyChange) window.__onCurrencyChange(e.target.value);
    else location.reload();
  });
}

/* ================= PWA Install ================= */
let deferredPrompt = null;
function initInstall() {
  const card = $('#installCard');
  const btn = $('#installBtn');
  if (!card || !btn) return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    card.classList.remove('hidden');
  });

  btn.addEventListener('click', async () => {
    if (!deferredPrompt) {
      toast('Open your browser menu and choose "Install app" or "Add to Home Screen".', 'info', 5000);
      return;
    }
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      toast('App installed successfully!', 'success');
      card.classList.add('hidden');
    }
    deferredPrompt = null;
  });

  window.addEventListener('appinstalled', () => {
    card.classList.add('hidden');
    toast(resolvedName ? `${resolvedName} installed!` : 'App installed!', 'success');
  });
}

/* ================= Service Worker ================= */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;

  // A reload caused by our own update flow must happen at most once, or a
  // `controllerchange` that fires twice would loop forever.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Only reload when a worker was ALREADY controlling this page — on the very
    // first visit `clients.claim()` also fires this event, and reloading then
    // would double-load the app for no reason.
    if (reloading || !navigator.serviceWorker.controller) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('sw.js', {
        // Never serve sw.js from the HTTP cache: a stale worker script can
        // delay an update by up to 24 hours and is invisible to the user.
        updateViaCache: 'none',
      })
      .then((registration) => {
        // Check for a new build on every load and whenever the tab regains
        // focus, so a long-lived tab does not sit on an old version.
        registration.update().catch(() => {});
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') registration.update().catch(() => {});
        });
      })
      .catch((err) => {
        console.warn('SW registration failed:', err);
      });
  });
}

/* ================= Online/Offline ================= */
function initConnectivity() {
  const badge = $('#offlineBadge');
  const update = () => {
    if (!badge) return;
    badge.style.display = navigator.onLine ? 'none' : '';
  };
  window.addEventListener('online', () => { update(); toast('Back online', 'success'); });
  window.addEventListener('offline', () => { update(); toast('You are offline — working from local data', 'warning', 5000); });
  update();
}

/* ================= Logo ================= */
export async function initLogo() {
  const [logoData, company] = await Promise.all([
    getSetting('logoDataUrl', null),
    getSetting('company', {}),
  ]);
  const box = $('#sidebarLogo');
  if (!box) return;
  if (logoData) {
    box.innerHTML = `<img src="${logoData}" alt="Business logo">`;
  } else {
    // Fall back to initials rather than a fixed mark, and prefer the business
    // name, then the white-labelled app name.
    //
    // The app name fallback is load-bearing: `initials('')` returns '?', which
    // is TRUTHY, so an `|| 'CI'` guard never fires and a fresh install (no
    // business name yet) paints a literal "?" as its logo. Passing a name that
    // is always non-empty is what makes the fallback work.
    const mark = initials(company?.businessName || resolveAppName(activeBrand, company));
    box.innerHTML = `<div class="logo-fallback" aria-hidden="true">${escapeHTML(mark)}</div>`;
  }
}

/* ================= Stock badge ================= */
export async function initStockBadge() {
  const { getProducts } = await import('./storageService.js');
  const badge = $('#navStockBadge');
  if (!badge) return;
  try {
    const products = await getProducts();
    const low = products.filter((p) => (p.stock || 0) <= (p.lowStock || 0)).length;
    if (low) {
      badge.textContent = low;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch {
    badge.classList.add('hidden');
  }
}

/* ================= Init ================= */
export async function initShell() {
  // Pick the storage adapter before anything reads or writes data. With the
  // default `local` adapter this is a no-op; with a cloud adapter configured it
  // is where the backend is validated and the fallback happens if it is not
  // reachable.
  await initStorage();

  initTheme();
  initSidebar();
  initRipple();
  initInstall();
  initPrintPalette();
  registerSW();
  initConnectivity();

  await initBrand();
  await initLogo();
  await initCurrencySelect();
  await initStockBadge();

  /* The onboarding guide needs the storage layer (it records that the tour has
     been seen) and the business profile (the tour's copy is generic, but the
     launcher's pulse state is not), so it runs after both. It is deliberately
     last: a first-run tour that opens before the dashboard has painted would
     spotlight skeletons. */
  await initOnboarding();

  /* Feedback has the same two prerequisites as the guide — the storage layer
     (reviews and the one-shot nudge flag live there) and the business profile
     (the nudge names the app). It runs after onboarding because the nudge
     deliberately waits for the tour to have been seen: two surfaces competing
     for a new user's first minute is how a first impression goes wrong. */
  await initFeedback();

  const themeBtn = $('#themeToggle');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  const fab = $('#fabNewInvoice');
  if (fab) fab.addEventListener('click', () => { location.href = 'invoice.html?new=1'; });

  // Keyboard shortcut: Ctrl/Cmd + N for new invoice
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      location.href = 'invoice.html?new=1';
    }
  });

  // Readiness flag — used by the automated browser checks.
  window.__APP_READY__ = true;
  window.__BRAND__ = activeBrand;
  // Exposed for the browser test suites and for support: which build is
  // running, which adapter is active, and how much is waiting to sync.
  window.__STORAGE__ = { adapter: activeAdapterId(), pending: await pendingCount() };
}
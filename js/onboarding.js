/**
 * Onboarding guide.
 *
 * Two things live here, and they share one content model:
 *
 *   1. The TOUR — a visual, step-by-step walkthrough. Each step dims the app,
 *      cuts a hole around the thing it is talking about, and points a small
 *      card at it. Steps that talk about another page carry the tour across
 *      the navigation via `?tour=<step>`, so a first-time user is walked from
 *      "set up your business" to "send the invoice" without ever being told
 *      "now go to the Products page yourself".
 *
 *   2. The HELP PANEL — the same steps as a scrollable manual, reachable any
 *      time from the Guide button. A tour is only useful once; a manual has to
 *      be there on the day someone forgets which button makes the PDF.
 *
 * WHY THE CONTENT IS CODE AND NOT MARKUP
 *   Every page would need its own copy of the step list, and the six copies
 *   would drift apart within a week. The steps live in one array here, are
 *   filtered by the page actually being viewed, and are rendered by whichever
 *   of the two surfaces asked for them. `scripts/test-onboarding.js` drives the
 *   real app to prove the anchors still exist.
 *
 * WHY THE FIRST-RUN FLAG IS IN IndexedDB AND NOT localStorage
 *   localStorage is per-origin; IndexedDB is the app's real data store. Using
 *   the same store means "Reset All Data" genuinely resets the onboarding (a
 *   client handed a wiped device gets the walkthrough again), and a restored
 *   backup that predates the feature does not replay a tour at a user who has
 *   been using the app for months.
 */

import { $, $$, escapeHTML, toast } from './utils.js';
import { getSetting, setSetting } from './storageService.js';

/* ==========================================================================
   Content
   ========================================================================== */

/**
 * The tour, in order. One flat list shared by every page:
 *
 *   page   which document the step belongs to (`data-page` on <body>)
 *   target CSS selector to spotlight; looked up by data-tour first, then by
 *          the selector itself, so markup refactors only have to keep one
 *          attribute alive
 *   place  where the card sits relative to the spotlight
 *   art    key into ART — the small illustration drawn in the card
 *   query  optional query string carried along when the step is on another
 *          page, for the case where a step lives inside a view that page has
 *          to open first (the invoice editor is only reachable via ?new=1)
 *
 * A step whose target is missing is SKIPPED rather than shown pointing at
 * nothing. That is what keeps the tour honest when a page changes: the worst
 * case is a shorter tour, never a card floating in the middle of an empty
 * screen explaining a button that is not there.
 */
const STEPS = [
  {
    id: 'welcome',
    page: 'dashboard',
    target: null,
    center: true,
    title: 'Welcome aboard',
    body:
      'This is your invoicing workspace. Everything lives on this device — your ' +
      'invoices, customers and products work with no internet at all. ' +
      'Let us take nine short steps to get you set up.',
    art: 'welcome',
  },
  {
    id: 'business',
    page: 'settings',
    target: '[data-tour="business-info"]',
    place: 'bottom',
    title: 'Your business details',
    body:
      'Your name, address, phone, TIN and VRN are printed on every invoice. ' +
      'Type them once here and they flow into the preview, the PDF and every report.',
    art: 'business',
  },
  {
    id: 'logo',
    page: 'settings',
    target: '[data-tour="brand-panel"]',
    place: 'bottom',
    title: 'Make it look like you',
    body:
      'Upload your logo, signature and stamp below, and pick your brand colour. ' +
      'The whole interface re-themes instantly, and so do your invoices.',
    art: 'brand',
  },
  {
    id: 'products',
    page: 'products',
    target: '[data-tour="product-list"]',
    place: 'bottom',
    title: 'Add what you sell',
    body:
      'Add each product or service with its price, tax and stock. Once they are ' +
      'here, creating an invoice is just picking items from a list — no retyping.',
    art: 'products',
  },
  {
    id: 'customers',
    page: 'customers',
    target: '[data-tour="customer-list"]',
    place: 'bottom',
    title: 'Add your customers',
    body:
      'Names, phone numbers and TINs. You will pick a customer when you raise an ' +
      'invoice, and the app keeps their purchase history and outstanding balance for you.',
    art: 'customers',
  },
  {
    id: 'new-invoice',
    page: 'invoice',
    target: '[data-tour="new-invoice"]',
    // The invoice page defaults to the list, but if the user is coming BACK
    // from the editor step the editor is still open — so ask for the list
    // explicitly rather than relying on the default.
    query: 'view=list',
    place: 'bottom',
    title: 'Create your first invoice',
    body:
      'Pick the customer, add line items, set the tax and any discount. The totals ' +
      'and the amount in words update as you type.',
    art: 'invoice',
  },
  {
    id: 'invoice-actions',
    page: 'invoice',
    target: '[data-tour="invoice-actions"]',
    // The Save / Download / Print actions only exist once the editor is open,
    // and the invoice page lands on the list. Carrying ?new=1 across makes the
    // page open the editor for us, so the spotlight has something to land on —
    // and the user gets to *see* the flow instead of being told about it.
    query: 'new=1',
    place: 'bottom',
    title: 'Save, download and send',
    body:
      'Save the invoice, then Download PDF, Print it, or send it straight to your ' +
      'customer on WhatsApp. The QR code on the invoice points back to these details.',
    art: 'send',
  },
  {
    id: 'reports',
    page: 'reports',
    target: '[data-tour="report-summary"]',
    place: 'bottom',
    title: 'See how the business is doing',
    body:
      'Revenue, profit, outstanding balances, best customers and best products — ' +
      'daily, weekly, monthly or yearly. Export any of it to PDF or CSV.',
    art: 'reports',
  },
  {
    id: 'backup',
    page: 'settings',
    target: '[data-tour="data-tools"]',
    place: 'bottom',
    title: 'One last thing — keep your data safe',
    body:
      'Your records live only on this device, so download a backup regularly. ' +
      'Restore it on a new phone in seconds. You can replay this guide any time ' +
      'from the Guide button.',
    art: 'backup',
  },
];

/**
 * Small spot illustrations. Deliberately geometric and theme-agnostic: they are
 * drawn with `currentColor` and the brand tokens, so they inherit whatever
 * palette the business chose instead of shipping a fixed green that would clash
 * with a client's brand.
 */
const ART = {
  welcome: `
    <rect x="6" y="10" width="46" height="34" rx="5"/>
    <path d="M6 20h46"/>
    <circle cx="13" cy="15" r="1.6" fill="currentColor" stroke="none"/>
    <circle cx="18.5" cy="15" r="1.6" fill="currentColor" stroke="none"/>
    <path d="M14 29h22M14 36h14"/>`,
  business: `
    <rect x="8" y="14" width="44" height="30" rx="5"/>
    <path d="M8 24h44"/>
    <path d="M16 32h12M16 38h20"/>
    <circle cx="43" cy="33" r="5"/>
    <path d="M28 14V9h12v5"/>`,
  brand: `
    <circle cx="22" cy="29" r="12"/>
    <circle cx="37" cy="29" r="12"/>
    <path d="M29.5 19.5c4 5 4 14 0 19"/>`,
  products: `
    <path d="M30 8 50 18v20L30 48 10 38V18z"/>
    <path d="M10 18l20 10 20-10M30 28v20"/>`,
  customers: `
    <circle cx="24" cy="20" r="8"/>
    <path d="M10 46a14 14 0 0 1 28 0"/>
    <circle cx="43" cy="24" r="5.5"/>
    <path d="M38 46a9 9 0 0 1 10-8"/>`,
  invoice: `
    <path d="M15 8h22l8 8v34H15z"/>
    <path d="M37 8v8h8"/>
    <path d="M22 26h16M22 33h16M22 40h10"/>`,
  send: `
    <path d="M47 12 10 28l14 5 5 14z"/>
    <path d="M47 12 24 33"/>`,
  reports: `
    <path d="M12 46V26M23 46V14M34 46V32M45 46V20"/>
    <path d="M8 50h40"/>`,
  backup: `
    <ellipse cx="30" cy="16" rx="18" ry="7"/>
    <path d="M12 16v14c0 4 8 7 18 7s18-3 18-7V16"/>
    <path d="M12 30v10c0 4 8 7 18 7s18-3 18-7V30"/>`,
};

/* ==========================================================================
   State
   ========================================================================== */

/** The page this document is, matching `data-page` on <body>. */
const PAGE = (document.body && document.body.dataset.page) || '';

/** Storage key for "this user has already seen the tour". */
const SEEN_KEY = 'onboardingSeen';

/** Storage key for the step the tour was on when it hopped pages. */
const RESUME_KEY = 'onboardingResume';

/* ==========================================================================
   Element resolution
   ========================================================================== */

/**
 * Find a step's anchor.
 *
 * `data-tour` wins over the selector because the tour is a *contract* about
 * where things are, and a class name is not. Several markup changes (a card
 * growing an extra wrapper, a toolbar moving inside a header) would silently
 * break a CSS-selector anchor while leaving the element on screen.
 */
function resolveTarget(step) {
  if (!step.target) return null;
  const byAttribute = document.querySelector(`[data-tour="${step.target.match(/"([^"]+)"/)?.[1] || step.id}"]`);
  if (byAttribute) return byAttribute;
  return document.querySelector(step.target);
}

/**
 * The full tour, with the anchors that exist on *this* page resolved.
 *
 * Deliberately NOT filtered down to the current page. The tour is a single
 * narrative that walks the user across six pages; filtering would leave the
 * dashboard with one lonely step and force the rest to be discovered by hand.
 * A step filed under another page is simply one we navigate to when it comes
 * up (see `crossToPage`), and steps whose anchor has gone missing are skipped
 * at render time rather than dropped up front — a missing element on a page we
 * have not even loaded yet says nothing about whether the step is useful.
 */
function tourSteps() {
  return STEPS.map((s) => ({ ...s, el: s.page === PAGE ? resolveTarget(s) : null }));
}

/** Every step regardless of page — the help panel shows the full manual. */
export function allSteps() {
  return STEPS.slice();
}

export function currentPage() {
  return PAGE;
}

/** Steps that exist on the page currently loaded (used by the first-run check). */
function stepsOnThisPage() {
  return STEPS.filter((s) => s.page === PAGE && (s.center || resolveTarget(s)));
}

/* ==========================================================================
   Tour engine
   ========================================================================== */

let tour = null;

const isReducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Build the two layers the tour needs:
 *
 *   .tour-blocks   four solid panels arranged around the spotlight rectangle.
 *                  Not a single dimmed overlay with a `box-shadow` hole —
 *                  a shadow hole still swallows clicks, so the user cannot
 *                  tap the very button the card is describing.
 *   .tour-card     the coach mark itself.
 *
 * Both live in one fixed container so a single `display:none` tears the whole
 * thing down, and so the print stylesheet can hide it in one rule.
 */
function buildLayers() {
  const root = document.createElement('div');
  root.className = 'tour-root';
  root.setAttribute('data-tour-root', '1');
  root.innerHTML = `
    <div class="tour-block" data-side="top"></div>
    <div class="tour-block" data-side="right"></div>
    <div class="tour-block" data-side="bottom"></div>
    <div class="tour-block" data-side="left"></div>
    <div class="tour-glow" aria-hidden="true"></div>
    <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tourTitle">
      <div class="tour-art" aria-hidden="true"></div>
      <div class="tour-meta">
        <span class="tour-step-badge"></span>
        <span class="tour-page-badge"></span>
      </div>
      <h3 id="tourTitle" class="tour-title"></h3>
      <p class="tour-body"></p>
      <div class="tour-dots" role="tablist" aria-label="Tour progress"></div>
      <div class="tour-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-tour-action="exit">Skip tour</button>
        <span class="tour-spacer"></span>
        <button type="button" class="btn btn-outline btn-sm" data-tour-action="prev">Back</button>
        <button type="button" class="btn btn-primary btn-sm" data-tour-action="next">Next</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  return root;
}

/** Human label for a page id, used on the "this step is on another page" badge. */
const PAGE_LABELS = {
  dashboard: 'Dashboard',
  invoice: 'Invoices',
  customers: 'Customers',
  products: 'Products',
  reports: 'Reports',
  settings: 'Settings',
};

/**
 * Position the four dimming panels flush around the spotlight rectangle.
 *
 * Using four panels (rather than one overlay with a punched hole) is what makes
 * the highlighted element only *look* inert. Nothing is layered over it, so the
 * user can genuinely click it — which matters for steps where the whole point
 * is "tap this".
 */
function placeBlocks(root, rect) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = 8;
  const x = Math.max(0, rect.left - pad);
  const y = Math.max(0, rect.top - pad);
  const r = Math.min(vw, rect.right + pad);
  const b = Math.min(vh, rect.bottom + pad);

  const set = (sel, css) => {
    const el = root.querySelector(sel);
    if (el) Object.assign(el.style, css);
  };

  set('[data-side="top"]', { left: '0px', top: '0px', width: '100%', height: `${y}px` });
  set('[data-side="bottom"]', { left: '0px', top: `${b}px`, width: '100%', height: `${Math.max(0, vh - b)}px` });
  set('[data-side="left"]', { left: '0px', top: `${y}px`, width: `${x}px`, height: `${Math.max(0, b - y)}px` });
  set('[data-side="right"]', { left: `${r}px`, top: `${y}px`, width: `${Math.max(0, vw - r)}px`, height: `${Math.max(0, b - y)}px` });

  const glow = root.querySelector('.tour-glow');
  if (glow) {
    glow.classList.toggle('hidden', !rect.width && !rect.height);
    Object.assign(glow.style, {
      left: `${x}px`, top: `${y}px`,
      width: `${Math.max(0, r - x)}px`, height: `${Math.max(0, b - y)}px`,
    });
  }
}

/**
 * Place the coach mark near the spotlight, then keep it on screen.
 *
 * Order matters: preferred side first, then the opposite side, then a centred
 * fallback. A card that runs off the edge is worse than a card on the wrong
 * side of the element it describes.
 */
function placeCard(root, rect, place) {
  const card = root.querySelector('.tour-card');
  if (!card) return;
  const gap = 14;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Reset before measuring — a stale width would make every calculation below
  // depend on the previous step's layout.
  card.style.left = '0px';
  card.style.top = '0px';
  card.style.maxWidth = '';
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;

  let left;
  let top;

  if (!rect.width && !rect.height) {
    left = (vw - cw) / 2;
    top = (vh - ch) / 2;
  } else {
    const fitsBelow = rect.bottom + gap + ch <= vh - 8;
    const fitsAbove = rect.top - gap - ch >= 8;
    const fitsRight = rect.right + gap + cw <= vw - 8;
    const fitsLeft = rect.left - gap - cw >= 8;

    const side = place === 'bottom' && fitsBelow ? 'bottom'
      : place === 'top' && fitsAbove ? 'top'
        : place === 'right' && fitsRight ? 'right'
          : place === 'left' && fitsLeft ? 'left'
            : fitsBelow ? 'bottom'
              : fitsAbove ? 'top'
                : fitsRight ? 'right'
                  : fitsLeft ? 'left'
                    : 'center';

    if (side === 'bottom') {
      left = rect.left + rect.width / 2 - cw / 2;
      top = rect.bottom + gap;
    } else if (side === 'top') {
      left = rect.left + rect.width / 2 - cw / 2;
      top = rect.top - gap - ch;
    } else if (side === 'right') {
      left = rect.right + gap;
      top = rect.top + rect.height / 2 - ch / 2;
    } else if (side === 'left') {
      left = rect.left - gap - cw;
      top = rect.top + rect.height / 2 - ch / 2;
    } else {
      left = (vw - cw) / 2;
      top = (vh - ch) / 2;
    }
  }

  const margin = 10;
  left = Math.min(Math.max(margin, left), Math.max(margin, vw - cw - margin));
  top = Math.min(Math.max(margin, top), Math.max(margin, vh - ch - margin));

  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
}

/**
 * The rectangle to spotlight for an element.
 *
 * Clamped to the viewport height. A step anchored to a tall panel (a whole
 * settings card is routinely two screens high) would otherwise draw a cut-out
 * taller than the window, which reads as "no spotlight at all" and leaves the
 * coach mark with nowhere sensible to sit. Clamping keeps the top of the
 * section framed — which is the part the copy is talking about anyway.
 */
function spotRect(el) {
  const r = el.getBoundingClientRect();
  const maxBottom = window.innerHeight - 12;
  if (r.bottom <= maxBottom) return r;
  return {
    left: r.left,
    right: r.right,
    top: r.top,
    width: r.width,
    height: Math.max(0, maxBottom - r.top),
    bottom: maxBottom,
  };
}

/**
 * Keep a highlighted element inside the visible band.
 *
 * A step that points at a tall card (a whole settings panel, say) would
 * otherwise be "in view" while the part that matters is scrolled off. Aligning
 * the TOP to just under the topbar is what the reader expects — it shows the
 * section heading and the first rows, which is where the eye should start.
 *
 * Returns the delay to allow before re-measuring: smooth scrolling is animated,
 * and measuring mid-flight pins the card to a position the element is about to
 * leave.
 */
function bringIntoView(el) {
  const TOP_MARGIN = 84;   // clears the sticky topbar
  const BOTTOM_MARGIN = 24;
  const r = el.getBoundingClientRect();
  const tooTall = r.height > window.innerHeight - TOP_MARGIN - BOTTOM_MARGIN;
  const topClipped = r.top < TOP_MARGIN;
  const bottomClipped = r.bottom > window.innerHeight - BOTTOM_MARGIN;

  if (!topClipped && !bottomClipped) return 0;

  // A target taller than the viewport can never fully fit, so align its top —
  // scrolling its bottom into view would push the heading off screen.
  const block = tooTall ? 'start' : (topClipped ? 'start' : 'end');
  el.scrollIntoView({ behavior: isReducedMotion() ? 'auto' : 'smooth', block });
  return isReducedMotion() ? 0 : 320;
}

/**
 * Fill the card in without positioning it.
 *
 * Used for the one frame before a cross-page hop, where the card is visible but
 * there is no anchor to point at yet. Without this the card would briefly show
 * the *previous* step's copy while the browser navigates away.
 */
function renderStepArtOnly() {
  if (!tour) return;
  const step = tour.steps[tour.index];
  if (!step) return;
  const { root } = tour;
  root.querySelector('.tour-art').innerHTML = `<svg viewBox="0 0 60 56" fill="none" stroke="currentColor" stroke-width="2.4"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ART[step.art] || ''}</svg>`;
  root.querySelector('.tour-title').textContent = step.title;
  root.querySelector('.tour-body').textContent = step.body;
  root.querySelector('.tour-step-badge').textContent = `${tour.index + 1} / ${tour.steps.length}`;
}

/** Render one step into the card and move the spotlight. */
function renderStep() {
  if (!tour) return;
  const step = tour.steps[tour.index];
  if (!step) return endTour();

  const { root } = tour;
  const card = root.querySelector('.tour-card');

  // Re-resolve on every render: a step may have been jumped to on a freshly
  // loaded page, and elements can be re-created by the feature module after
  // initShell() has already run.
  step.el = resolveTarget(step);
  if (!step.center && !step.el) return skipMissingStep();

  const art = root.querySelector('.tour-art');
  art.innerHTML = `<svg viewBox="0 0 60 56" fill="none" stroke="currentColor" stroke-width="2.4"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ART[step.art] || ''}</svg>`;

  root.querySelector('.tour-title').textContent = step.title;
  root.querySelector('.tour-body').textContent = step.body;
  root.querySelector('.tour-step-badge').textContent = `${tour.index + 1} / ${tour.steps.length}`;

  const pageBadge = root.querySelector('.tour-page-badge');
  const label = PAGE_LABELS[step.page] || step.page;
  pageBadge.textContent = label;
  pageBadge.style.display = step.page === PAGE ? 'none' : '';

  // Progress dots double as navigation — a user who wants step 6 should not
  // have to click Next four times.
  const dots = root.querySelector('.tour-dots');
  dots.innerHTML = tour.steps.map((s, i) =>
    `<button type="button" class="tour-dot${i === tour.index ? ' active' : ''}" role="tab"
       aria-selected="${i === tour.index}" aria-label="Step ${i + 1}: ${escapeHTML(s.title)}"
       data-tour-index="${i}"></button>`).join('');

  root.querySelector('[data-tour-action="prev"]').disabled = tour.index === 0;
  root.querySelector('[data-tour-action="next"]').textContent =
    tour.index === tour.steps.length - 1 ? 'Finish' : 'Next';

  const rect = step.center || !step.el
    ? { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }
    : spotRect(step.el);

  // A step pointing at an element outside the visible band is useless — bring
  // it into view first, then measure and place.
  if (step.el && !step.center) {
    const delay = bringIntoView(step.el);
    if (delay) {
      // Hide the dimming while the page scrolls underneath it. Without this the
      // panels sit still while the content moves, so the cut-out appears to
      // slide off its own element for the duration of the smooth scroll.
      root.classList.add('repositioning');
      clearTimeout(tour.repositionTimer);
      tour.repositionTimer = setTimeout(() => {
        if (!tour) return;
        root.classList.remove('repositioning');
        const r2 = step.el ? spotRect(step.el) : null;
        if (r2) {
          placeBlocks(root, r2);
          placeCard(root, r2, step.place);
        }
      }, isReducedMotion() ? 0 : 320);
    }
  }

  placeBlocks(root, rect);
  placeCard(root, rect, step.place);

  /* An anchor can exist in the DOM and still have no layout yet: the invoice
     editor is opened by the page from `?new=1`, and the tour starts before the
     page has finished showing it. Measuring then yields a 0×0 rectangle, the
     spotlight collapses, and the card floats over nothing — the exact failure
     the skip logic exists to avoid, except the element IS there, just late.
     Re-measure a few times, then accept whatever we have. */
  if (!step.center && step.el && !rect.width && !rect.height) {
    tour.measureRetries = (tour.measureRetries || 0) + 1;
    if (tour.measureRetries <= 5) {
      clearTimeout(tour.measureTimer);
      tour.measureTimer = setTimeout(() => { if (tour) renderStep(); }, 300);
    }
  } else {
    tour.measureRetries = 0;
  }

  // Focus the primary action so the tour is fully keyboard operable: Tab moves
  // within the card, Enter advances. Restoring focus on exit happens in
  // endTour() so the user is returned to whatever they were doing.
  if (!tour.silent) card.querySelector('[data-tour-action="next"]')?.focus({ preventScroll: true });
}

/**
 * A step whose anchor vanished: move past it instead of showing a dead card.
 *
 * Skipping forward (not just aborting) is what keeps the tour usable on a page
 * whose layout changed — the user still gets the rest of the story. The guard
 * is that we only skip *within* this page; a step belonging to another page is
 * never "missing", it is simply not here yet.
 */
function skipMissingStep() {
  const before = tour.index;
  tour.index += 1;
  while (tour.index < tour.steps.length) {
    const next = tour.steps[tour.index];
    if (next.page !== PAGE) return goTo(tour.index);
    if (next.center || resolveTarget(next)) return goTo(tour.index);
    tour.index += 1;
  }
  // Nothing usable ahead. Step back, or finish if there is nowhere to go.
  if (before > 0) return endTour();
  endTour();
}

/**
 * Is a step's required page state already in the URL?
 *
 * A step may carry `query` (e.g. `new=1` to make the invoice page open its
 * editor). Navigating away and back would otherwise be a reload for nothing, so
 * check first. Each `k=v` pair must match.
 */
function queryApplied(query) {
  const params = new URLSearchParams(window.location.search);
  return query.split('&').every((pair) => {
    const [key, value = ''] = pair.split('=');
    return params.get(key) === value;
  });
}

/**
 * Cross to the step's page.
 *
 * The tour is not a single-page widget, and pretending otherwise would mean
 * either (a) restricting it to the dashboard, or (b) telling the user to
 * navigate themselves — both of which defeat the point. So a cross-page step
 * stores where we are and navigates; `initOnboarding()` picks it back up.
 */
function crossToPage(step) {
  try {
    sessionStorage.setItem(RESUME_KEY, String(tour.index));
  } catch {
    /* private mode — the tour simply restarts on the new page */
  }
  const url = step.page === 'dashboard' ? 'index.html' : `${step.page}.html`;
  // `query` lets a step ask its page to open the view it points into, before
  // the tour renders. `?tour=` is stripped by initOnboarding() on arrival, and
  // the extra parameter is deliberately kept.
  const extra = step.query ? `&${step.query}` : '';
  window.location.href = `${url}?tour=${encodeURIComponent(step.id)}${extra}`;
}

function goTo(index, { silent = false } = {}) {
  if (!tour) return;
  tour.silent = silent;
  if (index < 0) return;
  if (index >= tour.steps.length) return endTour();

  const step = tour.steps[index];
  tour.index = index;
  // A new step gets a fresh retry budget; only the renderStep retries below
  // increment it.
  tour.measureRetries = 0;
  // Navigate when the step is on another page, or when it needs THIS page in a
  // particular state that is not currently applied (the invoice editor only
  // exists behind ?new=1). Rendering in place would measure a hidden element
  // and collapse the spotlight.
  if (step.page !== PAGE || (step.query && !queryApplied(step.query))) {
    renderStepArtOnly();
    return crossToPage(step);
  }
  // A step on this page whose anchor is gone: skip instead of pointing at
  // nothing.
  if (!step.center && !resolveTarget(step)) return skipMissingStep();
  renderStep();
  tour.silent = false;
}

export function nextStep() {
  if (tour) goTo(tour.index + 1);
}

export function prevStep() {
  if (tour) goTo(tour.index - 1);
}

/** Abort the step currently in flight (used when the card is dismissed). */
function endTour({ markSeen = true } = {}) {
  if (!tour) return;
  clearTimeout(tour.repositionTimer);
  clearTimeout(tour.measureTimer);
  const { root, opener } = tour;
  root.classList.remove('open');
  window.removeEventListener('resize', tour.onResize);
  window.removeEventListener('scroll', tour.onScroll, true);
  document.removeEventListener('keydown', tour.onKey);
  const kill = () => root.remove();
  if (isReducedMotion()) kill();
  else setTimeout(kill, 200);
  tour = null;
  document.documentElement.classList.remove('tour-active');
  if (markSeen) markOnboardingSeen();
  // Return focus to whatever opened the tour, so keyboard users are not
  // dumped back at the top of the document.
  if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
}

export function exitTour() {
  endTour();
}

/**
 * Start the tour.
 *
 * @param {object}  opts
 * @param {string}  opts.stepId  resume at this step instead of the first
 * @param {string}  opts.from    'first-run' | 'manual' | 'help-panel'
 */
export function startTour({ stepId = null, from = 'manual' } = {}) {
  if (tour) return;

  const steps = tourSteps();
  if (!steps.length) return;

  const root = buildLayers();
  tour = {
    root,
    steps,
    index: 0,
    silent: false,
    from,
    opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    repositionTimer: null,
    measureTimer: null,
    measureRetries: 0,
  };

  // Keep the card glued to its anchor through rotation, resize and scroll.
  const reposition = () => {
    if (!tour) return;
    const step = tour.steps[tour.index];
    if (!step || step.center) return;
    step.el = resolveTarget(step);
    const rect = step.el ? step.el.getBoundingClientRect() : null;
    if (!rect) return;
    placeBlocks(root, rect);
    placeCard(root, rect, step.place);
  };
  tour.onResize = reposition;
  tour.onScroll = reposition;
  window.addEventListener('resize', tour.onResize);
  window.addEventListener('scroll', tour.onScroll, true);

  tour.onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); endTour(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); nextStep(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); prevStep(); return; }
    // Trap Tab inside the card — the dimmed regions are decorative, so letting
    // focus walk into them would leave the user tabbing through an invisible UI.
    if (e.key === 'Tab') {
      const focusables = $$('button:not([disabled])', root).filter((el) => el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', tour.onKey);

  root.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-tour-action], [data-tour-index]') : null;
    if (!btn) return;
    const index = btn.getAttribute('data-tour-index');
    if (index !== null) return goTo(Number(index));
    const action = btn.getAttribute('data-tour-action');
    if (action === 'next') return nextStep();
    if (action === 'prev') return prevStep();
    if (action === 'exit') return endTour();
  });

  document.documentElement.classList.add('tour-active');
  requestAnimationFrame(() => root.classList.add('open'));

  if (stepId) {
    const found = steps.findIndex((s) => s.id === stepId);
    tour.index = found === -1 ? 0 : found;
  }
  // Opening straight onto a step that lives on another page — or that needs
  // this page in a state it is not in — is exactly the cross-page hop, so let
  // goTo() do the navigation rather than rendering a card with no anchor.
  const first = tour.steps[tour.index];
  if (first && (first.page !== PAGE || (first.query && !queryApplied(first.query)))) {
    renderStepArtOnly();
    return crossToPage(first);
  }
  renderStep();
}

/* ==========================================================================
   Help panel — the manual
   ========================================================================== */

let helpPanel = null;

/**
 * The manual. Same content as the tour, laid out as readable steps with the
 * option to jump straight into the interactive version from any step.
 */
export function openHelpPanel() {
  if (helpPanel) return;

  const steps = STEPS;
  const panel = document.createElement('div');
  panel.className = 'help-overlay';
  panel.setAttribute('data-help-root', '1');
  panel.innerHTML = `
    <div class="help-drawer" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
      <div class="help-head">
        <div class="help-head-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <div class="help-head-text">
          <h3 id="helpTitle">How to use this app</h3>
          <p>Nine short steps. You can also replay the interactive guide.</p>
        </div>
        <button type="button" class="icon-btn help-close" data-help-action="close" aria-label="Close the guide">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div class="help-body">
        <ol class="help-steps">
          ${steps.map((s, i) => `
            <li class="help-step">
              <div class="help-step-art" aria-hidden="true">
                <svg viewBox="0 0 60 56" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ART[s.art] || ''}</svg>
              </div>
              <div class="help-step-text">
                <h4><span class="help-step-num">${i + 1}</span>${escapeHTML(s.title)}</h4>
                <p>${escapeHTML(s.body)}</p>
                <span class="help-step-where">${escapeHTML(PAGE_LABELS[s.page] || s.page)}</span>
              </div>
            </li>`).join('')}
        </ol>

        <div class="help-note">
          <strong>Everything stays on your device.</strong>
          <p>Your invoices, customers and products are stored locally and work with no
            internet. Download a backup from Settings regularly, and restore it on a new
            phone whenever you need to.</p>
        </div>
      </div>

      <div class="help-foot">
        <button type="button" class="btn btn-ghost btn-sm" data-help-action="close">Close</button>
        <button type="button" class="btn btn-primary btn-sm" data-help-action="tour">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>
          Start the guided tour
        </button>
      </div>
    </div>`;
  document.body.appendChild(panel);
  helpPanel = panel;
  document.documentElement.classList.add('help-active');

  const close = () => {
    panel.classList.remove('open');
    document.documentElement.classList.remove('help-active');
    const kill = () => { panel.remove(); helpPanel = null; };
    if (isReducedMotion()) kill();
    else setTimeout(kill, 240);
  };

  panel.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    // Clicking the scrim (but not the drawer) dismisses, matching the modal.
    if (target === panel) return close();
    const btn = target.closest('[data-help-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-help-action');
    if (action === 'close') return close();
    if (action === 'tour') {
      close();
      // Let the drawer finish closing before the tour measures the page.
      setTimeout(() => startTour({ from: 'help-panel' }), isReducedMotion() ? 0 : 260);
    }
  });

  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  requestAnimationFrame(() => {
    panel.classList.add('open');
    panel.querySelector('[data-help-action="close"]')?.focus({ preventScroll: true });
  });
}

export function closeHelpPanel() {
  const btn = helpPanel?.querySelector('[data-help-action="close"]');
  if (btn) btn.click();
}

/* ==========================================================================
   Persistence
   ========================================================================== */

async function hasSeenOnboarding() {
  try {
    return Boolean(await getSetting(SEEN_KEY, false));
  } catch {
    return true; // storage unavailable — never nag
  }
}

export async function markOnboardingSeen() {
  try {
    await setSetting(SEEN_KEY, true);
  } catch {
    /* storage blocked — the tour may reappear on the next load, which is
       strictly better than throwing inside a dismissal handler */
  }
}

/** Wipe the flag so the walkthrough runs again (used by the Guide button's tests). */
export async function resetOnboarding() {
  try {
    await setSetting(SEEN_KEY, false);
  } catch {
    /* ignore */
  }
}

/* ==========================================================================
   Init
   ========================================================================== */

/**
 * Wire the launcher and decide whether to open the tour.
 *
 * Called from initShell() on every page, after the storage layer is up.
 */
export async function initOnboarding() {
  // Launchers — the sidebar button, the bottom-nav button, and any page-level
  // "Show me how" link. Delegated so markup rendered later still works.
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-action="help"], #helpBtn, #tourBtn') : null;
    if (!btn) return;
    e.preventDefault();
    // A dedicated tour button starts the tour; everything else opens the manual.
    if (btn.hasAttribute('data-tour-start')) startTour({ from: 'manual' });
    else openHelpPanel();
  });

  // The sidebar launcher stops pulsing once the tour has actually been seen.
  // Read once here rather than in an animation callback so there is exactly one
  // source of truth for the state.
  try {
    if (await hasSeenOnboarding()) {
      $$('.guide-card.is-new').forEach((el) => el.classList.remove('is-new'));
    }
  } catch {
    /* storage blocked — leave the pulse, it is only decorative */
  }

  // `?tour=<stepId>` — arriving from a cross-page step. Handle it before the
  // first-run check, because resuming exists to *continue* a tour, not to
  // start one.
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    params = new URLSearchParams('');
  }
  const resumeId = params.get('tour');
  if (resumeId) {
    // Strip the parameter so a reload does not re-open the tour, and so the
    // URL the user shares is clean.
    try {
      const clean = new URL(window.location.href);
      clean.searchParams.delete('tour');
      window.history.replaceState({}, '', clean.pathname + clean.search + clean.hash);
    } catch {
      /* history unavailable — harmless */
    }
    try { sessionStorage.removeItem(RESUME_KEY); } catch { /* ignore */ }
    setTimeout(() => startTour({ stepId: resumeId, from: 'manual' }), isReducedMotion() ? 0 : 450);
    return;
  }

  // First run. Deliberately *after* a short pause: the dashboard seeds sample
  // data and paints its charts on load, and a tour that opens into a spinner
  // teaches the user nothing about the app they are about to use.
  if (await hasSeenOnboarding()) return;
  // Only the dashboard opens it unprompted. Landing on a deep link should not
  // be interrupted — the launcher is always there for that user.
  if (PAGE !== 'dashboard') return;
  if (!stepsOnThisPage().length) return;

  setTimeout(() => {
    startTour({ from: 'first-run' });
    toast('New here? This is the 9-step guide. Press Esc to skip.', 'info', 6000);
  }, isReducedMotion() ? 900 : 1500);
}

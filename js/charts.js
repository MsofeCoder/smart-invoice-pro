/**
 * Chart layer — presentational only.
 *
 * This module READS data and draws it. It never computes a business total, a
 * status, an invoice number or a storage key; the caller passes in buckets it
 * already has. That keeps the chart layer swappable and keeps every financial
 * rule in js/calculations.js where the tests expect it.
 *
 * Two charts:
 *   renderStatusDonut  an inline-SVG donut ring
 *   renderBarChart     an inline-SVG bar chart with a value axis
 *
 * Design rules applied here (ported as *patterns*, not code, from a reference
 * dashboard):
 *   - the ring is thick (62% cutout) with surface-coloured separators
 *   - hover/focus pops a segment out along its own radius
 *   - bars have rounded tops, flat bottoms, a max width, and no vertical
 *     gridlines; horizontal gridlines sit at a few "nice" numbers
 *   - only transform / opacity / stroke-dasharray are animated
 *   - every colour comes from a design token, so both themes work untouched
 *   - each chart carries role="img" + a generated summary, a legend that
 *     repeats the values as text, and a visually-hidden data table
 *
 * Everything is dependency-free: no chart library, no CDN, nothing to precache.
 */

import { escapeHTML, toNumber } from './utils.js';
import { formatMoney, formatNumber } from './currency.js';

/* ==========================================================================
   1. Status vocabulary
   ========================================================================== */

/**
 * The four buckets the ring is built from.
 *
 * The reference design names its buckets Paid / Pending / Overdue / Draft. This
 * app stores paid / partial / unpaid / draft and derives "overdue" separately
 * (js/app.js `isOverdue` — an unpaid or partial invoice past its due date), so
 * the labels below stay honest: an invoice that is merely unpaid is NOT called
 * overdue. The colour roles still follow the reference: positive = brand,
 * attention = spark, negative = danger, inert = neutral.
 */
export const STATUS_META = [
  { key: 'paid', label: 'Paid', color: 'var(--brand-500)' },
  { key: 'partial', label: 'Partial', color: 'var(--spark)' },
  { key: 'unpaid', label: 'Unpaid', color: 'var(--danger)' },
  { key: 'draft', label: 'Draft', color: 'var(--ink-faint)' },
];

/* ==========================================================================
   2. Formatting helpers
   ========================================================================== */

const COMPACT_UNITS = [
  { limit: 1e12, suffix: 'T' },
  { limit: 1e9, suffix: 'B' },
  { limit: 1e6, suffix: 'M' },
  { limit: 1e3, suffix: 'K' },
];

/**
 * Compact money for axis ticks, the donut centre and anywhere a full
 * "TZS 1,662,930.00" would not fit. 1_200_000 -> "TZS 1.2M".
 *
 * `decimals` is chosen so the mantissa keeps three significant figures at most
 * (1.2M, 12M, 123M) — enough to compare bars, short enough never to clip.
 */
export function formatCompactMoney(amount, currency, { withSymbol = true } = {}) {
  const n = Math.abs(toNumber(amount));
  const symbol = (currency && currency.symbol) || '';
  let body;

  if (n < 1000) {
    // Small values keep enough precision to be meaningful (0.50, 12.5, 999).
    body = formatNumber(n, n < 10 && n % 1 !== 0 ? 2 : n < 100 && n % 1 !== 0 ? 1 : 0);
  } else {
    const unit = COMPACT_UNITS.find((u) => n >= u.limit) || COMPACT_UNITS[COMPACT_UNITS.length - 1];
    const v = n / unit.limit;
    body = `${formatNumber(v, v < 10 ? 1 : 0)}${unit.suffix}`;
  }

  return withSymbol && symbol ? `${symbol} ${body}` : body;
}

/**
 * "Nice" axis steps: round the max up to 1 / 2 / 2.5 / 5 x 10^n and divide it
 * into `count` equal steps. Returns { max, step, ticks[] } with ticks ascending
 * from 0 — so the axis always starts at zero.
 */
export function niceScale(rawMax, count = 4) {
  const max = toNumber(rawMax);
  if (!(max > 0)) return { max: 0, step: 0, ticks: [0] };

  const rough = max / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = nice * mag;
  const top = Math.ceil(max / step) * step;

  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { max: top, step, ticks };
}

/* ==========================================================================
   3. Motion helpers
   ========================================================================== */

const REDUCED = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Run `cb` the first time `el` is actually on screen.
 *
 * IntersectionObserver alone is not enough: an element that is already visible
 * at creation time may be inside a hidden tab (display:none) when we observe
 * it, and the observer then never fires. So check the box synchronously first
 * and only fall back to the observer when the element really is off-screen.
 */
function runOnVisible(el, cb) {
  if (typeof IntersectionObserver === 'undefined') { cb(); return; }

  const r = el.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh) { cb(); return; }

  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { io.disconnect(); cb(); }
  }, { threshold: 0.1 });
  io.observe(el);
}

/** Restart a CSS animation class without forcing a synchronous reflow storm. */
function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/* ==========================================================================
   4. Shared DOM bits
   ========================================================================== */

let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;

/**
 * The visually-hidden table that carries the real numbers.
 *
 * role="img" makes a chart a single opaque blob to a screen reader, so the
 * summary label is all it can say. The table is what lets someone actually read
 * the data. It is in the DOM (not generated at read time) so it is reachable by
 * every AT and by "read the page as text".
 */
function hiddenTable(caption, columns, rows) {
  const id = nextId('chart-table');
  const head = columns.map((c) => `<th scope="col">${escapeHTML(c)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((cell, i) => (i === 0
    ? `<th scope="row">${escapeHTML(String(cell))}</th>`
    : `<td>${escapeHTML(String(cell))}</td>`)).join('')}</tr>`).join('');
  return `<table class="sr-only" id="${id}"><caption>${escapeHTML(caption)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/* ==========================================================================
   5. Status donut
   ========================================================================== */

/* Geometry, in viewBox units on a 0 0 42 42 grid (centre 21,21).
   r + stroke/2 is the outer edge, r - stroke/2 the inner edge, so the cutout is
   inner/outer = 9.9 / 16.1 = 62% — a thick ring, not a hairline. */
const D_CX = 21;
const D_CY = 21;
const D_R = 13;
const D_STROKE = 6.2;
/* Separator width in pathLength units. The circumference is 2*pi*13 = 81.68
   user units, so 0.6% of the path is ~0.49 user units ~= 2px at the 170px
   render size. */
const D_GAP = 0.6;
/* Pop-out distance: 2.5 user units is ~10px at the 170px render size. */
const D_POP = 2.5;

/**
 * Draw the invoice-status ring.
 *
 * @param {HTMLElement} el        container (e.g. #statusDonut)
 * @param {Object}      data
 * @param {Object}      data.buckets  { key, label, count, amount }[]
 * @param {Object}      data.currency currency record (symbol/decimals)
 * @param {string}     [data.caption] centre caption, default "Total"
 */
export function renderStatusDonut(el, { buckets, currency, caption = 'Total' }) {
  if (!el) return;

  const items = (buckets || []).map((b) => {
    const meta = STATUS_META.find((m) => m.key === b.key) || {};
    return {
      key: b.key,
      label: b.label || meta.label || b.key,
      color: meta.color || 'var(--ink-faint)',
      count: toNumber(b.count),
      amount: toNumber(b.amount),
    };
  });

  const totalCount = items.reduce((s, i) => s + i.count, 0);
  const totalAmount = items.reduce((s, i) => s + i.amount, 0);
  const currencySymbol = (currency && currency.symbol) || '';

  /* ---- Empty state: nothing to divide, so do not draw a ring of nothing ---- */
  if (!totalCount && !totalAmount) {
    el.classList.add('donut-host');
    el.innerHTML = `
      <div class="chart-empty rise-in">
        <div class="chart-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 9 9"/><path d="M8 12h8"/>
          </svg>
        </div>
        <p class="chart-empty-title">No invoices yet</p>
        <p class="chart-empty-body">Create your first invoice and this ring will show how your money is split across paid, partial and unpaid.</p>
        <a class="btn btn-primary btn-sm" href="invoice.html?new=1">New Invoice</a>
      </div>`;
    return;
  }

  /* ---- Segments ---- */
  const denom = totalAmount > 0 ? totalAmount : totalCount;
  const metric = (i) => (totalAmount > 0 ? i.amount : i.count);
  const drawn = items.filter((i) => metric(i) > 0);

  let cursor = 0;
  const segments = drawn.map((item) => {
    const span = (metric(item) / denom) * 100;
    const start = cursor;
    cursor += span;

    // Mid-angle, measured clockwise from 3 o'clock in the SVG's own frame (the
    // per-circle rotate(-90) moves the dash start to 12 o'clock afterwards).
    const mid = ((start + span / 2) / 100) * Math.PI * 2;
    const popX = (D_POP * Math.cos(mid)).toFixed(3);
    const popY = (D_POP * Math.sin(mid)).toFixed(3);

    // Inset by half the separator at each end so the gap between two segments is
    // exactly D_GAP. Never let a tiny segment vanish entirely.
    const arc = Math.max(0.6, span - D_GAP);
    const dash = `${arc.toFixed(3)} ${(100 - arc).toFixed(3)}`;
    const offset = (-(start + D_GAP / 2)).toFixed(3);

    const pct = totalAmount > 0 ? (item.amount / totalAmount) * 100 : (item.count / denom) * 100;

    return `
      <g class="donut-seg" data-key="${escapeHTML(item.key)}" style="--pop:translate(${popX}px,${popY}px)"
         tabindex="0" role="img"
         aria-label="${escapeHTML(`${item.label}: ${formatMoney(item.amount, currency)}, ${item.count} invoice${item.count === 1 ? '' : 's'}, ${pct.toFixed(1)}%`)}">
        <circle class="donut-arc" cx="${D_CX}" cy="${D_CY}" r="${D_R}" pathLength="100"
                transform="rotate(-90 ${D_CX} ${D_CY})"
                fill="none" stroke="${item.color}" stroke-width="${D_STROKE}"
                stroke-dasharray="0 100" stroke-dashoffset="${offset}"
                data-dash="${dash}"></circle>
      </g>`;
  }).join('');

  /* ---- Legend: swatch + label + amount (text, so colour is never the only signal) ---- */
  const legend = drawn.map((item) => `
      <li class="legend-row" data-key="${escapeHTML(item.key)}" tabindex="0">
        <span class="legend-swatch" style="background:${item.color}" aria-hidden="true"></span>
        <span class="legend-label">${escapeHTML(item.label)}</span>
        <span class="legend-value">${escapeHTML(formatMoney(item.amount, currency))}</span>
      </li>`).join('');

  const ariaSummary = `Invoice status: ${items
    .map((i) => `${i.count} ${i.label.toLowerCase()}`)
    .join(', ')}. Total ${formatMoney(totalAmount, currency)}.`;

  el.classList.add('donut-host');
  el.innerHTML = `
    <figure class="donut-figure rise-in">
      <svg class="donut-svg" viewBox="0 0 42 42" role="img" aria-label="${escapeHTML(ariaSummary)}" focusable="false">
        <circle class="donut-track" cx="${D_CX}" cy="${D_CY}" r="${D_R}" fill="none"
                stroke="var(--surface)" stroke-width="${D_STROKE}"></circle>
        ${segments}
      </svg>
      <div class="donut-center" aria-hidden="true">
        <div class="donut-total">${escapeHTML(formatCompactMoney(totalAmount, currency, { withSymbol: false }))}</div>
        <div class="donut-caption">${escapeHTML(currencySymbol ? `${currencySymbol} ${caption}` : caption)}</div>
      </div>
      <div class="chart-tip" role="tooltip" hidden></div>
    </figure>
    <ul class="legend" aria-label="Invoice status legend">${legend}</ul>
    ${hiddenTable('Invoice status breakdown', ['Status', 'Invoices', 'Amount'],
      items.map((i) => [i.label, i.count, formatMoney(i.amount, currency)]))}`;

  wireDonut(el, { items, currency, totalAmount });
}

/** Hover / focus interaction for the ring. Split out to keep the renderer flat. */
function wireDonut(el, { items, currency, totalAmount }) {
  const figure = el.querySelector('.donut-figure');
  const svg = el.querySelector('.donut-svg');
  const tip = el.querySelector('.chart-tip');
  /* Two distinct collections, and they are NOT interchangeable:
     `.donut-seg` is the <g> wrapper that carries data-key and does the pop-out,
     `.donut-arc` is the <circle> that carries data-dash and does the growth.
     Targeting the <g> for the dash silently no-ops (dataset.dash is undefined),
     which leaves the ring invisible. */
  const segs = [...el.querySelectorAll('.donut-seg')];
  const arcs = [...el.querySelectorAll('.donut-arc')];
  const rows = [...el.querySelectorAll('.legend-row')];

  const byKey = (k) => segs.find((a) => a.dataset.key === k);

  /* Tooltip anchor, in the figure's own pixel space. The visual angle is the
     SVG angle rotated by -90 degrees: (cos b, sin b) -> (sin b, -cos b). */
  const anchorFor = (key) => {
    const item = items.find((i) => i.key === key);
    if (!item) return { x: 50, y: 50 };
    const box = svg.getBoundingClientRect();
    const fig = figure.getBoundingClientRect();
    const scale = box.width / 42 || 1;
    const cx = box.left - fig.left + (box.width / 2);
    const cy = box.top - fig.top + (box.height / 2);

    // Re-derive this segment's mid-angle from the data, not from the DOM.
    const denom = totalAmount > 0 ? totalAmount : items.reduce((s, i) => s + i.count, 0);
    const metric = (i) => (totalAmount > 0 ? i.amount : i.count);
    let cursor = 0;
    for (const i of items) {
      const span = (metric(i) / denom) * 100;
      if (i.key === key) {
        const mid = ((cursor + span / 2) / 100) * Math.PI * 2;
        const radius = (D_R + D_STROKE / 2 + 3) * scale;
        return { x: cx + Math.sin(mid) * radius, y: cy - Math.cos(mid) * radius };
      }
      cursor += span;
    }
    return { x: cx, y: cy };
  };

  const show = (key) => {
    const item = items.find((i) => i.key === key);
    const seg = byKey(key);
    if (!item || !seg) return;
    segs.forEach((a) => a.classList.toggle('is-pop', a === seg));
    rows.forEach((r) => r.classList.toggle('is-active', r.dataset.key === key));
    tip.textContent = `${item.label}: ${formatMoney(item.amount, currency)}`;
    const { x, y } = anchorFor(key);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.hidden = false;
  };

  const hide = () => {
    segs.forEach((a) => a.classList.remove('is-pop'));
    rows.forEach((r) => r.classList.remove('is-active'));
    tip.hidden = true;
  };

  const bind = (node, key) => {
    node.addEventListener('pointerenter', () => show(key));
    node.addEventListener('pointerleave', hide);
    node.addEventListener('focus', () => show(key));
    node.addEventListener('blur', hide);
  };

  segs.forEach((a) => bind(a, a.dataset.key));
  rows.forEach((r) => bind(r, r.dataset.key));
  el.addEventListener('pointerleave', hide);

  /* Entrance: each arc grows from 0 to its value, staggered. Under reduced
     motion the final dash is written straight away. */
  runOnVisible(figure, () => {
    if (REDUCED()) {
      arcs.forEach((a) => { a.style.strokeDasharray = a.dataset.dash; });
      return;
    }
    arcs.forEach((a, i) => {
      window.setTimeout(() => { a.style.strokeDasharray = a.dataset.dash; }, i * 80);
    });
  });
}

/* ==========================================================================
   6. Bar chart
   ========================================================================== */

/**
 * Column density, from the bucket count. Kept here rather than in the callers
 * so there is exactly one rule: a short range shares the card equally (0 = let
 * flex do the work), a longer one gets a readable fixed column and the plot
 * scrolls instead of overflowing the card.
 */
function densityFor(n) {
  return n <= 14 ? 'normal' : n <= 45 ? 'dense' : 'ultra';
}

/**
 * Draw a single-series bar chart with a value axis.
 *
 * The vertical geometry is three stacked bands, expressed as CSS custom
 * properties on `.chart-figure` so the axis, the gridlines and the bars all
 * measure from the SAME box (`--scale-h`, the 0..axis-max band):
 *
 *   --gutter-top     room for the on-bar value label above the tallest bar
 *   --scale-h        the plotting band itself
 *   --gutter-bottom  room for the x-axis label
 *
 * Getting this wrong is the classic chart bug: if the bars' percentage height
 * resolves against a box that also contains the x-axis label, every bar is
 * short by that label's height and the gridlines no longer line up with the
 * ticks.
 *
 * @param {HTMLElement} el
 * @param {Object}   data
 * @param {Object[]} data.buckets   { key, label }[]
 * @param {number[]} data.values    aligned with buckets
 * @param {Object}   data.currency  currency record
 * @param {string}  [data.caption]  series name, e.g. "Sales"
 */
export function renderBarChart(el, { buckets, values, currency, caption = 'Sales' }) {
  if (!el) return;

  const rows = (buckets || []).map((b, i) => ({
    key: b.key,
    label: b.label,
    value: toNumber(values ? values[i] : 0),
  }));

  el.classList.add('chart-bar');
  el.dataset.density = densityFor(rows.length);
  /* The animation class lives on the container, which survives innerHTML
     replacement. Clearing it here means a re-render starts from an explicit
     "not animating" state instead of inheriting the previous render's class —
     otherwise a re-render under reduced motion would still match the animation
     rule (harmless today because the media query neutralises it, but it is the
     kind of stale state that bites later). */
  el.classList.remove('is-grown');

  const total = rows.reduce((s, r) => s + r.value, 0);

  /* Nothing to plot at all — one honest message and one way forward, centred
     in a panel that keeps its height so the grid does not jump. */
  if (!rows.length || total <= 0) {
    el.innerHTML = `
      <figure class="chart-figure chart-figure-empty rise-in">
        <div class="chart-empty">
          <div class="chart-empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 20h18"/><rect x="4.5" y="12" width="3.5" height="8" rx="1"/>
              <rect x="10.2" y="7" width="3.5" height="13" rx="1"/><rect x="15.9" y="15" width="3.5" height="5" rx="1"/>
            </svg>
          </div>
          <p class="chart-empty-title">No ${escapeHTML(caption.toLowerCase())} yet</p>
          <p class="chart-empty-body">Issue an invoice and this chart will plot your ${escapeHTML(caption.toLowerCase())} over time.</p>
          <a class="btn btn-primary btn-sm" href="invoice.html?new=1">New Invoice</a>
        </div>
      </figure>`;
    return;
  }

  /* The axis always starts at zero and the top is a "nice" number, so the
     ticks land on 0 / 200K / 400K / ... instead of 0 / 173,400 / ... */
  const scale = niceScale(Math.max(...rows.map((r) => r.value)), 4);
  const peak = rows.reduce((best, r, i) => (r.value > rows[best].value ? i : best), 0);
  const pctOf = (v) => (scale.max > 0 ? (v / scale.max) * 100 : 0);

  const bars = rows.map((r, i) => {
    /* A bucket with a real value but a tiny share still gets a visible stub, or
       the chart silently claims there was no sale that day. */
    const h = r.value > 0 ? Math.max(1.5, pctOf(r.value)) : 0;
    const isPeak = i === peak;
    return `
      <div class="bar-col" title="${escapeHTML(`${r.label}: ${formatMoney(r.value, currency)}`)}">
        <span class="bar-scale" style="--h:${h.toFixed(2)}%;--d:${i * 60}ms">
          <span class="bar-value">${r.value > 0 ? escapeHTML(formatNumber(r.value, 2)) : ''}</span>
          <span class="bar-fill${isPeak ? ' is-peak' : ''}"></span>
        </span>
        <span class="bar-label">${escapeHTML(r.label)}</span>
      </div>`;
  }).join('');

  /* Horizontal gridlines only — vertical ones add ink without adding meaning,
     because the columns already separate the periods. */
  const ticks = scale.ticks.map((t) => `
        <span style="bottom:${pctOf(t).toFixed(2)}%"></span>`).join('');

  const yTicks = scale.ticks.map((t) => `
        <span class="chart-ytick" style="bottom:${pctOf(t).toFixed(2)}%">${escapeHTML(formatCompactMoney(t, currency, { withSymbol: false }))}</span>`).join('');

  const peakRow = rows[peak];
  const ariaSummary = `${caption} by period. ${rows.length} periods, total ${formatMoney(total, currency)}. Highest: ${peakRow.label} at ${formatMoney(peakRow.value, currency)}.`;

  el.innerHTML = `
    <figure class="chart-figure rise-in">
      <div class="chart-yaxis" aria-hidden="true">
        <div class="chart-ybox">${yTicks}</div>
      </div>
      <div class="chart-plot" role="img" aria-label="${escapeHTML(ariaSummary)}">
        <div class="chart-grid" aria-hidden="true">${ticks}</div>
        <div class="chart-cols">${bars}</div>
      </div>
    </figure>
    ${hiddenTable(`${caption} by period`, ['Period', caption], rows.map((r) => [r.label, formatMoney(r.value, currency)]))}`;

  /* Entrance: bars grow from the baseline, staggered left to right. The class
     is what starts the CSS animation, so a JS failure leaves the bars at full
     height rather than invisible. Reduced motion skips it entirely — the base
     state already IS the final state. */
  const figure = el.querySelector('.chart-figure');
  runOnVisible(figure, () => {
    if (REDUCED()) return;
    replay(el, 'is-grown');
  });
}

export { runOnVisible, REDUCED as prefersReducedMotion, replay, hiddenTable, nextId };

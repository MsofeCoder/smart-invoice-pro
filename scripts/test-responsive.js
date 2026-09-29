/**
 * responsive / mobile-first verification.
 *
 * The static suite can prove the CSS *declares* the right breakpoints; only a
 * real browser can prove the page actually fits. This sweeps every page across
 * the widths that matter and fails on the four ways a responsive layout breaks
 * silently:
 *
 *   OVERFLOW  the document ends up wider than the viewport (sideways scroll)
 *   CRUSHED   a multi-column grid whose children collapsed below readable width
 *   CLIPPED   text wider than its box (an ellipsis that was never intended)
 *   COLLIDE   chart bar labels overlapping their neighbours
 *
 * It then asserts the mobile-first chrome contract: bottom nav on phones,
 * docked sidebar on desktop, and a FAB that clears the bottom nav.
 *
 * Run via `npm run test:responsive`, or `npm run test:e2e` for the whole set.
 */
import { CONFIG, connect, createReporter, sleep } from './lib/cdp.js';

const r = createReporter('Responsive');
const { send, evaluate, goto } = await connect();

/* Exact CSS widths. `mobile: true` is deliberately NOT used: Chrome then applies
   a device-pixel-ratio-based layout width (320 requested laid out at 378), which
   silently invalidates the entire sweep. Touch/hover are handled by the
   `@media (hover: none)` query, not by this override. */
const WIDTHS = [320, 390, 430, 600, 768, 900, 1024, 1280, 1440, 1600];
const PAGES = ['index.html', 'invoice.html', 'customers.html', 'products.html', 'reports.html', 'settings.html'];

await send('Storage.clearDataForOrigin', { origin: CONFIG.origin, storageTypes: 'all' });
// Warm up so the app seeds its demo data before we start measuring charts.
await goto('index.html', 3400);

const probe = `(() => {
  const vw = window.innerWidth;
  const out = { vw, scrollW: document.documentElement.scrollWidth, culprits: [], clipped: [], grid: [], collisions: 0, barLabels: 0 };

  // Only report elements that genuinely push the page wide — skip anything an
  // ancestor clips (overflow:hidden) or makes scrollable (overflow-x:auto).
  const clippedByAncestor = (el) => {
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const o = getComputedStyle(p);
      if (o.overflowX !== 'visible' || o.overflowY !== 'visible') return true;
    }
    return false;
  };
  const label = (el) => {
    if (el.className && typeof el.className === 'string' && el.className.trim()) return el.className.trim().split(/\\s+/)[0];
    const p = el.closest('[class]');
    return p ? (p.className.toString().trim().split(/\\s+/)[0] || p.tagName) : el.tagName;
  };

  for (const el of document.querySelectorAll('body *')) {
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) continue;
    if (b.right > vw + 1.5 && !clippedByAncestor(el)) {
      out.culprits.push({ tag: el.tagName, cls: label(el), right: Math.round(b.right), w: Math.round(b.width) });
    }
  }

  // Text that cannot fit its box. .btn is included deliberately: buttons are
  // white-space: nowrap, so an under-wide column makes the label spill out of
  // its card — invisible to the page-overflow check when the card is
  // overflow: visible, which is exactly how the Quick Actions grid broke.
  for (const el of document.querySelectorAll('.stat-value, .cell-main, h3, .ci-label, .bar-label, .bp-title, .brand-name, .page-title, .tab, .seg button, .btn')) {
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) {
      out.clipped.push({ cls: label(el), need: el.scrollWidth, have: el.clientWidth, txt: (el.textContent || '').trim().slice(0, 18) });
    }
  }

  // Multi-column grids whose children collapsed below a readable width.
  document.querySelectorAll('.grid').forEach((g) => {
    // Hidden views (the invoice editor on other pages) are legitimately 0x0.
    if (!g.offsetParent && getComputedStyle(g).position !== 'fixed') return;
    const cs = getComputedStyle(g);
    if (cs.display !== 'grid') return;
    const cols = cs.gridTemplateColumns.split(' ').length;
    const first = g.firstElementChild;
    if (!first) return;
    const w = Math.round(first.getBoundingClientRect().width);
    if (cols > 1 && w < 90) out.grid.push({ cols, childW: w, cls: label(g) });
  });

  // Chart bar labels must not overlap the next column.
  const labels = Array.from(document.querySelectorAll('#revenueChart .bar-label'));
  out.barLabels = labels.length;
  for (let i = 1; i < labels.length; i++) {
    const a = labels[i - 1].getBoundingClientRect();
    const b = labels[i].getBoundingClientRect();
    if (b.left < a.right - 0.5) out.collisions++;
  }

  const donut = document.querySelector('#reportDonut');
  if (donut) out.donutW = Math.round(donut.getBoundingClientRect().width);
  const chart = document.querySelector('#revenueChart');
  if (chart && chart.closest('.card')) out.chartW = Math.round(chart.closest('.card').getBoundingClientRect().width);

  return JSON.stringify(out);
})()`;

const seen = new Set();

/* ============ A. Nothing overflows, crushes, clips or collides ============ */
r.section('A. Page fits the viewport');
for (const w of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
  for (const page of PAGES) {
    await goto(page, 1400);
    const m = JSON.parse(await evaluate(probe));
    const problems = [];
    if (m.scrollW > m.vw) problems.push(`scrollW ${m.scrollW}>${m.vw}`);
    if (m.culprits.length) problems.push(`${m.culprits.length} overflow`);
    if (m.grid.length) problems.push(`${m.grid.length} crushed grid`);
    if (m.clipped.length) problems.push(`${m.clipped.length} clipped`);
    if (m.collisions) problems.push(`${m.collisions}/${m.barLabels} label collisions`);

    r.check(`${String(w).padStart(4)}px ${page} fits`, problems.length === 0, problems.join('; '));

    // Print the culprit once per shape — a broken layout repeats on every page.
    for (const c of m.culprits) {
      const k = `ov|${w}|${c.cls}|${c.tag}`;
      if (seen.has(k)) continue;
      seen.add(k);
      console.log(`         OVERFLOW <${c.tag} .${c.cls}> w=${c.w} right=${c.right}`);
    }
    for (const c of m.grid) {
      const k = `cr|${w}|${c.cls}|${c.cols}`;
      if (seen.has(k)) continue;
      seen.add(k);
      console.log(`         CRUSHED  grid cols=${c.cols} childW=${c.childW} (.${c.cls})`);
    }
    for (const c of m.clipped) {
      const k = `cl|${w}|${c.cls}|${c.txt}`;
      if (seen.has(k)) continue;
      seen.add(k);
      console.log(`         CLIPPED  .${c.cls} "${c.txt}" ${c.need}>${c.have}`);
    }
  }
}

/* ============ B. Charts stay readable at phone widths ============ */
r.section('B. Charts at phone width');
await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: false });
await goto('reports.html', 1800);
const phoneChart = JSON.parse(
  await evaluate(`JSON.stringify({
    chart: (document.querySelector('#revenueChart')?.closest('.card') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width,
    donut: (document.querySelector('#reportDonut') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width,
    legend: document.querySelector('.legend') ? getComputedStyle(document.querySelector('.legend')).minWidth : null
  })`),
);
r.check('chart card is readable at 320px (>= 200px)', phoneChart.chart >= 200, `${Math.round(phoneChart.chart)}px`);
r.check('donut is readable at 320px (>= 120px)', phoneChart.donut >= 120, `${Math.round(phoneChart.donut)}px`);

/* ============ C. Mobile-first chrome contract ============ */
r.section('C. Chrome across breakpoints');
const chrome = async (w) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
  await goto('index.html', 1600);
  return JSON.parse(
    await evaluate(`(() => {
      const nav = document.querySelector('.bottom-nav');
      const sb = document.querySelector('.sidebar');
      const fab = document.querySelector('.fab');
      const menu = document.querySelector('#menuBtn');
      const sbr = sb.getBoundingClientRect();
      const nr = nav ? nav.getBoundingClientRect() : null;
      const fr = fab ? fab.getBoundingClientRect() : null;
      return JSON.stringify({
        navDisplay: nav ? getComputedStyle(nav).display : 'missing',
        menuDisplay: menu ? getComputedStyle(menu).display : 'missing',
        sbLeft: Math.round(sbr.left),
        sbRight: Math.round(sbr.right),
        sbWidth: Math.round(sbr.width),
        fabClearsNav: !!(fr && nr) ? fr.bottom <= nr.top + 1 : null
      });
    })()`),
  );
};

const at320 = await chrome(320);
r.eq('320px: bottom nav is visible', at320.navDisplay, 'block');
r.check('320px: sidebar is off-canvas', at320.sbRight <= 0, `right=${at320.sbRight}`);
r.check('320px: hamburger is available', at320.menuDisplay !== 'none', at320.menuDisplay);
r.check('320px: FAB clears the bottom nav', at320.fabClearsNav !== false, String(at320.fabClearsNav));

// 768px is the last phone-class width: the bottom nav retires at 769px.
const at768 = await chrome(768);
r.eq('768px: bottom nav still visible', at768.navDisplay, 'block');
r.check('768px: sidebar still off-canvas', at768.sbRight <= 0, `right=${at768.sbRight}`);
r.check('768px: hamburger is available', at768.menuDisplay !== 'none', at768.menuDisplay);

// The tablet range (769–1023px) is hamburger-only: no bottom nav, no docked
// sidebar. Navigation must therefore still be reachable via the menu button.
const at900 = await chrome(900);
r.eq('900px: bottom nav retired', at900.navDisplay, 'none');
r.check('900px: sidebar off-canvas', at900.sbRight <= 0, `right=${at900.sbRight}`);
r.check('900px: hamburger carries navigation', at900.menuDisplay !== 'none', at900.menuDisplay);

const at1024 = await chrome(1024);
r.eq('1024px: bottom nav retired', at1024.navDisplay, 'none');
r.check('1024px: sidebar docked', at1024.sbLeft === 0 && at1024.sbWidth >= 200, `left=${at1024.sbLeft} w=${at1024.sbWidth}`);
r.eq('1024px: hamburger hidden', at1024.menuDisplay, 'none');

const at1440 = await chrome(1440);
r.eq('1440px: bottom nav gone', at1440.navDisplay, 'none');
r.check('1440px: sidebar docked', at1440.sbLeft === 0 && at1440.sbWidth >= 200, `left=${at1440.sbLeft} w=${at1440.sbWidth}`);
r.eq('1440px: hamburger hidden', at1440.menuDisplay, 'none');

/* ============ D. Dashboard chart ranges ============
   Section A only ever measures the DEFAULT 7-day chart. The bar chart is a flex
   row, and a flex item defaults to `min-width: auto` — so a 30- or 90-day range
   inflates every column to its own label width, overflowing the card and, since
   the card is a grid item, the entire page. That is exactly how a 1440px / 90D
   dashboard shipped overflowing by 1641px: nothing here ever changed the range.
   Sweep all three ranges at the widths the bug report named. */
r.section('D. Dashboard chart ranges');
{
  const RANGES = ['7', '30', '90'];
  const RANGE_WIDTHS = [375, 768, 1024, 1440];
  for (const w of RANGE_WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const range of RANGES) {
      await goto('index.html', 3000);
      await evaluate(`document.querySelector('[data-range="${range}"]').click()`);
      await sleep(600);
      const d = JSON.parse(await evaluate(`(() => {
        const doc = document.documentElement;
        const chart = document.querySelector('#salesChart');
        const salesCard = chart && chart.closest('.card');
        const statusCard = document.querySelector('.col-span-4.card');
        let overlap = 0;
        if (salesCard && statusCard) {
          const a = salesCard.getBoundingClientRect();
          const b = statusCard.getBoundingClientRect();
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ox > 0 && oy > 0) overlap = Math.round(ox);
        }
        const labels = Array.from(document.querySelectorAll('#salesChart .bar-label'));
        let collisions = 0;
        for (let i = 1; i < labels.length; i++) {
          const a = labels[i - 1].getBoundingClientRect();
          const b = labels[i].getBoundingClientRect();
          if (b.left < a.right - 0.5) collisions++;
        }
        return JSON.stringify({
          bars: document.querySelectorAll('#salesChart .bar-col').length,
          pageOverflow: doc.scrollWidth - doc.clientWidth,
          overlap, collisions,
          density: chart ? chart.dataset.density : null,
        });
      })()`));

      const problems = [];
      if (d.pageOverflow > 1) problems.push(`page overflows by ${d.pageOverflow}px`);
      if (d.overlap > 0) problems.push(`Sales/Status cards overlap by ${d.overlap}px`);
      if (d.collisions > 0) problems.push(`${d.collisions} bar-label collisions`);
      if (d.bars !== Number(range)) problems.push(`rendered ${d.bars} bars, expected ${range}`);
      r.check(`${String(w).padStart(4)}px ${range.padStart(2)}D: fits, cards clear, labels readable`,
        problems.length === 0, problems.join('; '));

      const expected = Number(range) <= 14 ? 'normal' : Number(range) <= 45 ? 'dense' : 'ultra';
      r.eq(`${String(w).padStart(4)}px ${range.padStart(2)}D: density is "${expected}"`, d.density, expected);
    }
  }
}

await send('Emulation.clearDeviceMetricsOverride');

const ok = r.finish();
process.exit(ok ? 0 : 1);

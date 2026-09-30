/**
 * Chart regression suite — the donut and the bar chart.
 *
 * These two charts are hand-rolled inline SVG/CSS with no chart library, so
 * nothing else in the project would notice if they silently stopped drawing,
 * started lying about the numbers, or grew a CDN dependency. The static suite
 * can only prove the markup exists; this proves the rendered pixels agree with
 * the ledger.
 *
 * The checks that actually matter, and the bug each one would have caught:
 *
 *   geometry   the bars' band, the gridline band and the y-axis band must be
 *              the SAME box. When they drift, every bar is silently short by
 *              the x-axis label height and the ticks stop meeting the lines.
 *   encoding   bar height == value / axis max. Catches a chart that looks
 *              plausible but is not proportional.
 *   ledger     every bucket equals an independently recomputed daily total
 *              from the invoice records.
 *   clipping   the tallest bar's value label must be visible. `overflow-x:auto`
 *              forces overflow-y to auto, so the top gutter has to live INSIDE
 *              the scroll container.
 *   offline    zero cross-origin requests — no CDN chart library.
 *
 * Run via `npm run test:charts`, or `npm run test:e2e` for the whole set.
 */
import { CONFIG, connect, createReporter, sleep } from './lib/cdp.js';

const r = createReporter('Charts');
const { send, evaluate, goto, errors, close } = await connect();

/** Demo seeding is not instantaneous, and a cold Chrome start is slower still. */
const waitFor = async (expr, tries = 80, gap = 250) => {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(expr)) return true;
    await sleep(gap);
  }
  return false;
};

/**
 * Wait until both entrance animations have finished.
 *
 * Asserting "the chart is drawn" the moment the elements appear is a race: the
 * bars are deliberately rendered collapsed and then grow, and the donut writes
 * its dash on a staggered timeout. For about a second the CORRECT state is an
 * empty ring and zero-height bars, so a fixed sleep is a flake waiting to
 * happen on a slow machine. Poll for the settled state instead.
 */
const SETTLED = `(() => {
  const fills = [...document.querySelectorAll('#salesChart .bar-fill')];
  const arcs = [...document.querySelectorAll('#statusDonut .donut-arc')];
  return fills.length > 0 && arcs.length > 0
    && fills.every((f) => getComputedStyle(f).transform === 'matrix(1, 0, 0, 1, 0, 0)')
    && arcs.every((a) => a.style.strokeDasharray && a.style.strokeDasharray !== '0 100');
})()`;
const waitSettled = (tries = 40, gap = 250) => waitFor(SETTLED, tries, gap);

const setWidth = (w, h) =>
  send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });

/** Read a CSS custom property as a resolved colour, so tokens compare fairly. */
const PROBE = `(v) => { const d = document.createElement('div'); d.style.color = v; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; }`;
const normDash = (s) => String(s).replace(/[,\s]+/g, ' ').trim();

await send('Storage.clearDataForOrigin', { origin: CONFIG.origin, storageTypes: 'all' });
await setWidth(1440, 1000);
await goto('index.html', 2000);
await waitFor(`!!document.querySelector('#statusDonut .donut-seg') && !!document.querySelector('#salesChart .bar-col')`);
await waitSettled();

/* ==================================================================
   Donut
   ================================================================== */
r.section('Donut — structure');
const donut = await evaluate(`(() => {
  const host = document.querySelector('#statusDonut');
  const svg = host.querySelector('svg.donut-svg');
  const circles = [...host.querySelectorAll('.donut-arc')];
  const segs = [...host.querySelectorAll('.donut-seg')];
  const legend = [...host.querySelectorAll('.legend-row')];
  const first = circles[0];
  const rad = first ? parseFloat(first.getAttribute('r')) : 0;
  const sw = first ? parseFloat(first.getAttribute('stroke-width')) : 0;
  const track = host.querySelector('.donut-track');
  const probe = ${PROBE};
  return {
    hasSvg: !!svg,
    role: svg?.getAttribute('role'),
    aria: svg?.getAttribute('aria-label') || '',
    pathLength: first?.getAttribute('pathLength'),
    cutout: +(((rad - sw / 2) / (rad + sw / 2)).toFixed(3)),
    dashStyle: circles.map((c) => c.style.strokeDasharray || ''),
    dashAttr: circles.map((c) => c.getAttribute('data-dash') || ''),
    segs: segs.length,
    legendRows: legend.length,
    swatchRadius: legend[0] ? getComputedStyle(legend[0].querySelector('.legend-swatch')).borderRadius : null,
    centre: host.querySelector('.donut-total')?.textContent?.trim(),
    trackStroke: track ? getComputedStyle(track).stroke : null,
    surface: probe('var(--surface)'),
    tipRole: host.querySelector('.chart-tip')?.getAttribute('role'),
    tableRows: host.querySelectorAll('table.sr-only tbody tr').length,
    legendSum: legend.reduce((s, l) => s + (Number((l.querySelector('.legend-value')?.textContent || '').replace(/[^0-9.]/g, '')) || 0), 0),
  };
})()`);

r.check('renders an inline <svg>', donut.hasSvg, donut.hasSvg);
r.eq('svg is role=img', donut.role, 'img');
r.check('aria-label summarises the data', /Invoice status:/.test(donut.aria), donut.aria.slice(0, 80));
r.eq('pathLength=100', donut.pathLength, '100');
r.check('cutout is 62%', Math.abs(donut.cutout - 0.62) < 0.015, donut.cutout);
r.check('every arc grew to its final dash', donut.dashStyle.every((d) => d && d !== '0 100'), JSON.stringify(donut.dashStyle));
r.check('rendered dash matches data-dash', donut.dashStyle.every((d, i) => normDash(d) === normDash(donut.dashAttr[i])), JSON.stringify(donut.dashStyle));
r.check('separators show the surface-coloured track', donut.trackStroke === donut.surface, `${donut.trackStroke} vs ${donut.surface}`);
r.eq('legend swatch radius 4px', donut.swatchRadius, '4px');
r.eq('legend row per drawn segment', donut.legendRows, donut.segs);
r.eq('tooltip has role=tooltip', donut.tipRole, 'tooltip');
r.check('centre shows a total', !!donut.centre, donut.centre);
r.check('hidden table carries every status', donut.tableRows === 4, donut.tableRows);

r.section('Donut — ledger');
const donutData = await evaluate(`(async () => {
  const db = await import('./js/db.js');
  const invoices = await db.getInvoices();
  const payments = await db.getPayments();
  const paidBy = {};
  payments.forEach((p) => { paidBy[p.invoiceId] = (paidBy[p.invoiceId] || 0) + Number(p.amount || 0); });
  // The donut is handed the ENRICHED list (app.js enrichInvoices -> deriveStatus),
  // so the expectation has to be built the same way, not from the stored status.
  const enriched = invoices.map((inv) => {
    const amountPaid = paidBy[inv.id] || inv.amountPaid || 0;
    const gt = Number(inv.grandTotal || 0);
    const status = gt <= 0 || gt - amountPaid <= 0 ? 'paid' : amountPaid > 0 ? 'partial' : 'unpaid';
    return { ...inv, status };
  });
  const host = document.querySelector('#statusDonut');
  const sum = (a) => a.reduce((s, v) => s + (Number(v) || 0), 0);
  const rows = [...host.querySelectorAll('table.sr-only tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent.trim()));
  const meta = { Paid: 'paid', Partial: 'partial', Unpaid: 'unpaid', Draft: 'draft' };
  const expected = Object.entries(meta).map(([label, key]) => ({
    label,
    count: enriched.filter((i) => i.status === key).length,
    amount: Math.round(sum(enriched.filter((i) => i.status === key).map((i) => i.grandTotal))),
  }));
  const actual = rows.map((c) => ({ label: c[0], count: Number(c[1]), amount: Math.round(Number(c[2].replace(/[^0-9.]/g, '')) || 0) }));
  return {
    expected, actual,
    countsOk: actual.length === expected.length && actual.every((a, i) => a.count === expected[i].count),
    amountsOk: actual.length === expected.length && actual.every((a, i) => Math.abs(a.amount - expected[i].amount) < 1),
  };
})()`);
r.check('per-status counts match the invoice records', donutData.countsOk, JSON.stringify(donutData.actual));
r.check('per-status amounts match the invoice records', donutData.amountsOk, JSON.stringify(donutData.actual));

r.section('Donut — interaction');
const hover = await (async () => {
  await evaluate(`(() => { const s = document.querySelector('#statusDonut .donut-seg'); s.dataset.zzKey = s.dataset.key; s.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true })); return true; })()`);
  await sleep(350); // let the 180ms pop-out transition land before measuring
  const h = await evaluate(`(() => {
    const seg = document.querySelector('#statusDonut .donut-seg');
    const tip = document.querySelector('#statusDonut .chart-tip');
    const row = document.querySelector('#statusDonut .legend-row[data-key="' + seg.dataset.zzKey + '"]');
    return { popped: seg.classList.contains('is-pop'), rowActive: row?.classList.contains('is-active'), tipHidden: tip.hidden, tipText: tip.textContent, transform: getComputedStyle(seg).transform };
  })()`);
  await evaluate(`document.querySelector('#statusDonut .donut-seg').dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))`);
  await sleep(350);
  h.afterLeave = await evaluate(`document.querySelector('#statusDonut .donut-seg').classList.contains('is-pop')`);
  return h;
})();
r.check('hovering a segment pops it out', hover.popped, hover.popped);
r.check('pop-out is a real translate', hover.transform !== 'none' && hover.transform !== 'matrix(1, 0, 0, 1, 0, 0)', hover.transform);
r.check('the matching legend row highlights', hover.rowActive === true, hover.rowActive);
r.check('tooltip reads "<label>: <amount>"', /^[A-Za-z]+: .+/.test(hover.tipText), hover.tipText);
r.check('pop-out clears on leave', hover.afterLeave === false, hover.afterLeave);

const kbd = await evaluate(`(() => { const s = document.querySelector('#statusDonut .donut-seg'); s.focus(); const t = document.querySelector('#statusDonut .chart-tip'); const o = { focused: document.activeElement === s, tipHidden: t.hidden }; s.blur(); return o; })()`);
r.check('keyboard focus on a segment shows the tooltip', kbd.focused && kbd.tipHidden === false, JSON.stringify(kbd));

/* ==================================================================
   Bar chart
   ================================================================== */
r.section('Bars — geometry');
const geo = await evaluate(`(() => {
  const el = document.querySelector('#salesChart');
  const band = (s) => { const e = el.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height) }; };
  return {
    density: el.dataset.density,
    cols: el.querySelectorAll('.bar-col').length,
    fills: el.querySelectorAll('.bar-fill').length,
    labels: el.querySelectorAll('.bar-label').length,
    scale: band('.bar-scale'), grid: band('.chart-grid'), ybox: band('.chart-ybox'),
    ticks: [...el.querySelectorAll('.chart-ytick')].map((t) => t.textContent),
    role: el.querySelector('.chart-plot')?.getAttribute('role'),
    aria: el.querySelector('.chart-plot')?.getAttribute('aria-label') || '',
    tableRows: el.querySelectorAll('table.sr-only tbody tr').length,
  };
})()`);
const sameBand = (a, b) => a && b && a.t === b.t && a.b === b.b;
r.eq('one column per day (7D)', geo.cols, 7);
r.eq('one bar per column', geo.fills, geo.cols);
r.eq('one x label per column', geo.labels, geo.cols);
r.eq('density "normal" for 7 buckets', geo.density, 'normal');
r.check('bar band == gridline band', sameBand(geo.scale, geo.grid), JSON.stringify({ scale: geo.scale, grid: geo.grid }));
r.check('bar band == y-axis band', sameBand(geo.scale, geo.ybox), JSON.stringify({ scale: geo.scale, ybox: geo.ybox }));
r.eq('plot is role=img', geo.role, 'img');
r.check('plot has a generated summary', /total/.test(geo.aria), geo.aria.slice(0, 90));
r.eq('hidden table has one row per bar', geo.tableRows, geo.cols);
r.check('axis starts at zero', geo.ticks[0] === '0', geo.ticks[0]);
r.check('ticks are compact (K/M)', geo.ticks.slice(1).every((t) => /[KM]$/.test(t)), JSON.stringify(geo.ticks));
r.check('4-5 nice steps', geo.ticks.length >= 4 && geo.ticks.length <= 6, geo.ticks.length);

r.section('Bars — encoding and tokens');
const enc = await evaluate(`(() => {
  const el = document.querySelector('#salesChart');
  const probe = ${PROBE};
  const yboxH = el.querySelector('.chart-ybox').getBoundingClientRect().height;
  const ticks = [...el.querySelectorAll('.chart-ytick')].map((t) => {
    const n = Number(t.textContent.replace(/[^0-9.]/g, ''));
    return /M/.test(t.textContent) ? n * 1e6 : /K/.test(t.textContent) ? n * 1e3 : n;
  });
  const axisMax = Math.max(...ticks);
  const values = [...el.querySelectorAll('table.sr-only tbody tr')].map((tr) => Number([...tr.children][1].textContent.replace(/[^0-9.]/g, '')) || 0);
  const fills = [...el.querySelectorAll('.bar-fill')];
  const heights = fills.map((f) => f.getBoundingClientRect().height);
  const cs = (e) => getComputedStyle(e);
  return {
    worst: +Math.max(...values.map((v, i) => Math.abs(heights[i] - (v / axisMax) * yboxH))).toFixed(1),
    bgs: fills.map((f) => cs(f).backgroundColor),
    opacities: fills.map((f) => cs(f).opacity),
    brand700: probe('var(--brand-700)'),
    spark: probe('var(--spark)'),
    peaks: fills.map((f) => f.classList.contains('is-peak')),
    radii: fills.map((f) => cs(f).borderTopLeftRadius + '/' + cs(f).borderBottomLeftRadius),
    maxW: fills.map((f) => cs(f).maxWidth),
    gridOpacity: cs(el.querySelector('.chart-grid span')).opacity,
    // .chart-cols is the clipping box: overflow-x:auto forces overflow-y to
    // auto, so anything poking above it is cut off. Assert against THAT, not
    // against the plot — a 1px overhang there is a real clip.
    tallestLabelVisible: (() => {
      const i = values.indexOf(Math.max(...values));
      if (i < 0) return null;
      const box = el.querySelectorAll('.bar-value')[i].getBoundingClientRect();
      const clip = el.querySelector('.chart-cols').getBoundingClientRect();
      return box.height > 0 && box.top >= clip.top - 0.5 && box.bottom <= clip.bottom + 0.5;
    })(),
  };
})()`);
r.check('bar height == value / axis max (<=1px)', enc.worst <= 1, `${enc.worst}px`);
r.check('resting bars use --brand-700', enc.bgs.filter((c) => c === enc.brand700).length === enc.bgs.length - 1, JSON.stringify(enc.bgs));
r.check('exactly one bar is the peak', enc.peaks.filter(Boolean).length === 1, JSON.stringify(enc.peaks));
r.check('the peak bar uses --spark', enc.bgs[enc.peaks.indexOf(true)] === enc.spark, enc.bgs[enc.peaks.indexOf(true)]);
r.check('resting opacity is 0.85', enc.opacities.every((o) => o === '0.85'), JSON.stringify(enc.opacities));
r.check('rounded top, flat bottom', enc.radii.every((v) => v === '8px/0px'), JSON.stringify(enc.radii));
r.check('bar max width is 42px', enc.maxW.every((w) => w === '42px'), JSON.stringify(enc.maxW));
r.eq('gridlines are at 8% opacity', enc.gridOpacity, '0.08');
r.check('the tallest bar\'s value label is not clipped', enc.tallestLabelVisible === true, enc.tallestLabelVisible);

r.section('Bars — ledger');
const acc = await evaluate(`(async () => {
  const db = await import('./js/db.js');
  const invoices = await db.getInvoices();
  const payments = await db.getPayments();
  const paidBy = {};
  payments.forEach((p) => { paidBy[p.invoiceId] = (paidBy[p.invoiceId] || 0) + Number(p.amount || 0); });
  // Reproduce the app's own enrichment (app.js enrichInvoices -> deriveStatus),
  // because the chart is handed the enriched list, not the stored status.
  const enriched = invoices.map((inv) => {
    const amountPaid = paidBy[inv.id] || inv.amountPaid || 0;
    const gt = Number(inv.grandTotal || 0);
    const status = gt <= 0 || gt - amountPaid <= 0 ? 'paid' : amountPaid > 0 ? 'partial' : 'unpaid';
    return { ...inv, status };
  });
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const expected = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = iso(d);
    expected.push(Math.round(enriched.filter((inv) => inv.issueDate === key && inv.status !== 'draft' && inv.status !== 'cancelled').reduce((s, inv) => s + (inv.grandTotal || 0), 0)));
  }
  const el = document.querySelector('#salesChart');
  const chart = [...el.querySelectorAll('table.sr-only tbody tr')].map((tr) => Math.round(Number([...tr.children][1].textContent.replace(/[^0-9.]/g, '')) || 0));
  return { chart, expected, ok: chart.length === expected.length && chart.every((v, i) => Math.abs(v - expected[i]) < 1) };
})()`);
r.check('every bucket equals its recomputed daily total', acc.ok, `chart=${JSON.stringify(acc.chart)} expected=${JSON.stringify(acc.expected)}`);

r.section('Bars — entrance animation');
await evaluate(`document.querySelector('[data-range="30"]').click()`);
await sleep(30);
const mid = await evaluate(`(() => {
  const el = document.querySelector('#salesChart');
  return {
    grown: el.classList.contains('is-grown'),
    transforms: [...el.querySelectorAll('.bar-fill')].slice(0, 6).map((f) => getComputedStyle(f).transform),
    delays: [...el.querySelectorAll('.bar-scale')].slice(0, 4).map((s) => s.style.getPropertyValue('--d')),
    cols: el.querySelectorAll('.bar-col').length,
    density: el.dataset.density,
  };
})()`);
await sleep(2700); // 30 bars x 60ms + 500ms duration
const settled = await evaluate(`[...document.querySelectorAll('#salesChart .bar-fill')].every((f) => getComputedStyle(f).transform === 'matrix(1, 0, 0, 1, 0, 0)')`);
r.check('animation class applied on render', mid.grown, mid.grown);
r.check('bars start collapsed (scaleY 0)', mid.transforms.some((t) => /matrix\(1, 0, 0, 0, 0, 0\)/.test(t)), JSON.stringify(mid.transforms));
r.eq('stagger is 60ms per bar', mid.delays.join(','), '0ms,60ms,120ms,180ms');
r.eq('30 buckets -> 30 columns', mid.cols, 30);
r.eq('density "dense" for 30 buckets', mid.density, 'dense');
r.check('every bar ends at full scale', settled, settled);

r.section('Reduced motion');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await evaluate(`document.querySelector('[data-range="7"]').click()`);
await sleep(40);
const rmBars = await evaluate(`(() => {
  const el = document.querySelector('#salesChart');
  return { grown: el.classList.contains('is-grown'), allFull: [...el.querySelectorAll('.bar-fill')].every((f) => ['none', 'matrix(1, 0, 0, 1, 0, 0)'].includes(getComputedStyle(f).transform)) };
})()`);
r.check('bar animation is not armed', rmBars.grown === false, rmBars.grown);
r.check('bars render at final height immediately', rmBars.allFull, rmBars.allFull);

const rmDonut = await evaluate(`(async () => {
  const m = await import('./js/charts.js');
  const host = document.querySelector('#statusDonut');
  m.renderStatusDonut(host, { buckets: [{ key: 'paid', label: 'Paid', count: 2, amount: 1662930 }, { key: 'unpaid', label: 'Unpaid', count: 3, amount: 3233200 }], currency: { symbol: 'TZS' } });
  const arcs = [...host.querySelectorAll('.donut-arc')];
  return { dashes: arcs.map((a) => a.style.strokeDasharray || ''), data: arcs.map((a) => a.getAttribute('data-dash')) };
})()`);
r.check('donut writes its final dash synchronously', rmDonut.dashes.every((d, i) => d && normDash(d) === normDash(rmDonut.data[i])), JSON.stringify(rmDonut.dashes));
await send('Emulation.setEmulatedMedia', { features: [] });

r.section('Empty state');
const empty = await evaluate(`(async () => {
  const m = await import('./js/charts.js');
  const out = {};
  const d = document.createElement('div'); document.body.appendChild(d);
  m.renderStatusDonut(d, { buckets: [{ key: 'paid', label: 'Paid', count: 0, amount: 0 }], currency: { symbol: 'TZS' } });
  out.donut = { empty: !!d.querySelector('.chart-empty'), svg: !!d.querySelector('svg.donut-svg'), title: d.querySelector('.chart-empty-title')?.textContent?.trim(), cta: !!d.querySelector('.chart-empty a') };
  d.remove();
  const b = document.createElement('div'); document.body.appendChild(b);
  m.renderBarChart(b, { buckets: [{ key: 'x', label: 'Mon' }], values: [0], currency: { symbol: 'TZS' }, caption: 'Sales' });
  out.bars = { empty: !!b.querySelector('.chart-empty'), cols: b.querySelectorAll('.bar-col').length, title: b.querySelector('.chart-empty-title')?.textContent?.trim(), cta: !!b.querySelector('.chart-empty a') };
  b.remove();
  return out;
})()`);
r.check('donut renders the empty state, not a ring of nothing', empty.donut.empty && !empty.donut.svg, JSON.stringify(empty.donut));
r.check('donut empty state names the situation', empty.donut.title === 'No invoices yet', empty.donut.title);
r.check('donut empty state offers a way forward', empty.donut.cta, empty.donut.cta);
r.check('bar chart renders the empty state for an all-zero series', empty.bars.empty && empty.bars.cols === 0, JSON.stringify(empty.bars));
r.check('bar empty state names the series', empty.bars.title === 'No sales yet', empty.bars.title);
r.check('bar empty state offers a way forward', empty.bars.cta, empty.bars.cta);

/* ==================================================================
   Reports page, offline, layout
   ================================================================== */
r.section('Reports page');
await goto('reports.html', 2000);
await waitFor(`!!document.querySelector('#revenueChart .bar-col') && !!document.querySelector('#reportDonut .donut-seg')`);
await sleep(2600);
const rep = await evaluate(`(() => {
  const el = document.querySelector('#revenueChart');
  const host = document.querySelector('#reportDonut');
  return {
    cols: el.querySelectorAll('.bar-col').length,
    role: el.querySelector('.chart-plot')?.getAttribute('role'),
    table: el.querySelectorAll('table.sr-only tbody tr').length,
    ticks: [...el.querySelectorAll('.chart-ytick')].map((t) => t.textContent),
    donutArcs: host.querySelectorAll('.donut-arc').length,
    donutDashed: [...host.querySelectorAll('.donut-arc')].every((a) => a.style.strokeDasharray && a.style.strokeDasharray !== '0 100'),
  };
})()`);
r.check('revenue chart renders bars', rep.cols > 0, rep.cols);
r.check('revenue plot is role=img with a matching table', rep.role === 'img' && rep.table === rep.cols, JSON.stringify(rep));
r.check('revenue axis has compact ticks', rep.ticks.slice(1).every((t) => /[KM]$/.test(t)), JSON.stringify(rep.ticks));
r.check('report donut renders arcs', rep.donutArcs > 0, rep.donutArcs);
r.check('report donut arcs are drawn', rep.donutDashed, rep.donutDashed);

r.section('Offline / no external deps');
const external = await evaluate(`performance.getEntriesByType('resource').map((e) => e.name).filter((u) => !u.startsWith(location.origin))`);
r.eq('zero cross-origin requests (no CDN chart library)', external.length, 0);
if (external.length) console.log('  external:', external);

r.section('Layout at 360px');
await goto('index.html', 2000);
await waitFor(`!!document.querySelector('#salesChart .bar-col')`);
await setWidth(360, 900);
await waitSettled();
await sleep(400);
const ov = await evaluate(`(() => {
  const doc = document.documentElement;
  const ticks = [...document.querySelectorAll('#salesChart .chart-ytick')];
  return {
    scrollW: doc.scrollWidth, vw: window.innerWidth,
    ticksOffscreen: ticks.some((t) => t.getBoundingClientRect().left < 0),
    legendRight: (() => { const l = document.querySelector('.legend'); if (!l) return 0; return Math.round(l.getBoundingClientRect().right); })(),
    hostRight: Math.round(document.querySelector('#statusDonut').getBoundingClientRect().right),
  };
})()`);
r.check('no horizontal overflow', ov.scrollW <= ov.vw + 1, `scrollW=${ov.scrollW} vw=${ov.vw}`);
r.check('y-axis ticks stay on screen', ov.ticksOffscreen === false, ov.ticksOffscreen);
r.check('donut legend stays inside the card', ov.legendRight <= ov.hostRight + 1, `${ov.legendRight} <= ${ov.hostRight}`);

r.section('Console');
const errs = errors();
r.eq('zero console errors / exceptions', errs.length, 0);
errs.forEach((e) => console.log('   !', e.level, e.text));

const ok = r.finish();
close();
process.exit(ok ? 0 : 1);

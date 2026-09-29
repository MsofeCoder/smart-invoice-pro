/**
 * Dashboard module
 * Stats overview, sales chart, invoice status donut, recent invoices.
 * Seeds sample data on first run so the dashboard is never empty.
 */
import { $, $$, escapeHTML, toNumber, toISODate, formatDate, toast } from './utils.js';
import { getInvoices, getCustomers, getProducts, getPayments, getSetting, count, seedSampleData } from './storageService.js';
import { getDefaultCurrencyCode, getCurrency, formatMoney } from './currency.js';
import { round2, sum, deriveStatus } from './calculations.js';
import { initShell } from './shell.js';

let state = {
  invoices: [],
  customers: [],
  products: [],
  payments: [],
  currency: null,
  company: {},
  range: 7,
};

/* ================= Helpers ================= */
function statusBadge(status) {
  const map = {
    draft: '<span class="badge badge-gray"><span class="badge-dot"></span>Draft</span>',
    unpaid: '<span class="badge badge-orange"><span class="badge-dot"></span>Unpaid</span>',
    partial: '<span class="badge badge-gold"><span class="badge-dot"></span>Partial</span>',
    paid: '<span class="badge badge-green"><span class="badge-dot"></span>Paid</span>',
    overdue: '<span class="badge badge-red"><span class="badge-dot"></span>Overdue</span>',
    cancelled: '<span class="badge badge-gray"><span class="badge-dot"></span>Cancelled</span>',
  };
  return map[status] || '<span class="badge badge-gray">—</span>';
}

function enrichInvoices() {
  const paidByInvoice = {};
  state.payments.forEach((p) => {
    paidByInvoice[p.invoiceId] = round2((paidByInvoice[p.invoiceId] || 0) + toNumber(p.amount));
  });
  return state.invoices.map((inv) => {
    const amountPaid = paidByInvoice[inv.id] || inv.amountPaid || 0;
    const balance = round2((inv.grandTotal || 0) - amountPaid);
    const status = deriveStatus(inv.grandTotal, amountPaid);
    return { ...inv, amountPaid, balance, status };
  });
}

function isOverdue(inv) {
  if (inv.status === 'paid' || inv.status === 'cancelled' || inv.status === 'draft') return false;
  if (!inv.dueDate) return false;
  return inv.dueDate < toISODate();
}

/* ================= Stats ================= */
function renderStats(invoices) {
  const grid = $('#statsGrid');
  if (!grid) return;

  const today = toISODate();
  const thisMonth = today.slice(0, 7);
  const active = invoices.filter((i) => i.status !== 'draft' && i.status !== 'cancelled');

  const todaySales = sum(active.filter((i) => i.issueDate === today && i.status === 'paid').map((i) => i.grandTotal));
  const monthSales = sum(active.filter((i) => (i.issueDate || '').slice(0, 7) === thisMonth && i.status === 'paid').map((i) => i.grandTotal));
  const pendingCount = active.filter((i) => i.status === 'unpaid' || i.status === 'partial').length;
  const paidCount = active.filter((i) => i.status === 'paid').length;
  const revenue = sum(active.filter((i) => i.status === 'paid').map((i) => i.grandTotal));
  const outstanding = sum(active.filter((i) => i.status === 'unpaid' || i.status === 'partial').map((i) => i.balance));
  const customerCount = state.customers.length;
  const productCount = state.products.length;

  const cards = [
    { label: "Today's Sales", value: formatMoney(todaySales, state.currency), icon: 'today', color: 'success' },
    { label: 'Monthly Sales', value: formatMoney(monthSales, state.currency), icon: 'month', color: 'brand' },
    { label: 'Pending', value: pendingCount, icon: 'pending', color: 'gold' },
    { label: 'Paid Invoices', value: paidCount, icon: 'paid', color: 'success' },
    { label: 'Revenue', value: formatMoney(revenue, state.currency), icon: 'revenue', color: 'brand' },
    { label: 'Outstanding', value: formatMoney(outstanding, state.currency), icon: 'outstanding', color: 'danger' },
    { label: 'Customers', value: customerCount, icon: 'customers', color: 'brand' },
    { label: 'Products', value: productCount, icon: 'products', color: 'gold' },
  ];

  const icons = {
    today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    month: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>',
    pending: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    paid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    revenue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    outstanding: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    customers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    products: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  };
  const colors = {
    success: { bg: 'bg-success-soft', text: 'text-success', deco: 'var(--success)' },
    danger: { bg: 'bg-danger-soft', text: 'text-danger', deco: 'var(--danger)' },
    brand: { bg: 'bg-brand-soft', text: 'text-brand', deco: 'var(--brand)' },
    gold: { bg: 'bg-gold-soft', text: 'text-gold', deco: 'var(--gold)' },
  };

  grid.innerHTML = cards.map((c) => {
    const col = colors[c.color];
    return `
      <div class="card card-pad stat-card card-hover animate-fade">
        <div class="stat-icon ${col.bg} ${col.text}">${icons[c.icon]}</div>
        <div class="stat-value">${escapeHTML(String(c.value))}</div>
        <div class="stat-label">${escapeHTML(c.label)}</div>
        <div class="stat-deco" style="background:${col.deco}"></div>
      </div>`;
  }).join('');
}

/* ================= Sales chart ================= */
function renderSalesChart(invoices) {
  const el = $('#salesChart');
  if (!el) return;
  const days = state.range;
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = toISODate(d);
    const label = days <= 7
      ? d.toLocaleDateString('en-GB', { weekday: 'short' })
      : `${d.getDate()}/${d.getMonth() + 1}`;
    buckets.push({ key, label });
  }
  const totals = buckets.map((b) => sum(
    invoices.filter((inv) => inv.issueDate === b.key && inv.status !== 'draft' && inv.status !== 'cancelled').map((inv) => inv.grandTotal)
  ));
  const max = Math.max(...totals, 1);

  /* Drives the column width in section 22 of css/styles.css. A 7-day range
     shares the card equally; 30 and 90 need a readable fixed column, so the
     chart scrolls horizontally instead of overflowing the card (and, because
     the card is a grid item, the page). */
  el.dataset.density = days <= 14 ? 'normal' : days <= 45 ? 'dense' : 'ultra';

  el.innerHTML = buckets.map((b, i) => {
    const h = Math.max(3, Math.round((totals[i] / max) * 100));
    const isGold = i === buckets.length - 1;
    return `
      <div class="bar-col" title="${escapeHTML(formatMoney(totals[i], state.currency))}">
        <div class="bar-value">${totals[i] > 0 ? escapeHTML(formatMoney(totals[i], state.currency).split(' ')[1]) : ''}</div>
        <div class="bar-track"><div class="bar-fill ${isGold ? 'gold' : ''}" style="height:${h}%"></div></div>
        <div class="bar-label">${escapeHTML(b.label)}</div>
      </div>`;
  }).join('');
}

/* ================= Status donut ================= */
function renderDonut(invoices) {
  const el = $('#statusDonut');
  if (!el) return;
  const counts = {
    paid: invoices.filter((i) => i.status === 'paid').length,
    partial: invoices.filter((i) => i.status === 'partial').length,
    unpaid: invoices.filter((i) => i.status === 'unpaid').length,
    draft: invoices.filter((i) => i.status === 'draft').length,
  };
  const total = Math.max(invoices.length, 1);
  const colors = { paid: '#388E3C', partial: '#F9A825', unpaid: '#F57C00', draft: '#CBD3CB' };
  const labels = { paid: 'Paid', partial: 'Partial', unpaid: 'Unpaid', draft: 'Draft' };
  let offset = 0;
  const segments = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .map(([key, value]) => {
      const pct = (value / total) * 100;
      const seg = `<circle r="15.915" cx="21" cy="21" fill="transparent" stroke="${colors[key]}" stroke-width="4" stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="${offset}" />`;
      offset -= pct;
      return seg;
    }).join('');
  const legend = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .map(([key, value]) => `
      <div class="lg-item">
        <span class="lg-dot" style="background:${colors[key]}"></span>
        <span>${labels[key]}</span>
        <span class="lg-val">${value}</span>
      </div>`).join('');
  el.innerHTML = `
    <div class="donut">
      <svg viewBox="0 0 42 42" width="170" height="170">
        <circle r="15.915" cx="21" cy="21" fill="transparent" stroke="var(--surface-2)" stroke-width="4"></circle>
        ${segments}
      </svg>
      <div class="donut-center"><div><div class="v">${invoices.length}</div><div class="l">Invoices</div></div></div>
    </div>
    <div class="legend">${legend}</div>`;
}

/* ================= Recent invoices ================= */
function renderRecent(invoices) {
  const tbody = $('#recentInvoicesBody');
  if (!tbody) return;
  const recent = invoices.slice(0, 6);
  if (!recent.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-faint py-4">No invoices yet. Click <strong>New Invoice</strong> to get started.</td></tr>`;
    return;
  }
  tbody.innerHTML = recent.map((inv) => `
    <tr>
      <td><a href="invoice.html?id=${encodeURIComponent(inv.id)}" class="cell-main">${escapeHTML(inv.number || inv.id)}</a></td>
      <td><span class="cell-main">${escapeHTML(inv.customerName || '—')}</span></td>
      <td class="text-muted">${escapeHTML(formatDate(inv.issueDate))}</td>
      <td>${statusBadge(inv.status)}</td>
      <td class="num font-semibold">${escapeHTML(formatMoney(inv.grandTotal, state.currency))}</td>
    </tr>`).join('');
}

/* ================= Render all ================= */
function renderAll() {
  const invoices = enrichInvoices();
  renderStats(invoices);
  renderSalesChart(invoices);
  renderDonut(invoices);
  renderRecent(invoices);
}

/* ================= Init ================= */
async function init() {
  await initShell();

  // First-run seeding: if there are no invoices, seed sample data so the
  // dashboard is not empty on a fresh install.
  try {
    const invoiceCount = await count('invoices');
    if (invoiceCount === 0) {
      await seedSampleData();
      toast('Welcome! Sample data has been added to get you started.', 'success', 5000);
    }
  } catch {
    // Non-fatal — continue without sample data.
  }

  const [invoices, customers, products, payments, currency, company] = await Promise.all([
    getInvoices(),
    getCustomers(),
    getProducts(),
    getPayments(),
    getCurrency(await getDefaultCurrencyCode()),
    getSetting('company', {}),
  ]);
  state.invoices = invoices;
  state.customers = customers;
  state.products = products;
  state.payments = payments;
  state.currency = currency;
  state.company = company || {};
  renderAll();

  // Welcome subtitle
  const sub = $('#todaySub');
  if (sub) {
    const name = state.company.businessName || '';
    sub.textContent = name ? `Welcome back, ${name}` : 'Welcome back';
  }

  // Range chips
  $$('.chip[data-range]').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('.chip[data-range]').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.range = parseInt(chip.dataset.range, 10) || 7;
      renderAll();
    });
  });

  // Live currency switch
  window.__onCurrencyChange = async () => {
    state.currency = await getCurrency(await getDefaultCurrencyCode());
    renderAll();
  };
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((err) => {
    console.error('Dashboard init failed:', err);
    toast('Failed to initialize: ' + err.message, 'error', 6000);
  });
});
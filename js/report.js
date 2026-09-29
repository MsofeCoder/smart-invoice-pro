/**
 * Report module
 * Daily/weekly/monthly/yearly analytics, revenue trend, top customers,
 * top products, status donut, PDF/CSV export, print.
 */
import { $, $$, escapeHTML, toNumber, toISODate, formatDate, toast, downloadBlob, withLoading } from './utils.js';
import { getInvoices, getCustomers, getProducts, getPayments, getSetting } from './storageService.js';
import { getDefaultCurrencyCode, getCurrency, formatMoney } from './currency.js';
import { round2, sum, deriveStatus } from './calculations.js';
import { exportCSV } from './export.js';
import { initShell } from './shell.js';
import { loadBrandSync, paletteToCss, pdfColors } from './brand.js';
import { fallbackBusinessName } from './config.js';

let state = {
  invoices: [],
  customers: [],
  products: [],
  payments: [],
  currency: null,
  company: {},
  period: 'daily',
};

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

function periodBuckets() {
  const now = new Date();
  const buckets = [];
  if (state.period === 'daily') {
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      buckets.push({ key: toISODate(d), label: d.toLocaleDateString('en-GB', { weekday: 'short' }) });
    }
  } else if (state.period === 'weekly') {
    for (let i = 7; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i * 7);
      const start = new Date(d);
      start.setDate(start.getDate() - 6);
      buckets.push({ key: toISODate(start).slice(0, 7), label: start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) });
    }
  } else if (state.period === 'monthly') {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString('en-GB', { month: 'short' }) });
    }
  } else {
    for (let i = 4; i >= 0; i--) {
      const y = now.getFullYear() - i;
      buckets.push({ key: String(y), label: String(y) });
    }
  }
  return buckets;
}

function inBucket(inv, bucketKey) {
  const date = inv.issueDate || '';
  if (state.period === 'daily') return date === bucketKey;
  if (state.period === 'weekly') return date.slice(0, 7) === bucketKey;
  if (state.period === 'monthly') return date.slice(0, 7) === bucketKey;
  return date.slice(0, 4) === bucketKey;
}

function renderSummary(invoices) {
  const el = $('#reportSummary');
  if (!el) return;
  const active = invoices.filter((i) => i.status !== 'draft' && i.status !== 'cancelled');
  const revenue = sum(active.filter((i) => i.status === 'paid').map((i) => i.grandTotal));
  const outstanding = sum(active.filter((i) => i.status === 'unpaid' || i.status === 'partial').map((i) => i.balance));
  const count = active.length;
  const collected = sum(state.payments.map((p) => p.amount));

  const cards = [
    { label: 'Revenue', value: revenue, icon: 'revenue', color: 'success' },
    { label: 'Outstanding', value: outstanding, icon: 'outstanding', color: 'danger' },
    { label: 'Invoices', value: count, icon: 'invoices', color: 'brand' },
    { label: 'Collected', value: collected, icon: 'collected', color: 'gold' },
  ];
  const icons = {
    revenue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    outstanding: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    invoices: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    collected: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  };
  const colors = {
    success: { bg: 'bg-success-soft', text: 'text-success', deco: 'var(--success)' },
    danger: { bg: 'bg-danger-soft', text: 'text-danger', deco: 'var(--danger)' },
    brand: { bg: 'bg-brand-soft', text: 'text-brand', deco: 'var(--brand)' },
    gold: { bg: 'bg-gold-soft', text: 'text-gold', deco: 'var(--gold)' },
  };
  el.innerHTML = cards.map((c) => {
    const col = colors[c.color];
    return `
      <div class="card card-pad stat-card card-hover animate-fade">
        <div class="stat-icon ${col.bg} ${col.text}">${icons[c.icon]}</div>
        <div class="stat-value">${escapeHTML(formatMoney(c.value, state.currency))}</div>
        <div class="stat-label">${escapeHTML(c.label)}</div>
        <div class="stat-deco" style="background:${col.deco}"></div>
      </div>`;
  }).join('');
}

function renderRevenueChart(invoices) {
  const el = $('#revenueChart');
  if (!el) return;
  const buckets = periodBuckets();
  const totals = buckets.map((b) => sum(
    invoices.filter((inv) => inBucket(inv, b.key) && inv.status !== 'draft' && inv.status !== 'cancelled').map((inv) => inv.grandTotal)
  ));
  const max = Math.max(...totals, 1);
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

function renderTopCustomers(invoices) {
  const el = $('#topCustomers');
  if (!el) return;
  const byCustomer = {};
  invoices.filter((i) => i.status !== 'draft' && i.status !== 'cancelled').forEach((inv) => {
    const name = inv.customerName || 'Unknown';
    byCustomer[name] = round2((byCustomer[name] || 0) + (inv.grandTotal || 0));
  });
  const top = Object.entries(byCustomer).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!top.length) {
    el.innerHTML = '<p class="text-faint text-sm">No data yet.</p>';
    return;
  }
  const max = Math.max(...top.map(([, v]) => v), 1);
  el.innerHTML = top.map(([name, value]) => `
    <div class="mb-3">
      <div class="flex justify-between text-sm mb-1">
        <span class="font-semibold truncate">${escapeHTML(name)}</span>
        <span class="font-semibold">${escapeHTML(formatMoney(value, state.currency))}</span>
      </div>
      <div class="progress"><div class="bar" style="width:${Math.round((value / max) * 100)}%"></div></div>
    </div>`).join('');
}

function renderTopProducts(invoices) {
  const el = $('#topProducts');
  if (!el) return;
  const byProduct = {};
  invoices.filter((i) => i.status !== 'draft' && i.status !== 'cancelled').forEach((inv) => {
    (inv.items || []).forEach((item) => {
      const name = item.name || 'Unknown';
      byProduct[name] = round2((byProduct[name] || 0) + (item.total || 0));
    });
  });
  const top = Object.entries(byProduct).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!top.length) {
    el.innerHTML = '<p class="text-faint text-sm">No data yet.</p>';
    return;
  }
  const max = Math.max(...top.map(([, v]) => v), 1);
  el.innerHTML = top.map(([name, value]) => `
    <div class="mb-3">
      <div class="flex justify-between text-sm mb-1">
        <span class="font-semibold truncate">${escapeHTML(name)}</span>
        <span class="font-semibold">${escapeHTML(formatMoney(value, state.currency))}</span>
      </div>
      <div class="progress"><div class="bar gold" style="width:${Math.round((value / max) * 100)}%"></div></div>
    </div>`).join('');
}

function renderDonut(invoices) {
  const el = $('#reportDonut');
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

function renderAll() {
  const invoices = enrichInvoices();
  renderSummary(invoices);
  renderRevenueChart(invoices);
  renderTopCustomers(invoices);
  renderTopProducts(invoices);
  renderDonut(invoices);
}

/* ================= Export ================= */
function exportReportCSV() {
  const invoices = enrichInvoices().filter((i) => i.status !== 'draft' && i.status !== 'cancelled');
  const rows = invoices.map((inv) => ({
    'Invoice No': inv.number || '',
    'Customer': inv.customerName || '',
    'Issue Date': inv.issueDate || '',
    'Status': inv.status || '',
    'Subtotal': inv.subtotal ?? 0,
    'Tax': inv.tax ?? 0,
    'Grand Total': inv.grandTotal ?? 0,
    'Amount Paid': inv.amountPaid ?? 0,
    'Balance': inv.balance ?? 0,
  }));
  exportCSV(rows, `report_${state.period}_${toISODate()}.csv`);
  toast('Report exported', 'success');
}

function exportReportPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const invoices = enrichInvoices().filter((i) => i.status !== 'draft' && i.status !== 'cancelled');
  const P = pdfColors(loadBrandSync(), 'light');

  // Header
  doc.setFillColor(...P.brandDark);
  doc.rect(0, 0, pageW, 6, 'F');
  doc.setFillColor(...P.accent);
  doc.rect(0, 6, pageW, 1.2, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...P.brandInk);
  doc.text(`${state.company.businessName || 'Business'} — ${state.period.charAt(0).toUpperCase() + state.period.slice(1)} Report`, margin, 20);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(90, 90, 90);
  doc.text(`Generated: ${new Date().toLocaleString()}`, margin, 26);

  // Summary
  const active = invoices;
  const revenue = sum(active.filter((i) => i.status === 'paid').map((i) => i.grandTotal));
  const outstanding = sum(active.filter((i) => i.status === 'unpaid' || i.status === 'partial').map((i) => i.balance));
  const collected = sum(state.payments.map((p) => p.amount));
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(43, 43, 43);
  doc.text(`Revenue: ${formatMoney(revenue, state.currency)}`, margin, 34);
  doc.text(`Outstanding: ${formatMoney(outstanding, state.currency)}`, margin + 80, 34);
  doc.text(`Collected: ${formatMoney(collected, state.currency)}`, margin + 160, 34);

  // Table
  const head = [['Invoice', 'Customer', 'Date', 'Status', 'Total', 'Balance']];
  const body = invoices.map((inv) => [
    inv.number || '',
    inv.customerName || '',
    inv.issueDate || '',
    inv.status || '',
    formatMoney(inv.grandTotal, state.currency),
    formatMoney(inv.balance, state.currency),
  ]);
  doc.autoTable({
    startY: 40,
    head,
    body,
    margin: { left: margin, right: margin, top: 20, bottom: 20 },
    styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 2.5 },
    headStyles: { fillColor: P.brand, textColor: P.brandContrast, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 248] },
  });

  // Footer
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    const h = doc.internal.pageSize.getHeight();
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(138, 138, 138);
    doc.text(`${state.company.businessName || fallbackBusinessName()}`, margin, h - 9);
    doc.text(`Page ${i} / ${pageCount}`, pageW - margin, h - 9, { align: 'right' });
  }
  doc.save(`report_${state.period}_${toISODate()}.pdf`);
  toast('PDF exported', 'success');
}

function printReport() {
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) { window.print(); return; }
  const invoices = enrichInvoices().filter((i) => i.status !== 'draft' && i.status !== 'cancelled');
  const rows = invoices.map((inv) => `
    <tr>
      <td>${escapeHTML(inv.number || '')}</td>
      <td>${escapeHTML(inv.customerName || '')}</td>
      <td>${escapeHTML(inv.issueDate || '')}</td>
      <td>${escapeHTML(inv.status || '')}</td>
      <td class="num">${escapeHTML(formatMoney(inv.grandTotal, state.currency))}</td>
      <td class="num">${escapeHTML(formatMoney(inv.balance, state.currency))}</td>
    </tr>`).join('');
  win.document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Report</title>
<style>
${paletteToCss(loadBrandSync(), 'light')}
  body { font-family: "Segoe UI", Arial, sans-serif; color: #2B2B2B; padding: 30px; }
  h1 { color: var(--brand-ink); border-bottom: 3px solid var(--brand); padding-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th { background: var(--brand); color: var(--brand-contrast); text-align: left; padding: 8px 10px; font-size: 11px; }
  td { padding: 8px 10px; border-bottom: 1px solid #E4E7E4; font-size: 12px; }
  tr:nth-child(even) td { background: #F8FAF8; }
  .num { text-align: right; }
  .meta { color: #5A5A5A; font-size: 12px; }
</style></head>
<body>
  <h1>${escapeHTML(state.company.businessName || 'Business')} — ${escapeHTML(state.period)} Report</h1>
  <p class="meta">Generated: ${escapeHTML(new Date().toLocaleString())}</p>
  <table><thead><tr><th>Invoice</th><th>Customer</th><th>Date</th><th>Status</th><th class="num">Total</th><th class="num">Balance</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <script>window.onload = function(){ window.print(); };</script>
</body></html>`);
  win.document.close();
}

async function init() {
  await initShell();
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

  $$('.tab[data-period]').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab[data-period]').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.period = tab.dataset.period;
      renderAll();
    });
  });
  // exportReportPDF builds the document synchronously, so it needs the loading
  // state to be painted first (withLoading yields a frame before running it).
  $('#exportPdfBtn')?.addEventListener('click', (e) => withLoading(e.currentTarget, exportReportPDF));
  $('#exportCsvBtn')?.addEventListener('click', exportReportCSV);
  $('#printBtn')?.addEventListener('click', printReport);
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((err) => {
    console.error('Report init failed:', err);
    toast('Failed to initialize: ' + err.message, 'error', 6000);
  });
});
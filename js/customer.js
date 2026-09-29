/**
 * Customer module
 * List, search, add, edit, delete customers with outstanding balances.
 */
import { $, $$, escapeHTML, sanitizeString, toNumber, uid, toast, openModal, confirmDialog, debounce, initials, isValidEmail, isValidPhone } from './utils.js';
import { getCustomers, saveCustomer, deleteCustomer, getInvoices, getPayments } from './storageService.js';
import { getDefaultCurrencyCode, getCurrency, formatMoney } from './currency.js';
import { round2, deriveStatus } from './calculations.js';
import { exportCustomersCSV } from './export.js';
import { initShell } from './shell.js';

let state = {
  customers: [],
  invoices: [],
  payments: [],
  currency: null,
  search: '',
};

function enrichCustomers() {
  const paidByInvoice = {};
  state.payments.forEach((p) => {
    paidByInvoice[p.invoiceId] = round2((paidByInvoice[p.invoiceId] || 0) + toNumber(p.amount));
  });
  const byCustomer = {};
  state.invoices.forEach((inv) => {
    if (!inv.customerId) return;
    const paid = paidByInvoice[inv.id] || inv.amountPaid || 0;
    const balance = round2((inv.grandTotal || 0) - paid);
    const status = deriveStatus(inv.grandTotal, paid);
    if (status === 'unpaid' || status === 'partial') {
      byCustomer[inv.customerId] = round2((byCustomer[inv.customerId] || 0) + balance);
    }
  });
  return state.customers.map((c) => ({
    ...c,
    outstanding: byCustomer[c.id] || 0,
    invoiceCount: state.invoices.filter((i) => i.customerId === c.id).length,
  }));
}

function renderList() {
  const tbody = $('#customerTableBody');
  if (!tbody) return;
  let list = enrichCustomers();
  if (state.search) {
    const q = state.search.toLowerCase();
    list = list.filter((c) =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.phone || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.tin || '').toLowerCase().includes(q)
    );
  }
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-faint py-4">No customers found.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map((c) => `
    <tr>
      <td>
        <div class="flex items-center gap-3">
          <span class="avatar">${escapeHTML(initials(c.name))}</span>
          <div>
            <div class="cell-main">${escapeHTML(c.name || '—')}</div>
            ${c.address ? `<div class="cell-sub">${escapeHTML(c.address)}</div>` : ''}
          </div>
        </div>
      </td>
      <td class="text-muted">${escapeHTML(c.phone || '—')}</td>
      <td class="text-muted">${escapeHTML(c.email || '—')}</td>
      <td class="text-muted">${escapeHTML(c.tin || '—')}</td>
      <td class="num ${c.outstanding > 0 ? 'text-danger font-semibold' : 'text-success font-semibold'}">${escapeHTML(formatMoney(c.outstanding, state.currency))}</td>
      <td class="num">${c.invoiceCount}</td>
      <td>
        <div class="actions">
          <button class="icon-btn" data-action="invoice" data-id="${escapeHTML(c.id)}" aria-label="Create invoice" title="New invoice">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          </button>
          <button class="icon-btn" data-action="edit" data-id="${escapeHTML(c.id)}" aria-label="Edit customer" title="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="icon-btn danger" data-action="delete" data-id="${escapeHTML(c.id)}" aria-label="Delete customer" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>`).join('');
}

function openCustomerModal(id = null) {
  const customer = id ? state.customers.find((c) => c.id === id) : null;
  openModal({
    title: customer ? 'Edit Customer' : 'Add Customer',
    size: 'modal-lg',
    body: `
      <div class="grid grid-cols-2 gap-4">
        <div class="field">
          <label>Name <span class="req">*</span></label>
          <input type="text" class="input" id="custName" value="${escapeHTML(customer?.name || '')}" placeholder="Customer name">
        </div>
        <div class="field">
          <label>Phone</label>
          <input type="tel" class="input" id="custPhone" value="${escapeHTML(customer?.phone || '')}" placeholder="+255 7XX XXX XXX">
        </div>
        <div class="field">
          <label>Email</label>
          <input type="email" class="input" id="custEmail" value="${escapeHTML(customer?.email || '')}" placeholder="customer@email.com">
        </div>
        <div class="field">
          <label>TIN</label>
          <input type="text" class="input" id="custTin" value="${escapeHTML(customer?.tin || '')}" placeholder="TIN number">
        </div>
        <div class="field col-span-2">
          <label>Address</label>
          <input type="text" class="input" id="custAddress" value="${escapeHTML(customer?.address || '')}" placeholder="Street, City, Region">
        </div>
        <div class="field col-span-2">
          <label>Notes</label>
          <textarea class="textarea" id="custNotes" placeholder="Optional notes">${escapeHTML(customer?.notes || '')}</textarea>
        </div>
      </div>`,
    footer: `
      <button class="btn btn-outline" data-action="cancel">Cancel</button>
      <button class="btn btn-primary" data-action="save">${customer ? 'Save Changes' : 'Add Customer'}</button>`,
    onOpen: (ov) => {
      $('[data-action="cancel"]', ov).addEventListener('click', () => ov.remove());
      $('[data-action="save"]', ov).addEventListener('click', async () => {
        const name = sanitizeString($('#custName', ov).value, 200);
        const phone = sanitizeString($('#custPhone', ov).value, 50);
        const email = sanitizeString($('#custEmail', ov).value, 200);
        const tin = sanitizeString($('#custTin', ov).value, 50);
        const address = sanitizeString($('#custAddress', ov).value, 300);
        const notes = sanitizeString($('#custNotes', ov).value, 1000);

        if (!name) { toast('Customer name is required', 'error'); return; }
        if (email && !isValidEmail(email)) { toast('Please enter a valid email', 'error'); return; }
        if (phone && !isValidPhone(phone)) { toast('Please enter a valid phone number', 'error'); return; }

        const record = {
          id: customer ? customer.id : uid('cust'),
          name,
          phone,
          email,
          tin,
          address,
          notes,
          createdAt: customer ? customer.createdAt : new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        try {
          await saveCustomer(record);
          state.customers = await getCustomers();
          ov.remove();
          renderList();
          toast(customer ? 'Customer updated' : 'Customer added', 'success');
        } catch (err) {
          toast('Failed to save customer: ' + err.message, 'error');
        }
      });
    },
  });
}

async function init() {
  await initShell();
  const [customers, invoices, payments, currency] = await Promise.all([
    getCustomers(),
    getInvoices(),
    getPayments(),
    getCurrency(await getDefaultCurrencyCode()),
  ]);
  state.customers = customers;
  state.invoices = invoices;
  state.payments = payments;
  state.currency = currency;
  renderList();

  $('#addCustomerBtn')?.addEventListener('click', () => openCustomerModal());
  $('#exportCsvBtn')?.addEventListener('click', () => {
    exportCustomersCSV(state.customers);
    toast('Customers exported', 'success');
  });
  $('#customerSearch')?.addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); renderList(); }, 250));

  $('#customerTableBody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    if (action === 'edit') openCustomerModal(id);
    else if (action === 'invoice') location.href = `invoice.html?new=1&customer=${encodeURIComponent(id)}`;
    else if (action === 'delete') {
      const c = state.customers.find((x) => x.id === id);
      const ok = await confirmDialog({ title: 'Delete Customer', message: `Delete ${c?.name || 'this customer'}? Their invoices will be kept.`, confirmText: 'Delete', danger: true });
      if (ok) {
        await deleteCustomer(id);
        state.customers = await getCustomers();
        renderList();
        toast('Customer deleted', 'success');
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((err) => {
    console.error('Customer init failed:', err);
    toast('Failed to initialize: ' + err.message, 'error', 6000);
  });
});
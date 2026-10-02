/**
 * Invoice module
 * List, editor (with live calculations), preview, PDF export, payments.
 */
import { $, $$, escapeHTML, validateNumberInputs, sanitizeString, sanitizeMultiline, toNumber, uid, toISODate, addDays, formatDate, toast, openModal, confirmDialog, debounce, withLoading, isValidEmail, isValidPhone } from './utils.js';
import {
  getInvoices, saveInvoice, deleteInvoice, getCustomers, saveCustomer, getProducts,
  getPayments, savePayment, deletePayment, getSetting, setSetting, getCompanyProfile,
} from './storageService.js';
import { getCurrencies, getDefaultCurrencyCode, getCurrency, formatMoney, amountToWords, amountToWordsSwahili } from './currency.js';
import { calculateInvoiceTotals, calculateBalance, deriveStatus, validateItems, round2 } from './calculations.js';
import { generateQRDataURL, buildQRPayload, downloadInvoicePDF, printInvoice, exportInvoicesCSV } from './export.js';
import { initShell } from './shell.js';
import { fallbackBusinessName } from './config.js';
import { loadBrandSync, normalizeBrand } from './brand.js';
import { checkInvoiceQuota, showUpgradeModal, loadLicense } from './licenseService.js';
import { shareInvoice } from './share.js';

/* ================= State ================= */
let state = {
  invoices: [],
  customers: [],
  products: [],
  payments: [],
  currencies: [],
  currency: null,
  company: {},
  editingId: null,
  filter: 'all',
  search: '',
  language: 'en',
  /**
   * The invoice the preview panel is currently showing, and where it came from.
   *
   * The preview can be reached two ways — from the editor (carrying unsaved
   * edits, via collectInvoice()) or from the list's eye icon (a stored record).
   * Its actions must operate on THIS, never on the editor form: arriving via
   * the eye icon leaves the form untouched, so re-collecting from it produced
   * an invoice with no customer name and the Download PDF button silently did
   * nothing at all.
   *
   * `previewSource` decides what "Edit" means: from a stored record it must
   * load that invoice into the form, but from the editor it must go straight
   * back so the unsaved edits are not thrown away.
   */
  previewInvoice: null,
  previewSource: null,
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

function isOverdue(inv) {
  if (inv.status === 'paid' || inv.status === 'cancelled' || inv.status === 'draft') return false;
  if (!inv.dueDate) return false;
  return inv.dueDate < toISODate();
}

/**
 * The business name to print on an invoice.
 *
 * Precedence:
 *   1. a name typed on the invoice itself (`invoice.companyName`) — an override
 *      for this one document,
 *   2. the Business Profile (`company.businessName`),
 *   3. an explicitly set white-label App Name — Settings exposes both "App Name"
 *      (Brand & Appearance) and "Business Name" (Business Information), so a
 *      client who fills in only the former still gets their brand on the
 *      invoice rather than a "Business Name" placeholder,
 *   4. the configured fallback.
 *
 * Step 3 only fires when the App Name was actually typed (it defaults to an
 * empty string), so it can never leak the template's own product name onto a
 * customer's invoice.
 */
function invoiceBusinessName(invoice, company = state.company) {
  const override = invoice && invoice.companyName ? String(invoice.companyName).trim() : '';
  if (override) return override;
  const profile = company && company.businessName ? String(company.businessName).trim() : '';
  if (profile) return profile;
  const appLabel = normalizeBrand(loadBrandSync()).appName;
  if (appLabel) return appLabel;
  return fallbackBusinessName();
}

/**
 * The company record to render an invoice with: the profile, with the business
 * name resolved for this invoice and the logo attached.
 */
function invoiceCompany(invoice) {
  return { ...state.company, businessName: invoiceBusinessName(invoice) };
}

function enrichInvoice(inv) {
  const paid = state.payments.filter((p) => p.invoiceId === inv.id).reduce((a, p) => a + toNumber(p.amount), 0);
  const amountPaid = round2(paid);
  const balance = round2((inv.grandTotal || 0) - amountPaid);
  const status = deriveStatus(inv.grandTotal, amountPaid);
  return { ...inv, amountPaid, balance, status };
}

/* ================= List view ================= */
function renderList() {
  const tbody = $('#invoiceTableBody');
  if (!tbody) return;

  let list = state.invoices.map(enrichInvoice);
  if (state.filter !== 'all') {
    list = list.filter((inv) => {
      if (state.filter === 'overdue') return isOverdue(inv);
      return inv.status === state.filter;
    });
  }
  if (state.search) {
    const q = state.search.toLowerCase();
    list = list.filter((inv) =>
      (inv.number || '').toLowerCase().includes(q) ||
      (inv.customerName || '').toLowerCase().includes(q) ||
      (inv.customerPhone || '').toLowerCase().includes(q)
    );
  }

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center text-faint py-4">No invoices found.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map((inv) => `
    <tr>
      <td><a href="invoice.html?id=${encodeURIComponent(inv.id)}" class="cell-main">${escapeHTML(inv.number || inv.id)}</a></td>
      <td><span class="cell-main">${escapeHTML(inv.customerName || '—')}</span></td>
      <td class="text-muted">${escapeHTML(formatDate(inv.issueDate))}</td>
      <td class="text-muted">${escapeHTML(formatDate(inv.dueDate))}</td>
      <td>${statusBadge(inv.status)}</td>
      <td class="num font-semibold">${escapeHTML(formatMoney(inv.grandTotal, state.currency))}</td>
      <td class="num ${inv.balance > 0 ? 'text-danger font-semibold' : 'text-success font-semibold'}">${escapeHTML(formatMoney(inv.balance, state.currency))}</td>
      <td>
        <div class="actions">
          <button class="icon-btn" data-action="view" data-id="${escapeHTML(inv.id)}" aria-label="View invoice" title="View">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="icon-btn" data-action="edit" data-id="${escapeHTML(inv.id)}" aria-label="Edit invoice" title="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="icon-btn" data-action="pdf" data-id="${escapeHTML(inv.id)}" aria-label="Download PDF" title="Download PDF">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button class="icon-btn danger" data-action="delete" data-id="${escapeHTML(inv.id)}" aria-label="Delete invoice" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>`).join('');
}

/* ================= Editor ================= */
function nextInvoiceNumber() {
  const prefix = state.company.invoicePrefix || 'INV-';
  const format = state.company.invoiceNumberFormat || 'INV-{n}';
  const nums = state.invoices
    .map((i) => {
      const m = String(i.number || '').match(/(\d+)\s*$/);
      return m ? parseInt(m[1], 10) : 0;
    })
    .filter((n) => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return format.replace('{n}', String(next).padStart(4, '0')) || `${prefix}${String(next).padStart(4, '0')}`;
}

function populateCustomerSelect() {
  const sel = $('#invCustomer');
  if (!sel) return;
  sel.innerHTML = `<option value="">— Select customer —</option>` +
    state.customers.map((c) => `<option value="${escapeHTML(c.id)}">${escapeHTML(c.name)}</option>`).join('');
}

function populateCurrencySelect() {
  const sel = $('#invCurrency');
  if (!sel) return;
  sel.innerHTML = state.currencies
    .map((c) => `<option value="${escapeHTML(c.code)}">${escapeHTML(c.code)} — ${escapeHTML(c.name)}</option>`)
    .join('');
  sel.value = state.currency.code;
}

function addLineRow(item = {}) {
  const tbody = $('#itemsBody');
  if (!tbody) return;
  const row = document.createElement('tr');
  row.dataset.key = item.key || uid('line');
  row.innerHTML = `
    <td>
      <select class="select line-product" aria-label="Product" style="margin-bottom:4px">
        <option value="">— Select product —</option>
        ${state.products.map((p) => `<option value="${escapeHTML(p.id)}" ${item.productId === p.id ? 'selected' : ''}>${escapeHTML(p.name)}</option>`).join('')}
      </select>
      <input type="text" class="input line-name" placeholder="Description" value="${escapeHTML(item.name || '')}" aria-label="Description">
    </td>
    <td><input type="number" class="input line-qty" min="0" step="any" inputmode="decimal" value="${item.qty ?? 1}" aria-label="Quantity"></td>
    <td><input type="number" class="input line-price" min="0" step="0.01" inputmode="decimal" value="${item.unitPrice ?? ''}" aria-label="Unit price"></td>
    <td><input type="number" class="input line-disc" min="0" step="0.01" inputmode="decimal" value="${item.discountRate ?? 0}" aria-label="Discount percent"></td>
    <td class="num line-amount font-semibold">—</td>
    <td><button class="icon-btn danger line-remove" aria-label="Remove item" title="Remove">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button></td>`;
  tbody.appendChild(row);

  const productSel = $('.line-product', row);
  const nameInput = $('.line-name', row);
  const qtyInput = $('.line-qty', row);
  const priceInput = $('.line-price', row);
  const discInput = $('.line-disc', row);

  productSel.addEventListener('change', () => {
    const p = state.products.find((x) => x.id === productSel.value);
    if (p) {
      nameInput.value = p.name;
      priceInput.value = p.sellingPrice ?? '';
      discInput.value = p.discountRate ?? 0;
      // set tax rate from product if invoice tax is default
      const taxInput = $('#invTaxRate');
      if (taxInput && p.taxRate != null && !state.editingId) taxInput.value = p.taxRate;
    }
    recalc();
  });

  [qtyInput, priceInput, discInput].forEach((el) => el.addEventListener('input', recalc));
  $('.line-remove', row).addEventListener('click', () => {
    row.remove();
    recalc();
  });
}

function collectLines() {
  const rows = $$('#itemsBody tr');
  return rows.map((row) => {
    const productSel = $('.line-product', row);
    const p = state.products.find((x) => x.id === productSel.value);
    return {
      key: row.dataset.key,
      productId: productSel.value || null,
      name: sanitizeString($('.line-name', row).value, 200),
      qty: toNumber($('.line-qty', row).value),
      unitPrice: toNumber($('.line-price', row).value),
      discountRate: toNumber($('.line-disc', row).value),
      taxRate: p ? toNumber(p.taxRate) : toNumber($('#invTaxRate').value),
    };
  });
}

function recalc() {
  const lines = collectLines();
  const discount = toNumber($('#invDiscount').value);
  const discountType = $('#invDiscountType').value;
  const taxRate = toNumber($('#invTaxRate').value);
  const shipping = toNumber($('#invShipping').value);
  const taxInclusive = $('#invTaxInclusive').checked;

  const totals = calculateInvoiceTotals(lines, { discount, discountType, taxRate, shipping, taxInclusive });

  // Update line amounts
  $$('#itemsBody tr').forEach((row, i) => {
    const line = totals.lines[i];
    const amt = $('.line-amount', row);
    if (amt && line) amt.textContent = formatMoney(line.net, state.currency);
  });

  const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  set('#calcSubtotal', formatMoney(totals.subtotal, state.currency));
  set('#calcItemDiscount', formatMoney(totals.itemDiscount, state.currency));
  set('#calcInvoiceDiscount', formatMoney(totals.invoiceDiscount, state.currency));
  set('#calcTax', formatMoney(totals.tax, state.currency));
  set('#calcShipping', formatMoney(totals.shipping, state.currency));
  set('#calcGrandTotal', formatMoney(totals.grandTotal, state.currency));

  // Paid / balance
  const paid = toNumber($('#invPaidHidden')?.value) || 0;
  const balance = calculateBalance(totals.grandTotal, paid);
  set('#calcPaid', formatMoney(paid, state.currency));
  set('#calcBalance', formatMoney(balance, state.currency));

  return totals;
}

/**
 * Open the editor, refusing to start a NEW invoice once the plan's monthly
 * ceiling is reached.
 *
 * The check lives here rather than only at save time on purpose: discovering
 * the limit after filling in a whole invoice is a terrible experience. It is
 * repeated in saveCurrentInvoice() because this path can be bypassed (a stale
 * tab, the ?new=1 deep link, a direct call) and the save is the operation that
 * actually matters.
 */
async function openEditor(id = null) {
  if (id === null) {
    const quota = await checkInvoiceQuota();
    if (!quota.allowed) {
      showUpgradeModal(quota);
      return;
    }
  }
  state.editingId = id;
  $('#listView').classList.add('hidden');
  $('#previewView').classList.add('hidden');
  $('#editorView').classList.remove('hidden');
  $('#editorTitle').textContent = id ? 'Edit Invoice' : 'New Invoice';
  $('#pageTitle').textContent = id ? 'Edit Invoice' : 'New Invoice';

  populateCustomerSelect();
  populateCurrencySelect();

  const company = state.company;
  // Defaults to the profile; an existing invoice may carry its own override.
  $('#invCompanyName').value = company.businessName || '';

  if (id) {
    const inv = state.invoices.find((i) => i.id === id);
    if (inv) {
      $('#invCompanyName').value = inv.companyName || company.businessName || '';
      $('#invNumber').value = inv.number || '';
      $('#invIssueDate').value = inv.issueDate || toISODate();
      $('#invDueDate').value = inv.dueDate || addDays(inv.issueDate || toISODate(), 30);
      $('#invTerms').value = inv.paymentTerms || 'Net 30';
      $('#invCurrency').value = inv.currency || state.currency.code;
      $('#invStatus').value = inv.status || 'unpaid';
      $('#invPaymentRef').value = inv.paymentReference || '';
      $('#invDiscountType').value = inv.discountType || 'fixed';
      $('#invDiscount').value = inv.discount ?? 0;
      $('#invTaxRate').value = inv.taxRate ?? 18;
      $('#invShipping').value = inv.shipping ?? 0;
      $('#invTaxInclusive').checked = !!inv.taxInclusive;
      $('#invNotes').value = inv.notes || '';
      $('#invFooter').value = inv.footer || '';
      $('#invCustomer').value = inv.customerId || '';
      $('#invCustomerName').value = inv.customerName || '';
      $('#invCustomerPhone').value = inv.customerPhone || '';
      $('#invCustomerEmail').value = inv.customerEmail || '';
      $('#invCustomerTin').value = inv.customerTin || '';
      $('#invCustomerAddress').value = inv.customerAddress || '';
      // hidden paid amount
      let paidEl = $('#invPaidHidden');
      if (!paidEl) {
        paidEl = document.createElement('input');
        paidEl.type = 'hidden';
        paidEl.id = 'invPaidHidden';
        document.body.appendChild(paidEl);
      }
      paidEl.value = inv.amountPaid || 0;

      $('#itemsBody').innerHTML = '';
      (inv.items || []).forEach((item) => addLineRow(item));
    }
  } else {
    $('#invNumber').value = nextInvoiceNumber();
    $('#invIssueDate').value = toISODate();
    $('#invDueDate').value = addDays(toISODate(), 30);
    $('#invTerms').value = 'Net 30';
    $('#invCurrency').value = state.currency.code;
    $('#invStatus').value = 'unpaid';
    $('#invPaymentRef').value = '';
    $('#invDiscountType').value = 'fixed';
    $('#invDiscount').value = 0;
    $('#invTaxRate').value = state.company.defaultTaxRate ?? 18;
    $('#invShipping').value = 0;
    $('#invTaxInclusive').checked = false;
    $('#invNotes').value = '';
    $('#invFooter').value = state.company.invoiceFooter || 'Thank you for your business!';
    $('#invCustomer').value = '';
    $('#invCustomerName').value = '';
    $('#invCustomerPhone').value = '';
    $('#invCustomerEmail').value = '';
    $('#invCustomerTin').value = '';
    $('#invCustomerAddress').value = '';
    let paidEl = $('#invPaidHidden');
    if (!paidEl) {
      paidEl = document.createElement('input');
      paidEl.type = 'hidden';
      paidEl.id = 'invPaidHidden';
      document.body.appendChild(paidEl);
    }
    paidEl.value = 0;
    $('#itemsBody').innerHTML = '';
    addLineRow();
  }

  recalc();
  window.scrollTo(0, 0);
}

/**
 * Fill the customer fields from a record and mark it as the selected one.
 *
 * Three callers need exactly this — picking from the select, the `?customer=`
 * deep link from the Customers page, and the inline "New customer" form — so it
 * lives in one place. As three copies of five assignments, a change to one of
 * them silently stopped applying to the other two.
 */
function applyCustomerToForm(customer) {
  const select = $('#invCustomer');
  if (select && customer) select.value = customer.id;
  $('#invCustomerName').value = customer?.name || '';
  $('#invCustomerPhone').value = customer?.phone || '';
  $('#invCustomerEmail').value = customer?.email || '';
  $('#invCustomerTin').value = customer?.tin || '';
  $('#invCustomerAddress').value = customer?.address || '';
}

/**
 * Add a customer without leaving the invoice.
 *
 * Deliberately a compact form rather than a link to the Customers page: the
 * moment a user raises an invoice for someone new is the moment they have that
 * person's details in hand, and making them leave would cost a page change, a
 * re-find of the invoice, and the line items typed so far.
 *
 * It writes through `saveCustomer` — the same path the Customers page uses — so
 * the two screens can never disagree about what a customer record is.
 */
function openNewCustomerModal() {
  openModal({
    title: 'New customer',
    size: 'modal-lg',
    body: `
      <div class="grid grid-cols-2 gap-4">
        <div class="field col-span-2">
          <label for="ncName">Name <span class="req">*</span></label>
          <input type="text" class="input" id="ncName" placeholder="Customer name">
        </div>
        <div class="field">
          <label for="ncPhone">Phone</label>
          <input type="tel" class="input" id="ncPhone" placeholder="+255 7XX XXX XXX">
        </div>
        <div class="field">
          <label for="ncEmail">Email</label>
          <input type="email" class="input" id="ncEmail" placeholder="customer@email.com">
        </div>
        <div class="field">
          <label for="ncTin">TIN</label>
          <input type="text" class="input" id="ncTin" placeholder="TIN number">
        </div>
        <div class="field">
          <label for="ncAddress">Address</label>
          <input type="text" class="input" id="ncAddress" placeholder="Street, City">
        </div>
      </div>`,
    footer: `
      <button class="btn btn-outline" data-action="cancel">Cancel</button>
      <button class="btn btn-primary" data-action="save">Add &amp; select</button>`,
    onOpen: (ov) => {
      $('[data-action="cancel"]', ov).addEventListener('click', () => ov.remove());
      $('[data-action="save"]', ov).addEventListener('click', async () => {
        const name = sanitizeString($('#ncName', ov).value, 200);
        const phone = sanitizeString($('#ncPhone', ov).value, 50);
        const email = sanitizeString($('#ncEmail', ov).value, 200);
        const tin = sanitizeString($('#ncTin', ov).value, 50);
        const address = sanitizeString($('#ncAddress', ov).value, 300);

        if (!name) { toast('Customer name is required', 'error'); return; }
        if (email && !isValidEmail(email)) { toast('Please enter a valid email', 'error'); return; }
        if (phone && !isValidPhone(phone)) { toast('Please enter a valid phone number', 'error'); return; }

        // An existing record with the same name is reused rather than cloned —
        // the customer list is the one place a duplicate is never forgiven, and
        // the user's intent here is "bill this person", not "create a row".
        const dupe = state.customers.find(
          (c) => (c.name || '').trim().toLowerCase() === name.toLowerCase(),
        );
        const record = dupe
          ? {
            ...dupe,
            phone: phone || dupe.phone || '',
            email: email || dupe.email || '',
            tin: tin || dupe.tin || '',
            address: address || dupe.address || '',
            updatedAt: new Date().toISOString(),
          }
          : {
            id: uid('cust'),
            name, phone, email, tin, address,
            notes: '',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

        try {
          await saveCustomer(record);
          state.customers = await getCustomers();
          ov.remove();
          populateCustomerSelect();
          applyCustomerToForm(record);
          toast(dupe ? `Using existing customer "${record.name}"` : `Customer "${record.name}" added`, 'success');
        } catch (err) {
          toast('Failed to save customer: ' + err.message, 'error');
        }
      });
    },
  });
}

function collectInvoice() {
  const lines = collectLines();
  const discount = toNumber($('#invDiscount').value);
  const discountType = $('#invDiscountType').value;
  const taxRate = toNumber($('#invTaxRate').value);
  const shipping = toNumber($('#invShipping').value);
  const taxInclusive = $('#invTaxInclusive').checked;
  const totals = calculateInvoiceTotals(lines, { discount, discountType, taxRate, shipping, taxInclusive });

  const customerId = $('#invCustomer').value;
  const customer = state.customers.find((c) => c.id === customerId);
  const paid = toNumber($('#invPaidHidden')?.value) || 0;
  const balance = calculateBalance(totals.grandTotal, paid);
  const status = $('#invStatus').value;

  return {
    id: state.editingId || uid('inv'),
    number: sanitizeString($('#invNumber').value, 50),
    // Printed as the invoice's business name. Falls back to the Business
    // Profile (and then the App Name) at render time when left blank.
    companyName: sanitizeString($('#invCompanyName').value, 200),
    customerId: customerId || null,
    customerName: sanitizeString($('#invCustomerName').value, 200) || (customer ? customer.name : ''),
    customerPhone: sanitizeString($('#invCustomerPhone').value, 50) || (customer ? customer.phone : ''),
    customerEmail: sanitizeString($('#invCustomerEmail').value, 200) || (customer ? customer.email : ''),
    customerTin: sanitizeString($('#invCustomerTin').value, 50) || (customer ? customer.tin : ''),
    customerAddress: sanitizeString($('#invCustomerAddress').value, 300) || (customer ? customer.address : ''),
    issueDate: $('#invIssueDate').value || toISODate(),
    dueDate: $('#invDueDate').value || addDays($('#invIssueDate').value || toISODate(), 30),
    paymentTerms: $('#invTerms').value,
    currency: $('#invCurrency').value || state.currency.code,
    status,
    paymentReference: sanitizeString($('#invPaymentRef').value, 100),
    items: totals.lines.map((l) => ({
      id: l.key || uid('line'),
      productId: l.productId,
      name: l.name,
      qty: l.qty,
      unitPrice: l.unitPrice,
      discountRate: l.discountRate,
      taxRate: l.taxRate,
      total: l.net,
    })),
    subtotal: totals.subtotal,
    itemDiscount: totals.itemDiscount,
    invoiceDiscount: totals.invoiceDiscount,
    discount,
    discountType,
    tax: totals.tax,
    taxRate,
    taxInclusive,
    shipping: totals.shipping,
    grandTotal: totals.grandTotal,
    amountPaid: paid,
    balance,
    notes: sanitizeMultiline($('#invNotes').value, 2000),
    footer: sanitizeString($('#invFooter').value, 200),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Make sure the invoice's customer exists in the customer database.
 *
 * This is the "automatic" half of the feature: a user who types a new client's
 * details straight onto an invoice should not have to visit Customers to make
 * them real. Saving the invoice saves the customer.
 *
 * HOW THE TARGET IS CHOSEN
 *   The select picks the person and the editable Name field renames them, so a
 *   linked record is always the correct target — updating it is exactly what
 *   that field says it does. Only when nothing is linked do we fall back to a
 *   name lookup, and only when that misses too is this genuinely someone new.
 *   (Looking up by name first would clone the customer every time the user
 *   fixed a typo in the name.)
 *
 * FIELDS ARE ONLY EVER REFRESHED, NEVER CLEARED
 *   An empty field on the invoice means "not specified here", not "delete this
 *   from the customer record" — the invoice form is pre-filled from the record,
 *   so a blank means the user has not touched it, and wiping the customer's
 *   phone number because the invoice form was blank would be data loss.
 *
 * @returns {Promise<{customer: object, created: boolean}|null>}
 */
async function ensureCustomerFor(invoice) {
  const name = sanitizeString(invoice.customerName, 200);
  if (!name) return null;

  const linked = invoice.customerId
    ? state.customers.find((c) => c.id === invoice.customerId)
    : null;
  const existing = linked
    || state.customers.find((c) => (c.name || '').trim().toLowerCase() === name.toLowerCase())
    || null;

  const fields = {
    name,
    phone: sanitizeString(invoice.customerPhone, 50),
    email: sanitizeString(invoice.customerEmail, 200),
    tin: sanitizeString(invoice.customerTin, 50),
    address: sanitizeString(invoice.customerAddress, 300),
  };

  if (existing) {
    const changed = Object.entries(fields).some(([key, value]) => value && value !== (existing[key] || ''));
    invoice.customerId = existing.id;
    if (!changed) return { customer: existing, created: false };

    const updated = { ...existing, ...fields, updatedAt: new Date().toISOString() };
    await saveCustomer(updated);
    // Keep the in-memory list in step, or a second save in this session would
    // re-detect the same difference and write it again.
    const idx = state.customers.findIndex((c) => c.id === updated.id);
    if (idx !== -1) state.customers[idx] = updated;
    return { customer: updated, created: false };
  }

  const created = {
    id: uid('cust'),
    ...fields,
    notes: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveCustomer(created);
  state.customers.push(created);
  invoice.customerId = created.id;
  return { customer: created, created: true };
}

async function saveCurrentInvoice(statusOverride = null) {
  if (!validateNumberInputs($('#editorView'))) return null;
  const invoice = collectInvoice();
  if (statusOverride) invoice.status = statusOverride;

  const validation = validateItems(invoice.items);
  if (!validation.valid) {
    toast(validation.error, 'error');
    return null;
  }
  if (!invoice.customerName) {
    toast('Please enter a customer name.', 'error');
    return null;
  }
  if (!invoice.number) {
    toast('Please enter an invoice number.', 'error');
    return null;
  }

  // Only a brand-new invoice consumes quota; editing an existing one is free.
  if (!state.editingId) {
    const quota = await checkInvoiceQuota();
    if (!quota.allowed) {
      showUpgradeModal(quota);
      return null;
    }
  }

  try {
    // The customer is persisted BEFORE the invoice, so the invoice carries the
    // link in a single save instead of being written twice.
    const customer = await ensureCustomerFor(invoice);
    await saveInvoice(invoice);
    state.invoices = await getInvoices();
    if (customer) {
      state.customers = await getCustomers();
      if (customer.created) toast(`New customer "${customer.customer.name}" saved`, 'success', 4500);
    }
    toast(invoice.status === 'draft' ? 'Draft saved' : 'Invoice saved', 'success');
    return invoice;
  } catch (err) {
    toast('Failed to save invoice: ' + err.message, 'error');
    return null;
  }
}

/* ================= Preview ================= */
function renderPreview(invoice) {
  const el = $('#previewDoc');
  if (!el) return;
  const c = state.company;
  const businessName = invoiceBusinessName(invoice, c);
  const cur = state.currencies.find((x) => x.code === invoice.currency) || state.currency;
  const lang = state.language;
  const t = (en, sw) => (lang === 'sw' ? sw : en);
  const words = lang === 'sw' ? amountToWordsSwahili(invoice.grandTotal, cur) : amountToWords(invoice.grandTotal, cur);

  const rows = (invoice.items || []).map((item, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${escapeHTML(item.name || '')}</strong></td>
      <td class="num">${escapeHTML(String(item.qty ?? 0))}</td>
      <td class="num">${escapeHTML(formatMoney(item.unitPrice ?? 0, cur))}</td>
      <td class="num">${item.discountRate ? escapeHTML(String(item.discountRate)) + '%' : '—'}</td>
      <td class="num">${escapeHTML(formatMoney(item.total ?? 0, cur))}</td>
    </tr>`).join('');

  const totalRows = `
    <div class="row"><span>${t('Subtotal', 'Jumla Ndogo')}</span><span>${escapeHTML(formatMoney(invoice.subtotal, cur))}</span></div>
    ${(invoice.itemDiscount ?? 0) ? `<div class="row"><span>${t('Item Discount', 'Punguzo la Bidhaa')}</span><span>-${escapeHTML(formatMoney(invoice.itemDiscount, cur))}</span></div>` : ''}
    ${(invoice.invoiceDiscount ?? 0) ? `<div class="row"><span>${t('Invoice Discount', 'Punguzo la Ankara')}</span><span>-${escapeHTML(formatMoney(invoice.invoiceDiscount, cur))}</span></div>` : ''}
    ${(invoice.tax ?? 0) ? `<div class="row"><span>${t('Tax', 'Kodi')}</span><span>${escapeHTML(formatMoney(invoice.tax, cur))}</span></div>` : ''}
    ${(invoice.shipping ?? 0) ? `<div class="row"><span>${t('Shipping', 'Usafirishaji')}</span><span>${escapeHTML(formatMoney(invoice.shipping, cur))}</span></div>` : ''}
    <div class="row grand"><span>${t('GRAND TOTAL', 'JUMLA KUU')}</span><span>${escapeHTML(formatMoney(invoice.grandTotal, cur))}</span></div>
    <div class="row"><span>${t('Amount Paid', 'Kiasi Kilicholipwa')}</span><span>${escapeHTML(formatMoney(invoice.amountPaid || 0, cur))}</span></div>
    <div class="row"><span>${t('Balance Due', 'Salio')}</span><span>${escapeHTML(formatMoney(invoice.balance ?? invoice.grandTotal, cur))}</span></div>`;

  el.innerHTML = `
    <div class="doc-header">
      <div class="doc-brand">
        <div class="doc-company">
          <strong>${escapeHTML(businessName)}</strong>
        </div>
        <div class="doc-logo">
          ${c.logoDataUrl ? `<img src="${c.logoDataUrl}" alt="Logo">` : '<span class="text-faint text-sm">Business Logo</span>'}
        </div>
        <div class="doc-company">
          ${c.address ? escapeHTML(c.address) + '<br>' : ''}
          ${[c.region, c.district, c.country].filter(Boolean).join(', ') ? escapeHTML([c.region, c.district, c.country].filter(Boolean).join(', ')) + '<br>' : ''}
          ${c.phone ? 'Tel: ' + escapeHTML(c.phone) + '<br>' : ''}
          ${c.email ? 'Email: ' + escapeHTML(c.email) + '<br>' : ''}
          ${c.tin ? 'TIN: ' + escapeHTML(c.tin) + '<br>' : ''}
          ${c.vrn ? 'VRN: ' + escapeHTML(c.vrn) + '<br>' : ''}
        </div>
      </div>
      <div class="text-right">
        <div class="doc-title">${t('INVOICE', 'ANKARA')}</div>
        <div class="doc-meta mt-2">
          <span class="k">${t('Invoice No', 'Namba')}</span><span class="v">${escapeHTML(invoice.number || '')}</span>
          <span class="k">${t('Issue Date', 'Tarehe')}</span><span class="v">${escapeHTML(formatDate(invoice.issueDate))}</span>
          <span class="k">${t('Due Date', 'Tarehe ya Kukamilika')}</span><span class="v">${escapeHTML(formatDate(invoice.dueDate))}</span>
          <span class="k">${t('Status', 'Hali')}</span><span class="v">${statusBadge(invoice.status)}</span>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-4 mt-5">
      <div>
        <div class="doc-section-title">${t('BILL TO', 'MLIPAJI')}</div>
        <div class="doc-company">
          <strong>${escapeHTML(invoice.customerName || 'Customer Name')}</strong>
          ${invoice.customerAddress ? escapeHTML(invoice.customerAddress) + '<br>' : ''}
          ${invoice.customerPhone ? 'Tel: ' + escapeHTML(invoice.customerPhone) + '<br>' : ''}
          ${invoice.customerEmail ? 'Email: ' + escapeHTML(invoice.customerEmail) + '<br>' : ''}
          ${invoice.customerTin ? 'TIN: ' + escapeHTML(invoice.customerTin) + '<br>' : ''}
        </div>
      </div>
      <div>
        <div class="doc-section-title">${t('SHIP TO', 'PALE UNAPELEKA')}</div>
        <div class="doc-company">
          <strong>${escapeHTML(invoice.shipToName || invoice.customerName || '—')}</strong>
          ${invoice.shipToAddress ? escapeHTML(invoice.shipToAddress) + '<br>' : ''}
          ${invoice.shipToPhone ? 'Tel: ' + escapeHTML(invoice.shipToPhone) + '<br>' : ''}
        </div>
      </div>
    </div>

    <div class="mt-5">
      <table class="doc-table">
        <thead><tr><th>#</th><th>${t('Description', 'Maelezo')}</th><th>${t('Qty', 'Idadi')}</th><th>${t('Unit Price', 'Bei')}</th><th>${t('Disc %', 'Punguzo %')}</th><th>${t('Amount', 'Kiasi')}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div class="flex mt-4 gap-4 flex-wrap">
      <div class="flex-1">
        <div class="amount-words">${t('Amount in Words:', 'Kiasi kwa Maneno:')} ${escapeHTML(words)}</div>
        ${invoice.notes ? `<div class="mt-3"><div class="doc-section-title">${t('NOTES', 'MAELEZO')}</div><div class="doc-company">${escapeHTML(invoice.notes)}</div></div>` : ''}
      </div>
      <div class="totals">${totalRows}</div>
    </div>

    <div class="doc-sign">
      <div class="doc-sign-cell">
        ${c.signatureDataUrl ? `<img class="doc-sign-img" src="${c.signatureDataUrl}" alt="Signature">` : ''}
        <div class="doc-sign-rule"></div>
        <div class="doc-sign-label">${t('Authorized Signature', 'Sahihi Iliyoidhinishwa')}</div>
      </div>
      <div class="doc-sign-cell">
        ${c.stampDataUrl
          ? `<img class="doc-stamp-img" src="${c.stampDataUrl}" alt="Company stamp">
             <div class="doc-sign-label">${t('Company Stamp', 'Muhuri wa Kampuni')}</div>`
          : `<div class="doc-stamp-ring">${t('COMPANY STAMP', 'MUHURI WA KAMPUNI')}</div>`}
      </div>
    </div>

    <div class="doc-footer">${escapeHTML(businessName)}${c.website ? ' • ' + escapeHTML(c.website) : ''}</div>`;
}

/**
 * Show the preview panel.
 * @param {Object} invoice - the invoice to display and to act on
 * @param {'record'|'editor'} source - 'record' when the invoice came from
 *   storage (list / after a save), 'editor' when it is the live form state and
 *   may carry unsaved edits.
 */
function openPreview(invoice, source = 'record') {
  // Remember what is on screen so Print / Download / WhatsApp act on the
  // invoice being previewed rather than on whatever the editor form happens
  // to hold. Reached via the list's eye icon the form is untouched, and
  // re-collecting from it used to yield a blank customer name — which the
  // `if (inv.customerName)` guard turned into a silent no-op.
  state.previewInvoice = invoice;
  state.previewSource = source;
  $('#listView').classList.add('hidden');
  $('#editorView').classList.add('hidden');
  $('#previewView').classList.remove('hidden');
  $('#previewTitle').textContent = `Invoice ${invoice.number || ''}`;
  $('#pageTitle').textContent = `Invoice ${invoice.number || ''}`;
  renderPreview(invoice);
  window.scrollTo(0, 0);
}

/** The invoice the preview panel is showing, or null if it is not open. */
function previewTarget() {
  return state.previewInvoice;
}

/* ================= Payments ================= */
function openPaymentModal(invoice) {
  const balance = round2((invoice.grandTotal || 0) - (invoice.amountPaid || 0));
  const methods = ['Cash', 'Bank Transfer', 'M-Pesa', 'Airtel Money', 'Mixx by Yas', 'HaloPesa', 'Cheque', 'Credit', 'Bank Transfer'];
  const methodOptions = methods.map((m) => `<option value="${escapeHTML(m)}">${escapeHTML(m)}</option>`).join('');

  openModal({
    title: `Record Payment — ${invoice.number || ''}`,
    size: '',
    body: `
      <div class="field">
        <label>Amount <span class="req">*</span></label>
        <input type="number" class="input" id="payAmount" min="0.01" step="0.01" value="${balance > 0 ? balance : ''}" placeholder="Amount">
        <span class="hint">Balance due: ${escapeHTML(formatMoney(balance, state.currency))}</span>
      </div>
      <div class="field">
        <label>Date</label>
        <input type="date" class="input" id="payDate" value="${toISODate()}">
      </div>
      <div class="field">
        <label>Payment Method</label>
        <select class="select" id="payMethod">${methodOptions}</select>
      </div>
      <div class="field">
        <label>Reference</label>
        <input type="text" class="input" id="payRef" placeholder="Transaction reference">
      </div>
      <div class="field">
        <label>Notes</label>
        <textarea class="textarea" id="payNotes" placeholder="Optional notes"></textarea>
      </div>`,
    footer: `
      <button class="btn btn-outline" data-action="cancel">Cancel</button>
      <button class="btn btn-primary" data-action="save">Record Payment</button>`,
    onOpen: (ov) => {
      $('[data-action="cancel"]', ov).addEventListener('click', () => ov.remove());
      $('[data-action="save"]', ov).addEventListener('click', async () => {
        if (!validateNumberInputs(ov)) return;
        const amount = toNumber($('#payAmount', ov).value);
        if (amount <= 0) { toast('Enter a valid amount', 'error'); return; }
        const payment = {
          id: uid('pay'),
          invoiceId: invoice.id,
          date: $('#payDate', ov).value || toISODate(),
          amount,
          method: $('#payMethod', ov).value,
          reference: sanitizeString($('#payRef', ov).value, 100),
          notes: sanitizeString($('#payNotes', ov).value, 300),
          createdAt: new Date().toISOString(),
        };
        try {
          await savePayment(payment);
          state.payments = await getPayments();
          // update invoice amountPaid
          const totalPaid = state.payments.filter((p) => p.invoiceId === invoice.id).reduce((a, p) => a + toNumber(p.amount), 0);
          const updated = { ...invoice, amountPaid: round2(totalPaid), balance: round2((invoice.grandTotal || 0) - totalPaid), status: deriveStatus(invoice.grandTotal, totalPaid) };
          await saveInvoice(updated);
          state.invoices = await getInvoices();
          ov.remove();
          toast('Payment recorded', 'success');
          renderList();
          if (state.editingId === invoice.id) openEditor(invoice.id);
        } catch (err) {
          toast('Failed to record payment: ' + err.message, 'error');
        }
      });
    },
  });
}

/* ================= PDF helpers ================= */

/**
 * The artwork options every export path needs: the logo, the digital signature
 * and the company stamp. All three live outside the `company` record in
 * storage, and `getCompanyProfile()` is what folds them back in.
 */
function artworkOpts(company, extra = {}) {
  return {
    logoDataUrl: company.logoDataUrl || null,
    signatureDataUrl: company.signatureDataUrl || null,
    stampDataUrl: company.stampDataUrl || null,
    ...extra,
  };
}

async function getPdfAssets(invoice) {
  // `invoiceCompany` carries the invoice's own business-name override and the
  // artwork, which lives outside the `company` record in storage.
  const company = invoiceCompany(invoice);
  const cur = state.currencies.find((x) => x.code === invoice.currency) || state.currency;
  const payload = buildQRPayload(invoice, company);
  let qrDataUrl = null;
  try { qrDataUrl = await generateQRDataURL(payload, 220); } catch { /* ignore */ }
  return { company, currency: cur, opts: artworkOpts(company, { qrDataUrl, language: state.language }) };
}

async function handleDownloadPdf(invoice, btn = null) {
  try {
    await withLoading(btn, async () => {
      const assets = await getPdfAssets(invoice);
      await downloadInvoicePDF(invoice, assets.company, assets.currency, assets.opts);
    });
    toast('PDF downloaded', 'success');
  } catch (err) {
    toast('PDF generation failed: ' + err.message, 'error');
  }
}

function handlePrint(invoice) {
  const cur = state.currencies.find((x) => x.code === invoice.currency) || state.currency;
  const company = invoiceCompany(invoice);
  printInvoice(invoice, company, cur, artworkOpts(company, { language: state.language }));
}

/* ================= Init ================= */
async function loadData() {
  const [invoices, customers, products, payments, currencies, company, language] = await Promise.all([
    getInvoices(),
    getCustomers(),
    getProducts(),
    getPayments(),
    getCurrencies(),
    // getCompanyProfile merges the logo (stored as its own setting) into the
    // profile, so `company.logoDataUrl` is populated for the preview and PDF.
    getCompanyProfile(),
    getSetting('language', 'en'),
  ]);
  state.invoices = invoices;
  state.customers = customers;
  state.products = products;
  state.payments = payments;
  state.currencies = currencies;
  state.company = company || {};
  state.language = language || 'en';
  const defaultCode = await getDefaultCurrencyCode();
  state.currency = currencies.find((c) => c.code === defaultCode) || currencies[0];
}

function bindEvents() {
  // List
  $('#newInvoiceBtn')?.addEventListener('click', () => openEditor());
  $('#exportCsvBtn')?.addEventListener('click', () => {
    exportInvoicesCSV(state.invoices.map(enrichInvoice), state.currency);
    toast('CSV exported', 'success');
  });
  $('#invoiceSearch')?.addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); renderList(); }, 250));
  $$('.chip[data-filter]').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('.chip[data-filter]').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.filter = chip.dataset.filter;
      renderList();
    });
  });
  $('#invoiceTableBody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const inv = state.invoices.find((i) => i.id === id);
    if (!inv) return;
    const action = btn.dataset.action;
    if (action === 'view') openPreview(enrichInvoice(inv));
    else if (action === 'edit') openEditor(id);
    else if (action === 'pdf') handleDownloadPdf(enrichInvoice(inv), btn);
    else if (action === 'delete') {
      const ok = await confirmDialog({ title: 'Delete Invoice', message: `Delete invoice ${inv.number || ''}? This cannot be undone.`, confirmText: 'Delete', danger: true });
      if (ok) {
        await deleteInvoice(id);
        state.invoices = await getInvoices();
        renderList();
        toast('Invoice deleted', 'success');
      }
    }
  });

  // Editor
  $('#backToListBtn')?.addEventListener('click', () => {
    $('#editorView').classList.add('hidden');
    $('#previewView').classList.add('hidden');
    $('#listView').classList.remove('hidden');
    $('#pageTitle').textContent = 'Invoices';
    renderList();
  });
  $('#addLineBtn')?.addEventListener('click', () => addLineRow());
  $('#quickAddProductBtn')?.addEventListener('click', () => {
    if (state.products.length) {
      const last = $('#itemsBody tr:last-child .line-product');
      if (last) last.focus();
      toast('Select a product from the dropdown', 'info');
    } else {
      toast('No products yet. Add products in the Products page.', 'info');
    }
  });
  $('#invCustomer')?.addEventListener('change', (e) => {
    const c = state.customers.find((x) => x.id === e.target.value);
    if (c) applyCustomerToForm(c);
  });
  $('#invNewCustomerBtn')?.addEventListener('click', () => openNewCustomerModal());
  ['#invDiscount', '#invTaxRate', '#invShipping'].forEach((sel) => {
    $(sel)?.addEventListener('input', recalc);
  });
  $('#invDiscountType')?.addEventListener('change', recalc);
  $('#invTaxInclusive')?.addEventListener('change', recalc);
  $('#invCurrency')?.addEventListener('change', () => {
    const code = $('#invCurrency').value;
    state.currency = state.currencies.find((c) => c.code === code) || state.currency;
    recalc();
  });

  $('#saveInvoiceBtn')?.addEventListener('click', async () => {
    const inv = await saveCurrentInvoice();
    if (inv) { state.invoices = await getInvoices(); renderList(); openPreview(enrichInvoice(inv)); }
  });
  $('#saveInvoiceBtn2')?.addEventListener('click', async () => {
    const inv = await saveCurrentInvoice();
    if (inv) { state.invoices = await getInvoices(); renderList(); openPreview(enrichInvoice(inv)); }
  });
  $('#saveDraftBtn')?.addEventListener('click', async () => {
    const inv = await saveCurrentInvoice('draft');
    if (inv) { state.invoices = await getInvoices(); renderList(); }
  });
  $('#previewBtn')?.addEventListener('click', () => {
    const inv = collectInvoice();
    if (!inv.customerName) { toast('Enter a customer name first', 'error'); return; }
    openPreview(inv, 'editor');
  });
  $('#downloadPdfBtn')?.addEventListener('click', (e) => {
    const inv = collectInvoice();
    if (!inv.customerName) { toast('Enter a customer name first', 'error'); return; }
    handleDownloadPdf(inv, e.currentTarget);
  });
  $('#recordPaymentBtn')?.addEventListener('click', () => {
    const inv = collectInvoice();
    if (!inv.id) { toast('Save the invoice first', 'error'); return; }
    openPaymentModal(enrichInvoice(inv));
  });

  // Preview — every action here operates on the invoice being SHOWN, not on
  // the editor form (which is empty when the preview was opened from the list).
  $('#backToEditBtn')?.addEventListener('click', () => {
    const inv = previewTarget();
    // Came from a stored record (list's eye icon, or a save): load that invoice
    // into the editor so the form matches what was on screen. Just revealing
    // the editor would leave whatever was loaded last — and saving would then
    // overwrite THAT invoice.
    if (inv && state.previewSource === 'record' && state.invoices.some((i) => i.id === inv.id)) {
      openEditor(inv.id);
      return;
    }
    // Came from the editor: go straight back so unsaved edits survive.
    $('#previewView').classList.add('hidden');
    $('#editorView').classList.remove('hidden');
    $('#pageTitle').textContent = state.editingId ? 'Edit Invoice' : 'New Invoice';
  });
  $('#printBtn')?.addEventListener('click', () => {
    const inv = previewTarget();
    if (inv) handlePrint(inv);
  });
  $('#downloadPdfBtn2')?.addEventListener('click', (e) => {
    const inv = previewTarget();
    if (inv) handleDownloadPdf(inv, e.currentTarget);
  });
  $('#shareWhatsappBtn')?.addEventListener('click', async (e) => {
    const inv = previewTarget();
    if (!inv) return;
    if (!inv.customerName) { toast('Enter a customer name first', 'error'); return; }
    const cur = state.currencies.find((x) => x.code === inv.currency) || state.currency;
    // Rendering the PDF for a native share can take a moment, so show the
    // button's spinner while it happens.
    await withLoading(e.currentTarget, async () => {
      try {
        const company = invoiceCompany(inv);
        const result = await shareInvoice(inv, company, cur, {
          phone: inv.customerPhone,
          language: state.language,
          pdf: artworkOpts(company, { language: state.language }),
        });
        if (!result.ok) toast(result.reason || 'Could not open WhatsApp', 'error');
        else if (result.via === 'clipboard') toast('Pop-up blocked — invoice message copied to your clipboard', 'info', 5000);
        else if (result.via === 'whatsapp') toast('Opening WhatsApp…', 'success');
        else toast('Invoice shared', 'success');
      } catch (err) {
        toast('Share failed: ' + err.message, 'error');
      }
    });
  });
}

async function init() {
  await initShell();
  // The plan decides whether a new invoice may be started, so load it before
  // anything can open the editor.
  await loadLicense();
  await loadData();
  bindEvents();
  renderList();

  const params = new URLSearchParams(location.search);
  if (params.get('new') === '1') {
    // Awaited: openEditor() now yields on the quota check, and the customer
    // pre-select below must run after it has rebuilt the customer <select>.
    await openEditor();
    const customerId = params.get('customer');
    if (customerId) {
      const c = state.customers.find((x) => x.id === customerId);
      if (c) applyCustomerToForm(c);
    }
  } else if (params.get('id')) {
    const id = params.get('id');
    const inv = state.invoices.find((i) => i.id === id);
    if (inv) openEditor(id);
    else { toast('Invoice not found', 'error'); renderList(); }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((err) => {
    console.error('Invoice init failed:', err);
    toast('Failed to initialize: ' + err.message, 'error', 6000);
  });
});
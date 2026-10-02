/**
 * Product module
 * List, search, filter, add, edit, delete products with stock tracking.
 */
import { $, $$, escapeHTML, validateNumberInputs, sanitizeString, toNumber, uid, toast, openModal, confirmDialog, debounce, readFileAsDataURL } from './utils.js';
import { getProducts, saveProduct, deleteProduct } from './storageService.js';
import { getDefaultCurrencyCode, getCurrency, formatMoney } from './currency.js';
import { exportProductsCSV } from './export.js';
import { initShell } from './shell.js';

let state = {
  products: [],
  currency: null,
  search: '',
  category: 'all',
};

function stockStatus(p) {
  const stock = toNumber(p.stock);
  const low = toNumber(p.lowStock);
  if (stock <= 0) return { label: 'Out of Stock', cls: 'badge-red' };
  if (stock <= low) return { label: 'Low Stock', cls: 'badge-orange' };
  return { label: 'In Stock', cls: 'badge-green' };
}

function renderList() {
  const tbody = $('#productTableBody');
  if (!tbody) return;
  let list = state.products;
  if (state.category === 'low') list = list.filter((p) => toNumber(p.stock) > 0 && toNumber(p.stock) <= toNumber(p.lowStock));
  else if (state.category === 'out') list = list.filter((p) => toNumber(p.stock) <= 0);
  if (state.search) {
    const q = state.search.toLowerCase();
    list = list.filter((p) =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.sku || '').toLowerCase().includes(q) ||
      (p.barcode || '').toLowerCase().includes(q) ||
      (p.category || '').toLowerCase().includes(q)
    );
  }
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center text-faint py-4">No products found.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map((p) => {
    const st = stockStatus(p);
    return `
    <tr>
      <td>
        <div class="flex items-center gap-3">
          ${p.image ? `<img src="${p.image}" alt="" style="width:38px;height:38px;border-radius:10px;object-fit:cover;flex-shrink:0">` : `<span class="avatar gold">${escapeHTML((p.name || '?')[0].toUpperCase())}</span>`}
          <div>
            <div class="cell-main">${escapeHTML(p.name || '—')}</div>
            ${p.description ? `<div class="cell-sub line-clamp-1">${escapeHTML(p.description)}</div>` : ''}
          </div>
        </div>
      </td>
      <td class="text-muted">${escapeHTML(p.sku || '—')}</td>
      <td><span class="badge badge-gray">${escapeHTML(p.category || '—')}</span></td>
      <td class="num text-muted">${escapeHTML(formatMoney(p.costPrice, state.currency))}</td>
      <td class="num font-semibold">${escapeHTML(formatMoney(p.sellingPrice, state.currency))}</td>
      <td class="num">
        <span class="font-semibold ${toNumber(p.stock) <= 0 ? 'text-danger' : ''}">${escapeHTML(String(p.stock ?? 0))}</span>
        <span class="cell-sub"> ${escapeHTML(p.unit || '')}</span>
      </td>
      <td><span class="badge ${st.cls}"><span class="badge-dot"></span>${st.label}</span></td>
      <td>
        <div class="actions">
          <button class="icon-btn" data-action="edit" data-id="${escapeHTML(p.id)}" aria-label="Edit product" title="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="icon-btn danger" data-action="delete" data-id="${escapeHTML(p.id)}" aria-label="Delete product" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function openProductModal(id = null) {
  const p = id ? state.products.find((x) => x.id === id) : null;
  openModal({
    title: p ? 'Edit Product' : 'Add Product',
    size: 'modal-xl',
    body: `
      <div class="grid grid-cols-3 gap-4">
        <div class="field col-span-3">
          <label>Product Name <span class="req">*</span></label>
          <input type="text" class="input" id="prodName" value="${escapeHTML(p?.name || '')}" placeholder="Product name">
        </div>
        <div class="field col-span-3">
          <label>Description</label>
          <textarea class="textarea" id="prodDesc" placeholder="Short description">${escapeHTML(p?.description || '')}</textarea>
        </div>
        <div class="field">
          <label>SKU</label>
          <input type="text" class="input" id="prodSku" value="${escapeHTML(p?.sku || '')}" placeholder="SKU">
        </div>
        <div class="field">
          <label>Barcode</label>
          <input type="text" class="input" id="prodBarcode" value="${escapeHTML(p?.barcode || '')}" placeholder="Barcode">
        </div>
        <div class="field">
          <label>Category</label>
          <input type="text" class="input" id="prodCategory" value="${escapeHTML(p?.category || '')}" placeholder="e.g. Cashew Nuts">
        </div>
        <div class="field">
          <label>Unit</label>
          <select class="select" id="prodUnit">
            ${['kg', 'g', 'pack', 'box', 'jar', 'bottle', 'piece', 'bag', 'dozen', 'litre', 'unit'].map((u) => `<option value="${u}" ${p?.unit === u ? 'selected' : ''}>${u}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Cost Price</label>
          <input type="number" class="input" id="prodCost" min="0" step="0.01" value="${p?.costPrice ?? ''}" placeholder="0.00">
        </div>
        <div class="field">
          <label>Selling Price <span class="req">*</span></label>
          <input type="number" class="input" id="prodPrice" min="0" step="0.01" value="${p?.sellingPrice ?? ''}" placeholder="0.00">
        </div>
        <div class="field">
          <label>Tax Rate (%)</label>
          <input type="number" class="input" id="prodTax" min="0" step="0.01" value="${p?.taxRate ?? 18}" placeholder="18">
        </div>
        <div class="field">
          <label>Discount (%)</label>
          <input type="number" class="input" id="prodDisc" min="0" step="0.01" value="${p?.discountRate ?? 0}" placeholder="0">
        </div>
        <div class="field">
          <label>Stock</label>
          <input type="number" class="input" id="prodStock" min="0" step="1" value="${p?.stock ?? 0}" placeholder="0">
        </div>
        <div class="field">
          <label>Low Stock Alert</label>
          <input type="number" class="input" id="prodLow" min="0" step="1" value="${p?.lowStock ?? 10}" placeholder="10">
        </div>
        <div class="field">
          <label>Status</label>
          <select class="select" id="prodStatus">
            <option value="active" ${p?.status === 'active' ? 'selected' : ''}>Active</option>
            <option value="inactive" ${p?.status === 'inactive' ? 'selected' : ''}>Inactive</option>
          </select>
        </div>
        <div class="field col-span-3">
          <label>Product Image</label>
          <div class="flex items-center gap-3">
            <div id="prodImagePreview" style="width:64px;height:64px;border-radius:12px;background:var(--surface-2);display:grid;place-items:center;overflow:hidden;border:1px solid var(--border)">
              ${p?.image ? `<img src="${p.image}" alt="" style="width:100%;height:100%;object-fit:cover">` : '<span class="text-faint text-xs">No image</span>'}
            </div>
            <input type="file" class="input" id="prodImageInput" accept="image/*" style="max-width:260px">
            ${p?.image ? `<button class="btn btn-sm btn-danger-outline" id="prodImageRemove">Remove</button>` : ''}
          </div>
        </div>
      </div>`,
    footer: `
      <button class="btn btn-outline" data-action="cancel">Cancel</button>
      <button class="btn btn-primary" data-action="save">${p ? 'Save Changes' : 'Add Product'}</button>`,
    onOpen: (ov) => {
      $('[data-action="cancel"]', ov).addEventListener('click', () => ov.remove());
      let imageData = p?.image || '';
      const preview = $('#prodImagePreview', ov);
      $('#prodImageInput', ov)?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) { toast('Image must be under 2MB', 'error'); return; }
        try {
          imageData = await readFileAsDataURL(file);
          preview.innerHTML = `<img src="${imageData}" alt="" style="width:100%;height:100%;object-fit:cover">`;
        } catch {
          toast('Failed to read image', 'error');
        }
      });
      $('#prodImageRemove', ov)?.addEventListener('click', () => {
        imageData = '';
        preview.innerHTML = '<span class="text-faint text-xs">No image</span>';
      });
      $('[data-action="save"]', ov).addEventListener('click', async () => {
        if (!validateNumberInputs(ov)) return;
        const name = sanitizeString($('#prodName', ov).value, 200);
        const price = toNumber($('#prodPrice', ov).value);
        if (!name) { toast('Product name is required', 'error'); return; }
        if (price < 0) { toast('Selling price cannot be negative', 'error'); return; }
        const record = {
          id: p ? p.id : uid('prod'),
          name,
          description: sanitizeString($('#prodDesc', ov).value, 1000),
          sku: sanitizeString($('#prodSku', ov).value, 50),
          barcode: sanitizeString($('#prodBarcode', ov).value, 50),
          category: sanitizeString($('#prodCategory', ov).value, 100),
          unit: $('#prodUnit', ov).value,
          costPrice: toNumber($('#prodCost', ov).value),
          sellingPrice: price,
          taxRate: toNumber($('#prodTax', ov).value),
          discountRate: toNumber($('#prodDisc', ov).value),
          stock: toNumber($('#prodStock', ov).value),
          lowStock: toNumber($('#prodLow', ov).value),
          status: $('#prodStatus', ov).value,
          image: imageData,
          createdAt: p ? p.createdAt : new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        try {
          await saveProduct(record);
          state.products = await getProducts();
          ov.remove();
          renderList();
          toast(p ? 'Product updated' : 'Product added', 'success');
        } catch (err) {
          toast('Failed to save product: ' + err.message, 'error');
        }
      });
    },
  });
}

async function init() {
  await initShell();
  const [products, currency] = await Promise.all([
    getProducts(),
    getCurrency(await getDefaultCurrencyCode()),
  ]);
  state.products = products;
  state.currency = currency;
  renderList();

  $('#addProductBtn')?.addEventListener('click', () => openProductModal());
  $('#exportCsvBtn')?.addEventListener('click', () => {
    exportProductsCSV(state.products);
    toast('Products exported', 'success');
  });
  $('#productSearch')?.addEventListener('input', debounce((e) => { state.search = e.target.value.trim(); renderList(); }, 250));
  $$('.chip[data-cat]').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('.chip[data-cat]').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.category = chip.dataset.cat;
      renderList();
    });
  });

  $('#productTableBody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'edit') openProductModal(id);
    else if (btn.dataset.action === 'delete') {
      const p = state.products.find((x) => x.id === id);
      const ok = await confirmDialog({ title: 'Delete Product', message: `Delete ${p?.name || 'this product'}?`, confirmText: 'Delete', danger: true });
      if (ok) {
        await deleteProduct(id);
        state.products = await getProducts();
        renderList();
        toast('Product deleted', 'success');
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((err) => {
    console.error('Product init failed:', err);
    toast('Failed to initialize: ' + err.message, 'error', 6000);
  });
});
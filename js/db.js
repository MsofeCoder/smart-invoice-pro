/**
 * IndexedDB data layer.
 * Stores: settings, customers, products, invoices, payments, syncQueue
 * All operations are Promise-based with full error handling.
 *
 * The database name comes from js/app.config.js. Renaming it for a white-label
 * deployment would strand existing users' invoices in an orphaned database, so
 * `migrateLegacyDatabases()` copies them across once, on first boot.
 */
import { CONFIG } from './config.js';

const DB_NAME = CONFIG.dbName || 'invoice-app';
const DB_VERSION = 1;

/** Stamped into backups so a restore can be validated. */
const APP_ID = CONFIG.slug || 'invoice-app';
/** Accepted on import, so a file exported before the rebrand still restores. */
const ACCEPTED_APP_IDS = [APP_ID, ...(CONFIG.legacyDbNames || [])].filter(Boolean);

const STORES = {
  settings: { keyPath: 'key' },
  customers: { keyPath: 'id', indexes: [{ name: 'by_name', keyPath: 'name' }] },
  products: { keyPath: 'id', indexes: [{ name: 'by_name', keyPath: 'name' }] },
  invoices: { keyPath: 'id', indexes: [{ name: 'by_date', keyPath: 'issueDate' }, { name: 'by_status', keyPath: 'status' }] },
  payments: { keyPath: 'id', indexes: [{ name: 'by_invoice', keyPath: 'invoiceId' }, { name: 'by_date', keyPath: 'date' }] },
  syncQueue: { keyPath: 'id', indexes: [{ name: 'by_created', keyPath: 'createdAt' }] },
};

let dbPromise = null;

/**
 * One-time copy out of a pre-rebrand database.
 *
 * Two guards keep this safe:
 *   1. `indexedDB.databases()` tells us the old database actually exists.
 *      Opening a name blindly would CREATE an empty legacy database as a side
 *      effect, which is worse than not migrating at all.
 *   2. Data is only copied into a completely empty new database, so a user who
 *      has already started working in the new one is never overwritten.
 *
 * Every failure path is swallowed: a botched migration must not stop the app
 * from opening. Returns a short description of what happened, for logging.
 */
async function migrateLegacyDatabases() {
  const legacy = (CONFIG.legacyDbNames || []).filter(Boolean);
  if (!legacy.length) return 'no legacy names configured';
  if (typeof indexedDB.databases !== 'function') return 'databases() unsupported';

  let names;
  try {
    names = (await indexedDB.databases()).map((d) => d.name);
  } catch {
    return 'could not enumerate databases';
  }

  const source = legacy.find((name) => names.includes(name));
  if (!source) return 'nothing to migrate';

  const readAll = (dbName) => new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => {
      const db = req.result;
      const stores = Array.from(db.objectStoreNames);
      if (!stores.length) { db.close(); resolve({}); return; }
      const tx = db.transaction(stores, 'readonly');
      const out = {};
      stores.forEach((name) => {
        const get = tx.objectStore(name).getAll();
        get.onsuccess = () => { out[name] = get.result || []; };
      });
      tx.oncomplete = () => { db.close(); resolve(out); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  });

  try {
    const legacyData = await readAll(source);
    const storeNames = Object.keys(legacyData);
    if (!storeNames.length) return `${source} was empty`;

    // Create/open the new database so its stores exist, then check emptiness.
    const target = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        for (const [name, cfg] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, { keyPath: cfg.keyPath });
            (cfg.indexes || []).forEach((idx) => store.createIndex(idx.name, idx.keyPath, { unique: !!idx.unique }));
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const counts = await new Promise((resolve, reject) => {
      const stores = Array.from(target.objectStoreNames);
      const tx = target.transaction(stores, 'readonly');
      const out = {};
      stores.forEach((name) => {
        const c = tx.objectStore(name).count();
        c.onsuccess = () => { out[name] = c.result; };
      });
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
    });

    const alreadyPopulated = Object.values(counts).some((n) => n > 0);
    if (alreadyPopulated) {
      target.close();
      return `${source} skipped — target already has data`;
    }

    await new Promise((resolve, reject) => {
      const usable = Array.from(target.objectStoreNames);
      const tx = target.transaction(usable, 'readwrite');
      let copied = 0;
      for (const name of usable) {
        (legacyData[name] || []).forEach((row) => { tx.objectStore(name).put(row); copied++; });
      }
      tx.oncomplete = () => resolve(copied);
      tx.onerror = () => reject(tx.error);
    });

    target.close();
    return `migrated ${source} → ${DB_NAME}`;
  } catch (err) {
    console.warn('[db] legacy migration skipped:', err);
    return 'migration failed (see console)';
  }
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const note = await migrateLegacyDatabases();
    if (note && note.startsWith('migrated')) console.info('[db]', note);
    return openFresh();
  })();
  return dbPromise;
}

function openFresh() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not supported in this browser.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      for (const [name, cfg] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: cfg.keyPath });
          (cfg.indexes || []).forEach((idx) => store.createIndex(idx.name, idx.keyPath, { unique: !!idx.unique }));
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open database'));
    req.onblocked = () => reject(new Error('Database upgrade blocked by another tab'));
  });
}

async function withStore(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeName, mode);
    } catch (err) {
      reject(err);
      return;
    }
    const store = tx.objectStore(storeName);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error(`Transaction failed on ${storeName}`));
    tx.onabort = () => reject(tx.error || new Error(`Transaction aborted on ${storeName}`));
  });
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

/* ---------------- Generic CRUD ---------------- */
export async function dbPut(storeName, value) {
  return withStore(storeName, 'readwrite', (store) => {
    store.put(value);
    return value;
  });
}

export async function dbBulkPut(storeName, values) {
  if (!values || !values.length) return [];
  return withStore(storeName, 'readwrite', (store) => {
    values.forEach((v) => store.put(v));
    return values;
  });
}

export async function dbGet(storeName, key) {
  return withStore(storeName, 'readonly', (store) => requestToPromise(store.get(key)));
}

export async function dbGetAll(storeName) {
  return withStore(storeName, 'readonly', (store) => requestToPromise(store.getAll()));
}

export async function dbDelete(storeName, key) {
  return withStore(storeName, 'readwrite', (store) => {
    store.delete(key);
    return key;
  });
}

export async function dbClear(storeName) {
  return withStore(storeName, 'readwrite', (store) => {
    store.clear();
    return true;
  });
}

export async function dbCount(storeName) {
  return withStore(storeName, 'readonly', (store) => requestToPromise(store.count()));
}

/* ---------------- Settings (key/value) ---------------- */
export async function getSetting(key, fallback = null) {
  const row = await dbGet('settings', key);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  return dbPut('settings', { key, value, updatedAt: Date.now() });
}

export async function getAllSettings() {
  const rows = await dbGetAll('settings');
  const out = {};
  rows.forEach((r) => { out[r.key] = r.value; });
  return out;
}

export async function bulkSetSettings(obj) {
  const rows = Object.entries(obj).map(([key, value]) => ({ key, value, updatedAt: Date.now() }));
  return dbBulkPut('settings', rows);
}

/* ---------------- Customers ---------------- */
export async function getCustomers() {
  const all = await dbGetAll('customers');
  return all.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

export async function saveCustomer(customer) {
  return dbPut('customers', customer);
}

export async function deleteCustomer(id) {
  return dbDelete('customers', id);
}

/* ---------------- Products ---------------- */
export async function getProducts() {
  const all = await dbGetAll('products');
  return all.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

export async function saveProduct(product) {
  return dbPut('products', product);
}

export async function deleteProduct(id) {
  return dbDelete('products', id);
}

/* ---------------- Invoices ---------------- */
export async function getInvoices() {
  const all = await dbGetAll('invoices');
  return all.sort((a, b) => String(b.issueDate || '').localeCompare(String(a.issueDate || '')));
}

export async function saveInvoice(invoice) {
  return dbPut('invoices', invoice);
}

export async function deleteInvoice(id) {
  return dbDelete('invoices', id);
}

/* ---------------- Payments ---------------- */
export async function getPayments() {
  const all = await dbGetAll('payments');
  return all.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

export async function getPaymentsForInvoice(invoiceId) {
  const all = await getPayments();
  return all.filter((p) => p.invoiceId === invoiceId).sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

export async function savePayment(payment) {
  return dbPut('payments', payment);
}

export async function deletePayment(id) {
  return dbDelete('payments', id);
}

/* ---------------- Sync queue (future cloud sync) ---------------- */
export async function enqueueSync(operation) {
  const item = {
    id: `sync_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ...operation,
    createdAt: Date.now(),
    status: 'pending',
  };
  return dbPut('syncQueue', item);
}

export async function getSyncQueue() {
  return dbGetAll('syncQueue');
}

export async function clearSyncQueue() {
  return dbClear('syncQueue');
}

/* ---------------- Backup / Restore ---------------- */
export async function exportAllData() {
  const [settings, customers, products, invoices, payments] = await Promise.all([
    dbGetAll('settings'),
    dbGetAll('customers'),
    dbGetAll('products'),
    dbGetAll('invoices'),
    dbGetAll('payments'),
  ]);
  return {
    app: APP_ID,
    version: 1,
    exportedAt: new Date().toISOString(),
    data: { settings, customers, products, invoices, payments },
  };
}

export async function importAllData(payload) {
  if (!payload || !ACCEPTED_APP_IDS.includes(payload.app) || payload.version !== 1 ||
      !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    throw new Error('Invalid or unsupported backup file');
  }
  const names = ['settings', 'customers', 'products', 'invoices', 'payments'];
  // A full backup must contain every store: omitted stores must never erase data.
  for (const name of names) {
    const rows = payload.data[name];
    if (!Array.isArray(rows)) throw new Error(`Invalid backup: ${name} must be an array`);
    const key = STORES[name].keyPath;
    const keys = new Set();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) ||
          typeof row[key] !== 'string' || !row[key].trim() || keys.has(row[key])) {
        throw new Error(`Invalid backup: missing or duplicate ${name} ${key}`);
      }
      keys.add(row[key]);
    }
  }
  const db = await openDB();
  // Queue clears and inserts synchronously in ONE transaction. Failure in any
  // store rolls back all stores, including the pending sync queue.
  await new Promise((resolve, reject) => {
    const tx = db.transaction([...names, 'syncQueue'], 'readwrite');
    let failure;
    tx.oncomplete = resolve;
    tx.onabort = () => reject(failure || tx.error || new Error('Backup restore aborted; existing data was preserved'));
    tx.onerror = () => { failure ||= tx.error; };
    try {
      for (const name of names) {
        const store = tx.objectStore(name);
        store.clear();
        payload.data[name].forEach(row => store.put(row));
      }
      // Operations queued against the replaced dataset must not be replayed.
      tx.objectStore('syncQueue').clear();
    } catch (err) {
      failure = err;
      tx.abort();
    }
  });
  return Object.fromEntries(names.map(name => [name, payload.data[name].length]));
}

/* ---------------- Sample data ---------------- */
export async function seedSampleData() {
  const now = new Date();
  const iso = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const daysAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return iso(d); };
  const daysAhead = (n) => { const d = new Date(now); d.setDate(d.getDate() + n); return iso(d); };

  const customers = [
    { id: 'cust_001', name: 'Mama Nguvu Traders', phone: '+255 712 345 678', email: 'info@mamanguvu.co.tz', tin: '123-456-789', address: 'Mchikichini Market, Dar es Salaam', notes: 'Cashew wholesale buyer', createdAt: daysAgo(120) },
    { id: 'cust_002', name: 'Kilimo Bora Ltd', phone: '+255 754 111 222', email: 'sales@kilimobora.co.tz', tin: '987-654-321', address: 'Nyerere Road, Mtwara', notes: 'Agricultural supplies', createdAt: daysAgo(90) },
    { id: 'cust_003', name: 'Zanzibar Spice House', phone: '+255 777 555 444', email: 'hello@zanzibarpice.com', tin: '555-111-222', address: 'Stone Town, Zanzibar', notes: '', createdAt: daysAgo(60) },
    { id: 'cust_004', name: 'Dar Fresh Grocers', phone: '+255 713 888 999', email: 'orders@darfresh.co.tz', tin: '333-444-555', address: 'Mwenge, Dar es Salaam', notes: 'Pays via M-Pesa', createdAt: daysAgo(30) },
  ];

  const products = [
    { id: 'prod_001', name: 'Raw Cashew Nuts (Grade A)', description: 'Premium raw cashew nuts, 1kg pack', sku: 'CSW-A-001', barcode: '6001234567890', category: 'Cashew Nuts', unit: 'kg', costPrice: 8500, sellingPrice: 12000, taxRate: 18, discountRate: 0, stock: 250, lowStock: 50, image: '', status: 'active', createdAt: daysAgo(120) },
    { id: 'prod_002', name: 'Roasted Cashew Nuts (Salted)', description: 'Oven roasted, lightly salted, 500g pack', sku: 'CSW-R-002', barcode: '6001234567891', category: 'Cashew Nuts', unit: 'pack', costPrice: 9500, sellingPrice: 13500, taxRate: 18, discountRate: 0, stock: 180, lowStock: 40, image: '', status: 'active', createdAt: daysAgo(110) },
    { id: 'prod_003', name: 'Honey Roasted Cashews', description: 'Sweet honey roasted cashews, 250g pack', sku: 'CSW-H-003', barcode: '6001234567892', category: 'Cashew Nuts', unit: 'pack', costPrice: 6500, sellingPrice: 9500, taxRate: 18, discountRate: 0, stock: 12, lowStock: 30, image: '', status: 'active', createdAt: daysAgo(100) },
    { id: 'prod_004', name: 'Cashew Butter (Smooth)', description: '100% natural cashew butter, 350g jar', sku: 'CSW-B-004', barcode: '6001234567893', category: 'Cashew Products', unit: 'jar', costPrice: 11000, sellingPrice: 16000, taxRate: 18, discountRate: 0, stock: 0, lowStock: 20, image: '', status: 'active', createdAt: daysAgo(80) },
    { id: 'prod_005', name: 'Dried Mango Slices', description: 'Naturally dried mango, no added sugar, 200g', sku: 'FRT-M-005', barcode: '6001234567894', category: 'Dried Fruits', unit: 'pack', costPrice: 4200, sellingPrice: 6800, taxRate: 18, discountRate: 0, stock: 95, lowStock: 25, image: '', status: 'active', createdAt: daysAgo(70) },
    { id: 'prod_006', name: 'Groundnut (Peanut) Butter', description: 'Crunchy groundnut butter, 350g jar', sku: 'NUT-P-006', barcode: '6001234567895', category: 'Nuts & Spreads', unit: 'jar', costPrice: 5800, sellingPrice: 8900, taxRate: 18, discountRate: 0, stock: 60, lowStock: 20, image: '', status: 'active', createdAt: daysAgo(50) },
  ];

  const mkInvoice = (id, customer, items, issueDate, dueDate, status, paidAmount = 0, discount = 0, shipping = 0, notes = '') => {
    let subtotal = 0;
    const lines = items.map(([productId, qty, price, discountRate]) => {
      const p = products.find((x) => x.id === productId);
      const lineTotal = qty * price;
      const lineDiscount = lineTotal * (discountRate / 100);
      subtotal += lineTotal - lineDiscount;
      return {
        id: `line_${id}_${productId}`,
        productId,
        name: p ? p.name : 'Product',
        description: p ? p.description : '',
        qty,
        unitPrice: price,
        discountRate,
        taxRate: p ? p.taxRate : 18,
        total: lineTotal - lineDiscount,
      };
    });
    const tax = subtotal * 0.18;
    const grandTotal = subtotal + tax + shipping - discount;
    return {
      id,
      number: id.toUpperCase(),
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone,
      customerEmail: customer.email,
      customerTin: customer.tin,
      customerAddress: customer.address,
      issueDate,
      dueDate,
      paymentTerms: 'Net 30',
      status,
      items: lines,
      subtotal: Math.round(subtotal * 100) / 100,
      discount,
      discountType: 'fixed',
      tax,
      taxRate: 18,
      shipping,
      grandTotal: Math.round(grandTotal * 100) / 100,
      amountPaid: paidAmount,
      balance: Math.round((grandTotal - paidAmount) * 100) / 100,
      currency: 'TZS',
      notes,
      createdAt: issueDate,
      updatedAt: issueDate,
    };
  };

  const invoices = [
    mkInvoice('inv_001', customers[0], [['prod_001', 50, 12000, 0], ['prod_002', 20, 13500, 5]], daysAgo(45), daysAgo(15), 'paid', 0, 0, 0, 'Wholesale order for export.'),
    mkInvoice('inv_002', customers[1], [['prod_003', 30, 9500, 0], ['prod_005', 40, 6800, 0]], daysAgo(30), daysAgo(0), 'paid', 0, 5000, 0, ''),
    mkInvoice('inv_003', customers[2], [['prod_004', 15, 16000, 10], ['prod_006', 25, 8900, 0]], daysAgo(20), daysAhead(10), 'partial', 200000, 0, 0, 'Partial payment received via bank.'),
    mkInvoice('inv_004', customers[3], [['prod_001', 100, 12000, 0], ['prod_002', 50, 13500, 0]], daysAgo(12), daysAhead(18), 'unpaid', 0, 0, 0, ''),
    mkInvoice('inv_005', customers[0], [['prod_005', 60, 6800, 0], ['prod_006', 30, 8900, 0]], daysAgo(5), daysAhead(25), 'unpaid', 0, 0, 0, ''),
    mkInvoice('inv_006', customers[2], [['prod_003', 20, 9500, 0]], daysAgo(2), daysAhead(28), 'draft', 0, 0, 0, 'Draft — awaiting confirmation.'),
  ];

  // payments for paid/partial invoices
  const payments = [
    { id: 'pay_001', invoiceId: 'inv_001', date: daysAgo(40), amount: invoices[0].grandTotal, method: 'Bank Transfer', reference: 'TRX-88213', notes: 'Full settlement' },
    { id: 'pay_002', invoiceId: 'inv_002', date: daysAgo(28), amount: invoices[1].grandTotal, method: 'M-Pesa', reference: 'MP-556677', notes: '' },
    { id: 'pay_003', invoiceId: 'inv_003', date: daysAgo(15), amount: 200000, method: 'Bank Transfer', reference: 'TRX-99102', notes: 'First installment' },
  ];

  await Promise.all([
    dbBulkPut('customers', customers),
    dbBulkPut('products', products),
    dbBulkPut('invoices', invoices),
    dbBulkPut('payments', payments),
  ]);
  return { customers: customers.length, products: products.length, invoices: invoices.length, payments: payments.length };
}
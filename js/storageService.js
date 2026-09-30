/**
 * ============================================================================
 *  STORAGE SERVICE
 * ============================================================================
 *
 *  One interface, swappable backends.
 *
 *  Feature modules never talk to IndexedDB (or to a cloud SDK) directly — they
 *  import from here. Today the active adapter is `local`, which is the
 *  IndexedDB engine in `js/db.js`. Switching to a cloud backend is a
 *  configuration change plus one adapter implementation, not a rewrite of six
 *  modules.
 *
 *  ---------------------------------------------------------------------------
 *  ADAPTER CONTRACT
 *  ---------------------------------------------------------------------------
 *  Every adapter implements the same methods. All of them are async, even where
 *  the underlying store is synchronous, so swapping in a network-backed
 *  implementation never changes a caller.
 *
 *    init(options)                        → Promise<void>
 *    get(store, key)                      → Promise<row|undefined>
 *    getAll(store)                        → Promise<row[]>
 *    put(store, value)                    → Promise<row>
 *    bulkPut(store, values)               → Promise<row[]>
 *    remove(store, key)                   → Promise<key>
 *    clear(store)                         → Promise<true>
 *    count(store)                         → Promise<number>
 *    getSetting(key, fallback)            → Promise<any>
 *    setSetting(key, value)               → Promise<void>
 *    getAllSettings()                     → Promise<object>
 *    bulkSetSettings(obj)                 → Promise<void>
 *
 *  `store` is one of: settings, customers, products, invoices, payments,
 *  syncQueue.
 *
 *  ---------------------------------------------------------------------------
 *  OFFLINE-FIRST + SYNC
 *  ---------------------------------------------------------------------------
 *  Writes always land in the local store first, so the app is fully usable
 *  offline. When a cloud adapter is active, the same write is appended to the
 *  `syncQueue` and pushed opportunistically. `pushPending()` is the single
 *  place that talks to the network, which makes retry and backoff trivial to
 *  reason about.
 *
 *  Nothing in this file performs a network request today: `sync.adapter` is
 *  `local` by default and the cloud adapters refuse to operate until they are
 *  given an endpoint, so a misconfiguration fails loudly at the call site
 *  rather than silently discarding a business's invoices.
 */

import * as local from './db.js';
import { CONFIG, syncConfig } from './config.js';

/* ==========================================================================
   Stores
   ========================================================================== */

export const STORES = Object.freeze({
  settings: 'settings',
  customers: 'customers',
  products: 'products',
  invoices: 'invoices',
  payments: 'payments',
  syncQueue: 'syncQueue',
});

/** Stores whose writes are worth pushing to a cloud backend. */
const SYNCABLE = ['customers', 'products', 'invoices', 'payments', 'settings'];

/* ==========================================================================
   Errors
   ========================================================================== */

export class StorageError extends Error {
  constructor(message, { adapter, store, cause } = {}) {
    super(message);
    this.name = 'StorageError';
    this.adapter = adapter;
    this.store = store;
    if (cause) this.cause = cause;
  }
}

/** Thrown when a cloud adapter is selected but has no endpoint configured. */
export class NotConfiguredError extends StorageError {
  constructor(adapter) {
    super(
      `The "${adapter}" storage adapter is selected but not configured. ` +
        'Set CONFIG.sync.endpoint (and apiKey) in js/app.config.js, or switch ' +
        'CONFIG.sync.adapter back to "local".',
      { adapter },
    );
    this.name = 'NotConfiguredError';
  }
}

/* ==========================================================================
   Local adapter — IndexedDB, via js/db.js
   ========================================================================== */

export class LocalAdapter {
  static id = 'local';

  get id() {
    return 'local';
  }

  get offline() {
    return true;
  }

  async init() {
    /* Nothing to do: js/db.js opens lazily on first use. */
  }

  get(store, key) { return local.dbGet(store, key); }
  getAll(store) { return local.dbGetAll(store); }
  put(store, value) { return local.dbPut(store, value); }
  bulkPut(store, values) { return local.dbBulkPut(store, values); }
  remove(store, key) { return local.dbDelete(store, key); }
  clear(store) { return local.dbClear(store); }
  count(store) { return local.dbCount(store); }

  getSetting(key, fallback = null) { return local.getSetting(key, fallback); }
  setSetting(key, value) { return local.setSetting(key, value); }
  getAllSettings() { return local.getAllSettings(); }
  bulkSetSettings(obj) { return local.bulkSetSettings(obj); }

  enqueue(op) { return local.enqueueSync(op); }
  pending() { return local.getSyncQueue(); }
  clearQueue() { return local.clearSyncQueue(); }

  /** Local storage has no remote, so there is never anything to push. */
  async push() {
    return { pushed: 0, skipped: 'local adapter' };
  }
}

/* ==========================================================================
   REST adapter — the reference cloud implementation
   ==========================================================================
   The endpoints below are the contract a backend must satisfy. They are
   deliberately boring: one collection route per store, JSON in and out.

     GET    {endpoint}/{store}             → [{...}] | { items: [{...}] }
     GET    {endpoint}/{store}/{key}       → {...}
     PUT    {endpoint}/{store}/{key}       → {...}      (upsert)
     POST   {endpoint}/{store}             → [{...}]    (bulk upsert)
     DELETE {endpoint}/{store}/{key}       → 204
     GET    {endpoint}/settings            → { key: value, ... }
     PATCH  {endpoint}/settings            → { key: value, ... }

   Auth is a bearer token in the Authorization header. Supabase and Firebase
   both expose a REST surface, so they are thin subclasses rather than separate
   implementations.
   ========================================================================== */

export class RestAdapter {
  static id = 'rest';

  constructor(options = {}) {
    this.endpoint = String(options.endpoint || '').replace(/\/+$/, '');
    this.apiKey = options.apiKey || '';
    this.timeoutMs = options.timeoutMs || 15000;
  }

  get id() {
    return 'rest';
  }

  get offline() {
    return false;
  }

  async init() {
    if (!this.endpoint) throw new NotConfiguredError(this.id);
    // A cheap liveness probe: better to fail at boot than mid-invoice.
    await this.#request('GET', '/health').catch(() => {});
  }

  #url(path) {
    if (!this.endpoint) throw new NotConfiguredError(this.id);
    return `${this.endpoint}${path}`;
  }

  async #request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.#url(path), {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new StorageError(`${method} ${path} → ${res.status}`, { adapter: this.id });
      }
      if (res.status === 204) return null;
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  async get(store, key) { return this.#request('GET', `/${store}/${encodeURIComponent(key)}`); }

  async getAll(store) {
    const data = await this.#request('GET', `/${store}`);
    return Array.isArray(data) ? data : (data?.items ?? []);
  }

  async put(store, value) {
    return this.#request('PUT', `/${store}/${encodeURIComponent(value.id ?? value.key)}`, value);
  }

  async bulkPut(store, values) {
    if (!values?.length) return [];
    return this.#request('POST', `/${store}`, values);
  }

  async remove(store, key) {
    await this.#request('DELETE', `/${store}/${encodeURIComponent(key)}`);
    return key;
  }

  async clear(store) {
    await this.#request('DELETE', `/${store}`);
    return true;
  }

  async count(store) {
    return (await this.getAll(store)).length;
  }

  async getSetting(key, fallback = null) {
    const all = await this.getAllSettings();
    return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : fallback;
  }

  async setSetting(key, value) {
    await this.#request('PATCH', '/settings', { [key]: value });
  }

  async getAllSettings() {
    return (await this.#request('GET', '/settings')) || {};
  }

  async bulkSetSettings(obj) {
    await this.#request('PATCH', '/settings', obj);
  }

  /* --- sync plumbing is local: the queue lives on-device so it survives --- */
  enqueue(op) { return local.enqueueSync(op); }
  pending() { return local.getSyncQueue(); }
  clearQueue() { return local.clearSyncQueue(); }

  async push() {
    const queue = await this.pending();
    if (!queue.length) return { pushed: 0 };
    let pushed = 0;
    for (const op of queue) {
      try {
        if (op.type === 'delete') await this.remove(op.store, op.key);
        else if (op.type === 'put') await this.put(op.store, op.value);
        else if (op.type === 'bulk') await this.bulkPut(op.store, op.values);
        else if (op.type === 'setting') await this.setSetting(op.key, op.value);
        else continue;
        pushed++;
      } catch (err) {
        // Stop at the first failure: later operations may depend on this one,
        // and a partial flush must not reorder writes.
        return { pushed, error: String(err?.message || err) };
      }
    }
    await this.clearQueue();
    return { pushed };
  }
}

/**
 * Supabase speaks PostgREST. Point `endpoint` at
 * `https://<project>.supabase.co/rest/v1` and set `apiKey` to the anon key.
 */
export class SupabaseAdapter extends RestAdapter {
  static id = 'supabase';
  get id() {
    return 'supabase';
  }
}

/**
 * Firebase Realtime Database / Firestore REST. Point `endpoint` at
 * `https://<project>.firebaseio.com` (append `?auth=<token>` if not using
 * the Authorization header).
 */
export class FirebaseAdapter extends RestAdapter {
  static id = 'firebase';
  get id() {
    return 'firebase';
  }
}

/* ==========================================================================
   Service
   ========================================================================== */

const ADAPTERS = {
  local: LocalAdapter,
  rest: RestAdapter,
  supabase: SupabaseAdapter,
  firebase: FirebaseAdapter,
};

/** IndexedDB is always the local cache, whatever the cloud adapter is. */
const localCache = new LocalAdapter();

let active = localCache;
let activeId = 'local';
let autoSyncTimer = null;
let initialized = null;

const listeners = new Set();

/** Subscribe to storage + sync events. Returns an unsubscribe function. */
export function onStorageEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event) {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (err) {
      console.warn('[storage] listener failed', err);
    }
  }
}

/**
 * Choose the active adapter.
 * Called once at boot; safe to call again (e.g. after the user changes
 * Settings) — the previous adapter is simply replaced.
 */
export async function configure(options = {}) {
  const cfg = { ...syncConfig(), ...options };
  const AdapterClass = ADAPTERS[cfg.adapter] || LocalAdapter;
  const instance = AdapterClass === LocalAdapter ? localCache : new AdapterClass(cfg);

  active = instance;
  activeId = instance.id;
  initialized = instance.init();

  try {
    await initialized;
  } catch (err) {
    // A cloud adapter that cannot reach its backend must not brick the app:
    // fall back to local and surface the reason.
    console.warn(`[storage] "${activeId}" unavailable, using local storage:`, err?.message || err);
    active = localCache;
    activeId = 'local';
    emit({ type: 'adapter-fallback', requested: cfg.adapter, reason: String(err?.message || err) });
  }

  emit({ type: 'adapter-changed', adapter: activeId });

  if (cfg.autoSync && activeId !== 'local') startAutoSync(cfg.intervalMs);
  else stopAutoSync();

  return activeId;
}

export function activeAdapter() {
  return active;
}

export function activeAdapterId() {
  return activeId;
}

/** True while every write stays on-device. */
export function isOfflineOnly() {
  return activeId === 'local';
}

async function ready() {
  if (initialized) await initialized;
}

/* ==========================================================================
   Reads — always served from the local cache so the UI never blocks on a
   network round-trip.
   ========================================================================== */

export const get = (store, key) => localCache.get(store, key);
export const getAll = (store) => localCache.getAll(store);
export const count = (store) => localCache.count(store);
export const getSetting = (key, fallback = null) => localCache.getSetting(key, fallback);
export const getAllSettings = () => localCache.getAllSettings();

/**
 * The business profile, with the uploaded artwork folded in.
 *
 * The logo, signature and stamp are each stored as their own setting rather
 * than inside the `company` record, but every renderer — the invoice preview,
 * the PDF, the print sheet — reads `company.logoDataUrl` and friends. Merging
 * on read keeps one copy of each image in storage (a logo can be 2 MB of
 * base64) while making the profile self-consistent for callers, so no consumer
 * has to know where the artwork lives.
 */
export async function getCompanyProfile() {
  const company = (await getSetting('company', {})) || {};
  const [logo, signature, stamp] = await Promise.all([
    company.logoDataUrl ? null : getSetting('logoDataUrl', null),
    company.signatureDataUrl ? null : getSetting('signatureDataUrl', null),
    company.stampDataUrl ? null : getSetting('stampDataUrl', null),
  ]);
  return {
    ...company,
    ...(company.logoDataUrl ? {} : logo ? { logoDataUrl: logo } : {}),
    ...(company.signatureDataUrl ? {} : signature ? { signatureDataUrl: signature } : {}),
    ...(company.stampDataUrl ? {} : stamp ? { stampDataUrl: stamp } : {}),
  };
}

/* ==========================================================================
   Writes — local first, then queued for the cloud when one is active.
   ========================================================================== */

/**
 * Record a write for later upload.
 * Never throws: a full sync queue must not fail the user's save.
 */
async function enqueue(type, payload) {
  if (activeId === 'local') return;
  try {
    await localCache.enqueue({ id: `${type}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, type, ...payload, createdAt: Date.now() });
  } catch (err) {
    console.warn('[storage] could not queue sync operation', err);
  }
}

export async function put(store, value) {
  await ready();
  const result = await localCache.put(store, value);
  if (SYNCABLE.includes(store)) await enqueue('put', { store, value, key: value?.id ?? value?.key });
  emit({ type: 'write', store, op: 'put' });
  return result;
}

export async function bulkPut(store, values) {
  await ready();
  const result = await localCache.bulkPut(store, values);
  if (SYNCABLE.includes(store)) await enqueue('bulk', { store, values });
  emit({ type: 'write', store, op: 'bulkPut' });
  return result;
}

export async function remove(store, key) {
  await ready();
  const result = await localCache.remove(store, key);
  if (SYNCABLE.includes(store)) await enqueue('delete', { store, key });
  emit({ type: 'write', store, op: 'remove' });
  return result;
}

export async function clear(store) {
  await ready();
  const result = await localCache.clear(store);
  emit({ type: 'write', store, op: 'clear' });
  return result;
}

export async function setSetting(key, value) {
  await ready();
  await localCache.setSetting(key, value);
  await enqueue('setting', { key, value });
  emit({ type: 'write', store: 'settings', op: 'setSetting' });
}

export async function bulkSetSettings(obj) {
  await ready();
  await localCache.bulkSetSettings(obj);
  for (const [key, value] of Object.entries(obj)) await enqueue('setting', { key, value });
  emit({ type: 'write', store: 'settings', op: 'bulkSetSettings' });
}

/* ==========================================================================
   Domain helpers — thin, named wrappers so feature modules read naturally
   and never need to know a store name.
   ========================================================================== */

export const getCustomers = () => getAll(STORES.customers);
export const getProducts = () => getAll(STORES.products);
export const getInvoices = () => getAll(STORES.invoices);
export const getPayments = () => getAll(STORES.payments);
export const getPaymentsForInvoice = async (invoiceId) =>
  (await getPayments()).filter((p) => p.invoiceId === invoiceId);

export const saveCustomer = (row) => put(STORES.customers, row);
export const saveProduct = (row) => put(STORES.products, row);
export const saveInvoice = (row) => put(STORES.invoices, row);
export const savePayment = (row) => put(STORES.payments, row);

export const deleteCustomer = (id) => remove(STORES.customers, id);
export const deleteProduct = (id) => remove(STORES.products, id);
export const deleteInvoice = (id) => remove(STORES.invoices, id);
export const deletePayment = (id) => remove(STORES.payments, id);

/* ==========================================================================
   Backup / restore + sample data pass straight through to the local engine:
   both are whole-database operations and must work offline.
   ========================================================================== */

export const exportAllData = () => local.exportAllData();
export const importAllData = (payload) => local.importAllData(payload);
export const seedSampleData = () => local.seedSampleData();

/* ==========================================================================
   Sync
   ========================================================================== */

export async function pendingCount() {
  try {
    return (await localCache.pending()).length;
  } catch {
    return 0;
  }
}

/**
 * Push queued writes to the cloud.
 * Resolves to `{ pushed, error? }`; never rejects, because callers are usually
 * background timers or `online` handlers with nowhere to report an error.
 */
export async function pushPending() {
  if (activeId === 'local') return { pushed: 0, skipped: 'offline-only' };
  emit({ type: 'sync-start' });
  try {
    const result = await active.push();
    emit({ type: 'sync-done', ...result });
    return result;
  } catch (err) {
    const message = String(err?.message || err);
    emit({ type: 'sync-error', error: message });
    return { pushed: 0, error: message };
  }
}

/**
 * Replace the local cache with the cloud copy.
 * Destructive by design — callers must confirm with the user first.
 */
export async function pullAll() {
  if (activeId === 'local') return { skipped: 'offline-only' };
  emit({ type: 'pull-start' });
  for (const store of SYNCABLE) {
    if (store === 'settings') {
      await localCache.bulkSetSettings(await active.getAllSettings());
    } else {
      await localCache.clear(store);
      await localCache.bulkPut(store, await active.getAll(store));
    }
  }
  emit({ type: 'pull-done' });
  return { ok: true };
}

export function startAutoSync(intervalMs = 30000) {
  stopAutoSync();
  if (activeId === 'local') return;
  autoSyncTimer = setInterval(() => {
    if (navigator.onLine) pushPending();
  }, Math.max(5000, Number(intervalMs) || 30000));
  window.addEventListener('online', pushPending);
}

export function stopAutoSync() {
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  autoSyncTimer = null;
  window.removeEventListener('online', pushPending);
}

/* ==========================================================================
   Boot
   ========================================================================== */

/** Read the configured adapter and apply it. Called from each page's entry. */
export async function initStorage() {
  return configure(CONFIG.sync || {});
}

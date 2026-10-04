export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PAGES = ['dashboard', 'invoice', 'customers', 'products', 'reports', 'settings'];
export const ERROR_CODES = ['APP_ERROR', 'STORAGE_ERROR', 'PDF_ERROR', 'NETWORK_ERROR'];
export const HEARTBEAT_MS = 15 * 60 * 1000;

// Strict allowlist: invoice/customer details, tokens, URLs and raw exceptions
// must never accidentally become part of a monitoring request.
export function statusPayload(value = {}) {
  return {
    app_version: String(value.app_version || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 32) || 'unknown',
    page: PAGES.includes(value.page) ? value.page : 'dashboard',
    pending_count: Math.min(10000, Math.max(0, Math.trunc(Number(value.pending_count) || 0))),
    sync_state: 'local_only',
    error_codes: [...new Set((Array.isArray(value.error_codes) ? value.error_codes : []).filter(code => ERROR_CODES.includes(code)))],
  };
}

export function validBinding(value) {
  return !!value && UUID.test(value.businessId) && UUID.test(value.userId) && UUID.test(value.deviceId) && value.consent === true;
}

export function retryDelay(attempt = 0, random = Math.random) {
  return Math.min(HEARTBEAT_MS, 15000 * 2 ** Math.min(6, Math.max(0, attempt))) * (0.8 + random() * 0.2);
}

export function contactLabel(timestamp, now = Date.now()) {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return 'Never contacted';
  const age = Math.max(0, now - time);
  if (age < 20 * 60 * 1000) return 'Contacted recently';
  if (age < 24 * 60 * 60 * 1000) return 'No recent contact';
  return 'Inactive or offline';
}

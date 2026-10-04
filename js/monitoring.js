import { CONFIG, workspaceId } from './config.js';
import { CLOUD } from './cloud.config.js';
import { getCloudClient } from './cloudClient.js';
import { pendingCount } from './storageService.js';
import { statusPayload, validBinding, HEARTBEAT_MS, retryDelay, UUID } from './monitoringModel.js';
import { readMonitorState, writeMonitorState, deleteMonitorState, acknowledgeStatus } from './monitoringStore.js';

let running = false;
let timer;
let retries = 0;
let inFlight;
const errors = new Set();
const workspaceKey = () => (CONFIG.storagePrefix || 'app_') + 'workspace';
const bindingKey = () => `binding:${workspaceId()}`;
const queueKey = user => `status:${workspaceId()}:${user}`;
const notify = () => window.dispatchEvent(new CustomEvent('monitoringchange'));

export async function monitoringAccount() {
  const client = await getCloudClient();
  if (!client) return {client: null, user: null, businesses: [], binding: null};
  const {data, error} = await client.auth.getSession();
  if (error) return {client, user: null, businesses: [], binding: null};
  const user = data.session?.user || null;
  const binding = await readMonitorState(bindingKey());
  let businesses = [];
  if (user && navigator.onLine) {
    await client.rpc('claim_client_invitation');
    const result = await client.from('business_memberships').select('business_id,role,businesses(id,name,status)').order('business_id');
    if (!result.error) businesses = result.data || [];
  }
  return {client, user, businesses, binding: validBinding(binding) && binding.userId === user?.id ? binding : null};
}

export function changeWorkspace(id = '') {
  if (id && !UUID.test(id)) throw new Error('Invalid business workspace');
  stopMonitoring();
  if (id) localStorage.setItem(workspaceKey(), id);
  else localStorage.removeItem(workspaceKey());
  location.reload();
}

export async function connectMonitoring(businessId, consent) {
  if (!consent) throw new Error('Choose whether to share operational status before connecting.');
  const {client, user, businesses} = await monitoringAccount();
  if (!client || !user || !businesses.some(row => row.business_id === businessId && row.businesses?.status === 'active')) {
    throw new Error('An active business invitation is required. Reconnect and try again.');
  }
  const key = `binding:${businessId}`;
  const previous = await readMonitorState(key);
  const binding = {
    businessId, userId: user.id, deviceId: validBinding(previous) && previous.userId === user.id ? previous.deviceId : crypto.randomUUID(),
    consent: true, consentVersion: 1,
  };
  await writeMonitorState(key, binding);
  if (workspaceId() !== businessId) changeWorkspace(businessId);
  else { await startMonitoring(); notify(); }
}

export async function disconnectMonitoring({signOut = false} = {}) {
  stopMonitoring();
  const binding = await readMonitorState(bindingKey());
  await deleteMonitorState(bindingKey());
  if (binding?.userId) await deleteMonitorState(queueKey(binding.userId));
  if (binding?.userId) await deleteMonitorState(`feedback:${workspaceId()}:${binding.userId}`);
  if (signOut) {
    const client = await getCloudClient();
    // Local sign-out clears this browser's tokens even if the backend is offline.
    await client?.auth.signOut({scope: 'local'});
    changeWorkspace();
  }
  notify();
}

export async function monitoringStatus() {
  const binding = await readMonitorState(bindingKey());
  const lastContact = await readMonitorState(`contact:${workspaceId()}`);
  return {connected: validBinding(binding), lastContact, pending: binding?.userId ? !!await readMonitorState(queueKey(binding.userId)) : false};
}

export async function sendFeedback(message) {
  const {client, user, binding} = await monitoringAccount();
  if (!client || !user || !binding) throw new Error('Connect your business account first.');
  const clean = String(message || '').trim();
  if (!clean || clean.length > 2000) throw new Error('Enter between 1 and 2,000 characters.');
  const operation = await readMonitorState(`feedback:${workspaceId()}:${user.id}`);
  const next = operation?.message === clean ? operation : {id: crypto.randomUUID(), message: clean};
  await writeMonitorState(`feedback:${workspaceId()}:${user.id}`, next);
  const {error} = await client.rpc('submit_client_feedback', {target: binding.businessId, operation: next.id, message: clean});
  if (error) throw new Error('Feedback was not confirmed. Reconnect and retry to send it safely.');
  await deleteMonitorState(`feedback:${workspaceId()}:${user.id}`);
}

async function cycle(force = false) {
  if (!running || inFlight || document.visibilityState === 'hidden') return;
  inFlight = (async () => {
    const {client, user, binding} = await monitoringAccount();
    if (!running || !client || !user || !binding || binding.businessId !== workspaceId()) return;
    const key = queueKey(user.id);
    let queued = await readMonitorState(key);
    const contact = await readMonitorState(`contact:${workspaceId()}`);
    if (!queued && !force && Date.now() - Date.parse(contact || '') < HEARTBEAT_MS) return;
    if (!queued) {
      queued = {operationId: crypto.randomUUID(), payload: statusPayload({
        app_version: CLOUD.appVersion, page: document.body.dataset.page,
        pending_count: await pendingCount(), error_codes: [...errors],
      })};
      await writeMonitorState(key, queued);
    }
    if (!navigator.onLine || !running) return;
    const {data, error} = await client.rpc('record_client_status', {
      target: binding.businessId, device: binding.deviceId, operation: queued.operationId,
      payload: statusPayload(queued.payload),
    });
    if (error || !data) throw new Error('Operational status is waiting for connection.');
    if (!running) return;
    await acknowledgeStatus(key, queued.operationId);
    await writeMonitorState(`contact:${workspaceId()}`, data);
    errors.clear(); retries = 0; notify();
  })();
  try { await inFlight; } catch { retries++; notify(); } finally {
    inFlight = null;
    if (running) { clearTimeout(timer); timer = setTimeout(cycle, retries ? retryDelay(retries - 1) : HEARTBEAT_MS); }
  }
}
export const retryMonitoring = () => cycle(true);
const foreground = () => { if (document.visibilityState === 'visible') cycle(); };
const errorEvent = () => { errors.add('APP_ERROR'); };

export function stopMonitoring() {
  running = false;
  clearTimeout(timer);
  window.removeEventListener('online', foreground);
  window.removeEventListener('error', errorEvent);
  window.removeEventListener('unhandledrejection', errorEvent);
  document.removeEventListener('visibilitychange', foreground);
}
export async function startMonitoring() {
  stopMonitoring();
  const binding = await readMonitorState(bindingKey());
  if (!validBinding(binding) || !workspaceId()) return;
  running = true;
  window.addEventListener('online', foreground);
  window.addEventListener('error', errorEvent);
  window.addEventListener('unhandledrejection', errorEvent);
  document.addEventListener('visibilitychange', foreground);
  // Monitoring must never block invoice boot or saving.
  cycle();
}

window.addEventListener('storage', event => {
  if (event.key === workspaceKey()) { stopMonitoring(); location.reload(); }
});

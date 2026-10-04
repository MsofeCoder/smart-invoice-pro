import { cloudConfigured, signInWithGoogle } from './cloudClient.js';
import { monitoringAccount, connectMonitoring, disconnectMonitoring, monitoringStatus, retryMonitoring, sendFeedback } from './monitoring.js';
import { workspaceId } from './config.js';
import { escapeHTML, toast, downloadBlob } from './utils.js';
import { exportAllData } from './storageService.js';

export function initAccountUI() {
  if (!cloudConfigured()) return;
  const grid = document.querySelector('main.content > .grid');
  if (!grid) return;
  const card = document.createElement('section');
  card.className = 'col-span-12 card no-print';
  card.id = 'accountMonitoring';
  card.setAttribute('aria-labelledby', 'accountHeading');
  card.innerHTML = `<div class="card-header"><h3 id="accountHeading">Account &amp; connection</h3></div>
    <div class="card-body"><p id="accountStatus" role="status" aria-live="polite">Checking your account…</p>
    <div id="accountControls" class="mt-3"></div><p id="accountError" class="text-danger mt-2" role="alert"></p></div>`;
  grid.prepend(card);
  let refreshing = false;
  const error = message => { card.querySelector('#accountError').textContent = message; };
  const act = async (button, action) => {
    button.disabled = true; error('');
    try { await action(); } catch (err) { error(err.message || 'Please reconnect and try again.'); }
    finally { button.disabled = false; }
  };
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const account = await monitoringAccount();
      const status = await monitoringStatus();
      card.querySelector('#accountStatus').textContent = account.user
        ? `Signed in as ${account.user.email || 'your Google account'}. ${status.connected ? 'Operational status sharing is enabled.' : 'Operational status sharing is off.'}`
        : 'Your invoices remain on this device. Sign in to connect an invited business account.';
      const controls = card.querySelector('#accountControls');
      if (!account.user) {
        controls.innerHTML = '<button type="button" class="btn btn-primary" id="accountSignIn">Continue with Google</button>';
        controls.querySelector('#accountSignIn').onclick = event => act(event.currentTarget, () => signInWithGoogle());
        return;
      }
      const businessOptions = account.businesses.filter(row => row.businesses?.status === 'active').map(row =>
        `<option value="${escapeHTML(row.business_id)}" ${row.business_id === workspaceId() ? 'selected' : ''}>${escapeHTML(row.businesses.name)}</option>`).join('');
      controls.innerHTML = `<div class="grid grid-cols-2 gap-4">
        <div class="field"><label for="accountBusiness">Business workspace</label>
          <select id="accountBusiness" class="select" ${businessOptions ? '' : 'disabled'}>${businessOptions || '<option>Reconnect or request a business invitation</option>'}</select>
          <p class="hint">Each business has separate records on this device. Opening a new workspace starts empty; your original local records are preserved. Export and import a backup to transfer them.</p>
        </div>
        <div class="field"><label for="monitoringConsent"><input id="monitoringConsent" type="checkbox"> Share app version, page, pending operation count and general error codes with support.</label>
          <p class="hint">Invoice contents, customer details and raw errors are not shared. Updates are sent while the app is open and connected. You can stop sharing at any time.</p>
        </div>
      </div>
      <div class="flex gap-2 flex-wrap mt-3">
        <button type="button" class="btn btn-outline" id="accountExport">Export this workspace</button>
        <button type="button" class="btn btn-primary" id="accountConnect" ${businessOptions ? '' : 'disabled'}>Connect business workspace</button>
        <button type="button" class="btn btn-outline" id="accountRetry" ${status.connected ? '' : 'disabled'}>Retry connection</button>
        <button type="button" class="btn btn-outline" id="accountStop" ${status.connected ? '' : 'disabled'}>Stop sharing status</button>
        <button type="button" class="btn btn-outline" id="accountSignOut">Sign out</button>
      </div>
      <p id="accountContact" class="hint mt-3">Last confirmed server contact: ${status.lastContact ? escapeHTML(new Date(status.lastContact).toLocaleString()) : 'None'}. ${status.pending ? 'An update is waiting to send.' : 'No status update is pending.'} Business records are local; cloud backup is not enabled.</p>
      <div class="field mt-3"><label for="accountFeedback">Message to support (optional)</label>
        <textarea class="input" id="accountFeedback" rows="3" maxlength="2000" placeholder="Describe the issue without customer or payment details."></textarea>
        <p class="hint">Only the message you enter here will be sent when you choose Send.</p>
        <button type="button" class="btn btn-outline mt-2" id="accountSendFeedback" ${status.connected ? '' : 'disabled'}>Send message to support</button>
      </div>`;
      const bind = (id, fn) => controls.querySelector(id).onclick = event => act(event.currentTarget, fn);
      bind('#accountConnect', async () => { await connectMonitoring(controls.querySelector('#accountBusiness').value, controls.querySelector('#monitoringConsent').checked); await refresh(); });
      bind('#accountExport', async () => downloadBlob(new Blob([JSON.stringify(await exportAllData(), null, 2)], {type: 'application/json'}), `invoice-workspace-backup-${new Date().toISOString().slice(0,10)}.json`));
      bind('#accountRetry', async () => { await retryMonitoring(); await refresh(); });
      bind('#accountStop', async () => { await disconnectMonitoring(); await refresh(); });
      bind('#accountSignOut', () => disconnectMonitoring({signOut: true}));
      bind('#accountSendFeedback', async () => {
        await sendFeedback(controls.querySelector('#accountFeedback').value);
        controls.querySelector('#accountFeedback').value = ''; toast('Your message was sent to support.', 'success');
      });
    } catch { error('Account status is unavailable. Your local invoices still work.'); }
    finally { refreshing = false; }
  }
  refresh();
  // Preserve typed feedback and consent controls during background heartbeats.
  window.addEventListener('monitoringchange', async () => {
    const status = await monitoringStatus();
    const contact = card.querySelector('#accountContact');
    if (contact) contact.textContent = `Last confirmed server contact: ${status.lastContact ? new Date(status.lastContact).toLocaleString() : 'None'}. ${status.pending ? 'An update is waiting to send.' : 'No status update is pending.'} Business records are local; cloud backup is not enabled.`;
    if (!status.connected) refresh();
  });
}

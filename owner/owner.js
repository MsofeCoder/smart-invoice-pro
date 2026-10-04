import { getCloudClient, signInWithGoogle } from '../js/cloudClient.js';
import { contactLabel } from '../js/monitoringModel.js';
import { escapeHTML } from '../js/utils.js';

const $ = selector => document.querySelector(selector);
let client;
let factor;
let refreshTimer;
let refreshing = false;
let enrollment;
let accessGeneration = 0;
const fail = message => { $('#ownerError').textContent = message; };
async function action(button, operation) {
  button.disabled = true; fail('');
  try { await operation(); } catch (err) { fail(err.message || 'Request failed. Reconnect and try again.'); }
  finally { button.disabled = false; }
}
function clearClientData() {
  accessGeneration++;
  clearTimeout(refreshTimer);
  $('#ownerContent').classList.add('hidden');
  $('#ownerGate').classList.remove('hidden');
  for (const id of ['#ownerClients','#ownerMetrics','#ownerFeedback']) $(id).replaceChildren();
}

async function refresh() {
  if (refreshing || document.visibilityState === 'hidden') return;
  refreshing = true;
  const generation = accessGeneration;
  try {
    const access = await client.rpc('is_owner_admin');
    if (access.error || access.data !== true) { clearClientData(); throw new Error('An authorized owner account and verified authenticator code are required.'); }
    const results = await Promise.all([
      client.from('businesses').select('id,name,status,created_at').order('created_at',{ascending:false}).limit(100),
      client.from('business_licenses').select('business_id,plan_id,expires_at').limit(100),
      client.from('client_devices').select('business_id,app_version,pending_count,error_codes,last_contact_at').order('last_contact_at',{ascending:false}).limit(1000),
      client.from('client_feedback').select('business_id,message,created_at').order('created_at',{ascending:false}).limit(50),
    ]);
    if (results.some(result => result.error)) { clearClientData(); throw new Error('Client information could not be refreshed. Please reconnect.'); }
    const [businesses, licenses, devices, feedback] = results.map(result => result.data || []);
    if (generation !== accessGeneration) return;
    const recent = devices.filter(device => contactLabel(device.last_contact_at) === 'Contacted recently');
    $('#ownerMetrics').innerHTML = [['Businesses',businesses.length],['Recently contacted devices',recent.length],['Messages shown',feedback.length]].map(([name,count]) =>
      `<div class="card owner-metric"><strong>${count}</strong><span>${escapeHTML(name)}</span></div>`).join('');
    $('#ownerClients').innerHTML = businesses.map(business => {
      const license = licenses.find(row => row.business_id === business.id);
      const device = devices.find(row => row.business_id === business.id);
      const state = device ? `${contactLabel(device.last_contact_at)} · ${device.pending_count} queued · ${device.error_codes.length} error codes` : 'Awaiting first connection';
      return `<tr><td><strong>${escapeHTML(business.name)}</strong><br><span class="text-muted">${escapeHTML(business.status)}</span></td>
        <td>${escapeHTML(license?.plan_id || 'Unassigned')}${license?.expires_at ? '<br>' + escapeHTML(new Date(license.expires_at).toLocaleDateString()) : ''}</td>
        <td>${escapeHTML(device?.app_version || '—')}</td><td>${device ? escapeHTML(new Date(device.last_contact_at).toLocaleString()) : 'Never'}</td><td>${escapeHTML(state)}</td></tr>`;
    }).join('') || '<tr><td colspan="5">No client businesses yet. Create your first invitation below.</td></tr>';
    $('#ownerFeedback').innerHTML = feedback.map(message => `<article class="mb-4"><strong>${escapeHTML(businesses.find(row => row.id === message.business_id)?.name || 'Client business')}</strong>
      <p>${escapeHTML(message.message)}</p><span class="hint">${escapeHTML(new Date(message.created_at).toLocaleString())}</span></article>`).join('') || '<p class="text-muted">No client messages yet.</p>';
    $('#ownerGate').classList.add('hidden'); $('#ownerContent').classList.remove('hidden');
    $('#ownerStatus').textContent = `Verified owner access · Updated ${new Date().toLocaleTimeString()}`;
    fail('');
  } finally {
    refreshing = false; clearTimeout(refreshTimer);
    if (generation === accessGeneration && !$('#ownerContent').classList.contains('hidden')) refreshTimer = setTimeout(() => refresh().catch(err => fail(err.message)),60000);
  }
}

async function boot() {
  client = await getCloudClient();
  if (!client) { $('#ownerStatus').textContent = 'Online accounts have not been connected yet.'; $('#ownerGoogle').disabled = true; return; }
  client.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_OUT') { clearClientData(); $('#ownerStatus').textContent = 'You are signed out.'; }
  });
  const {data} = await client.auth.getSession();
  if (!data.session) { clearClientData(); $('#ownerStatus').textContent = 'Sign in to access your owner dashboard.'; return; }
  $('#ownerSignOut').classList.remove('hidden'); $('#ownerGoogle').classList.add('hidden');
  const assurance = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assurance.error) throw new Error('Account verification is unavailable. Please reconnect.');
  if (assurance.data.currentLevel === 'aal2') { await refresh(); return; }
  $('#ownerStatus').textContent = 'Verify your authenticator to continue.';
  $('#ownerMfa').classList.remove('hidden');
  const factors = await client.auth.mfa.listFactors();
  if (factors.error) throw new Error('Authenticator details are unavailable.');
  factor = factors.data.totp.find(item => item.status === 'verified')?.id;
  $('#ownerEnrollMfa').classList.toggle('hidden', !!factor);
}

$('#ownerGoogle').onclick = event => action(event.currentTarget, () => signInWithGoogle('index.html'));
$('#ownerSignOut').onclick = event => action(event.currentTarget, async () => { clearClientData(); await client.auth.signOut({scope:'local'}); location.reload(); });
$('#ownerRefresh').onclick = event => action(event.currentTarget, refresh);
$('#ownerEnrollMfa').onclick = event => action(event.currentTarget, async () => {
  const factors = await client.auth.mfa.listFactors();
  if (factors.error) throw new Error('Authenticator details are unavailable. Please reconnect.');
  for (const item of factors.data.totp.filter(item => item.status !== 'verified')) {
    const result = await client.auth.mfa.unenroll({factorId:item.id});
    if (result.error) throw new Error('Previous authenticator setup could not be cleared. Try again.');
  }
  const {data,error} = await client.auth.mfa.enroll({factorType:'totp',friendlyName:'Owner dashboard'});
  if (error) throw new Error('Authenticator setup failed. Try again.');
  factor = data.id; $('#ownerMfaQr').src = data.totp.qr_code; $('#ownerMfaQr').classList.remove('hidden');
  $('#ownerMfaSecret').textContent = `Manual setup key: ${data.totp.secret}`;
  $('#ownerEnrollMfa').classList.add('hidden');
});
$('#ownerMfaForm').onsubmit = event => {
  event.preventDefault();
  action(event.submitter, async () => {
    if (!factor) throw new Error('Set up your authenticator first.');
    const {error} = await client.auth.mfa.challengeAndVerify({factorId:factor,code:$('#ownerCode').value});
    if (error) throw new Error('Code was not accepted. Try the next authenticator code.');
    $('#ownerCode').value = ''; $('#ownerMfaSecret').textContent = ''; $('#ownerMfaQr').removeAttribute('src');
    await refresh();
  });
};
$('#ownerEnroll').onsubmit = event => {
  event.preventDefault();
  action(event.submitter, async () => {
    const business_name = $('#ownerBusinessName').value.trim();
    const invite_email = $('#ownerClientEmail').value.trim().toLowerCase();
    if (!enrollment || enrollment.business_name !== business_name || enrollment.invite_email !== invite_email) {
      enrollment = {business_name,invite_email,operation:crypto.randomUUID()};
    }
    const {error} = await client.rpc('enroll_client_business', enrollment);
    if (error) throw new Error('Invitation could not be created. Verify owner access and client details.');
    enrollment = null; event.target.reset(); await refresh();
  });
};
document.addEventListener('visibilitychange', () => { if (client && !$('#ownerContent').classList.contains('hidden')) refresh().catch(err => fail(err.message)); });
boot().catch(err => { clearClientData(); fail(err.message); });

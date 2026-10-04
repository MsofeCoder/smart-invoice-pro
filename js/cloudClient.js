import { CLOUD } from './cloud.config.js';

let pending;
export function cloudConfigured() {
  if (!CLOUD.enabled || typeof CLOUD.publishableKey !== 'string' || !CLOUD.publishableKey.startsWith('sb_publishable_')) return false;
  try {
    const url = new URL(CLOUD.url);
    const local = ['127.0.0.1', 'localhost'].includes(url.hostname) &&
      ['127.0.0.1', 'localhost'].includes(globalThis.location?.hostname);
    return (url.protocol === 'https:' && /^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)) ||
      (local && url.protocol === 'http:');
  } catch { return false; }
}

export async function getCloudClient() {
  if (!cloudConfigured()) return null;
  pending ||= import('../libs/supabase.js').then(({createClient}) => createClient(CLOUD.url, CLOUD.publishableKey, {
    auth: {
      flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true,
      storageKey: `smart-invoice-auth-${new URL(CLOUD.url).host}`,
    },
    global: { fetch: (input, init) => fetch(input, {...init, signal: init?.signal || AbortSignal.timeout(15000)}) },
  }));
  return pending;
}

export async function signInWithGoogle(callback = 'settings.html') {
  const client = await getCloudClient();
  if (!client) throw new Error('Online accounts are not configured yet.');
  const redirectTo = new URL(callback, location.href).href;
  const {error} = await client.auth.signInWithOAuth({provider: 'google', options: {redirectTo, scopes: 'openid email profile'}});
  if (error) throw new Error('Google sign-in could not start. Please try again.');
}

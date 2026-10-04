import fs from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
import {CONFIG,connect,createReporter,sleep} from './lib/cdp.js';
if (!process.env.E2E_ISOLATED_PROFILE) throw new Error('Use an isolated browser profile');
const metadataPath = process.env.MONITORING_TEST_METADATA || '.ci-monitoring-backend.log';
const text = fs.readFileSync(metadataPath,'utf8');
let metadata;
try { metadata = JSON.parse(text.trim()); }
catch { metadata = JSON.parse(text.split(/\r?\n/).find(line => line.startsWith('{') && line.includes('API_URL')) || '{}'); }
metadata = metadata.env || metadata;
const api = metadata.API_URL;
const key = metadata.PUBLISHABLE_KEY || metadata.ANON_KEY;
if (!api || !key || !['localhost','127.0.0.1'].includes(new URL(api).hostname)) throw new Error('Use only a disposable local Supabase backend');
const dbUrl = metadata.DB_URL || 'postgresql://postgres:postgres@127.0.0.1:55432/postgres';
if (!['localhost','127.0.0.1'].includes(new URL(dbUrl).hostname)) throw new Error('Hosted databases are forbidden in this fixture test');
const db = new pg.Client({connectionString:dbUrl,connectionTimeoutMillis:10000,query_timeout:10000});
const c = await connect();
const r = createReporter('Online monitoring');
const business = crypto.randomUUID();
const emails = [`monitor-client-${Date.now()}@example.test`,`monitor-owner-${Date.now()}@example.test`];
const users = [];
const password = crypto.randomBytes(24).toString('base64url');
const posts = [];
const config = `export const CLOUD=Object.freeze(${JSON.stringify({enabled:true,url:api,publishableKey:key,appVersion:'2.1.0-test'})});`;
const wait = async (expression, tries=60) => {for(let i=0;i<tries;i++){if(await c.evaluate(expression))return true;await sleep(200);}return false;};
function totp(secret) {
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits=[...secret.toUpperCase().replace(/=+$/,'')].map(char=>alphabet.indexOf(char).toString(2).padStart(5,'0')).join('');
  const bytes=Buffer.from((bits.match(/.{8}/g)||[]).map(byte=>parseInt(byte,2)));
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
  const hash=crypto.createHmac('sha1',bytes).update(counter).digest();const offset=hash[19]&15;
  return String((hash.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
}
try {
  await db.connect();
  await c.send('Storage.clearDataForOrigin',{origin:CONFIG.origin,storageTypes:'all'});
  await c.send('Network.setBypassServiceWorker',{bypass:true});
  c.on('Fetch.requestPaused', event => {
    c.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/javascript'}],body:Buffer.from(config).toString('base64')}).catch(error=>console.error(error.message));
  });
  c.on('Network.requestWillBeSent', event => {
    if (event.request.url.endsWith('/rpc/record_client_status') && event.request.postData) posts.push(JSON.parse(event.request.postData));
  });
  await c.send('Fetch.enable',{patterns:[{urlPattern:'*/js/cloud.config.js',requestStage:'Request'}]});
  await c.goto('settings.html',2000);
  r.check('configured account panel appears',await wait("!!document.querySelector('#accountSignIn')"));
  const user = await c.evaluate(`(async()=>{
    const client=await(await import('./js/cloudClient.js')).getCloudClient();
    const result=await client.auth.signUp({email:${JSON.stringify(emails[0])},password:${JSON.stringify(password)}});
    if(result.error)throw new Error(result.error.message);return result.data.user.id;
  })()`);
  users.push(user);
  await db.query('insert into public.businesses(id,name) values($1,$2)',[business,'Pilot <img src=x onerror=alert(1)>']);
  await db.query('insert into public.business_licenses(business_id) values($1)',[business]);
  await db.query('insert into public.client_invitations(business_id,email) values($1,$2)',[business,emails[0]]);
  await c.goto('settings.html',2000);
  r.check('verified account claims its invitation',await wait(`document.querySelector('#accountBusiness')?.value===${JSON.stringify(business)}`));
  r.check('business name is rendered as text, never HTML',await c.evaluate("!document.querySelector('#accountBusiness img') && document.querySelector('#accountBusiness').textContent.includes('<img')"));
  await c.evaluate("document.querySelector('#accountConnect').click()");
  r.check('explicit monitoring consent is required',await wait("document.querySelector('#accountError').textContent.includes('before connecting')"));
  await c.evaluate("document.querySelector('#monitoringConsent').checked=true;document.querySelector('#accountConnect').click()");
  r.check('connection opens the selected isolated workspace',await wait(`globalThis.AppConfig?.workspaceId()===${JSON.stringify(business)} && !!document.querySelector('#accountStop')`));
  r.check('first status receives server confirmation',await wait("(async()=>!!(await(await import('./js/monitoring.js')).monitoringStatus()).lastContact)()"));
  const device = (await db.query('select * from public.client_devices where business_id=$1',[business])).rows[0];
  r.eq('server derives authenticated device owner',device.user_id,user);
  r.eq('monitoring reports local-only business storage',device.sync_state,'local_only');
  r.check('real monitoring POST contains only allowed operational fields',posts.length>0 && posts.every(post => Object.keys(post.payload).sort().join(',')==='app_version,error_codes,page,pending_count,sync_state'));

  await c.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
  await c.evaluate("(async()=>await(await import('./js/monitoring.js')).retryMonitoring())()");
  r.check('offline update is retained durably',await c.evaluate("(async()=>(await(await import('./js/monitoring.js')).monitoringStatus()).pending)()"));
  await db.query("update public.client_devices set last_contact_at=now()-interval '1 minute' where business_id=$1",[business]);
  await c.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await c.evaluate("(async()=>await(await import('./js/monitoring.js')).retryMonitoring())()");
  r.check('reconnect acknowledges and clears the same queued update',await wait("(async()=>!(await(await import('./js/monitoring.js')).monitoringStatus()).pending)()"));
  await c.evaluate("(async()=>await(await import('./js/monitoring.js')).sendFeedback('<script>window.hacked=true</script>'))()");
  r.eq('explicit support feedback reaches backend once',(await db.query('select count(*)::int as count from public.client_feedback where business_id=$1',[business])).rows[0].count,1);
  await c.evaluate("document.querySelector('#accountStop').click()");
  r.check('withdrawal disables collection',await wait("(async()=>!(await(await import('./js/monitoring.js')).monitoringStatus()).connected)()"));
  await c.evaluate("document.querySelector('#accountSignOut').click()");
  r.check('sign-out exits the connected business workspace',await wait("globalThis.AppConfig?.workspaceId()===''"));

  const owner = await c.evaluate(`(async()=>{
    const client=await(await import('./js/cloudClient.js')).getCloudClient();
    const result=await client.auth.signUp({email:${JSON.stringify(emails[1])},password:${JSON.stringify(password)}});
    if(result.error)throw new Error(result.error.message);return result.data.user.id;
  })()`);
  users.push(owner);
  await db.query('insert into invoice_private.owner_admins(user_id) values($1)',[owner]);
  await c.goto('owner/index.html',1800);
  r.check('owner must enroll or verify MFA before viewing clients',await wait("!document.querySelector('#ownerMfa').classList.contains('hidden') && document.querySelector('#ownerContent').classList.contains('hidden')"));
  await c.evaluate("document.querySelector('#ownerEnrollMfa').click()");
  const enrolled = await wait("document.querySelector('#ownerMfaSecret').textContent.includes('Manual setup key:')");
  r.check('real authenticator enrollment returns setup details',enrolled,await c.evaluate("document.querySelector('#ownerError').textContent"));
  if(!enrolled) throw new Error(await c.evaluate("(async()=>{const sdk=await(await import('../js/cloudClient.js')).getCloudClient();const result=await sdk.auth.mfa.enroll({factorType:'totp',friendlyName:'Diagnostic'});return result.error?.message||'Unexpected setup response';})()"));
  await c.goto('owner/index.html',1800);
  await c.evaluate("document.querySelector('#ownerEnrollMfa').click()");
  r.check('interrupted authenticator setup can restart after reload',await wait("document.querySelector('#ownerMfaSecret').textContent.includes('Manual setup key:')"));
  r.eq('restart removes the obsolete unverified factor',await c.evaluate("(async()=>{const sdk=await(await import('../js/cloudClient.js')).getCloudClient();return (await sdk.auth.mfa.listFactors()).data.all.filter(item=>item.factor_type==='totp').length;})()"),1);
  const secret=await c.evaluate("document.querySelector('#ownerMfaSecret').textContent.replace('Manual setup key: ','')");
  await c.evaluate(`document.querySelector('#ownerCode').value=${JSON.stringify(totp(secret))};document.querySelector('#ownerMfaForm button').click()`);
  r.check('real TOTP verification grants owner dashboard access',await wait("!document.querySelector('#ownerContent').classList.contains('hidden')",100));
  r.check('owner sees the real monitored business',await c.evaluate("document.querySelector('#ownerClients').textContent.includes('Pilot <img')"));
  r.check('client business names cannot execute HTML in owner dashboard',await c.evaluate("!document.querySelector('#ownerClients img')"));
  r.check('client feedback cannot execute scripts in owner dashboard',await c.evaluate("!document.querySelector('#ownerFeedback script') && !window.hacked && document.querySelector('#ownerFeedback').textContent.includes('<script>')"));
  await c.shot('owner-monitoring-desktop.png');
  await c.send('Emulation.setDeviceMetricsOverride',{width:360,height:900,deviceScaleFactor:1,mobile:false});
  await sleep(300);
  r.check('authenticated owner dashboard fits a phone',await c.evaluate('document.documentElement.scrollWidth<=360'));
  await c.shot('owner-monitoring-phone.png');
  await c.evaluate("document.querySelector('#ownerSignOut').click()");
  r.check('owner sign-out removes client details from the screen',await wait("document.querySelector('#ownerContent').classList.contains('hidden') && document.querySelector('#ownerClients').textContent===''") );
  const ok=r.finish();c.close();process.exitCode=ok?0:1;
} catch(error) { console.error(error.message);r.finish();c.close();process.exitCode=1; }
finally {
  try {
    await db.query('delete from public.businesses where id=$1',[business]);
    if(users.length) await db.query('delete from auth.users where id=any($1::uuid[])',[users]);
  } finally {await db.end();}
}
process.exit(process.exitCode || 0);

import { CONFIG, connect, createReporter, sleep } from './lib/cdp.js';
if (!process.env.E2E_ISOLATED_PROFILE) throw new Error('Use the disposable browser test launcher');
const c = await connect();
const r = createReporter('Monitoring safety');
const a = '30000000-0000-4000-8000-000000000001';
const b = '30000000-0000-4000-8000-000000000002';
try {
  await c.send('Storage.clearDataForOrigin',{origin:CONFIG.origin,storageTypes:'all'});
  await c.goto('settings.html',2200);
  const privacy = await c.evaluate(`(async () => {
    const store = await import('./js/monitoringStore.js');
    await store.writeMonitorState('secret-test',{userId:'private-user',token:'must-not-export'});
    const db = await import('./js/db.js');
    await db.saveCustomer({id:'original-customer',name:'Original local customer'});
    return {backup:JSON.stringify(await db.exportAllData()),hidden:!document.querySelector('#accountMonitoring'),nav:!!document.querySelector('[data-nav="admin"]')};
  })()`);
  r.check('monitoring metadata is excluded from business backups',!privacy.backup.includes('must-not-export') && !privacy.backup.includes('private-user'));
  r.check('unconfigured cloud account UI is hidden',privacy.hidden);
  r.check('client account settings never expose Admin navigation',!privacy.nav);

  await c.evaluate(`localStorage.setItem(APP_CONFIG.storagePrefix+'workspace',${JSON.stringify(a)})`);
  await c.goto('settings.html',1800);
  const workspaceA = await c.evaluate(`(async()=>{
    const db=await import('./js/db.js'); const existing=await db.getCustomers();
    await db.saveCustomer({id:'business-a-customer',name:'Business A customer'});
    AppConfig.writeStorage('brand','Business A brand');
    return {existing:existing.length,workspace:AppConfig.workspaceId()};
  })()`);
  r.eq('first business workspace starts separately from existing local data',workspaceA.existing,0);
  r.eq('business A workspace is active',workspaceA.workspace,a);
  await c.evaluate(`localStorage.setItem(APP_CONFIG.storagePrefix+'workspace',${JSON.stringify(b)})`);
  await c.goto('settings.html',1800);
  const workspaceB = await c.evaluate(`(async()=>{
    const db=await import('./js/db.js');
    return {customers:(await db.getCustomers()).length,brand:AppConfig.readStorage('brand'),workspace:AppConfig.workspaceId()};
  })()`);
  r.eq('business B cannot see business A customers',workspaceB.customers,0);
  r.eq('business B cannot inherit business A cached brand',workspaceB.brand,null);
  r.eq('business B workspace is active',workspaceB.workspace,b);
  await c.evaluate(`localStorage.removeItem(APP_CONFIG.storagePrefix+'workspace')`);
  await c.goto('settings.html',1800);
  r.eq('original local customer survives workspace switches',await c.evaluate(`(async()=>(await(await import('./js/db.js')).getCustomers())[0]?.name)()`),'Original local customer');

  const ack = await c.evaluate(`(async()=>{
    const store=await import('./js/monitoringStore.js');
    await store.writeMonitorState('status-test',{operationId:'new',payload:{page:'invoice'}});
    await store.acknowledgeStatus('status-test','old');
    const afterOld=await store.readMonitorState('status-test');
    await store.acknowledgeStatus('status-test','new');
    return {afterOld,afterNew:await store.readMonitorState('status-test')};
  })()`);
  r.eq('old acknowledgement cannot erase a newer queued operation',ack.afterOld.operationId,'new');
  r.eq('matching acknowledgement clears the delivered operation',ack.afterNew,null);
  await c.goto('owner/index.html',1200);
  const owner = await c.evaluate(`({heading:document.querySelector('h1')?.textContent,status:document.querySelector('#ownerStatus')?.textContent,hidden:document.querySelector('#ownerContent')?.classList.contains('hidden')})`);
  r.eq('separate owner dashboard loads',owner.heading,'Client monitoring');
  r.check('unconfigured owner dashboard keeps client records hidden',owner.hidden);
  r.check('owner dashboard clearly reports unconfigured accounts',/not been connected/.test(owner.status));
  await c.send('Emulation.setDeviceMetricsOverride',{width:360,height:900,deviceScaleFactor:1,mobile:false});
  await sleep(200);
  r.check('owner login fits phone width',await c.evaluate('document.documentElement.scrollWidth <= 360'));
  r.eq('zero uncaught monitoring application errors',c.errors().length,0);
  const ok=r.finish();c.close();process.exit(ok?0:1);
} catch(error) {console.error(error);r.finish();c.close();process.exit(1);}

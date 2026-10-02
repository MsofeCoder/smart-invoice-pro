import { CONFIG, connect, createReporter, sleep } from './lib/cdp.js';
// Destructive probes are restricted to the launcher's disposable browser profile.
if (!process.env.E2E_ISOLATED_PROFILE) throw new Error('Run via npm run test:release in an isolated profile');
const r = createReporter('Release safety');
const c = await connect();
try {
  await c.send('Storage.clearDataForOrigin', { origin: CONFIG.origin, storageTypes: 'all' });
  await c.goto('index.html', 2400);
  const fresh = await c.evaluate(`(async () => {
    const db = await import('./js/db.js');
    (await import('./js/onboarding.js')).markOnboardingSeen();
    return { invoices: (await db.getInvoices()).length, customers: (await db.getCustomers()).length, products: (await db.getProducts()).length };
  })()`);
  r.eq('fresh install starts without demo invoices', fresh.invoices, 0);
  r.eq('fresh install starts without demo customers', fresh.customers, 0);
  r.eq('fresh install starts without demo products', fresh.products, 0);
  await c.evaluate(`(async () => {
    const db = await import('./js/db.js');
    await db.saveCustomer({id:'cust_001',name:'REAL CLIENT CUSTOMER'});
    await db.saveProduct({id:'prod_001',name:'REAL CLIENT PRODUCT',sellingPrice:1000,stock:2});
  })()`);
  await c.goto('index.html', 1800);
  const empty = await c.evaluate(`(async () => {
    const db=await import('./js/db.js');
    return {invoices:(await db.getInvoices()).length,customer:(await db.getCustomers())[0].name,product:(await db.getProducts())[0].name};
  })()`);
  r.eq('empty ledger stays empty on revisit', empty.invoices, 0);
  r.eq('demo ID cannot overwrite a real customer', empty.customer, 'REAL CLIENT CUSTOMER');
  r.eq('demo ID cannot overwrite a real product', empty.product, 'REAL CLIENT PRODUCT');
  await c.goto('invoice.html', 1800);
  await c.evaluate(`document.querySelector('#newInvoiceBtn').click()`);
  await sleep(300);
  const amount = await c.evaluate(`(() => {
    if(!document.querySelector('.line-qty')) document.querySelector('#addLineBtn').click();
    const row=document.querySelector('#itemsBody tr');
    const set=(sel,value)=>{const el=row.querySelector(sel); el.value=value; el.dispatchEvent(new Event('input',{bubbles:true}));};
    document.querySelector('#invCustomerName').value='REAL CLIENT CUSTOMER';
    set('.line-name','Fractional goods'); set('.line-qty','0.125'); set('.line-price','1000');
    document.querySelector('#invTaxRate').value='0';
    document.querySelector('#invTaxRate').dispatchEvent(new Event('input',{bubbles:true}));
    return row.querySelector('.line-amount').textContent;
  })()`);
  r.check('fractional quantity displays TZS 125.00', /125\.00/.test(amount) && !/125,000/.test(amount), amount);
  await c.evaluate(`document.querySelector('#saveInvoiceBtn').click()`);
  await sleep(700);
  const saved = await c.evaluate(`(async()=> (await (await import('./js/db.js')).getInvoices())[0])()`);
  r.check('fractional invoice actually persists', !!saved);
  if (saved) {
    r.eq('stored quantity remains fractional', saved.items[0].qty, 0.125);
    r.eq('stored unit price is correct', saved.items[0].unitPrice, 1000);
    r.eq('stored total is correct', saved.grandTotal, 125);
  }
  const restore = await c.evaluate(`(async () => {
    const db=await import('./js/db.js');
    await db.setSetting('releaseMarker','keep');
    await db.savePayment({id:'release-payment',invoiceId:'release-invoice',amount:5,date:'2026-10-02'});
    await db.enqueueSync({type:'release-marker'});
    const original=await db.exportAllData();
    const snapshot=async()=>JSON.stringify({data:(await db.exportAllData()).data,queue:await db.getSyncQueue()});
    const before=await snapshot();
    const outcomes=[];
    const test=async(label,alter)=>{
      const bad=structuredClone(original); alter(bad);
      let rejected=false; try{await db.importAllData(bad);}catch{rejected=true;}
      outcomes.push({label,rejected,preserved:await snapshot()===before});
    };
    await test('missing store',p=>delete p.data.invoices);
    await test('missing primary key',p=>p.data.customers.push({name:'Broken'}));
    await test('duplicate primary key',p=>p.data.customers.push({...p.data.customers[0]}));
    await test('invalid store type',p=>p.data.products={});
    await test('unsupported version',p=>p.version=999);
    await test('invalid app',p=>p.app='other-app');
    await test('uncloneable row rolls back queued clears',p=>p.data.settings.push({key:'broken',value:()=>true}));
    const put=IDBObjectStore.prototype.put;
    let injected=false;
    IDBObjectStore.prototype.put=function(...args){
      const result=put.apply(this,args);
      if(!injected){injected=true;const tx=this.transaction;queueMicrotask(()=>tx.abort());}
      return result;
    };
    let rejected=false;
    try{await db.importAllData(original);}catch{rejected=true;}finally{IDBObjectStore.prototype.put=put;}
    outcomes.push({label:'asynchronous transaction abort',rejected,preserved:await snapshot()===before});
    const replacement=structuredClone(original);
    replacement.data.invoices=[];replacement.data.payments=[];
    const counts=await db.importAllData(replacement);
    return {outcomes,counts,restored:JSON.stringify((await db.exportAllData()).data)===JSON.stringify(replacement.data),queueCount:(await db.getSyncQueue()).length};
  })()`);
  for (const result of restore.outcomes) {
    r.check(`${result.label}: rejected`, result.rejected);
    r.check(`${result.label}: all stores preserved`, result.preserved);
  }
  r.check('valid backup round-trips every data store', restore.restored);
  r.eq('valid restore removes stale sync operations', restore.queueCount, 0);
  r.eq('valid empty-ledger restore has zero invoices', restore.counts.invoices, 0);
  await c.goto('index.html', 1800);
  r.eq('empty-ledger restore stays empty after dashboard reload', await c.evaluate(`(async()=> (await (await import('./js/db.js')).getInvoices()).length)()`), 0);
  await c.send('Emulation.setDeviceMetricsOverride',{width:320,height:900,deviceScaleFactor:1,mobile:false});
  await c.evaluate(`(async()=>{(await import('./js/utils.js')).toast('A very long client notification '+ 'X'.repeat(120),'success',10000)})()`);
  await sleep(30);
  const toast = await c.evaluate(`(() => {const el=document.querySelector('.toast');const b=el.getBoundingClientRect();return {left:b.left,right:b.right,page:document.documentElement.scrollWidth};})()`);
  r.check('long toast stays inside 320px viewport during animation', toast.left>=0 && toast.right<=320 && toast.page<=320,JSON.stringify(toast));
  r.eq('zero uncaught application errors', c.errors().length, 0);
  const ok=r.finish();c.close();process.exit(ok?0:1);
} catch(error) { console.error(error);r.finish();c.close();process.exit(1); }

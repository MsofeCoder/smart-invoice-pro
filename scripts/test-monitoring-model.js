import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {statusPayload, validBinding, retryDelay, contactLabel, HEARTBEAT_MS} from '../js/monitoringModel.js';

let passed = 0;
const check = (label, operation) => { operation(); passed++; console.log(`PASS: ${label}`); };
const business = '30000000-0000-4000-8000-000000000001';
const binding = {businessId:business,userId:'10000000-0000-4000-8000-000000000001',deviceId:'40000000-0000-4000-8000-000000000001',consent:true};
check('monitoring strips private fields and raw errors', () => {
  const status = statusPayload({app_version:'2.1.0',page:'invoice',pending_count:3,error_codes:['APP_ERROR','token=secret','STORAGE_ERROR'],customer:'Private',invoice:{grandTotal:100},token:'secret',url:'https://private'});
  assert.deepEqual(status,{app_version:'2.1.0',page:'invoice',pending_count:3,sync_state:'local_only',error_codes:['APP_ERROR','STORAGE_ERROR']});
});
check('monitoring reports local-only sync honestly', () => assert.equal(statusPayload({sync_state:'cloud_synced'}).sync_state,'local_only'));
for (const [input, expected] of [[-5,0],[4.9,4],[Infinity,10000],['99999',10000],['bad',0],[null,0]]) {
  check(`bounded queue count: ${input}`, () => assert.equal(statusPayload({pending_count:input}).pending_count,expected));
}
check('unknown page and empty version normalize safely', () => assert.deepEqual(statusPayload(),{app_version:'unknown',page:'dashboard',pending_count:0,sync_state:'local_only',error_codes:[]}));
check('error codes are deduplicated', () => assert.deepEqual(statusPayload({error_codes:['APP_ERROR','APP_ERROR']}).error_codes,['APP_ERROR']));
check('valid explicit consent binding', () => assert.equal(validBinding(binding),true));
for (const patch of [{consent:false},{consent:'true'},{userId:'other'},{businessId:'../other'},{deviceId:null}]) {
  check(`invalid binding denied: ${JSON.stringify(patch)}`, () => assert.equal(validBinding({...binding,...patch}),false));
}
check('retry backoff starts low and is capped', () => { assert.equal(retryDelay(0,()=>1),15000); assert.equal(retryDelay(20,()=>1),HEARTBEAT_MS); });
const now = Date.UTC(2026,9,4,12);
for (const [stamp,label] of [[null,'Never contacted'],[new Date(now-60000).toISOString(),'Contacted recently'],[new Date(now-3600000).toISOString(),'No recent contact'],[new Date(now-86400000).toISOString(),'Inactive or offline']]) {
  check(`contact label: ${label}`, () => assert.equal(contactLabel(stamp,now),label));
}

function config(entries = {}) {
  const store = new Map(Object.entries(entries));
  const context = {localStorage:{getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,String(value)),removeItem:key=>store.delete(key)}};
  context.window = context;
  vm.runInNewContext(fs.readFileSync(new URL('../js/app.config.js',import.meta.url),'utf8'),context);
  return {...context,store};
}
const original = config();
const prefix = original.APP_CONFIG.storagePrefix;
const isolated = config({[prefix+'workspace']:business,[prefix+'brand']:'Other business',[prefix+'business:'+business+':theme']:'dark'});
check('business workspace scopes keys before first paint', () => assert.equal(isolated.AppConfig.storageKey('theme'),prefix+'business:'+business+':theme'));
check('business workspace reads its own settings', () => assert.equal(isolated.AppConfig.readStorage('theme'),'dark'));
check('business workspace does not inherit original brand', () => assert.equal(isolated.AppConfig.readStorage('brand'),null));
check('workspace is fixed until page reload', () => { isolated.store.set(prefix+'workspace','30000000-0000-4000-8000-000000000002'); assert.equal(isolated.AppConfig.workspaceId(),business); });
check('business remove does not erase original local records', () => { isolated.AppConfig.removeStorage('brand'); assert.equal(isolated.store.get(prefix+'brand'),'Other business'); });
check('malformed workspace cannot inject database names', () => assert.equal(config({[prefix+'workspace']:'../private'}).AppConfig.workspaceId(),''));
console.log(`${passed} monitoring model checks passed`);

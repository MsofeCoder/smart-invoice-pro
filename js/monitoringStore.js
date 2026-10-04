import { CONFIG } from './config.js';

let connection;
function open() {
  connection ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(`${CONFIG.dbName || 'invoice-app'}-monitoring`, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state', {keyPath: 'key'});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { connection = null; reject(request.error); };
  });
  return connection;
}
async function transaction(mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', mode);
    let result;
    const request = action(tx.objectStore('state'));
    if (request) request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('Monitoring storage failed'));
  });
}
export const readMonitorState = async key => (await transaction('readonly', store => store.get(key)))?.value ?? null;
export const writeMonitorState = (key, value) => transaction('readwrite', store => store.put({key, value}));
export const deleteMonitorState = key => transaction('readwrite', store => store.delete(key));

// Compare operation identity in the same transaction as deletion. An old
// network acknowledgement cannot erase a newer status queued by another tab.
export async function acknowledgeStatus(key, operationId) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', 'readwrite');
    const store = tx.objectStore('state');
    const request = store.get(key);
    request.onsuccess = () => {
      if (request.result?.value?.operationId === operationId) store.delete(key);
    };
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

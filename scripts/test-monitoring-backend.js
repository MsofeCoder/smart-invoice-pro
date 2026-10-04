import fs from 'node:fs';
import pg from 'pg';

const connectionString = process.env.MONITORING_TEST_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:55432/postgres';
const url = new URL(connectionString);
if (!['localhost','127.0.0.1'].includes(url.hostname)) throw new Error('Backend tests require a disposable local database, never a hosted client database.');
const client = new pg.Client({connectionString,connectionTimeoutMillis:10000,query_timeout:30000});
let passed = 0;
client.on('notice', notice => { if (notice.message.startsWith('PASS:')) { passed++; console.log(notice.message); } });
try {
  await client.connect();
  await client.query(fs.readFileSync(new URL('./test-monitoring.sql',import.meta.url),'utf8'));
  if (passed < 20) throw new Error('Authorization test assertions did not all run');
  console.log(`${passed} real database authorization checks passed; all fixtures rolled back.`);
} finally { await client.end(); }

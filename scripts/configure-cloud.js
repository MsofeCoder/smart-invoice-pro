import fs from 'node:fs';
const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_PUBLISHABLE_KEY || '';
const local = process.argv.includes('--local');
const parsed = new URL(url);
if (!((parsed.protocol === 'https:' && /^[a-z0-9-]+\.supabase\.co$/.test(parsed.hostname)) ||
      (local && parsed.protocol === 'http:' && ['localhost','127.0.0.1'].includes(parsed.hostname)))) throw new Error('Use a Supabase project URL');
if (!key.startsWith('sb_publishable_')) throw new Error('Only a modern publishable key may enter a public build. Secret/service-role keys are rejected.');
const values = {enabled:true,url:parsed.origin,publishableKey:key,appVersion:'2.1.0-monitoring'};
fs.writeFileSync('js/cloud.config.js', '// Public deployment configuration. No privileged credentials.\nexport const CLOUD = Object.freeze(' + JSON.stringify(values,null,2) + ');\n');
console.log('Configured public cloud settings. No privileged key was written.');

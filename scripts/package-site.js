import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const target = path.resolve(dist, 'site');
// Only this generated directory may be replaced; never resolve a caller path.
if (path.dirname(target) !== dist || !target.startsWith(root + path.sep)) throw new Error('Invalid release output path');
console.log(`Packaging application into ${target}`);
fs.mkdirSync(dist, {recursive:true});
fs.rmSync(target, {recursive:true,force:true});
fs.mkdirSync(target);
const entries = ['.nojekyll','index.html','invoice.html','customers.html','products.html','reports.html','settings.html','manifest.json','sw.js','favicon.svg','favicon.ico','favicon.png','css','js','libs','assets'];
const operatorFiles = new Set(['admin.html', 'js/admin.js', 'js/adminKeys.js']);
for (const entry of entries) fs.cpSync(path.join(root,entry),path.join(target,entry),{
  recursive:true,
  filter: source => !operatorFiles.has(path.relative(root, source).split(path.sep).join('/')),
});
for (const file of operatorFiles) {
  if (fs.existsSync(path.join(target, file))) throw new Error(`Operator file leaked into client release: ${file}`);
}
console.log('Packaged client application only; operator console, development tooling and local data are excluded.');

const ownerTarget = path.resolve(dist, 'owner');
if (path.dirname(ownerTarget) !== dist) throw new Error('Invalid owner output path');
fs.rmSync(ownerTarget, {recursive:true,force:true});
fs.mkdirSync(ownerTarget);
for (const entry of ['owner','css','assets','favicon.svg']) fs.cpSync(path.join(root,entry),path.join(ownerTarget,entry),{recursive:true});
for (const entry of ['app.config.js','brand-boot.js','config.js','utils.js','cloud.config.js','cloudClient.js','monitoringModel.js']) {
  fs.mkdirSync(path.join(ownerTarget,'js'),{recursive:true});
  fs.copyFileSync(path.join(root,'js',entry),path.join(ownerTarget,'js',entry));
}
fs.mkdirSync(path.join(ownerTarget,'libs'));
for (const entry of ['supabase.js','supabase-licenses.txt','SUPABASE-LICENSE']) fs.copyFileSync(path.join(root,'libs',entry),path.join(ownerTarget,'libs',entry));
fs.writeFileSync(path.join(ownerTarget,'_redirects'), '/ /owner/index.html 302\n');
console.log('Packaged the owner dashboard separately into dist/owner.');
const headers = '/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n/js/cloud.config.js\n  Cache-Control: no-cache\n/sw.js\n  Cache-Control: no-cache\n';
fs.writeFileSync(path.join(target,'_headers'),headers);
fs.writeFileSync(path.join(ownerTarget,'_headers'),headers+'\n/owner/*\n  Cache-Control: no-store\n');

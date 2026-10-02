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
const entries = ['.nojekyll','index.html','invoice.html','customers.html','products.html','reports.html','settings.html','admin.html','manifest.json','sw.js','favicon.svg','favicon.ico','favicon.png','css','js','libs','assets'];
for (const entry of entries) fs.cpSync(path.join(root,entry),path.join(target,entry),{recursive:true});
console.log('Packaged only application files; development tooling and local data are excluded.');

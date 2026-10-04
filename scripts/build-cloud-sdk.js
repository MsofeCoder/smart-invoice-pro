import { build } from 'esbuild';
import fs from 'node:fs';

const result = await build({
  stdin: {contents: "export { createClient } from '@supabase/supabase-js';", resolveDir: process.cwd(), sourcefile: 'supabase-entry.js'},
  outfile: 'libs/supabase.js', bundle: true, format: 'esm', platform: 'browser', target: ['es2022'],
  minify: true, legalComments: 'inline', metafile: true,
});
fs.copyFileSync('node_modules/@supabase/supabase-js/LICENSE', 'libs/SUPABASE-LICENSE');
const packages = new Set(Object.keys(result.metafile.inputs).map(input => input.replaceAll('\\','/').match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean));
const notices = [...packages].map(name => {
  const license = ['LICENSE','LICENSE.md','LICENSE.txt','license','license.md'].map(file => `node_modules/${name}/${file}`).find(file => fs.existsSync(file));
  if (!license) throw new Error(`Missing bundled dependency license: ${name}`);
  return `${name}\n${fs.readFileSync(license,'utf8')}`;
}).join('\n\n--------------------\n\n');
fs.writeFileSync('libs/supabase-licenses.txt', notices);
console.log('Built a local, pinned Supabase SDK; no runtime CDN required.');

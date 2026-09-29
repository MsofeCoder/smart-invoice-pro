/**
 * Brand showcase screenshots.
 *
 * Renders the app under several brand palettes so the theming can be reviewed
 * visually. Writes PNGs into .workbuddy-ai/screenshots/.
 *
 * Run: npm run shots   (starts its own server + browser)
 */
import fs from 'node:fs';
import { CONFIG, connect, sleep } from './lib/cdp.js';

fs.mkdirSync(CONFIG.shots, { recursive: true });
const { send, evaluate, shot, close } = await connect();

await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

const BRANDS = [
  { file: '20-ocean-blue', primary: '#1565C0', accent: '#00ACC1', sidebar: 'gradient', radius: 12, theme: 'light', page: 'index.html' },
  { file: '21-royal-purple-dark', primary: '#6A1B9A', accent: '#EC407A', sidebar: 'gradient', radius: 14, theme: 'dark', page: 'index.html' },
  { file: '22-crimson-light-sidebar', primary: '#C62828', accent: '#FB8C00', sidebar: 'light', radius: 10, theme: 'light', page: 'reports.html' },
  { file: '23-corporate-slate-deep', primary: '#37474F', accent: '#00B0FF', sidebar: 'deep', radius: 6, theme: 'dark', page: 'invoice.html' },
];

for (const b of BRANDS) {
  // Save through the app's own API — IndexedDB is authoritative and would
  // otherwise overwrite a localStorage-only change on the next load.
  await send('Page.navigate', { url: `${CONFIG.origin}/index.html` });
  await sleep(2200);
  await evaluate(`(async () => {
    const m = await import('./js/brand.js');
    await m.saveBrand(${JSON.stringify({
      preset: 'custom',
      primary: b.primary,
      accent: b.accent,
      radius: b.radius,
      sidebar: b.sidebar,
      appName: 'Kilimo Bora Ltd',
      appTagline: 'Invoicing Suite',
    })});
    window.AppConfig.writeStorage('theme', ${JSON.stringify(b.theme)});
    return true;
  })()`);
  await send('Page.navigate', { url: `${CONFIG.origin}/${b.page}` });
  await send('Page.bringToFront');
  await sleep(3200);
  const applied = await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()`);
  console.log(`  ${b.file}: --brand = ${applied} (expected ${b.primary})`);
  await shot(`brand-${b.file}.png`);
}

// The CDP socket keeps Node's event loop alive — close it and exit explicitly,
// or the launcher waits forever for this process to finish.
close();
console.log(`\nScreenshots written to ${CONFIG.shots}`);
process.exit(0);

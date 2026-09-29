/**
 * E2E test launcher.
 *
 * Starts a static server and a headless Chromium with remote debugging, waits
 * for both to be ready, runs the browser suites against them, then tears
 * everything down. This is what `npm run test:e2e` invokes so the suites are
 * reproducible without any manual setup.
 *
 * Flags:
 *   --a11y-only     run only the accessibility suite
 *   --shots         render the brand showcase screenshots instead of the suites
 *   --suite=<file>  run a specific script from scripts/ against the live server
 *   --keep          leave the server/browser running after the run
 *   --headed        launch a visible browser window (debugging)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowser } from './lib/cdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const a11yOnly = args.includes('--a11y-only');
const shotsMode = args.includes('--shots');
const customSuite = (args.find((a) => a.startsWith('--suite=')) || '').slice('--suite='.length);
const keepAlive = args.includes('--keep');
const headed = args.includes('--headed');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask the OS for a free port by binding to 0 and reading it back. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const waitFor = async (url, { tries = 60, gap = 250, label = url } = {}) => {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(gap);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const browser = resolveBrowser();
if (!browser) {
  console.error(
    '\n  No Chromium-family browser found.\n' +
      '  Install Chrome/Edge, or point E2E_BROWSER at the executable.\n',
  );
  process.exit(1);
}

const serverPort = await freePort();
const cdpPort = await freePort();
const origin = `http://127.0.0.1:${serverPort}`;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-e2e-profile-'));
const children = [];

const shutdown = () => {
  for (const child of children) {
    if (child.killed || child.exitCode !== null) continue;
    if (process.platform === 'win32') {
      // kill() only signals the direct child; Chromium spawns helpers.
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        child.kill();
      }
    } else {
      child.kill('SIGTERM');
    }
  }
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};

process.on('exit', shutdown);
process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});

/* ---------- 1. Static server ---------- */
const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve.js'), String(serverPort)], {
  cwd: ROOT,
  stdio: 'ignore',
});
children.push(server);
await waitFor(`${origin}/index.html`, { label: 'static server' });
console.log(`  server   ${origin}`);

/* ---------- 2. Headless browser ---------- */
const chromeArgs = [
  headed ? '--headless=false' : '--headless=new',
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--metrics-recording-only',
  '--window-size=1600,1000',
  'about:blank',
];
const chrome = spawn(browser, chromeArgs, { stdio: 'ignore' });
children.push(chrome);
await waitFor(`http://127.0.0.1:${cdpPort}/json/version`, { label: 'browser devtools' });
console.log(`  browser  ${path.basename(browser)} on :${cdpPort}\n`);

/* ---------- 3. Suites ---------- */
const env = {
  ...process.env,
  E2E_CDP: `http://127.0.0.1:${cdpPort}`,
  E2E_ORIGIN: origin,
};

const SUITE_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT || 300000);

const run = (file) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'scripts', file)], { cwd: ROOT, stdio: 'inherit', env });
    // A suite that forgets to exit (e.g. an open socket) would otherwise hang the
    // whole run forever, so bound it.
    const timer = setTimeout(() => {
      console.error(`\n  ${file} exceeded ${SUITE_TIMEOUT_MS / 1000}s — terminating.\n`);
      if (process.platform === 'win32') {
        try {
          spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {
          p.kill();
        }
      } else {
        p.kill('SIGKILL');
      }
    }, SUITE_TIMEOUT_MS);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });

const suites = customSuite
  ? [customSuite]
  : shotsMode
    ? ['screenshots.js']
    : a11yOnly
      ? ['test-a11y.js']
      : ['test-e2e.js', 'test-a11y.js', 'test-polish.js', 'test-responsive.js', 'test-platform.js'];
const results = [];
for (const suite of suites) {
  results.push([suite, await run(suite)]);
}

if (!keepAlive) shutdown();

const failed = results.filter(([, code]) => code !== 0);
console.log('\n' + '-'.repeat(52));
for (const [suite, code] of results) {
  console.log(`  ${code === 0 ? 'PASS' : 'FAIL'}  ${suite}`);
}
console.log('-'.repeat(52) + '\n');

if (keepAlive) {
  console.log(`  --keep set: server ${origin}, devtools http://127.0.0.1:${cdpPort}\n`);
}

process.exit(failed.length ? 1 : 0);

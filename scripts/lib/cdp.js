/**
 * Minimal Chrome DevTools Protocol client for the E2E suites.
 *
 * Node 22 ships a global `WebSocket` and `fetch`, so this needs no dependencies.
 * Everything here is deliberately small: connect to an already-running browser,
 * send commands, evaluate expressions, take screenshots.
 *
 * Configuration comes from the environment so `scripts/e2e.js` can hand the
 * suites a server/browser pair it started itself:
 *   E2E_CDP     devtools endpoint        (default http://127.0.0.1:9223)
 *   E2E_ORIGIN  app origin under test    (default http://127.0.0.1:8080)
 *   E2E_SHOTS   screenshot output dir
 *   E2E_DL      download dir
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..', '..');

export const CONFIG = {
  cdp: process.env.E2E_CDP || 'http://127.0.0.1:9223',
  origin: process.env.E2E_ORIGIN || 'http://127.0.0.1:8080',
  shots: process.env.E2E_SHOTS || path.join(ROOT, '.workbuddy-ai', 'screenshots'),
  downloads: process.env.E2E_DL || path.join(os.tmpdir(), 'invoice-e2e-downloads'),
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Locate a Chromium-family binary, honouring an explicit override. */
export function resolveBrowser() {
  if (process.env.E2E_BROWSER && fs.existsSync(process.env.E2E_BROWSER)) return process.env.E2E_BROWSER;

  const candidates = {
    win32: [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
  }[process.platform] || [];

  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/**
 * Connect to the first page target of a running browser.
 * Returns the command channel plus convenience wrappers.
 */
export async function connect() {
  const list = await (await fetch(`${CONFIG.cdp}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  if (!target) throw new Error('no page target available at ' + CONFIG.cdp);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();

  /** Console errors/exceptions and failed requests, reset on every navigation. */
  const state = { logs: [], netFails: [] };

  const send = (method, params = {}, timeoutMs = 40000) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rej(new Error('CDP timeout: ' + method));
        }
      }, timeoutMs);
    });

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      state.logs.push({
        level: m.params.type,
        text: m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300),
      });
    }
    if (m.method === 'Runtime.exceptionThrown') {
      state.logs.push({
        level: 'exception',
        text: (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 500),
      });
    }
    if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) {
      state.logs.push({ level: m.params.entry.level, text: (m.params.entry.text || '').slice(0, 300) });
    }
    if (m.method === 'Network.loadingFailed') {
      state.netFails.push(`${m.params.errorText} ${m.params.url || ''}`.slice(0, 140));
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true });
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result.value;
  };

  /** Navigate and let the app settle. Console/network state is cleared first. */
  const goto = async (page, waitMs = 2400) => {
    state.logs = [];
    state.netFails.length = 0;
    await send('Page.navigate', { url: `${CONFIG.origin}/${page}` });
    await send('Page.bringToFront');
    await sleep(waitMs);
  };

  const shot = async (file) => {
    fs.mkdirSync(CONFIG.shots, { recursive: true });
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(CONFIG.shots, file), Buffer.from(data, 'base64'));
    return path.join(CONFIG.shots, file);
  };

  return {
    send,
    evaluate,
    goto,
    shot,
    state,
    /** Console errors + uncaught exceptions since the last navigation. */
    errors: () => state.logs.filter((l) => l.level === 'error' || l.level === 'exception'),
    /** Failed network requests since the last navigation. */
    netFails: () => state.netFails.slice(),
    close: () => ws.close(),
  };
}

/** Tiny assertion collector shared by both suites. */
export function createReporter(title) {
  const checks = [];
  const record = (name, pass, actual) =>
    checks.push({ name, pass: !!pass, actual: String(actual ?? '').slice(0, 160) });

  return {
    check: record,
    eq: (name, actual, expected) =>
      record(name, actual === expected, `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`),
    section: (label) => console.log(`\n=== ${label} ===`),
    finish() {
      const failed = checks.filter((c) => !c.pass);
      console.log(`\n${title}: ${checks.length - failed.length}/${checks.length} passed\n`);
      for (const c of checks) {
        if (!c.pass) console.log(`  FAIL  ${c.name}  [${c.actual}]`);
      }
      if (failed.length) console.log(`\n${failed.length} failure(s)`);
      return failed.length === 0;
    },
    get count() {
      return checks.length;
    },
  };
}

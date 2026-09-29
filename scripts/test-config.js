/**
 * Configuration + white-label contract test
 *
 * Two jobs:
 *
 *  1. Load `js/app.config.js` the way a browser would and assert the shape a
 *     fresh install depends on, plus the storage-key semantics that keep an
 *     existing install's theme and brand alive across the rename.
 *
 *  2. Fail the build if product branding creeps back into the template. This
 *     is the guard that makes the white-label promise real: the whole point of
 *     the refactor is that no client should ever see the vendor's name.
 *
 * The branding scan is an allowlist, not a blocklist: a reference to the old
 * brand is only permitted on a line that matches one of the documented
 * migration patterns. A new hardcoded name will not look like a migration
 * alias, so it fails.
 *
 * Run: node scripts/test-config.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;

function assert(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name} \u2014 expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

function assertTrue(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${detail ? ' \u2014 ' + detail : ''}`); }
}

/* ==========================================================================
   1. Load js/app.config.js as a classic script
   ========================================================================== */

const APP_CONFIG_SRC = fs.readFileSync(path.join(ROOT, 'js', 'app.config.js'), 'utf8');

/** A Map-backed localStorage so we can inspect exactly what was written. */
function makeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const store = makeStorage();
const win = {};
new Function('window', 'localStorage', APP_CONFIG_SRC)(win, store);

const CFG = win.APP_CONFIG;
const H = win.AppConfig;

console.log('== app.config.js loads ==');
assertTrue('publishes window.APP_CONFIG', CFG !== undefined);
assertTrue('publishes window.AppConfig helpers', H !== undefined);
assertTrue('APP_CONFIG is frozen', Object.isFrozen(CFG));
assertTrue('AppConfig is frozen', Object.isFrozen(H));

/* ==========================================================================
   2. Required shape
   ========================================================================== */

console.log('\n== Required config keys ==');
for (const key of [
  'appName', 'shortName', 'tagline', 'description', 'slug',
  'fallbackBusinessName', 'defaultCurrency', 'defaultTaxRate',
  'allowWhiteLabel', 'allowCustomLogo', 'dbName', 'storagePrefix',
  'legacyDbNames', 'legacyStoragePrefixes', 'sync', 'defaultPlan',
  'plans', 'paidFeatures', 'paymentGateways', 'whatsapp', 'pdf',
]) {
  assertTrue(`has ${key}`, Object.prototype.hasOwnProperty.call(CFG, key));
}

console.log('\n== Values a fresh install depends on ==');
assert('appName is a non-empty string', typeof CFG.appName === 'string' && CFG.appName.length > 0, true);
assert('tagline', CFG.tagline, 'Business Invoicing & Management');
assert('defaultCurrency', CFG.defaultCurrency, 'TZS');
assert('defaultTaxRate', CFG.defaultTaxRate, 18);
assert('allowWhiteLabel defaults on', CFG.allowWhiteLabel, true);
assert('defaultPlan', CFG.defaultPlan, 'free');
assertTrue('slug is URL/filename safe', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(CFG.slug), CFG.slug);
assert('storagePrefix ends with a separator', /[_-]$/.test(CFG.storagePrefix), true);
assertTrue('legacyDbNames is a list', Array.isArray(CFG.legacyDbNames));
assertTrue('legacyStoragePrefixes is a list', Array.isArray(CFG.legacyStoragePrefixes));

console.log('\n== Storage key semantics ==');
assert('storageKey prefixes the name', H.storageKey('brand'), `${CFG.storagePrefix}brand`);
assert('readStorage on an empty store', H.readStorage('brand'), null);
H.writeStorage('brand', '{"primary":"#2E7D32"}');
assert('writeStorage then readStorage round-trips', H.readStorage('brand'), '{"primary":"#2E7D32"}');
assert('writeStorage reports success', H.writeStorage('theme', 'dark'), true);

console.log('\n== Legacy key fallback (existing installs must survive the rename) ==');
const legacyStore = makeStorage();
const legacyWin = {};
new Function('window', 'localStorage', APP_CONFIG_SRC)(legacyWin, legacyStore);
const LH = legacyWin.AppConfig;
const legacyPrefix = legacyWin.APP_CONFIG.legacyStoragePrefixes[0];
legacyStore.setItem(`${legacyPrefix}brand`, '{"primary":"#7B1FA2"}');
assert('reads a legacy-prefixed key when the new one is absent', LH.readStorage('brand'), '{"primary":"#7B1FA2"}');
legacyStore.setItem(`${legacyWin.APP_CONFIG.storagePrefix}brand`, '{"primary":"#1565C0"}');
assert('new prefix wins when both exist', LH.readStorage('brand'), '{"primary":"#1565C0"}');
LH.removeStorage('brand');
assert('removeStorage clears the new key', legacyStore.getItem(`${legacyWin.APP_CONFIG.storagePrefix}brand`), null);
assert('removeStorage also clears the legacy key', legacyStore.getItem(`${legacyPrefix}brand`), null);

console.log('\n== Plan helpers ==');
assert('getPlan resolves a known plan', H.getPlan('pro')?.id, 'pro');
// An unknown id deliberately resolves to the default plan, never null, so no
// caller has to null-check before reading a limit.
assert('getPlan falls back to the default plan for an unknown id', H.getPlan('platinum')?.id, CFG.defaultPlan);
assert('free plan caps invoices per month', H.getPlan('free').invoiceLimitPerMonth, 10);
assert('pro plan is unlimited', H.getPlan('pro').invoiceLimitPerMonth, null);
assertTrue('pro includes brand-customisation', H.planHasFeature('pro', 'brand-customisation'));
assertTrue('free does not include brand-customisation', !H.planHasFeature('free', 'brand-customisation'));
assertTrue('every plan declares a feature list', Object.values(CFG.plans).every((p) => Array.isArray(p.features) && p.features.length > 0));
assertTrue('plan ids match their keys', Object.entries(CFG.plans).every(([id, p]) => p.id === id));

console.log('\n== Payment gateway placeholders ==');
assertTrue('paymentGateways is a list', Array.isArray(CFG.paymentGateways));
for (const id of ['azampay', 'selcom']) {
  const gw = CFG.paymentGateways.find((g) => g.id === id);
  assertTrue(`declares ${id}`, Boolean(gw));
  if (gw) {
    assertTrue(`${id} lists mobile-money methods`, Array.isArray(gw.methods) && gw.methods.length > 0);
    assert(`${id} ships disabled`, gw.enabled, false);
    assert(`${id} defaults to sandbox`, gw.mode, 'sandbox');
    assertTrue(`${id} documents a docs URL`, typeof gw.docs === 'string' && gw.docs.startsWith('http'));
  }
}
assertTrue('gateways offer M-Pesa', CFG.paymentGateways.every((g) => g.methods.includes('M-Pesa')));

console.log('\n== WhatsApp + PDF geometry ==');
assert('whatsapp country code', CFG.whatsapp.countryCode, '255');
assertTrue('whatsapp message has placeholders', /\{customer\}/.test(CFG.whatsapp.defaultMessage) && /\{total\}/.test(CFG.whatsapp.defaultMessage));
assert('pdf page size', CFG.pdf.pageSize, 'a4');
assert('pdf orientation', CFG.pdf.orientation, 'portrait');
assert('pdf unit', CFG.pdf.unit, 'mm');
assertTrue('pdf margin is a positive number', CFG.pdf.margin > 0);

/* ==========================================================================
   3. Load order — app.config.js must run before brand-boot.js
   ========================================================================== */

console.log('\n== Script load order ==');
const PAGES = ['index.html', 'invoice.html', 'customers.html', 'products.html', 'reports.html', 'settings.html'];
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const cfgAt = html.indexOf('js/app.config.js');
  const bootAt = html.indexOf('js/brand-boot.js');
  assertTrue(`${page} loads app.config.js`, cfgAt !== -1);
  assertTrue(`${page} loads brand-boot.js`, bootAt !== -1);
  // brand-boot.js reads window.AppConfig on its very first line, so the config
  // script has to be earlier in the document, not merely present.
  assertTrue(`${page} loads config before brand-boot`, cfgAt !== -1 && bootAt !== -1 && cfgAt < bootAt, `config@${cfgAt} boot@${bootAt}`);
}

/* ==========================================================================
   4. Branding guard
   ========================================================================== */

console.log('\n== Branding guard: no vendor name in the template ==');
const VENDOR = 'Crown Invoice Pro';
const readIfPresent = (rel) => {
  const abs = path.join(ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
};

/* 4a. The literal product name must be gone everywhere, README included. */
const NEVER_FILES = [
  ...PAGES,
  'manifest.json', 'package.json', 'sw.js', 'README.md',
  'css/styles.css',
];
for (const rel of NEVER_FILES) {
  const text = readIfPresent(rel);
  if (text === null) { assertTrue(`${rel} exists`, false); continue; }
  assertTrue(`${rel} has no "${VENDOR}"`, !text.includes(VENDOR));
}

/* 4b. The bare word must be gone from user-facing content entirely. `sw.js` is
       deliberately not in this list — it is code, and it legitimately needs
       the old cache prefix to sweep caches the previous version created. It is
       covered by the allowlist scan in 4c instead. `README.md` is also in 4c,
       because a rebranding guide has to be able to show the migration aliases
       it is telling you about. */
for (const rel of [...PAGES, 'manifest.json', 'package.json', 'css/styles.css']) {
  const text = readIfPresent(rel) || '';
  assertTrue(`${rel} has no "crown" of any case`, !/crown/i.test(text));
}

/* 4c. In source dirs it may only appear on a documented migration line. */
const MIGRATION_LINE = [
  /legacyDbNames/,
  /legacyStoragePrefixes/,
  /PRESET_ALIASES/,
  /OWNED_PREFIXES/,
  /crown:\s*'signature'/,
  /preset:\s*'crown'/,
  /'crown-invoice-pro'/,
  /'crown_'/,
];

/* This file is exempt from its own scan: a guard has to be able to name the
   thing it forbids. It is the only exemption, and it is asserted below so the
   exemption cannot quietly grow. */
const SELF = 'scripts/test-config.js';

const sourceFiles = ['sw.js', 'README.md'];
for (const dir of ['js', 'css', 'scripts', 'libs']) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.isFile() && /\.(js|css)$/.test(entry.name)) sourceFiles.push(`${dir}/${entry.name}`);
    // scripts/lib/cdp.js is the only nested source directory.
    if (entry.isDirectory() && entry.name === 'lib') {
      for (const nested of fs.readdirSync(path.join(abs, entry.name))) {
        if (nested.endsWith('.js')) sourceFiles.push(`${dir}/${entry.name}/${nested}`);
      }
    }
  }
}
assertTrue('scanned the source tree', sourceFiles.length > 10, `${sourceFiles.length} files`);
assertTrue('the guard file itself is in the scanned set', sourceFiles.includes(SELF));

const offenders = [];
for (const rel of sourceFiles) {
  if (rel === SELF) continue;
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!/crown/i.test(line)) return;
    if (MIGRATION_LINE.some((re) => re.test(line))) return;
    offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
  });
}
assertTrue(
  'every "crown" in source is a documented migration alias',
  offenders.length === 0,
  offenders.slice(0, 6).join(' | '),
);

/* 4d. The app name in the manifest must match the configured one, and the
       icons the manifest references must actually exist. */
console.log('\n== manifest.json agrees with the config ==');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
assert('manifest name matches config appName', manifest.name, CFG.appName);
assert('manifest short_name matches config shortName', manifest.short_name, CFG.shortName);
assert('manifest id matches config slug', manifest.id, CFG.slug);
assertTrue('manifest declares start_url', typeof manifest.start_url === 'string' && manifest.start_url.length > 0);
assertTrue('manifest declares display standalone', manifest.display === 'standalone' || manifest.display === 'fullscreen');
assertTrue('manifest declares at least one maskable icon', (manifest.icons || []).some((i) => String(i.purpose || '').includes('maskable')));
assertTrue('manifest icons 192 + 512 present', [192, 512].every((s) => (manifest.icons || []).some((i) => i.sizes === `${s}x${s}`)));
for (const icon of manifest.icons || []) {
  assertTrue(`icon file exists: ${icon.src}`, fs.existsSync(path.join(ROOT, icon.src)), icon.src);
}
assertTrue('theme_color is a hex colour', /^#[0-9A-Fa-f]{6}$/.test(manifest.theme_color), manifest.theme_color);

/* 4e. The pages must not bake the product name into the markup either — the
       name is stamped at runtime from config + saved settings. */
console.log('\n== pages ship an empty identity slot ==');
for (const page of PAGES) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
  assertTrue(`${page} title has no product name`, !title.includes(CFG.appName) && !/crown/i.test(title), title.trim());
  assertTrue(`${page} <title> is not empty`, title.trim().length > 0);
}

/* ==========================================================================
   Result
   ========================================================================== */

console.log(`\n${'-'.repeat(52)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log(`${'-'.repeat(52)}\n`);
process.exit(fail ? 1 : 0);

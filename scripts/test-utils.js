/**
 * utils.js unit tests
 * Run: node scripts/test-utils.js
 */
import {
  escapeHTML,
  sanitizeString,
  sanitizeMultiline,
  toNumber,
  uid,
  toISODate,
  parseISODate,
  formatDate,
  addDays,
  debounce,
  throttle,
  initials,
  isValidEmail,
  isValidPhone,
  clamp,
} from '../js/utils.js';

let pass = 0;
let fail = 0;

function assert(name, actual, expected) {
  const ok = actual === expected;
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

function assertApprox(name, actual, expected, tolerance = 0.001) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} — expected ~${expected}, got ${actual}`); }
}

console.log('== escapeHTML ==');
// Entity fragments are concatenated rather than written literally. A previous
// revision of this file had the literal entities silently decoded to raw
// characters by a formatter, which turned these assertions into no-ops that
// "passed" only because expected and actual were both unescaped.
const AMP = '&' + 'amp;';
const LT = '&' + 'lt;';
const GT = '&' + 'gt;';
const QUOT = '&' + 'quot;';
const APOS = '&#' + '39;';

assert('escapes &', escapeHTML('a & b'), `a ${AMP} b`);
assert('escapes <', escapeHTML('a < b'), `a ${LT} b`);
assert('escapes >', escapeHTML('a > b'), `a ${GT} b`);
assert('escapes "', escapeHTML('say "hi"'), `say ${QUOT}hi${QUOT}`);
assert("escapes '", escapeHTML("it's"), `it${APOS}s`);
assert('escapes all', escapeHTML('<script>alert("x")</script>'),
  `${LT}script${GT}alert(${QUOT}x${QUOT})${LT}/script${GT}`);
assert('escapes & first (no double-encode)', escapeHTML('&lt;'), `${AMP}lt;`);
assert('null -> empty', escapeHTML(null), '');
assert('undefined -> empty', escapeHTML(undefined), '');
assert('number -> string', escapeHTML(42), '42');

console.log('== sanitizeString ==');
assert('trims', sanitizeString('  hello  '), 'hello');
assert('collapses whitespace', sanitizeString('a   b\t\nc'), 'a b c');
assert('strips control chars', sanitizeString('a\x00b\x07c'), 'abc');
assert('respects maxLen', sanitizeString('abcdefghij', 5), 'abcde');
assert('null -> empty', sanitizeString(null), '');
assert('undefined -> empty', sanitizeString(undefined), '');

console.log('== sanitizeMultiline ==');
assert('keeps line breaks', sanitizeMultiline('line1\nline2'), 'line1\nline2');
assert('trims', sanitizeMultiline('  hello  '), 'hello');
assert('strips control chars', sanitizeMultiline('a\x00b'), 'ab');
assert('respects maxLen', sanitizeMultiline('abcdefghij', 4), 'abcd');

console.log('== toNumber ==');
assert('number passthrough', toNumber(42), 42);
assert('string number', toNumber('42'), 42);
assert('float string', toNumber('3.14'), 3.14);
assert('fractional quantity', toNumber('0.125'), 0.125);
assert('three decimal places stay decimal', toNumber('1.234'), 1.234);
assert('scientific notation', toNumber('1e3'), 1000);
assert('negative exponent', toNumber('1e-3'), 0.001);
assert('malformed inner letters rejected', toNumber('12oops34'), 0);
assert('malformed grouping rejected', toNumber('1,23,456'), 0);
assert('malformed mixed grouping rejected', toNumber('12.34,56'), 0);
assert('malformed dot grouping rejected', toNumber('1.2.3'), 0);
assert('fractional comma quantity', toNumber('0,125'), 0.125);
assert('strips non-numeric', toNumber('TZS 1,200.50'), 1200.5);
assert('empty string -> 0', toNumber(''), 0);
assert('null -> 0', toNumber(null), 0);
assert('undefined -> 0', toNumber(undefined), 0);
assert('NaN string -> 0', toNumber('abc'), 0);
assert('Infinity -> 0', toNumber(Infinity), 0);
assert('negative', toNumber('-50'), -50);
assert('keeps minus and dot', toNumber('-1,234.56'), -1234.56);
// Localised / pasted amounts: the separators are interpreted, not deleted.
// Before this was fixed, '1.234,56' became 1.23456 and '2,50' became 250 —
// wrong money stored silently.
assert('comma decimal (2,50 -> 2.5)', toNumber('2,50'), 2.5);
assert('dot grouping + comma decimal', toNumber('1.234,56'), 1234.56);
assert('space grouping + comma decimal', toNumber('1 234,56'), 1234.56);
assert('thousands grouping (1,234)', toNumber('1,234'), 1234);
assert('repeated grouping (1.234.567)', toNumber('1.234.567'), 1234567);
assert('multiple same separator groups', toNumber('1,234,567.89'), 1234567.89);
assert('accounting negative', toNumber('(500)'), -500);
assert('accounting negative with separators', toNumber('(1,234.56)'), -1234.56);
assert('leading plus', toNumber('+1,200'), 1200);
assert('expression -> 0 (no stray sign)', toNumber('0.1+0.2'), 0);
assert('whitespace only -> 0', toNumber('   '), 0);
assert('separators but no digits -> 0', toNumber('.,'), 0);

console.log('== uid ==');
const id1 = uid();
const id2 = uid();
assert('has prefix default', id1.startsWith('id_'), true);
assert('has prefix custom', uid('test').startsWith('test_'), true);
assert('unique', id1 !== id2, true);

console.log('== toISODate ==');
assert('formats date', toISODate(new Date(2026, 0, 5)), '2026-01-05');
assert('formats date with padding', toISODate(new Date(2026, 10, 3)), '2026-11-03');
assert('default is today', toISODate().match(/^\d{4}-\d{2}-\d{2}$/) !== null, true);

console.log('== parseISODate ==');
const d = parseISODate('2026-03-15');
assert('parses year', d.getFullYear(), 2026);
assert('parses month (0-indexed)', d.getMonth(), 2);
assert('parses day', d.getDate(), 15);
assert('empty -> null', parseISODate(''), null);
assert('null -> null', parseISODate(null), null);
assert('invalid -> null', parseISODate('abc'), null);

console.log('== formatDate ==');
assert('formats known date', formatDate('2026-08-02'), '2 Aug 2026');
assert('formats with padding', formatDate('2026-01-05'), '5 Jan 2026');
assert('empty -> dash', formatDate(''), '—');
assert('invalid -> dash', formatDate('xyz'), '—');

console.log('== addDays ==');
assert('add days forward', addDays('2026-01-01', 30), '2026-01-31');
assert('add days across month', addDays('2026-01-31', 1), '2026-02-01');
assert('add days backward', addDays('2026-01-10', -5), '2026-01-05');
assert('add days across year', addDays('2026-12-30', 3), '2027-01-02');

console.log('== initials ==');
assert('single name', initials('John'), 'J');
assert('two names', initials('John Doe'), 'JD');
assert('three names (first two)', initials('John Michael Doe'), 'JM');
assert('extra whitespace', initials('  John   Doe  '), 'JD');
assert('empty -> ?', initials(''), '?');
assert('null -> ?', initials(null), '?');

console.log('== isValidEmail ==');
assert('valid email', isValidEmail('test@example.com'), true);
assert('valid email with subdomain', isValidEmail('a@b.co.tz'), true);
assert('missing @', isValidEmail('testexample.com'), false);
assert('missing domain', isValidEmail('test@'), false);
assert('missing TLD', isValidEmail('test@example'), false);
assert('empty -> false', isValidEmail(''), false);
assert('null -> false', isValidEmail(null), false);

console.log('== isValidPhone ==');
assert('valid phone', isValidPhone('+255 712 345 678'), true);
assert('valid phone digits', isValidPhone('0712345678'), true);
assert('valid phone with parens', isValidPhone('+1 (555) 123-4567'), true);
assert('too short', isValidPhone('123'), false);
assert('empty -> false', isValidPhone(''), false);
assert('null -> false', isValidPhone(null), false);

console.log('== clamp ==');
assert('within range', clamp(5, 0, 10), 5);
assert('below min', clamp(-3, 0, 10), 0);
assert('above max', clamp(15, 0, 10), 10);
assert('at min', clamp(0, 0, 10), 0);
assert('at max', clamp(10, 0, 10), 10);

console.log('== debounce ==');
{
  let calls = 0;
  const fn = debounce(() => calls++, 10);
  fn(); fn(); fn();
  setTimeout(() => {
    assert('debounce single call', calls, 1);

    console.log('== throttle ==');
    {
      let tCalls = 0;
      const tfn = throttle(() => tCalls++, 10);
      tfn(); tfn(); tfn();
      assert('throttle first call immediate', tCalls, 1);
      setTimeout(() => {
        // after window, another call should go through
        tfn();
        assert('throttle allows after window', tCalls, 2);

        console.log(`\n${pass} passed, ${fail} failed`);
        process.exit(fail > 0 ? 1 : 0);
      }, 20);
    }
  }, 20);
}
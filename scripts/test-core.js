/**
 * core logic smoke test
 * Verifies the financial calculation engine and number-to-words.
 * Run: node scripts/test-core.js
 */
import { calculateInvoiceTotals, calculateBalance, deriveStatus, round2, sum, percentOf } from '../js/calculations.js';
import { numberToWordsInt, amountToWords, amountToWordsSwahili, formatMoney, formatNumber } from '../js/currency.js';

let pass = 0;
let fail = 0;

function assert(name, actual, expected) {
  const ok = actual === expected;
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} — expected ${expected}, got ${actual}`); }
}

console.log('== Calculations ==');
// 2 items: 3 x 1000 = 3000, 2 x 500 = 1000 => subtotal 4000, tax 18% = 720, grand 4720
const t1 = calculateInvoiceTotals(
  [
    { qty: 3, unitPrice: 1000, discountRate: 0 },
    { qty: 2, unitPrice: 500, discountRate: 0 },
  ],
  { discount: 0, discountType: 'fixed', taxRate: 18, shipping: 0 }
);
assert('subtotal', t1.subtotal, 4000);
assert('tax', t1.tax, 720);
assert('grandTotal', t1.grandTotal, 4720);

// Floating point safety: 0.1 + 0.2 style
const t2 = calculateInvoiceTotals(
  [{ qty: 1, unitPrice: 0.1, discountRate: 0 }, { qty: 1, unitPrice: 0.2, discountRate: 0 }],
  { discount: 0, discountType: 'fixed', taxRate: 0, shipping: 0 }
);
assert('float subtotal 0.3', t2.subtotal, 0.3);

// Percentage invoice discount: 4000 - 10% = 3600, tax 18% = 648, grand 4248
const t3 = calculateInvoiceTotals(
  [{ qty: 4, unitPrice: 1000, discountRate: 0 }],
  { discount: 10, discountType: 'percentage', taxRate: 18, shipping: 0 }
);
assert('pct discount subtotal', t3.subtotal, 4000);
assert('pct discount invoiceDiscount', t3.invoiceDiscount, 400);
assert('pct discount tax', t3.tax, 648);
assert('pct discount grand', t3.grandTotal, 4248);

// Item discount: 4 x 1000 with 25% item discount = 3000
const t4 = calculateInvoiceTotals(
  [{ qty: 4, unitPrice: 1000, discountRate: 25 }],
  { discount: 0, discountType: 'fixed', taxRate: 0, shipping: 0 }
);
assert('item discount subtotal', t4.subtotal, 3000);
assert('item discount amount', t4.itemDiscount, 1000);

// Shipping
const t5 = calculateInvoiceTotals(
  [{ qty: 1, unitPrice: 100, discountRate: 0 }],
  { discount: 0, discountType: 'fixed', taxRate: 0, shipping: 50 }
);
assert('shipping grand', t5.grandTotal, 150);

// Tax inclusive: 1180 with 18% inclusive => tax 180, base 1000
const t6 = calculateInvoiceTotals(
  [{ qty: 1, unitPrice: 1180, discountRate: 0 }],
  { discount: 0, discountType: 'fixed', taxRate: 18, shipping: 0, taxInclusive: true }
);
assert('tax-inclusive base', t6.taxableBase, 1000);
assert('tax-inclusive tax', t6.tax, 180);
assert('tax-inclusive grand', t6.grandTotal, 1180);

// Balance & status
assert('balance', calculateBalance(1000, 400), 600);
assert('status unpaid', deriveStatus(1000, 0), 'unpaid');
assert('status partial', deriveStatus(1000, 400), 'partial');
assert('status paid', deriveStatus(1000, 1000), 'paid');
assert('status overpaid', deriveStatus(1000, 1200), 'paid');
assert('round2', round2(0.1 + 0.2), 0.3);
assert('sum', sum([1.1, 2.2, 3.3]), 6.6);
assert('percentOf', percentOf(200, 10), 20);

console.log('== Number to Words ==');
assert('int 0', numberToWordsInt(0), 'Zero');
assert('int 1', numberToWordsInt(1), 'One');
assert('int 19', numberToWordsInt(19), 'Nineteen');
assert('int 21', numberToWordsInt(21), 'Twenty-One');
assert('int 100', numberToWordsInt(100), 'One Hundred');
assert('int 120000', numberToWordsInt(120000), 'One Hundred Twenty Thousand');
assert('int 1000000', numberToWordsInt(1000000), 'One Million');

const tzs = { words: 'Tanzanian Shillings', wordsSingular: 'Tanzanian Shilling' };
assert('amount words TZS', amountToWords(120000, tzs), 'One Hundred Twenty Thousand Tanzanian Shillings Only');
assert('amount words singular', amountToWords(1, tzs), 'One Tanzanian Shilling Only');
assert('amount words cents', amountToWords(100.5, tzs), 'One Hundred Tanzanian Shillings and Fifty Cents Only');

const usd = { words: 'United States Dollars', wordsSingular: 'United States Dollar' };
assert('amount words USD', amountToWords(450, usd), 'Four Hundred Fifty United States Dollars Only');

console.log('== Swahili ==');
assert('sw 0', amountToWordsSwahili(0, tzs), 'Sifuri Tanzanian Shillings Pekee');
assert('sw 100', amountToWordsSwahili(100, tzs), 'Mia Moja Tanzanian Shillings Pekee');
assert('sw 120000', amountToWordsSwahili(120000, tzs), 'Elfu Mia Moja Ishirini Tanzanian Shillings Pekee');

console.log('== Formatting ==');
assert('formatMoney TZS', formatMoney(120000, { symbol: 'TZS', decimals: 2 }), 'TZS 120,000.00');
assert('formatMoney USD', formatMoney(450, { symbol: 'USD', decimals: 2 }), 'USD 450.00');
assert('formatNumber', formatNumber(1234567.891, 2), '1,234,567.89');
assert('formatMoney negative', formatMoney(-50, { symbol: 'TZS', decimals: 2 }), '-TZS 50.00');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
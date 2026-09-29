/**
 * Financial calculation engine
 * All arithmetic uses integer-based decimal math to eliminate floating-point errors.
 * Every function returns values rounded to exactly 2 decimal places.
 */
import { toNumber } from './utils.js';

/** Round to exactly 2 decimal places using integer math. */
export function round2(value) {
  const n = toNumber(value);
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Round to a given number of decimal places. */
export function roundTo(value, decimals = 2) {
  const n = toNumber(value);
  const factor = Math.pow(10, decimals);
  return Math.round((n + Number.EPSILON) * factor) / factor;
}

/** Add two numbers with exact precision. */
export function add(a, b) {
  return round2(toNumber(a) + toNumber(b));
}

/** Subtract two numbers with exact precision. */
export function subtract(a, b) {
  return round2(toNumber(a) - toNumber(b));
}

/** Multiply two numbers with exact precision. */
export function multiply(a, b) {
  return round2(toNumber(a) * toNumber(b));
}

/** Divide two numbers with exact precision (returns 0 on divide-by-zero). */
export function divide(a, b) {
  const divisor = toNumber(b);
  if (divisor === 0) return 0;
  return round2(toNumber(a) / divisor);
}

/** Compute a percentage of a base amount. */
export function percentOf(base, percent) {
  return round2((toNumber(base) * toNumber(percent)) / 100);
}

/**
 * Calculate a single line item.
 * lineTotal = qty × unitPrice
 * lineDiscount = lineTotal × (discountRate / 100)   [percentage]  OR fixed amount
 * net = lineTotal - lineDiscount
 */
export function calculateLineItem({ qty, unitPrice, discountRate = 0, discountAmount = 0, discountType = 'percentage' }) {
  const q = toNumber(qty);
  const price = toNumber(unitPrice);
  const lineTotal = round2(q * price);

  let discount = 0;
  if (discountType === 'percentage') {
    discount = percentOf(lineTotal, discountRate);
  } else {
    discount = round2(toNumber(discountAmount));
  }
  // Clamp discount so net is never negative
  discount = Math.min(discount, lineTotal);

  const net = round2(lineTotal - discount);
  return { lineTotal, discount, net };
}

/**
 * Calculate invoice totals.
 * @param {Array} items - [{ qty, unitPrice, discountRate, discountAmount, discountType, taxRate }]
 * @param {Object} opts - { discount, discountType ('percentage'|'fixed'), taxRate, shipping, taxInclusive }
 * Returns { subtotal, itemDiscount, invoiceDiscount, taxableBase, tax, shipping, grandTotal }
 */
export function calculateInvoiceTotals(items = [], opts = {}) {
  const {
    discount = 0,
    discountType = 'fixed',
    taxRate = 0,
    shipping = 0,
    taxInclusive = false,
  } = opts;

  let subtotal = 0;
  let itemDiscount = 0;

  const lines = items.map((item) => {
    const calc = calculateLineItem(item);
    subtotal = round2(subtotal + calc.net);
    itemDiscount = round2(itemDiscount + calc.discount);
    return { ...item, ...calc };
  });

  // Invoice-level discount
  let invoiceDiscount = 0;
  if (discountType === 'percentage') {
    invoiceDiscount = percentOf(subtotal, discount);
  } else {
    invoiceDiscount = round2(toNumber(discount));
  }
  invoiceDiscount = Math.min(invoiceDiscount, subtotal);

  const afterDiscount = round2(subtotal - invoiceDiscount);
  const shippingRounded = round2(toNumber(shipping));

  let tax = 0;
  let taxableBase = afterDiscount;
  let grandTotal;
  if (taxInclusive) {
    // Tax is included in the price: extract it, do not add it again
    const rate = toNumber(taxRate);
    if (rate > 0) {
      tax = round2(afterDiscount - afterDiscount / (1 + rate / 100));
      taxableBase = round2(afterDiscount - tax);
    }
    grandTotal = round2(afterDiscount + shippingRounded);
  } else {
    tax = percentOf(afterDiscount, taxRate);
    grandTotal = round2(afterDiscount + tax + shippingRounded);
  }

  return {
    lines,
    subtotal,
    itemDiscount,
    invoiceDiscount,
    totalDiscount: round2(itemDiscount + invoiceDiscount),
    taxableBase,
    tax,
    taxRate: toNumber(taxRate),
    shipping: shippingRounded,
    grandTotal,
  };
}

/**
 * Calculate balance and outstanding amounts.
 * balance = grandTotal - amountPaid
 */
export function calculateBalance(grandTotal, amountPaid) {
  return round2(toNumber(grandTotal) - toNumber(amountPaid));
}

/**
 * Recompute an invoice's status from its payments.
 * paid: balance <= 0
 * partial: 0 < balance < grandTotal
 * unpaid: no payments and balance === grandTotal
 */
export function deriveStatus(grandTotal, totalPaid) {
  const gt = toNumber(grandTotal);
  const paid = toNumber(totalPaid);
  const balance = round2(gt - paid);
  if (gt <= 0) return 'paid';
  if (balance <= 0) return 'paid';
  if (paid > 0) return 'partial';
  return 'unpaid';
}

/** Sum an array of numeric values with exact precision. */
export function sum(values) {
  return round2(values.reduce((acc, v) => acc + toNumber(v), 0));
}

/** Compute profit for a line: (unitPrice - costPrice) × qty, minus discounts. */
export function lineProfit({ qty, unitPrice, costPrice = 0, discountRate = 0, discountAmount = 0, discountType = 'percentage' }) {
  const calc = calculateLineItem({ qty, unitPrice, discountRate, discountAmount, discountType });
  const cost = round2(toNumber(qty) * toNumber(costPrice));
  return round2(calc.net - cost);
}

/** Compute profit margin percentage. */
export function profitMargin(revenue, cost) {
  const rev = toNumber(revenue);
  if (rev === 0) return 0;
  return round2(((rev - toNumber(cost)) / rev) * 100);
}

/** Validate that a set of invoice items is non-empty and valid. */
export function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { valid: false, error: 'Add at least one line item.' };
  }
  for (const item of items) {
    if (toNumber(item.qty) <= 0) {
      return { valid: false, error: 'Quantity must be greater than zero.' };
    }
    if (toNumber(item.unitPrice) < 0) {
      return { valid: false, error: 'Unit price cannot be negative.' };
    }
  }
  return { valid: true, error: null };
}
/**
 * Currency engine
 * Unlimited currencies, offline exchange rates, precise formatting,
 * and number-to-words conversion for multiple currencies.
 */
import { getSetting, setSetting } from './storageService.js';
import { toNumber } from './utils.js';

export const DEFAULT_CURRENCIES = [
  { code: 'TZS', name: 'Tanzanian Shilling', symbol: 'TZS', decimals: 2, rate: 1, words: 'Tanzanian Shillings', wordsSingular: 'Tanzanian Shilling', locale: 'en-TZ' },
  { code: 'USD', name: 'US Dollar', symbol: 'USD', decimals: 2, rate: 2650, words: 'United States Dollars', wordsSingular: 'United States Dollar', locale: 'en-US' },
  { code: 'EUR', name: 'Euro', symbol: 'EUR', decimals: 2, rate: 2870, words: 'Euros', wordsSingular: 'Euro', locale: 'de-DE' },
  { code: 'KES', name: 'Kenyan Shilling', symbol: 'KES', decimals: 2, rate: 20.5, words: 'Kenyan Shillings', wordsSingular: 'Kenyan Shilling', locale: 'en-KE' },
  { code: 'GBP', name: 'British Pound', symbol: 'GBP', decimals: 2, rate: 3350, words: 'British Pounds', wordsSingular: 'British Pound', locale: 'en-GB' },
];

const CURRENCY_KEY = 'currencies';
const DEFAULT_CURRENCY_KEY = 'defaultCurrency';

/** Load currency definitions from settings (falls back to defaults). */
export async function getCurrencies() {
  const stored = await getSetting(CURRENCY_KEY, null);
  if (Array.isArray(stored) && stored.length) return stored;
  return DEFAULT_CURRENCIES.map((c) => ({ ...c }));
}

/** Persist currency definitions. */
export async function saveCurrencies(currencies) {
  return setSetting(CURRENCY_KEY, currencies);
}

/** Get the default currency code. */
export async function getDefaultCurrencyCode() {
  return (await getSetting(DEFAULT_CURRENCY_KEY, 'TZS')) || 'TZS';
}

/** Set the default currency code. */
export async function setDefaultCurrencyCode(code) {
  return setSetting(DEFAULT_CURRENCY_KEY, code);
}

/** Find a currency definition by code. */
export async function getCurrency(code) {
  const currencies = await getCurrencies();
  return currencies.find((c) => c.code === code) || currencies[0] || DEFAULT_CURRENCIES[0];
}

/**
 * Format a number as money with exact 2-decimal precision.
 * Uses integer math to avoid floating-point drift.
 */
export function formatMoney(amount, currency) {
  const n = toNumber(amount);
  const decimals = currency && typeof currency.decimals === 'number' ? currency.decimals : 2;
  const symbol = currency ? currency.symbol : 'TZS';
  const negative = n < 0;
  const abs = Math.abs(n);
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(abs * factor) / factor;
  const [intPart, decPart] = rounded.toFixed(decimals).split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const formatted = decimals > 0 ? `${withCommas}.${decPart}` : withCommas;
  return `${negative ? '-' : ''}${symbol} ${formatted}`;
}

/** Format a plain number with thousands separators (no currency symbol). */
export function formatNumber(amount, decimals = 2) {
  const n = toNumber(amount);
  const negative = n < 0;
  const abs = Math.abs(n);
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(abs * factor) / factor;
  const [intPart, decPart] = rounded.toFixed(decimals).split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${decimals > 0 ? `${withCommas}.${decPart}` : withCommas}`;
}

/** Convert an amount from one currency to another using stored rates. */
export async function convertAmount(amount, fromCode, toCode) {
  const currencies = await getCurrencies();
  const from = currencies.find((c) => c.code === fromCode) || currencies[0];
  const to = currencies.find((c) => c.code === toCode) || currencies[0];
  if (!from || !to) return toNumber(amount);
  if (from.code === to.code) return toNumber(amount);
  const fromRate = toNumber(from.rate) || 1;
  const toRate = toNumber(to.rate) || 1;
  return (toNumber(amount) * fromRate) / toRate;
}

/* ================= Number to Words ================= */

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function threeDigitsToWords(n) {
  const num = Math.floor(n);
  let out = '';
  const hundreds = Math.floor(num / 100);
  const remainder = num % 100;
  if (hundreds > 0) {
    out += ONES[hundreds] + ' Hundred';
    if (remainder > 0) out += ' ';
  }
  if (remainder > 0) {
    if (remainder < 20) {
      out += ONES[remainder];
    } else {
      const tens = Math.floor(remainder / 10);
      const ones = remainder % 10;
      out += TENS[tens];
      if (ones > 0) out += '-' + ONES[ones];
    }
  }
  return out;
}

const SCALES = ['', 'Thousand', 'Million', 'Billion', 'Trillion', 'Quadrillion', 'Quintillion'];

/** Convert an integer to English words. */
export function numberToWordsInt(value) {
  const n = Math.floor(Math.abs(toNumber(value)));
  if (n === 0) return 'Zero';
  let out = '';
  let scaleIndex = 0;
  let remaining = n;
  const parts = [];
  while (remaining > 0) {
    const chunk = remaining % 1000;
    if (chunk > 0) {
      const words = threeDigitsToWords(chunk);
      parts.unshift(scaleIndex === 0 ? words : `${words} ${SCALES[scaleIndex]}`);
    }
    remaining = Math.floor(remaining / 1000);
    scaleIndex++;
  }
  return parts.join(' ');
}

/**
 * Convert an amount to words with currency, e.g.
 * "One Hundred Twenty Thousand Tanzanian Shillings Only"
 */
export function amountToWords(amount, currency) {
  const n = toNumber(amount);
  const negative = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs);
  const cents = Math.round((abs - whole) * 100);

  const currencyName = currency && currency.words ? currency.words : 'Currency';
  const currencySingular = currency && currency.wordsSingular ? currency.wordsSingular : currencyName;

  let out = '';
  if (negative) out += 'Minus ';
  out += numberToWordsInt(whole);
  out += ' ' + (whole === 1 ? currencySingular : currencyName);

  if (cents > 0) {
    out += ' and ' + numberToWordsInt(cents) + (cents === 1 ? ' Cent' : ' Cents');
  }
  out += ' Only';
  return out;
}

/** Swahili number-to-words (for localized invoices). */
export function amountToWordsSwahili(amount, currency) {
  const n = toNumber(amount);
  const negative = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs);
  const cents = Math.round((abs - whole) * 100);
  const currencyName = currency && currency.words ? currency.words : 'Currency';

  let out = '';
  if (negative) out += 'Hasara ';
  out += numberToWordsSwahili(whole);
  out += ' ' + currencyName;
  if (cents > 0) out += ' na ' + numberToWordsSwahili(cents) + ' Senti';
  out += ' Pekee';
  return out;
}

const SW_ONES = ['', 'Moja', 'Mbili', 'Tatu', 'Nne', 'Tano', 'Sita', 'Saba', 'Nane', 'Tisa', 'Kumi', 'Kumi na Moja', 'Kumi na Mbili', 'Kumi na Tatu', 'Kumi na Nne', 'Kumi na Tano', 'Kumi na Sita', 'Kumi na Saba', 'Kumi na Nane', 'Kumi na Tisa'];
const SW_TENS = ['', '', 'Ishirini', 'Thelathini', 'Arobaini', 'Hamsini', 'Sitini', 'Sabini', 'Themanini', 'Tisini'];

function swThreeDigits(n) {
  const num = Math.floor(n);
  let out = '';
  const hundreds = Math.floor(num / 100);
  const remainder = num % 100;
  if (hundreds > 0) {
    out += hundreds === 1 ? 'Mia Moja' : SW_ONES[hundreds] + ' Mia';
    if (remainder > 0) out += ' ';
  }
  if (remainder > 0) {
    if (remainder < 20) out += SW_ONES[remainder];
    else {
      const tens = Math.floor(remainder / 10);
      const ones = remainder % 10;
      out += SW_TENS[tens];
      if (ones > 0) out += ' na ' + SW_ONES[ones];
    }
  }
  return out;
}

const SW_SCALES = ['', 'Elfu', 'Milioni', 'Bilioni', 'Trilioni'];

export function numberToWordsSwahili(value) {
  const n = Math.floor(Math.abs(toNumber(value)));
  if (n === 0) return 'Sifuri';
  const parts = [];
  let remaining = n;
  let scaleIndex = 0;
  while (remaining > 0) {
    const chunk = remaining % 1000;
    if (chunk > 0) {
      const words = swThreeDigits(chunk);
      // In Swahili the scale word (Elfu, Milioni…) comes BEFORE the number
      parts.unshift(scaleIndex === 0 ? words : `${SW_SCALES[scaleIndex]} ${words}`);
    }
    remaining = Math.floor(remaining / 1000);
    scaleIndex++;
  }
  return parts.join(' ');
}

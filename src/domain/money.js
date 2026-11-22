import Decimal from 'decimal.js';

import { ValidationError } from './errors.js';

// Money and unit costs are rounded half up everywhere: PostgreSQL numeric
// division and JavaScript `Math.round` would disagree on .5 otherwise.
Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

const LOCALE = 'ru-BY';
const COST_DECIMALS = 4;
const MONEY_DECIMALS = 2;
const NUMERIC_MESSAGE = 'Сумма должна быть числом.';

// Intl inserts U+00A0 (and U+202F/U+2009 in some ICU builds) between digit
// groups. Normalising to a plain space keeps templates, tests and CSV output
// free of invisible characters.
const GROUP_SPACES = /[\u00A0\u2009\u202F]/g;

const moneyFormatter = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: MONEY_DECIMALS,
  maximumFractionDigits: MONEY_DECIMALS,
});

const qtyFormatter = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });

export { Decimal };

/**
 * Parse a value that came from PostgreSQL `numeric` (always a string there),
 * a form field or a domain calculation into a Decimal.
 *
 * Numbers are accepted for computed in-process values, but prices and costs
 * read from the database must stay strings so no binary float ever touches
 * them. Invalid input fails loudly instead of producing NaN downstream.
 *
 * @param {string|number|Decimal} value
 * @returns {Decimal}
 * @throws {ValidationError} when the value is not a finite number
 */
export function d(value) {
  if (Decimal.isDecimal(value)) return value;

  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ValidationError(NUMERIC_MESSAGE);
  }

  let decimal;
  try {
    decimal = new Decimal(value);
  } catch {
    // Decimal's own error text is English and internal; the user-facing
    // contract is the Russian ValidationError.
    throw new ValidationError(NUMERIC_MESSAGE);
  }

  if (!decimal.isFinite()) throw new ValidationError(NUMERIC_MESSAGE);
  return decimal;
}

/**
 * Storage representation for unit costs and document totals: `numeric(14,4)`
 * compatible, four decimals, half-up.
 *
 * @param {string|number|Decimal} value
 * @returns {string} e.g. `"67.5000"`
 */
export function toCost(value) {
  return d(value).toFixed(COST_DECIMALS);
}

/**
 * Display amount with `ru-BY` grouping, comma decimals and a regular space
 * between digit groups. The BYN sign is added in the view, not here.
 *
 * @param {string|number|Decimal} value
 * @returns {string} e.g. `"1 234,50"`
 */
export function formatMoney(value) {
  const rounded = d(value).toFixed(MONEY_DECIMALS);
  return moneyFormatter.format(rounded).replaceAll(GROUP_SPACES, ' ');
}

/**
 * Display quantity with `ru-BY` grouping. Quantities are whole pieces, so no
 * fractional digits are shown.
 *
 * @param {string|number|Decimal} value
 * @returns {string} e.g. `"1 234 567"`
 */
export function formatQty(value) {
  const rounded = d(value).toFixed(0);
  return qtyFormatter.format(rounded).replaceAll(GROUP_SPACES, ' ');
}

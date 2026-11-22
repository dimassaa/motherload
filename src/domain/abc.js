import { ABC_A, ABC_B } from '../config/inventory.js';
import { ValidationError } from './errors.js';
import { d } from './money.js';

const VALUE_MESSAGE = 'Стоимость позиции должна быть неотрицательным числом.';
// Shares are displayed with four decimals; classification uses the exact
// cumulative share so a boundary is never moved by display rounding.
const SHARE_DECIMALS = 4;

function readValue(value) {
  const amount = d(value);
  if (amount.isNegative()) throw new ValidationError(VALUE_MESSAGE);
  return amount;
}

function toDisplayNumber(decimal) {
  return Number(decimal.toFixed(SHARE_DECIMALS));
}

/**
 * Classify inventory positions by their share of total stock value (ABC).
 *
 * Items are ordered by value descending, then by `id` ascending, so equal
 * values and repeated runs produce the same class assignment. Boundaries are
 * inclusive and belong to the better class: a position whose cumulative share
 * is exactly 0.80 is A, exactly 0.95 is B.
 *
 * Items worth nothing are always C: they cannot meaningfully contribute to the
 * Pareto split. When the whole selection is worth nothing every share is 0 and
 * every class is C, so no NaN reaches the view.
 *
 * @param {Array<{ id: number, value: string|number }>} items values as
 *   PostgreSQL `numeric` strings; numbers are accepted only for computed values
 * @param {{ a?: number, b?: number }} [thresholds] cumulative share limits
 * @returns {Array<{ id: number, value: string|number, share: number, cumulativeShare: number, class: 'A'|'B'|'C' }>}
 *   `value` is echoed unchanged for the view layer
 * @throws {ValidationError} when a value is not a finite non-negative number
 */
export function classifyAbc(items, { a = ABC_A, b = ABC_B } = {}) {
  const prepared = items.map(({ id, value }) => ({ id, value, amount: readValue(value) }));

  const total = prepared.reduce((sum, item) => sum.plus(item.amount), d(0));

  prepared.sort((left, right) => {
    const byValue = right.amount.comparedTo(left.amount);
    if (byValue !== 0) return byValue;
    return left.id - right.id;
  });

  const limitA = d(a);
  const limitB = d(b);
  let cumulative = d(0);

  return prepared.map((item) => {
    const share = total.isZero() ? d(0) : item.amount.div(total);
    cumulative = cumulative.plus(share);

    let className = 'C';
    if (!item.amount.isZero()) {
      if (cumulative.lte(limitA)) className = 'A';
      else if (cumulative.lte(limitB)) className = 'B';
    }

    return {
      id: item.id,
      value: item.value,
      share: toDisplayNumber(share),
      cumulativeShare: toDisplayNumber(cumulative),
      class: className,
    };
  });
}

import { XYZ_MONTHS, XYZ_X, XYZ_Y } from '../config/inventory.js';
import { ValidationError } from './errors.js';
import { d } from './money.js';

const WINDOW_MESSAGE = `Для XYZ нужен расход ровно за ${XYZ_MONTHS} месяцев.`;
const QUANTITY_MESSAGE = 'Месячный расход должен быть неотрицательным числом.';
const CV_DECIMALS = 4;

function readQuantity(quantity) {
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) {
    throw new ValidationError(QUANTITY_MESSAGE);
  }
  return d(quantity);
}

/**
 * Classify demand regularity over six full months (XYZ).
 *
 * The variation coefficient uses the population standard deviation, because
 * the six months are the whole observation window rather than a sample of it.
 * Class limits are inclusive: cv exactly 0.10 is X, exactly 0.25 is Y. A zero
 * mean carries no variation information at all, so it reports `cv: null` and
 * class Z instead of dividing by zero.
 *
 * @param {number[]} monthlyQuantities six months of issue quantity, zeros included
 * @returns {{ cv: number|null, class: 'X'|'Y'|'Z' }}
 * @throws {ValidationError} when the window is not exactly six non-negative numbers
 */
export function classifyXyz(monthlyQuantities) {
  if (!Array.isArray(monthlyQuantities) || monthlyQuantities.length !== XYZ_MONTHS) {
    throw new ValidationError(WINDOW_MESSAGE);
  }

  const quantities = monthlyQuantities.map(readQuantity);
  const total = quantities.reduce((sum, quantity) => sum.plus(quantity), d(0));
  const mean = total.div(XYZ_MONTHS);

  if (mean.isZero()) return { cv: null, class: 'Z' };

  const variance = quantities
    .reduce((sum, quantity) => sum.plus(quantity.minus(mean).pow(2)), d(0))
    .div(XYZ_MONTHS);
  const cv = variance.sqrt().div(mean);

  let className = 'Z';
  if (cv.lte(d(XYZ_X))) className = 'X';
  else if (cv.lte(d(XYZ_Y))) className = 'Y';

  return { cv: Number(cv.toFixed(CV_DECIMALS)), class: className };
}

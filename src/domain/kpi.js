import { DEMAND_WINDOW_DAYS } from '../config/inventory.js';
import { d } from './money.js';

// The COGS window is one quarter, so four windows make a year. The spec
// annualises with a plain factor of four instead of 365/90 to keep the KPI
// comparable with the quarterly reports shown next to it.
const WINDOWS_PER_YEAR = 4;
const TURNOVER_DECIMALS = 4;
const DAYS_DECIMALS = 2;

/**
 * Stock turnover and coverage from stock value and the 90-day COGS.
 *
 * Both ratios are undefined rather than infinite when their denominator is
 * zero: turnover without stock, coverage without consumption. Callers render
 * `null` as "нет данных" instead of an impossible number.
 *
 * `deadValue` is accepted because every KPI caller already has it, but the
 * dead-stock share is derived in the report layer; returning it here would
 * duplicate a value this function does not compute.
 *
 * @param {{ stockValue: string|number, cogs90: string|number, deadValue?: string|number }} input
 *   money as `numeric` strings
 * @returns {{ turnoverYear: number|null, coverageDays: number|null }}
 */
export function calculateKpi({ stockValue, cogs90 }) {
  const stock = d(stockValue);
  const cogs = d(cogs90);

  const turnoverYear = stock.isZero()
    ? null
    : Number(cogs.div(stock).times(WINDOWS_PER_YEAR).toFixed(TURNOVER_DECIMALS));

  // Multiply before dividing so whole-day coverage stays exact for integer
  // money instead of inheriting the rounding of cogs / 90.
  const coverageDays = cogs.isZero()
    ? null
    : Number(stock.times(DEMAND_WINDOW_DAYS).div(cogs).toFixed(DAYS_DECIMALS));

  return { turnoverYear, coverageDays };
}

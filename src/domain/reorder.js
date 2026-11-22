import {
  DEMAND_WINDOW_DAYS,
  HOLDING_RATE,
  MIN_HISTORY_DAYS,
  ORDER_COST_BYN,
  SERVICE_LEVEL_Z,
} from '../config/inventory.js';
import { ValidationError } from './errors.js';
import { Decimal, d } from './money.js';

// The demand window is a rolling 90 days; annual demand scales it to a full
// year so EOQ is comparable across positions.
const DAYS_PER_YEAR = 365;
const AVG_DECIMALS = 4;
const QUANTITY_DECIMALS = 2;

const QUANTITIES_MESSAGE = 'Дневной расход должен быть массивом неотрицательных чисел.';
const WINDOW_MESSAGE = `Дневной расход должен содержать ровно ${DEMAND_WINDOW_DAYS} дней.`;
const NUMBER_MESSAGE = 'Параметр должен быть неотрицательным числом.';

function assertQuantities(dailyQuantities) {
  if (!Array.isArray(dailyQuantities) || dailyQuantities.length !== DEMAND_WINDOW_DAYS) {
    throw new ValidationError(WINDOW_MESSAGE);
  }
  for (const quantity of dailyQuantities) {
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) {
      throw new ValidationError(QUANTITIES_MESSAGE);
    }
  }
}

function assertNonNegativeNumber(value, message = NUMBER_MESSAGE) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(message);
  }
}

function roundTo(decimal, places) {
  return Number(decimal.toFixed(places));
}

/**
 * Reorder point, safety stock and economic order quantity for one
 * component/warehouse pair.
 *
 * The caller owns the window contents but not its length: `dailyQuantities`
 * must be exactly `DEMAND_WINDOW_DAYS` (90) entries with quiet days included as
 * zeros, because spec §6.6 fixes the divisor at 90. A shorter array would
 * inflate the average and silently raise the reorder point, so it is rejected.
 * `historyDays` is separate: it counts days since the first movement and only
 * decides whether the statistics are trustworthy (`lowData`).
 *
 * With little history the demand statistics cannot be trusted, so the reorder
 * point falls back to the configured minimum stock and the suggestion tops the
 * balance up to it. The raw statistics are still returned for the "мало
 * данных" badge, but `rop` and `suggested` follow the fallback.
 *
 * @param {{
 *   dailyQuantities: number[],
 *   historyDays?: number,
 *   leadTimeDays: number,
 *   minStock: number,
 *   balance: number,
 *   unitCost: string|number,
 * }} input unit cost from `numeric(14,4)`; quantities are whole pieces
 * @returns {{
 *   avgDaily: number,
 *   stddev: number,
 *   safetyStock: number,
 *   rop: number,
 *   eoq: number,
 *   suggested: number,
 *   lowData: boolean,
 * }}
 * @throws {ValidationError} for missing or negative input, non-numeric unit cost
 */
export function calculateReorder({
  dailyQuantities,
  historyDays = dailyQuantities?.length,
  leadTimeDays,
  minStock,
  balance,
  unitCost,
}) {
  assertQuantities(dailyQuantities);
  assertNonNegativeNumber(historyDays);
  assertNonNegativeNumber(leadTimeDays);
  assertNonNegativeNumber(minStock);
  assertNonNegativeNumber(balance);

  const unitCostDecimal = d(unitCost);

  const total = dailyQuantities.reduce((sum, quantity) => sum + quantity, 0);
  const avgDaily = d(total).div(DEMAND_WINDOW_DAYS);
  const variance = dailyQuantities
    .reduce((sum, quantity) => sum.plus(d(quantity).minus(avgDaily).pow(2)), d(0))
    .div(DEMAND_WINDOW_DAYS);
  const stddev = variance.sqrt();

  const leadTime = d(leadTimeDays);
  const safetyStock = d(SERVICE_LEVEL_Z).times(stddev).times(leadTime.sqrt());

  const lowData = historyDays < MIN_HISTORY_DAYS;
  const minStockDecimal = d(minStock);
  const balanceDecimal = d(balance);

  const rop = lowData ? minStockDecimal : avgDaily.times(leadTime).plus(safetyStock);

  const annualDemand = avgDaily.times(DAYS_PER_YEAR);
  const eoq = unitCostDecimal.lte(0)
    ? d(0)
    : d(2)
        .times(annualDemand)
        .times(d(ORDER_COST_BYN))
        .div(unitCostDecimal.times(d(HOLDING_RATE)))
        .sqrt();

  const suggested = lowData
    ? Decimal.max(d(0), minStockDecimal.minus(balanceDecimal)).ceil()
    : balanceDecimal.lte(rop)
      ? eoq.ceil()
      : d(0);

  return {
    avgDaily: roundTo(avgDaily, AVG_DECIMALS),
    stddev: roundTo(stddev, AVG_DECIMALS),
    safetyStock: roundTo(safetyStock, QUANTITY_DECIMALS),
    rop: roundTo(rop, QUANTITY_DECIMALS),
    eoq: roundTo(eoq, QUANTITY_DECIMALS),
    suggested: Number(suggested),
    lowData,
  };
}

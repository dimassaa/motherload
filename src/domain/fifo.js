import { InsufficientStockError, ValidationError } from './errors.js';
import { d } from './money.js';

const QUANTITY_MESSAGE = 'Количество должно быть целым положительным числом.';

function assertQuantity(quantity) {
  // A fractional or non-positive issue quantity means a validation bug or a
  // bypassed form check; allocating it would corrupt the ledger silently.
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
    throw new ValidationError(QUANTITY_MESSAGE);
  }
}

/**
 * Allocate a quantity across stock batches in FIFO order.
 *
 * The caller passes batches already scoped to one component and warehouse; this
 * function only orders them. Sort keys are `(received_at, id)` because two
 * receipts on the same date must still consume in a stable, reproducible order.
 * `receivedAt` is the `YYYY-MM-DD` string the repository preserves for `date`
 * columns, so lexicographic comparison matches chronological order.
 *
 * Pure: neither the batch array nor its objects are mutated.
 *
 * @param {Array<{ id: number, unitCost: string, qtyRemaining: number, receivedAt: string }>} batches
 * @param {number} quantity whole units to consume, greater than zero
 * @returns {{
 *   allocations: Array<{ batchId: number, qty: number, unitCost: string, totalCost: string }>,
 *   totalCost: string,
 * }} four-decimal money strings, allocation totals summing exactly to `totalCost`
 * @throws {ValidationError} when `quantity` is not a positive integer
 * @throws {InsufficientStockError} when the batches cannot cover `quantity`
 */
export function allocateFifo(batches, quantity) {
  assertQuantity(quantity);

  const ordered = [...batches].sort((left, right) => {
    if (left.receivedAt !== right.receivedAt) {
      return left.receivedAt < right.receivedAt ? -1 : 1;
    }
    return left.id - right.id;
  });

  const available = ordered.reduce(
    (sum, batch) => sum + (batch.qtyRemaining > 0 ? batch.qtyRemaining : 0),
    0,
  );

  let remaining = quantity;
  const allocations = [];
  let totalCost = d(0);

  for (const batch of ordered) {
    if (remaining === 0) break;
    if (batch.qtyRemaining <= 0) continue;

    const qty = Math.min(batch.qtyRemaining, remaining);
    // Unit costs come from `numeric(14,4)`; normalising before multiplying
    // keeps the stored allocation consistent with its stored unit cost.
    const unitCost = d(batch.unitCost).toDecimalPlaces(4);
    const cost = unitCost.times(qty);

    allocations.push({
      batchId: batch.id,
      qty,
      unitCost: unitCost.toFixed(4),
      totalCost: cost.toFixed(4),
    });

    totalCost = totalCost.plus(cost);
    remaining -= qty;
  }

  if (remaining > 0) throw new InsufficientStockError(available);

  return { allocations, totalCost: totalCost.toFixed(4) };
}

/**
 * Stock status used by the catalog summary and the per-warehouse card rows.
 *
 * Keeping the rule in one pure function prevents the list and the card from
 * disagreeing about a warehouse that is simply empty: zero stock is its own
 * status and outranks "below minimum", while `below_min` means positive stock
 * that has not reached the threshold yet.
 */

/** Higher rank wins when the catalog summarises several warehouses. */
export const STOCK_STATUS_SEVERITY = Object.freeze({
  zero: 3,
  below_min: 2,
  overstock: 1,
  ok: 0,
});

/**
 * Classify one component/warehouse pair.
 * @param {{ qty: number, minStock?: number, maxStock?: number | null }} input
 * @returns {'zero' | 'below_min' | 'overstock' | 'ok'}
 */
export function stockStatus({ qty, minStock = 0, maxStock = null }) {
  if (qty <= 0) return 'zero';
  if (minStock > 0 && qty < minStock) return 'below_min';
  if (maxStock !== null && qty > maxStock) return 'overstock';
  return 'ok';
}

/**
 * Worst status of a set of warehouses. An empty set means no warehouse holds
 * or has moved the position; the caller decides what that means for the
 * component, so this helper stays a pure maximum.
 * @param {Array<'zero' | 'below_min' | 'overstock' | 'ok'>} statuses
 * @returns {'zero' | 'below_min' | 'overstock' | 'ok'}
 */
export function worstStockStatus(statuses) {
  return statuses.reduce(
    (worst, current) =>
      STOCK_STATUS_SEVERITY[current] > STOCK_STATUS_SEVERITY[worst] ? current : worst,
    'ok',
  );
}

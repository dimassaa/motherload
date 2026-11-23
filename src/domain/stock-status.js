/**
 * Stock status used by the catalog summary and the per-warehouse card rows.
 *
 * Keeping the rule in one pure function prevents the list and the card from
 * disagreeing about a warehouse that is simply empty: zero stock is its own
 * status, while `below_min` means positive stock that has not reached the
 * threshold yet. A single warehouse is classified locally; the all-warehouse
 * summary compares the total balance with summed thresholds.
 */

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
 * Classify a component across several participating warehouses.
 *
 * An all-warehouse row must answer "does the company have enough?", not "is
 * some warehouse empty?". Aggregating per-warehouse statuses by severity marked
 * a position with stock in Gomel as out of stock merely because Minsk was
 * empty. The total balance is therefore compared with the sum of the
 * participating warehouses' thresholds instead. A total of zero stays `zero`
 * because no threshold can make an empty position healthy.
 *
 * A null `maxStock` on any participating warehouse means that warehouse has no
 * upper limit, so the aggregate has none either: summing only the bounded
 * warehouses would invent a company-wide limit the operator never configured.
 *
 * A single-warehouse state set reduces exactly to {@link stockStatus}, which is
 * why the catalog's per-warehouse mode can share this function.
 *
 * @param {{
 *   qty: number,
 *   warehouses: Array<{ minStock?: number, maxStock?: number | null }>,
 * }} input `qty` is the total balance; the array holds participating warehouses
 * @returns {'zero' | 'below_min' | 'overstock' | 'ok'}
 */
export function aggregateStockStatus({ qty, warehouses }) {
  if (qty <= 0) return 'zero';
  if (!Array.isArray(warehouses) || warehouses.length === 0) return 'ok';

  const minStock = warehouses.reduce((sum, warehouse) => sum + (warehouse.minStock ?? 0), 0);
  const maxima = warehouses.map((warehouse) => warehouse.maxStock ?? null);
  const maxStock = maxima.includes(null) ? null : maxima.reduce((sum, value) => sum + value, 0);

  return stockStatus({ qty, minStock, maxStock });
}

import { ACTIVITY_WINDOW_DAYS } from '../config/inventory.js';

/**
 * Find the inventory count currently freezing a warehouse.
 *
 * A count freezes its warehouse from creation until approval or cancellation,
 * so "active" means `draft` or `submitted`. The partial unique index
 * `inventory_counts_active_warehouse` guarantees at most one row.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {number} warehouseId
 * @returns {Promise<{ id: number, status: 'draft' | 'submitted' } | null>}
 */
export async function getActiveCount(client, warehouseId) {
  const { rows } = await client.query(
    `select id, status from inventory_counts
     where warehouse_id = $1 and status in ('draft', 'submitted')
     limit 1`,
    [warehouseId],
  );

  return rows[0] ? { id: rows[0].id, status: rows[0].status } : null;
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{ warehouseId: number, comment?: string | null, userId?: number | null }} input
 * @returns {Promise<{ id: number }>}
 */
export async function insertCount(client, { warehouseId, comment = null, userId = null }) {
  const { rows } = await client.query(
    `insert into inventory_counts (warehouse_id, started_by, comment)
     values ($1, $2, $3)
     returning id`,
    [warehouseId, userId, comment],
  );

  return { id: rows[0].id };
}

/**
 * Snapshot the warehouse into count lines.
 *
 * Only active components with a non-zero balance or a movement in the activity
 * window become lines. Empty rows with no history would force the operator to
 * type dozens of meaningless zeros; a genuinely empty warehouse still produces
 * an empty count, which is a valid "nothing here" statement.
 *
 * `unit_cost` is the weighted average of the remaining batches, falling back to
 * the last received batch price (the `v_stock_values` behaviour) and then to the
 * catalogue purchase price when the warehouse never held batches. That cost is
 * used later to value a positive adjustment.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ countId: number, warehouseId: number, asOf: string, windowDays?: number }} input
 *   `asOf` is the ISO date the activity window ends at
 * @returns {Promise<number>} number of inserted lines
 */
export async function snapshotLines(
  client,
  { countId, warehouseId, asOf, windowDays = ACTIVITY_WINDOW_DAYS },
) {
  // The movement window uses `stock_movements.created_at`, the actual posting
  // time. Document dates are backdatable; the freeze and the snapshot concern
  // what physically happened, not the paper date. The window ends at the
  // analytics reference date in demo mode so a fixed dataset keeps the same
  // snapshot lines regardless of when it is inspected.
  const result = await client.query(
    `insert into inventory_lines (count_id, component_id, expected_qty, unit_cost)
     select $1, c.id, coalesce(b.qty, 0), coalesce(v.avg_cost, c.purchase_price)
     from components c
     left join v_stock_balances b
       on b.component_id = c.id and b.warehouse_id = $2
     left join v_stock_values v
       on v.component_id = c.id and v.warehouse_id = $2
     where c.is_active
       and (
         coalesce(b.qty, 0) <> 0
         or exists (
           select 1 from stock_movements m
           where m.component_id = c.id
             and m.warehouse_id = $2
             and m.created_at >=
               (($4::date - make_interval(days => $3))::timestamp at time zone 'Europe/Minsk')
         )
       )
     order by c.sku`,
    [countId, warehouseId, windowDays, asOf],
  );

  return result.rowCount;
}

/**
 * Load a count. Pass `forUpdate` when the caller is about to change its status.
 * @param {import('pg').PoolClient} client
 * @param {number} countId
 * @param {{ forUpdate?: boolean }} [options]
 * @returns {Promise<{
 *   id: number,
 *   warehouseId: number,
 *   status: 'draft' | 'submitted' | 'approved' | 'cancelled',
 *   startedBy: number | null,
 *   submittedAt: Date | null,
 *   approvedBy: number | null,
 *   approvedAt: Date | null,
 *   comment: string | null,
 * } | null>}
 */
export async function findCountById(client, countId, { forUpdate = false } = {}) {
  const { rows } = await client.query(
    `select id, warehouse_id, status, started_by, submitted_at,
            approved_by, approved_at, comment
     from inventory_counts
     where id = $1
     ${forUpdate ? 'for update' : ''}`,
    [countId],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    warehouseId: row.warehouse_id,
    status: row.status,
    startedBy: row.started_by,
    submittedAt: row.submitted_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    comment: row.comment,
  };
}

function mapLine(row) {
  return {
    id: row.id,
    componentId: row.component_id,
    sku: row.sku,
    name: row.name,
    expectedQty: row.expected_qty,
    // NULL is the "not entered" state and must not be folded into zero here.
    actualQty: row.actual_qty,
    difference: row.difference,
    unitCost: row.unit_cost,
    comment: row.comment,
  };
}

const LINE_COLUMNS = `
  l.id, l.component_id, c.sku, c.name, l.expected_qty, l.actual_qty,
  l.difference, l.unit_cost, l.comment
`;

/**
 * @param {import('pg').PoolClient} client
 * @param {number} countId
 * @returns {Promise<Array<ReturnType<typeof mapLine>>>}
 */
export async function listLines(client, countId) {
  const { rows } = await client.query(
    `select ${LINE_COLUMNS}
     from inventory_lines l
     join components c on c.id = l.component_id
     where l.count_id = $1
     order by c.sku`,
    [countId],
  );

  return rows.map(mapLine);
}

/**
 * Load lines together with the ledger balance the approval will compare against
 * the snapshot. One query keeps the drift check consistent with the lines it
 * validates instead of interleaving N reads and updates.
 * @param {import('pg').PoolClient} client
 * @param {number} countId
 * @param {number} warehouseId
 * @returns {Promise<Array<ReturnType<typeof mapLine> & { currentQty: number }>>}
 */
export async function listLinesWithBalance(client, countId, warehouseId) {
  const { rows } = await client.query(
    `select ${LINE_COLUMNS}, coalesce(sum(m.qty_delta), 0)::integer as current_qty
     from inventory_lines l
     join components c on c.id = l.component_id
     left join stock_movements m
       on m.component_id = l.component_id and m.warehouse_id = $2
     where l.count_id = $1
     group by l.id, c.sku, c.name
     order by c.sku`,
    [countId, warehouseId],
  );

  return rows.map((row) => ({ ...mapLine(row), currentQty: row.current_qty }));
}

/**
 * @param {import('pg').PoolClient} client
 * @param {number} countId
 * @returns {Promise<number>}
 */
export async function countLines(client, countId) {
  const { rows } = await client.query(
    'select count(*)::integer as count from inventory_lines where count_id = $1',
    [countId],
  );

  return rows[0].count;
}

/**
 * Lines still missing a factual quantity, named for the 400 message.
 * @param {import('pg').PoolClient} client
 * @param {number} countId
 * @returns {Promise<Array<{ componentId: number, sku: string, name: string }>>}
 */
export async function findUnfilledLines(client, countId) {
  const { rows } = await client.query(
    `select l.component_id, c.sku, c.name
     from inventory_lines l
     join components c on c.id = l.component_id
     where l.count_id = $1 and l.actual_qty is null
     order by c.sku`,
    [countId],
  );

  return rows.map((row) => ({ componentId: row.component_id, sku: row.sku, name: row.name }));
}

/**
 * Write the factual quantity and derive the difference in one statement.
 *
 * The database check `inventory_lines_difference_matches` requires the two
 * columns to move together, so deriving `difference` here (rather than in a
 * second UPDATE) is what makes the pair atomic.
 *
 * A comment that is `undefined` in the request is left untouched; pass `null`
 * explicitly to clear it. This lets a partial save update quantities without
 * erasing notes the operator wrote earlier.
 *
 * @param {import('pg').PoolClient} client
 * @param {{
 *   countId: number,
 *   componentId: number,
 *   actualQty: number | null,
 *   comment?: string | null,
 *   touchComment?: boolean,
 * }} input
 * @returns {Promise<{ id: number } | null>} null when the component is not part of the count
 */
export async function updateLineActual(
  client,
  { countId, componentId, actualQty, comment = null, touchComment = true },
) {
  const { rows } = await client.query(
    `update inventory_lines
     set actual_qty = $3::integer,
         difference = case when $3::integer is null then null else $3::integer - expected_qty end,
         comment = case when $5::boolean then $4::text else comment end
     where count_id = $1 and component_id = $2
     returning id`,
    [countId, componentId, actualQty, comment, touchComment],
  );

  return rows[0] ? { id: rows[0].id } : null;
}

/**
 * @param {import('pg').PoolClient} client
 * @param {number} countId
 * @returns {Promise<boolean>} false when the count was not in `draft`
 */
export async function markSubmitted(client, countId) {
  const { rows } = await client.query(
    `update inventory_counts
     set status = 'submitted', submitted_at = now()
     where id = $1 and status = 'draft'
     returning id`,
    [countId],
  );

  return rows.length > 0;
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{ countId: number, approvedBy: number | null }} input
 * @returns {Promise<boolean>} false when the count was not in `submitted`
 */
export async function markApproved(client, { countId, approvedBy = null }) {
  const { rows } = await client.query(
    `update inventory_counts
     set status = 'approved', approved_by = $2, approved_at = now()
     where id = $1 and status = 'submitted'
     returning id`,
    [countId, approvedBy],
  );

  return rows.length > 0;
}

/**
 * @param {import('pg').PoolClient} client
 * @param {number} countId
 * @returns {Promise<boolean>} false when the count was already approved or cancelled
 */
export async function markCancelled(client, countId) {
  const { rows } = await client.query(
    `update inventory_counts
     set status = 'cancelled'
     where id = $1 and status in ('draft', 'submitted')
     returning id`,
    [countId],
  );

  return rows.length > 0;
}

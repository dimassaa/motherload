import { pool } from '../db/pool.js';

/**
 * Read models for ABC and XYZ analysis.
 *
 * Both analyses share the same warehouse/category filters, but read different
 * sources: ABC values current stock from FIFO batches, XYZ reads issue demand
 * from the movement ledger. Nothing is stored as a separate analytics balance,
 * so the pages cannot drift from the stock read models.
 */

// PostgreSQL sessions do not inherit the Node `TZ`; month and day boundaries
// are converted explicitly to the fixed Europe/Minsk business zone.
const DISPLAY_ZONE = 'Europe/Minsk';

function db(client) {
  return client ?? pool;
}

function mapAbcRow(row) {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    isActive: row.is_active,
    categoryName: row.category_name ?? null,
    qty: row.qty,
    // Money stays a PostgreSQL numeric string all the way to decimal.js.
    value: row.value,
  };
}

/**
 * Components with a remaining batch under the selected filters.
 *
 * Only positive `qty_remaining` rows contribute: an exhausted batch must not
 * keep a position in the ranking with a zero value. A position with a zero unit
 * cost is still returned so the service can classify it as C and the view can
 * explain why the total is zero.
 *
 * @param {{ warehouseId?: number|null, categoryId?: number|null }} filters
 * @returns {Promise<Array<{
 *   id: number, sku: string, name: string, unit: string, isActive: boolean,
 *   categoryName: string|null, qty: number, value: string
 * }>>}
 */
export async function listAbcCandidates({ warehouseId = null, categoryId = null } = {}) {
  const { rows } = await db().query(
    `select
       c.id,
       c.sku,
       c.name,
       c.unit,
       c.is_active,
       cat.name as category_name,
       sum(b.qty_remaining)::integer as qty,
       round(sum(b.qty_remaining * b.unit_cost), 4)::numeric(16,4) as value
     from stock_batches b
     join components c on c.id = b.component_id
     left join categories cat on cat.id = c.category_id
     where b.qty_remaining > 0
       and ($1::int is null or b.warehouse_id = $1)
       and ($2::int is null or c.category_id = $2)
     group by c.id, cat.name
     order by value desc, c.id`,
    [warehouseId, categoryId],
  );

  return rows.map(mapAbcRow);
}

function mapXyzComponent(row) {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    isActive: row.is_active,
    categoryName: row.category_name ?? null,
  };
}

/**
 * Components eligible for XYZ under the selected filters.
 *
 * A position belongs to the analysis when it either holds a remaining batch or
 * issued stock during the window. The first rule keeps zero-demand positions in
 * the table as class Z; the second keeps positions that were fully consumed but
 * still show a demand pattern.
 *
 * @param {{
 *   warehouseId?: number|null,
 *   categoryId?: number|null,
 *   start: string,
 *   end: string,
 * }} filters `start` inclusive, `end` exclusive, both `YYYY-MM-DD`
 * @returns {Promise<Array<{
 *   id: number, sku: string, name: string, unit: string,
 *   isActive: boolean, categoryName: string|null
 * }>>}
 */
export async function listXyzComponents({ warehouseId = null, categoryId = null, start, end }) {
  const { rows } = await db().query(
    `select
       c.id,
       c.sku,
       c.name,
       c.unit,
       c.is_active,
       cat.name as category_name
     from components c
     left join categories cat on cat.id = c.category_id
     where ($1::int is null or c.category_id = $1)
       and (
         exists (
           select 1
           from stock_batches b
           where b.component_id = c.id
             and b.qty_remaining > 0
             and ($2::int is null or b.warehouse_id = $2)
         )
         or exists (
           select 1
           from stock_movements m
           join stock_documents d on d.id = m.document_id
           where m.component_id = c.id
             and d.type = 'issue'
             and m.qty_delta < 0
             and ($2::int is null or m.warehouse_id = $2)
             and m.created_at >= ($3::date::timestamp at time zone '${DISPLAY_ZONE}')
             and m.created_at < ($4::date::timestamp at time zone '${DISPLAY_ZONE}')
         )
       )
     order by c.name, c.id`,
    [categoryId, warehouseId, start, end],
  );

  return rows.map(mapXyzComponent);
}

/**
 * Issued quantity per component and calendar month inside the window.
 *
 * Only issue documents count as demand: a transfer moves stock and an inventory
 * adjustment corrects it, but neither is consumption. The month key is produced
 * in Europe/Minsk so a movement just after local midnight lands in the right
 * bucket.
 *
 * @param {{
 *   warehouseId?: number|null,
 *   categoryId?: number|null,
 *   start: string,
 *   end: string,
 * }} filters `start` inclusive, `end` exclusive, both `YYYY-MM-DD`
 * @returns {Promise<Array<{ componentId: number, month: string, qty: number }>>}
 */
export async function listMonthlyIssues({ warehouseId = null, categoryId = null, start, end }) {
  const { rows } = await db().query(
    `select
       m.component_id,
       to_char(date_trunc('month', m.created_at at time zone '${DISPLAY_ZONE}'), 'YYYY-MM') as month,
       sum(-m.qty_delta)::integer as qty
     from stock_movements m
     join stock_documents d on d.id = m.document_id
     join components c on c.id = m.component_id
     where d.type = 'issue'
       and m.qty_delta < 0
       and ($1::int is null or m.warehouse_id = $1)
       and ($2::int is null or c.category_id = $2)
       and m.created_at >= ($3::date::timestamp at time zone '${DISPLAY_ZONE}')
       and m.created_at < ($4::date::timestamp at time zone '${DISPLAY_ZONE}')
     group by m.component_id, 2
     order by m.component_id, 2`,
    [warehouseId, categoryId, start, end],
  );

  return rows.map((row) => ({
    componentId: row.component_id,
    month: row.month,
    qty: row.qty,
  }));
}

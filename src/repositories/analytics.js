import { pool } from '../db/pool.js';

/**
 * Read models for the analytics screens.
 *
 * ABC values current stock from FIFO batches, XYZ reads issue demand from the
 * movement ledger, and reorder planning joins the two per component/warehouse
 * pair. Nothing is stored as a separate analytics balance, so the pages cannot
 * drift from the stock read models.
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

const ACTIVITY_WINDOW = "interval '180 days'";

/**
 * Component/warehouse pairs that take part in reorder planning.
 *
 * A pair participates when it holds stock or moved in the last 180 days, the
 * same participation rule the catalog and future alerts use. Empty, idle
 * warehouses must not create shortages nobody can act on.
 *
 * `first_issue_date` is the first *consumption* day, not the first receipt: the
 * demand statistics are only trustworthy once the position has actually been
 * issued. A batch that arrived a year ago but never sold is still "low data",
 * and the service falls back to `min_stock` exactly as §6.6 requires.
 *
 * @param {{
 *   warehouseId?: number|null,
 *   categoryId?: number|null,
 *   activityStart: string,
 * }} filters `activityStart` is the inclusive lower bound of the 180-day window
 * @returns {Promise<Array<{
 *   componentId: number, sku: string, name: string, unit: string,
 *   categoryName: string|null, minStock: number, purchasePrice: string,
 *   leadTimeDays: number, warehouseId: number, warehouseCode: string,
 *   warehouseName: string, warehouseCity: string, qty: number,
 *   avgCost: string|null, firstIssueDate: string|null
 * }>>}
 */
export async function listReorderPairs({ warehouseId = null, categoryId = null, activityStart }) {
  const { rows } = await db().query(
    `with participants as (
       select
         vw.component_id,
         c.sku,
         c.name,
         c.unit,
         c.min_stock,
         c.purchase_price,
         -- Component lead time wins, the default supplier is the fallback. A
         -- position without either still needs a finite horizon, so one day is
         -- the explicit minimum rather than an invented assumption.
         coalesce(c.lead_time_days, s.lead_time_days, 1) as lead_time_days,
         cat.name as category_name,
         vw.warehouse_id,
         w.code as warehouse_code,
         w.name as warehouse_name,
         w.city as warehouse_city,
         vw.qty,
         vw.avg_cost
       from v_component_warehouse_stock vw
       join components c on c.id = vw.component_id
       join warehouses w on w.id = vw.warehouse_id
       left join categories cat on cat.id = c.category_id
       left join suppliers s on s.id = c.default_supplier_id
       where c.is_active
         and ($1::int is null or vw.warehouse_id = $1)
         and ($2::int is null or c.category_id = $2)
         and (
           vw.qty > 0
           or exists (
             select 1
             from stock_movements m
             where m.component_id = vw.component_id
               and m.warehouse_id = vw.warehouse_id
               and m.created_at >=
                 (($3::date - ${ACTIVITY_WINDOW})::timestamp at time zone '${DISPLAY_ZONE}')
           )
         )
     )
     select
       p.*,
       first_issue.first_issue_date
     from participants p
     left join lateral (
       select (min(m.created_at) at time zone '${DISPLAY_ZONE}')::date as first_issue_date
       from stock_movements m
       join stock_documents d on d.id = m.document_id
       where m.component_id = p.component_id
         and m.warehouse_id = p.warehouse_id
         and d.type = 'issue'
         and m.qty_delta < 0
     ) first_issue on true
     order by p.name, p.component_id, p.warehouse_name, p.warehouse_id`,
    [warehouseId, categoryId, activityStart],
  );

  return rows.map((row) => ({
    componentId: row.component_id,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    categoryName: row.category_name ?? null,
    minStock: row.min_stock,
    // Money stays a PostgreSQL numeric string; the domain converts it with
    // decimal.js and never through Number.
    purchasePrice: row.purchase_price,
    leadTimeDays: row.lead_time_days,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    warehouseName: row.warehouse_name,
    warehouseCity: row.warehouse_city,
    qty: row.qty,
    avgCost: row.avg_cost ?? null,
    firstIssueDate: row.first_issue_date ?? null,
  }));
}

/**
 * Issued quantity per component, warehouse and calendar day.
 *
 * The day bucket is produced in Europe/Minsk so a movement just after local
 * midnight lands on the right day. Only issue documents count as demand.
 *
 * @param {{
 *   warehouseId?: number|null,
 *   categoryId?: number|null,
 *   start: string,
 *   end: string,
 * }} filters `start` inclusive, `end` exclusive, both `YYYY-MM-DD`
 * @returns {Promise<Array<{
 *   componentId: number, warehouseId: number, day: string, qty: number
 * }>>}
 */
export async function listDailyIssues({ warehouseId = null, categoryId = null, start, end }) {
  const { rows } = await db().query(
    `select
       m.component_id,
       m.warehouse_id,
       (date_trunc('day', m.created_at at time zone '${DISPLAY_ZONE}'))::date as day,
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
     group by m.component_id, m.warehouse_id, 3
     order by m.component_id, m.warehouse_id, 3`,
    [warehouseId, categoryId, start, end],
  );

  return rows.map((row) => ({
    componentId: row.component_id,
    warehouseId: row.warehouse_id,
    day: row.day,
    qty: row.qty,
  }));
}

/**
 * Stock value, 90-day COGS and dead-stock value for the dashboard KPI cards.
 *
 * COGS comes from the movement ledger (`qty_delta * unit_cost`) rather than a
 * document total so it uses the same FIFO cost that the stock value uses. A
 * position is dead when it still holds value and has no issue in the window;
 * the whole component value counts once, not per warehouse, because the KPI is
 * about frozen money, not about locations.
 *
 * @param {{ start: string, end: string }} window `start` inclusive, `end` exclusive
 * @returns {Promise<{ stockValue: string, cogs90: string, deadValue: string }>}
 */
export async function getKpiTotals({ start, end }) {
  const { rows } = await db().query(
    `select
       coalesce(
         (select round(sum(b.qty_remaining * b.unit_cost), 4)
          from stock_batches b
          where b.qty_remaining > 0),
         0
       )::numeric(16,4) as stock_value,
       coalesce(
         (select round(sum(-m.qty_delta * m.unit_cost), 4)
          from stock_movements m
          join stock_documents d on d.id = m.document_id
          where d.type = 'issue'
            and m.qty_delta < 0
            and m.created_at >= ($1::date::timestamp at time zone '${DISPLAY_ZONE}')
            and m.created_at < ($2::date::timestamp at time zone '${DISPLAY_ZONE}')),
         0
       )::numeric(16,4) as cogs_90,
       coalesce(
         (select round(sum(b.qty_remaining * b.unit_cost), 4)
          from stock_batches b
          where b.qty_remaining > 0
            and not exists (
              select 1
              from stock_movements m
              join stock_documents d on d.id = m.document_id
              where m.component_id = b.component_id
                and d.type = 'issue'
                and m.qty_delta < 0
                and m.created_at >= ($1::date::timestamp at time zone '${DISPLAY_ZONE}')
                and m.created_at < ($2::date::timestamp at time zone '${DISPLAY_ZONE}')
            )),
         0
       )::numeric(16,4) as dead_value
     `,
    [start, end],
  );

  const row = rows[0];
  return {
    stockValue: row.stock_value,
    cogs90: row.cogs_90,
    deadValue: row.dead_value,
  };
}

/**
 * Current stock value per category, largest first.
 *
 * A category only appears when it holds positive value: an empty bar would be
 * noise on the dashboard chart. Components without a category fall into one
 * explicit "Без категории" bucket instead of vanishing from the total.
 *
 * @returns {Promise<Array<{ name: string, value: string }>>}
 */
export async function listCategoryValues() {
  const { rows } = await db().query(
    `select
       coalesce(cat.name, 'Без категории') as name,
       round(sum(vw.value), 4)::numeric(16,4) as value
     from v_component_warehouse_stock vw
     join components c on c.id = vw.component_id
     left join categories cat on cat.id = c.category_id
     where vw.value > 0
     group by 1
     order by value desc, name`,
  );

  return rows.map((row) => ({ name: row.name, value: row.value }));
}

/**
 * The newest ledger movements for the dashboard feed.
 *
 * A movement may have no document (inventory adjustment), so the document and
 * author joins are optional; the view renders the missing type as a correction
 * instead of an empty cell.
 *
 * @param {number} limit hard upper bound chosen by the service
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function listRecentMovements(limit) {
  const { rows } = await db().query(
    `select
       m.id,
       m.created_at,
       m.qty_delta,
       d.type as document_type,
       d.number as document_number,
       c.sku,
       c.name as component_name,
       w.name as warehouse_name,
       u.full_name as user_name
     from stock_movements m
     join components c on c.id = m.component_id
     join warehouses w on w.id = m.warehouse_id
     left join stock_documents d on d.id = m.document_id
     left join users u on u.id = d.created_by
     order by m.created_at desc, m.id desc
     limit $1`,
    [limit],
  );

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    qtyDelta: row.qty_delta,
    documentType: row.document_type ?? null,
    documentNumber: row.document_number ?? null,
    sku: row.sku,
    componentName: row.component_name,
    warehouseName: row.warehouse_name,
    userName: row.user_name ?? null,
  }));
}

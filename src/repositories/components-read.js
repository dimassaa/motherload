import { pool } from '../db/pool.js';

/**
 * Read models for the public component catalog and the component card.
 *
 * The admin CRUD repository (`components.js`) owns rows; this module only
 * queries the derived stock views and the history tables. Quantities come from
 * `v_component_stock` / `v_component_warehouse_stock`, which in turn read the
 * movement ledger and FIFO batches, so no balance is ever stored twice.
 */

// The specification fixes every business day to Europe/Minsk. PostgreSQL
// sessions do not inherit the Node `TZ`, so month and activity boundaries are
// converted explicitly instead of relying on the server default.
const DISPLAY_ZONE = 'Europe/Minsk';

const ACTIVITY_WINDOW = "interval '180 days'";

/** One card render never lists more than the most recent 200 batches. */
const BATCH_LIMIT = 200;

/**
 * Escape LIKE metacharacters so a literal `%` or `_` in the search box does not
 * turn into a wildcard. PostgreSQL's default LIKE escape character is a
 * backslash; the query states it explicitly for readability.
 */
export function likePattern(value) {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

/**
 * Components list across every warehouse.
 *
 * `v_component_stock` supplies the total balance and value. The per-warehouse
 * inputs are aggregated into JSON so the service classifies them with the
 * shared `stockStatus` function instead of duplicating the rule in SQL. Only
 * warehouses that hold stock or moved it in the last 180 days contribute: idle
 * warehouses must not create false shortages.
 */
const ALL_WAREHOUSES_SOURCE = `
  with activity as (
    select vw.component_id, vw.qty, vw.min_stock, vw.max_stock
    from v_component_warehouse_stock vw
    where vw.qty > 0
       or exists (
         select 1
         from stock_movements m
         where m.component_id = vw.component_id
           and m.warehouse_id = vw.warehouse_id
           and m.created_at >= (($1::date - ${ACTIVITY_WINDOW})::timestamp at time zone '${DISPLAY_ZONE}')
       )
  )
  select
    c.id,
    c.sku,
    c.name,
    c.unit,
    c.min_stock,
    c.category_id,
    c.manufacturer_id,
    cat.name as category_name,
    mf.name as manufacturer_name,
    coalesce(t.qty, 0)::integer as qty,
    coalesce(t.value, 0)::numeric(16,4) as value,
    coalesce(
      jsonb_agg(
        jsonb_build_object('qty', a.qty, 'minStock', a.min_stock, 'maxStock', a.max_stock)
      ) filter (where a.component_id is not null),
      '[]'::jsonb
    ) as warehouse_states
  from components c
  left join categories cat on cat.id = c.category_id
  left join manufacturers mf on mf.id = c.manufacturer_id
  left join v_component_stock t on t.component_id = c.id
  left join activity a on a.component_id = c.id
  where c.is_active
  group by c.id, cat.name, mf.name, t.qty, t.value
`;

/**
 * Components list restricted to one warehouse. The row always exists because
 * `v_component_warehouse_stock` cross-joins components and warehouses, so a
 * missing balance reads as zero instead of hiding the position.
 */
const WAREHOUSE_SOURCE = `
  select
    c.id,
    c.sku,
    c.name,
    c.unit,
    c.min_stock,
    c.category_id,
    c.manufacturer_id,
    cat.name as category_name,
    mf.name as manufacturer_name,
    coalesce(b.qty, 0)::integer as qty,
    coalesce(b.value, 0)::numeric(16,4) as value,
    jsonb_build_array(
      jsonb_build_object(
        'qty', coalesce(b.qty, 0),
        'minStock', c.min_stock,
        'maxStock', c.max_stock
      )
    ) as warehouse_states
  from components c
  left join categories cat on cat.id = c.category_id
  left join manufacturers mf on mf.id = c.manufacturer_id
  left join v_component_warehouse_stock b
    on b.component_id = c.id and b.warehouse_id = $1
  where c.is_active
`;

function db(client) {
  return client ?? pool;
}

function mapCatalogRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    minStock: row.min_stock,
    categoryName: row.category_name ?? null,
    manufacturerName: row.manufacturer_name ?? null,
    // Quantities are integers; `numeric` values stay strings so the template
    // formats them without a float touching a money value.
    qty: row.qty,
    value: row.value,
    warehouseStates: row.warehouse_states ?? [],
  };
}

/**
 * Build the filtered source and its parameters. `referenceDate` is only used by
 * the all-warehouse source and is therefore consumed in that branch only.
 */
function buildListQuery(filters) {
  const params = [];
  let source;

  if (filters.warehouseId) {
    source = WAREHOUSE_SOURCE;
    params.push(filters.warehouseId);
  } else {
    source = ALL_WAREHOUSES_SOURCE;
    params.push(filters.referenceDate);
  }

  const conditions = [];

  if (filters.q) {
    params.push(likePattern(filters.q));
    conditions.push(
      `(r.name ilike $${params.length} escape '\\' or r.sku ilike $${params.length} escape '\\')`,
    );
  }
  if (filters.categoryId) {
    params.push(filters.categoryId);
    conditions.push(`r.category_id = $${params.length}`);
  }
  if (filters.manufacturerId) {
    params.push(filters.manufacturerId);
    conditions.push(`r.manufacturer_id = $${params.length}`);
  }

  return {
    source,
    where: conditions.length > 0 ? `where ${conditions.join(' and ')}` : '',
    params,
  };
}

/**
 * Every catalog row matching search/category/manufacturer/warehouse filters.
 *
 * Status is deliberately not computed here: the service classifies the
 * returned warehouse inputs with the shared `stockStatus` rule, applies the
 * status filter, sorts and paginates. One fetch also means the activity
 * `exists` is not duplicated between a count and a page query.
 *
 * @param {{
 *   q?: string,
 *   categoryId?: number | null,
 *   manufacturerId?: number | null,
 *   warehouseId?: number | null,
 *   referenceDate: string,
 * }} filters
 */
export async function listCatalogCandidates(filters) {
  const { source, where, params } = buildListQuery(filters);
  const { rows } = await db().query(
    `with rows as (${source})
     select r.*
     from rows r
     ${where}`,
    params,
  );

  return rows.map(mapCatalogRow);
}

function mapComponent(row) {
  if (!row) return null;

  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    specs: row.specs,
    purchasePrice: row.purchase_price,
    retailPrice: row.retail_price,
    minStock: row.min_stock,
    maxStock: row.max_stock,
    leadTimeDays: row.lead_time_days,
    isActive: row.is_active,
    categoryName: row.category_name ?? null,
    manufacturerName: row.manufacturer_name ?? null,
    supplierName: row.supplier_name ?? null,
    qty: row.qty,
    value: row.value,
    avgCost: row.avg_cost,
  };
}

/**
 * Header data for one card, including the aggregate balance and the weighted
 * average cost across warehouses.
 * @param {number} id
 */
export async function findCardComponent(id) {
  const { rows } = await db().query(
    `select
       c.id, c.sku, c.name, c.unit, c.specs, c.purchase_price, c.retail_price,
       c.min_stock, c.max_stock, c.lead_time_days, c.is_active,
       cat.name as category_name,
       mf.name as manufacturer_name,
       s.name as supplier_name,
       coalesce(t.qty, 0)::integer as qty,
       coalesce(t.value, 0)::numeric(16,4) as value,
       case
         when coalesce(sum(sv.qty), 0) > 0
           then round(sum(sv.avg_cost * sv.qty) / sum(sv.qty), 4)
         else null
       end as avg_cost
     from components c
     left join categories cat on cat.id = c.category_id
     left join manufacturers mf on mf.id = c.manufacturer_id
     left join suppliers s on s.id = c.default_supplier_id
     left join v_component_stock t on t.component_id = c.id
     left join v_stock_values sv on sv.component_id = c.id
     where c.id = $1
     group by c.id, cat.name, mf.name, s.name, t.qty, t.value`,
    [id],
  );

  return mapComponent(rows[0]);
}

/**
 * Per-warehouse balances for the card.
 *
 * The row carries `hasActivity` so the service can hide warehouses with no
 * stock and no movement in the last 180 days by default and reveal them under
 * the `showAll` option. Classification is left to the service, which uses the
 * same `stockStatus` rule as the catalog summary.
 * @param {number} componentId
 * @param {{ referenceDate: string }} options
 */
export async function listWarehouseBalances(componentId, { referenceDate }) {
  const { rows } = await db().query(
    `select
       vw.warehouse_id,
       w.code,
       w.name,
       w.city,
       w.is_active,
       vw.qty,
       vw.value,
       vw.avg_cost,
       vw.min_stock,
       vw.max_stock,
       (
         vw.qty > 0
         or exists (
           select 1
           from stock_movements m
           where m.component_id = vw.component_id
             and m.warehouse_id = vw.warehouse_id
             and m.created_at >= (($2::date - ${ACTIVITY_WINDOW})::timestamp at time zone '${DISPLAY_ZONE}')
         )
       ) as has_activity
     from v_component_warehouse_stock vw
     join warehouses w on w.id = vw.warehouse_id
     where vw.component_id = $1
     order by w.name, w.id`,
    [componentId, referenceDate],
  );

  return rows.map((row) => ({
    warehouseId: row.warehouse_id,
    code: row.code,
    name: row.name,
    city: row.city,
    isActive: row.is_active,
    qty: row.qty,
    value: row.value,
    avgCost: row.avg_cost,
    minStock: row.min_stock,
    maxStock: row.max_stock,
    hasActivity: row.has_activity,
  }));
}

/**
 * The most recent batches for the card in FIFO order.
 *
 * A position can accumulate thousands of consumed batches; the card only needs
 * the recent tail. One extra row is fetched to tell the view whether the list
 * was truncated without a second count query.
 * @param {number} componentId
 * @returns {Promise<{ items: Array<Record<string, unknown>>, truncated: boolean }>}
 */
export async function listBatches(componentId) {
  const { rows } = await db().query(
    `select
       b.id,
       b.received_at,
       b.qty_received,
       b.qty_remaining,
       b.unit_cost,
       b.document_no,
       w.code as warehouse_code,
       w.name as warehouse_name,
       s.name as supplier_name
     from stock_batches b
     join warehouses w on w.id = b.warehouse_id
     left join suppliers s on s.id = b.supplier_id
     where b.component_id = $1
     order by b.received_at desc, b.id desc
     limit $2`,
    [componentId, BATCH_LIMIT + 1],
  );

  const truncated = rows.length > BATCH_LIMIT;
  const items = rows
    .slice(0, BATCH_LIMIT)
    .reverse()
    .map((row) => ({
      id: row.id,
      receivedAt: row.received_at,
      qtyReceived: row.qty_received,
      qtyRemaining: row.qty_remaining,
      unitCost: row.unit_cost,
      documentNo: row.document_no ?? null,
      warehouseCode: row.warehouse_code,
      warehouseName: row.warehouse_name,
      supplierName: row.supplier_name ?? null,
    }));

  return { items, truncated };
}

function mapMovement(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    qtyDelta: row.qty_delta,
    unitCost: row.unit_cost,
    documentType: row.document_type ?? null,
    documentNumber: row.document_number ?? null,
    warehouseCode: row.warehouse_code,
    warehouseName: row.warehouse_name,
    userName: row.user_name ?? null,
  };
}

/**
 * One page of movements, newest first.
 * @param {number} componentId
 * @param {{ limit: number, offset?: number }} options
 */
export async function listMovements(componentId, { limit, offset = 0 }) {
  const { rows } = await db().query(
    `select
       m.id,
       m.created_at,
       m.qty_delta,
       m.unit_cost,
       d.type as document_type,
       d.number as document_number,
       w.code as warehouse_code,
       w.name as warehouse_name,
       u.full_name as user_name
     from stock_movements m
     join warehouses w on w.id = m.warehouse_id
     left join stock_documents d on d.id = m.document_id
     left join users u on u.id = d.created_by
     where m.component_id = $1
     order by m.created_at desc, m.id desc
     limit $2 offset $3`,
    [componentId, limit, offset],
  );

  return rows.map(mapMovement);
}

/**
 * @param {number} componentId
 */
export async function countMovements(componentId) {
  const { rows } = await db().query(
    'select count(*)::integer as total from stock_movements where component_id = $1',
    [componentId],
  );
  return rows[0].total;
}

/**
 * Consumed units per month for the card chart.
 *
 * Only issue documents count as consumption: a transfer moves stock and an
 * inventory adjustment corrects it, but neither is demand. The window is
 * expressed in Europe/Minsk so a movement shortly after local midnight lands
 * in the correct month.
 * @param {number} componentId
 * @param {{ start: string, end: string, warehouseId?: number | null }} range
 *   `YYYY-MM-DD`, end exclusive; `warehouseId=null` means every warehouse
 */
export async function listMonthlyConsumption(componentId, { start, end, warehouseId = null }) {
  const { rows } = await db().query(
    `select
       to_char(date_trunc('month', m.created_at at time zone '${DISPLAY_ZONE}'), 'YYYY-MM') as month,
       sum(-m.qty_delta)::integer as qty
     from stock_movements m
     join stock_documents d on d.id = m.document_id
     where m.component_id = $1
       and d.type = 'issue'
       and m.qty_delta < 0
       and ($4::int is null or m.warehouse_id = $4)
       and m.created_at >= ($2::date::timestamp at time zone '${DISPLAY_ZONE}')
       and m.created_at < ($3::date::timestamp at time zone '${DISPLAY_ZONE}')
     group by 1
     order by 1`,
    [componentId, start, end, warehouseId],
  );

  return rows.map((row) => ({ month: row.month, qty: row.qty }));
}

/**
 * Type-ahead search for stock forms. Archived positions are excluded so a
 * document cannot be created for a component the catalog has retired.
 * @param {string} q trimmed search text; empty matches the first page
 * @param {number} limit hard upper bound applied by the service
 */
export async function searchActive(q, limit) {
  const pattern = likePattern(q);
  const { rows } = await db().query(
    `select id, sku, name
     from components
     where is_active
       and ($1 = '' or name ilike $2 escape '\\' or sku ilike $2 escape '\\')
     order by name, id
     limit $3`,
    [q, pattern, limit],
  );

  return rows.map((row) => ({ id: row.id, sku: row.sku, name: row.name }));
}

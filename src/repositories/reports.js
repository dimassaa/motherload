import { pool } from '../db/pool.js';

/**
 * Read models for CSV reports.
 *
 * Analytics, inventory and audit reports reuse their own services and
 * repositories. Only two datasets have no other read model: the per-warehouse
 * balance list and the date-filtered movement ledger. Keeping their SQL here
 * preserves the repository boundary instead of leaking queries into the report
 * service.
 */

// Business dates are Moscow-free but Minsk-bound: the report range must mean
// local midnight regardless of the database session timezone.
const DISPLAY_ZONE = 'Europe/Minsk';

function db(client) {
  return client ?? pool;
}

/**
 * Current balances per component and warehouse.
 *
 * A pair is included only when the ledger says something remains: zero rows
 * would turn the export into a full cross product without adding information.
 *
 * @param {{ warehouseId?: number|null, categoryId?: number|null }} [filters]
 * @returns {Promise<Array<{
 *   componentId: number, sku: string, name: string, unit: string,
 *   categoryName: string|null, warehouseCode: string, warehouseName: string,
 *   qty: number, value: string, avgCost: string|null,
 *   minStock: number, maxStock: number|null
 * }>>}
 */
export async function listStockBalances({ warehouseId = null, categoryId = null } = {}) {
  const { rows } = await db().query(
    `select
       c.id as component_id,
       c.sku,
       c.name,
       c.unit,
       cat.name as category_name,
       w.code as warehouse_code,
       w.name as warehouse_name,
       vw.qty,
       vw.value,
       vw.avg_cost,
       vw.min_stock,
       vw.max_stock
     from v_component_warehouse_stock vw
     join components c on c.id = vw.component_id
     join warehouses w on w.id = vw.warehouse_id
     left join categories cat on cat.id = c.category_id
     where vw.qty > 0
       and ($1::int is null or vw.warehouse_id = $1)
       and ($2::int is null or c.category_id = $2)
     order by c.name, c.id, w.name, w.id`,
    [warehouseId, categoryId],
  );

  return rows.map((row) => ({
    componentId: row.component_id,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    categoryName: row.category_name ?? null,
    warehouseCode: row.warehouse_code,
    warehouseName: row.warehouse_name,
    qty: row.qty,
    value: row.value,
    avgCost: row.avg_cost ?? null,
    minStock: row.min_stock,
    maxStock: row.max_stock,
  }));
}

/**
 * Movement ledger rows inside an inclusive local-date range.
 *
 * A movement may have no stock document (an inventory adjustment), so the
 * document and author joins are optional and the service labels that case.
 * Ordering is chronological because a ledger export is read as a history, not
 * as a newest-first screen.
 *
 * @param {{
 *   dateFrom: string,
 *   dateTo: string,
 *   warehouseId?: number|null,
 *   categoryId?: number|null,
 * }} filters `dateFrom` and `dateTo` are inclusive `YYYY-MM-DD`
 * @returns {Promise<Array<{
 *   id: number, createdAt: Date, qtyDelta: number, unitCost: string,
 *   documentType: string|null, documentNumber: string|null,
 *   sku: string, componentName: string, unit: string,
 *   warehouseName: string, userName: string|null
 * }>>}
 */
export async function listMovements({ dateFrom, dateTo, warehouseId = null, categoryId = null }) {
  const { rows } = await db().query(
    `select
       m.id,
       m.created_at,
       m.qty_delta,
       m.unit_cost,
       d.type as document_type,
       d.number as document_number,
       c.sku,
       c.name as component_name,
       c.unit,
       w.name as warehouse_name,
       u.full_name as user_name
     from stock_movements m
     join components c on c.id = m.component_id
     join warehouses w on w.id = m.warehouse_id
     left join stock_documents d on d.id = m.document_id
     left join users u on u.id = d.created_by
     where m.created_at >= ($3::date::timestamp at time zone '${DISPLAY_ZONE}')
       and m.created_at < ((($4::date + 1)::timestamp) at time zone '${DISPLAY_ZONE}')
       and ($1::int is null or m.warehouse_id = $1)
       and ($2::int is null or c.category_id = $2)
     order by m.created_at, m.id`,
    [warehouseId, categoryId, dateFrom, dateTo],
  );

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    qtyDelta: row.qty_delta,
    unitCost: row.unit_cost,
    documentType: row.document_type ?? null,
    documentNumber: row.document_number ?? null,
    sku: row.sku,
    componentName: row.component_name,
    unit: row.unit,
    warehouseName: row.warehouse_name,
    userName: row.user_name ?? null,
  }));
}

import { pool } from '../db/pool.js';

/**
 * Read model for the date-filtered CSV movement ledger.
 *
 * ABC/XYZ/reorder, the inventory act and the catalog export reuse their own
 * services and repositories. The movement export is the only dataset without
 * another read model, so its SQL stays here instead of leaking into the report
 * service.
 */

// Business dates are Moscow-free but Minsk-bound: the report range must mean
// local midnight regardless of the database session timezone.
const DISPLAY_ZONE = 'Europe/Minsk';

function db(client) {
  return client ?? pool;
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

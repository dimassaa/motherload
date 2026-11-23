import { pool } from '../db/pool.js';
import { likePattern } from './components-read.js';

/**
 * SQL for the component catalog.
 *
 * Balances and history live in the stock ledger; this repository only owns the
 * catalog row itself. List queries join the reference names because the admin
 * table shows them and the page must not issue one query per row.
 */

const SELECT_COLUMNS = `
  c.id, c.sku, c.name, c.category_id, c.manufacturer_id, c.default_supplier_id,
  c.unit, c.specs, c.purchase_price, c.retail_price, c.min_stock, c.max_stock,
  c.lead_time_days, c.is_active, c.created_at, c.updated_at
`;

const JOINED_SELECT = `
  select ${SELECT_COLUMNS},
    cat.name as category_name,
    m.name as manufacturer_name,
    s.name as supplier_name
  from components c
  left join categories cat on cat.id = c.category_id
  left join manufacturers m on m.id = c.manufacturer_id
  left join suppliers s on s.id = c.default_supplier_id
`;

function db(client) {
  return client ?? pool;
}

/**
 * `pg` returns `numeric` as a string and `jsonb` as a parsed object. Prices stay
 * strings: converting them to `Number` here would put a float on the money path.
 */
function mapRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    categoryId: row.category_id,
    manufacturerId: row.manufacturer_id,
    defaultSupplierId: row.default_supplier_id,
    unit: row.unit,
    specs: row.specs,
    purchasePrice: row.purchase_price,
    retailPrice: row.retail_price,
    minStock: row.min_stock,
    maxStock: row.max_stock,
    leadTimeDays: row.lead_time_days,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    categoryName: row.category_name ?? null,
    manufacturerName: row.manufacturer_name ?? null,
    supplierName: row.supplier_name ?? null,
  };
}

/**
 * Build the shared WHERE clause for the list and its count. Values are always
 * parameters; only the placeholder positions are interpolated.
 */
function buildFilters({ q = '', categoryId = null, manufacturerId = null, isActive = null }) {
  const conditions = [];
  const params = [];

  if (q) {
    params.push(likePattern(q));
    conditions.push(
      `(c.name ilike $${params.length} escape '\\' or c.sku ilike $${params.length} escape '\\')`,
    );
  }
  if (categoryId !== null && categoryId !== undefined) {
    params.push(categoryId);
    conditions.push(`c.category_id = $${params.length}`);
  }
  if (manufacturerId !== null && manufacturerId !== undefined) {
    params.push(manufacturerId);
    conditions.push(`c.manufacturer_id = $${params.length}`);
  }
  if (isActive !== null && isActive !== undefined) {
    params.push(isActive);
    conditions.push(`c.is_active = $${params.length}`);
  }

  return {
    where: conditions.length > 0 ? `where ${conditions.join(' and ')}` : '',
    params,
  };
}

/**
 * One page of catalog rows in name order.
 * @param {{
 *   q?: string,
 *   categoryId?: number | null,
 *   manufacturerId?: number | null,
 *   isActive?: boolean | null,
 *   limit: number,
 *   offset: number,
 * }} filters
 * @param {import('pg').PoolClient | null} [client]
 */
export async function list(filters, client = null) {
  const { where, params } = buildFilters(filters);
  const limitIndex = params.length + 1;
  const offsetIndex = params.length + 2;

  const { rows } = await db(client).query(
    `${JOINED_SELECT}
     ${where}
     order by c.name, c.id
     limit $${limitIndex} offset $${offsetIndex}`,
    [...params, filters.limit, filters.offset],
  );

  return rows.map(mapRow);
}

/**
 * Total rows matching the same filters as {@link list}, before pagination.
 * @param {{ q?: string, categoryId?: number | null, manufacturerId?: number | null, isActive?: boolean | null }} filters
 * @param {import('pg').PoolClient | null} [client]
 */
export async function count(filters, client = null) {
  const { where, params } = buildFilters(filters);
  const { rows } = await db(client).query(
    `select count(*)::integer as total from components c ${where}`,
    params,
  );
  return rows[0].total;
}

/**
 * Find one catalog row, optionally locking it for the surrounding transaction.
 * The lock also serialises archive and delete against a concurrent edit.
 * @param {number} id
 * @param {{ forUpdate?: boolean, client?: import('pg').PoolClient | null }} [options]
 */
export async function findById(id, { forUpdate = false, client = null } = {}) {
  const { rows } = await db(client).query(
    `select ${SELECT_COLUMNS} from components c where c.id = $1${forUpdate ? ' for update' : ''}`,
    [id],
  );
  return mapRow(rows[0]);
}

/**
 * Insert one catalog row. `specs` is passed as an object; `pg` serialises it to
 * JSON for the `jsonb` column.
 * @param {Record<string, unknown>} values validated form data
 * @param {import('pg').PoolClient | null} [client]
 */
export async function insert(values, client = null) {
  const { rows } = await db(client).query(
    `insert into components as c
       (sku, name, category_id, manufacturer_id, default_supplier_id, unit, specs,
        purchase_price, retail_price, min_stock, max_stock, lead_time_days, is_active)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning ${SELECT_COLUMNS}`,
    [
      values.sku,
      values.name,
      values.categoryId,
      values.manufacturerId,
      values.defaultSupplierId,
      values.unit,
      values.specs,
      values.purchasePrice,
      values.retailPrice,
      values.minStock,
      values.maxStock,
      values.leadTimeDays,
      values.isActive,
    ],
  );
  return mapRow(rows[0]);
}

/**
 * Replace every editable field. SKU is absent by design: it is the immutable
 * identifier the history rows point at, and the controller refuses a change.
 * @param {number} id
 * @param {Record<string, unknown>} values validated form data
 * @param {import('pg').PoolClient | null} [client]
 */
export async function update(id, values, client = null) {
  const { rows } = await db(client).query(
    `update components as c
     set name = $1,
         category_id = $2,
         manufacturer_id = $3,
         default_supplier_id = $4,
         unit = $5,
         specs = $6,
         purchase_price = $7,
         retail_price = $8,
         min_stock = $9,
         max_stock = $10,
         lead_time_days = $11,
         is_active = $12,
         updated_at = now()
     where c.id = $13
     returning ${SELECT_COLUMNS}`,
    [
      values.name,
      values.categoryId,
      values.manufacturerId,
      values.defaultSupplierId,
      values.unit,
      values.specs,
      values.purchasePrice,
      values.retailPrice,
      values.minStock,
      values.maxStock,
      values.leadTimeDays,
      values.isActive,
      id,
    ],
  );
  return mapRow(rows[0]);
}

/**
 * Archive a row by clearing `is_active`. The schema has no separate archive
 * flag: "archived" and "inactive" are the same state, and history keeps
 * pointing at the row.
 * @param {number} id
 * @param {import('pg').PoolClient | null} [client]
 */
export async function archive(id, client = null) {
  const { rows } = await db(client).query(
    `update components as c
     set is_active = false, updated_at = now()
     where c.id = $1
     returning ${SELECT_COLUMNS}`,
    [id],
  );
  return mapRow(rows[0]);
}

/**
 * Delete one row and return it so the service can audit what was removed.
 * @param {number} id
 * @param {import('pg').PoolClient | null} [client]
 */
export async function remove(id, client = null) {
  const { rows } = await db(client).query(
    `delete from components c where c.id = $1 returning ${SELECT_COLUMNS}`,
    [id],
  );
  return mapRow(rows[0]);
}

/**
 * Count the references that make a delete destructive. One statement keeps the
 * five checks on the same snapshot as the locked component row. Alerts and
 * inventory lines are documented history too, so they block deletion even
 * though the spec names only batches, movements and document lines.
 * @param {number} id
 * @param {import('pg').PoolClient | null} [client]
 */
export async function historyCounts(id, client = null) {
  const { rows } = await db(client).query(
    `select
       (select count(*) from stock_batches where component_id = $1)::integer as batches,
       (select count(*) from stock_movements where component_id = $1)::integer as movements,
       (select count(*) from stock_document_lines where component_id = $1)::integer
         as document_lines,
       (select count(*) from inventory_lines where component_id = $1)::integer
         as inventory_lines,
       (select count(*) from alerts where component_id = $1)::integer as alerts`,
    [id],
  );
  return rows[0];
}

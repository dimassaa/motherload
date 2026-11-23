import { pool } from '../db/pool.js';

// Document number prefixes are part of the paper trail: operators and the
// printed forms expect ПР (приёмка), РС (расход) and ПМ (перемещение).
const DOCUMENT_PREFIXES = {
  receipt: 'ПР',
  issue: 'РС',
  transfer: 'ПМ',
};

const SEQUENCE_DIGITS = 4;

/**
 * Reserve the next document number for a type and year.
 *
 * The counter lives in `document_sequences` and is bumped by an upsert, so two
 * concurrent postings get different numbers without a gap-finding `MAX(id)`
 * query. The row is written inside the caller's transaction: a failed posting
 * releases the number together with its document.
 *
 * @param {import('pg').PoolClient} client
 * @param {'receipt' | 'issue' | 'transfer'} type
 * @param {number} year four-digit document year
 * @returns {Promise<string>} e.g. `"ПР-2026-0001"`
 */
export async function nextDocumentNumber(client, type, year) {
  const prefix = DOCUMENT_PREFIXES[type];
  if (!prefix) throw new TypeError(`nextDocumentNumber: unknown document type "${type}"`);

  const { rows } = await client.query(
    `insert into document_sequences (type, year, last_value)
     values ($1, $2, 1)
     on conflict (type, year) do update set last_value = document_sequences.last_value + 1
     returning last_value`,
    [type, year],
  );

  const sequence = String(rows[0].last_value).padStart(SEQUENCE_DIGITS, '0');
  return `${prefix}-${year}-${sequence}`;
}

/**
 * Look up a warehouse without locking it. Read-only callers such as the FIFO
 * preview must not queue behind a posting transaction.
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {number} warehouseId
 * @returns {Promise<{ id: number, code: string, name: string, isActive: boolean } | null>}
 */
export async function findWarehouseById(client, warehouseId) {
  const { rows } = await client.query(
    'select id, code, name, is_active from warehouses where id = $1',
    [warehouseId],
  );
  const row = rows[0];
  if (!row) return null;

  return { id: row.id, code: row.code, name: row.name, isActive: row.is_active };
}

/**
 * Lock the warehouse row and return it.
 *
 * Every stock operation starts here: the row lock serialises postings against
 * inventory count creation, which takes the same lock before freezing a
 * warehouse. Without it a receipt could pass the freeze check just before a
 * count snapshot is taken and silently invalidate `expected_qty`.
 *
 * @param {import('pg').PoolClient} client
 * @param {number} warehouseId
 * @returns {Promise<{ id: number, code: string, name: string, isActive: boolean } | null>}
 */
export async function lockWarehouse(client, warehouseId) {
  const { rows } = await client.query(
    'select id, code, name, is_active from warehouses where id = $1 for update',
    [warehouseId],
  );
  const row = rows[0];
  if (!row) return null;

  return { id: row.id, code: row.code, name: row.name, isActive: row.is_active };
}

/**
 * Find a live inventory count freezing the warehouse.
 * @param {import('pg').PoolClient} client
 * @param {number} warehouseId
 * @returns {Promise<number | null>} count id, or null when the warehouse is free
 */
export async function findActiveInventoryCount(client, warehouseId) {
  const { rows } = await client.query(
    `select id from inventory_counts
     where warehouse_id = $1 and status in ('draft', 'submitted')
     limit 1`,
    [warehouseId],
  );
  return rows[0]?.id ?? null;
}

/**
 * @param {import('pg').PoolClient} client
 * @param {number} supplierId
 * @returns {Promise<{ id: number, name: string, isActive: boolean } | null>}
 */
export async function findSupplierById(client, supplierId) {
  const { rows } = await client.query('select id, name, is_active from suppliers where id = $1', [
    supplierId,
  ]);
  const row = rows[0];
  if (!row) return null;

  return { id: row.id, name: row.name, isActive: row.is_active };
}

/**
 * Load several components in one round trip. Archived rows are returned too so
 * the service can name the offending SKU in the error instead of reporting a
 * missing component.
 * @param {import('pg').PoolClient} client
 * @param {number[]} componentIds
 * @returns {Promise<Array<{ id: number, sku: string, name: string, isActive: boolean }>>}
 */
export async function findComponentsByIds(client, componentIds) {
  const { rows } = await client.query(
    'select id, sku, name, is_active from components where id = any($1::int[])',
    [componentIds],
  );

  return rows.map((row) => ({
    id: row.id,
    sku: row.sku,
    name: row.name,
    isActive: row.is_active,
  }));
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{
 *   type: 'receipt' | 'issue' | 'transfer',
 *   number: string,
 *   docDate: string,
 *   supplierId?: number | null,
 *   warehouseId?: number | null,
 *   fromWarehouseId?: number | null,
 *   toWarehouseId?: number | null,
 *   reason?: string | null,
 *   comment?: string | null,
 *   totalCost: string,
 *   createdBy?: number | null,
 * }} input
 * @returns {Promise<{ id: number, number: string }>}
 */
export async function insertDocument(client, input) {
  const {
    type,
    number,
    docDate,
    supplierId = null,
    warehouseId = null,
    fromWarehouseId = null,
    toWarehouseId = null,
    reason = null,
    comment = null,
    totalCost,
    createdBy = null,
  } = input;

  const { rows } = await client.query(
    `insert into stock_documents
       (type, number, doc_date, supplier_id, warehouse_id,
        from_warehouse_id, to_warehouse_id, reason, comment, total_cost, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id, number`,
    [
      type,
      number,
      docDate,
      supplierId,
      warehouseId,
      fromWarehouseId,
      toWarehouseId,
      reason,
      comment,
      totalCost,
      createdBy,
    ],
  );

  return { id: rows[0].id, number: rows[0].number };
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{
 *   documentId: number,
 *   componentId: number,
 *   qty: number,
 *   unitCost: string,
 *   totalCost: string,
 *   comment?: string | null,
 * }} input
 * @returns {Promise<{ id: number }>}
 */
export async function insertDocumentLine(client, input) {
  const { documentId, componentId, qty, unitCost, totalCost, comment = null } = input;

  const { rows } = await client.query(
    `insert into stock_document_lines (document_id, component_id, qty, unit_cost, total_cost, comment)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [documentId, componentId, qty, unitCost, totalCost, comment],
  );

  return { id: rows[0].id };
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{
 *   componentId: number,
 *   warehouseId: number,
 *   supplierId?: number | null,
 *   unitCost: string,
 *   qty: number,
 *   receivedAt: string,
 *   documentNo?: string | null,
 * }} input
 * @returns {Promise<{ id: number }>}
 */
export async function insertBatch(client, input) {
  const {
    componentId,
    warehouseId,
    supplierId = null,
    unitCost,
    qty,
    receivedAt,
    documentNo = null,
  } = input;

  const { rows } = await client.query(
    `insert into stock_batches
       (component_id, warehouse_id, supplier_id, unit_cost, qty_received, qty_remaining,
        received_at, document_no)
     values ($1, $2, $3, $4, $5, $5, $6, $7)
     returning id`,
    [componentId, warehouseId, supplierId, unitCost, qty, receivedAt, documentNo],
  );

  return { id: rows[0].id };
}

/**
 * @param {import('pg').PoolClient} client
 * @param {{
 *   componentId: number,
 *   warehouseId: number,
 *   qtyDelta: number,
 *   unitCost: string,
 *   documentId?: number | null,
 *   lineId?: number | null,
 * }} input
 * @returns {Promise<{ id: number }>}
 */
export async function insertMovement(client, input) {
  const { componentId, warehouseId, qtyDelta, unitCost, documentId = null, lineId = null } = input;

  const { rows } = await client.query(
    `insert into stock_movements
       (component_id, warehouse_id, qty_delta, unit_cost, document_id, line_id)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [componentId, warehouseId, qtyDelta, unitCost, documentId, lineId],
  );

  return { id: rows[0].id };
}

// One SQL body for both preview and posting: the allocation must see exactly
// the rows the lock protects. ORDER BY matches allocateFifo's sort keys.
const OPEN_BATCHES_SQL = `select id, unit_cost, qty_remaining, received_at, document_no
  from stock_batches
  where component_id = $1 and warehouse_id = $2 and qty_remaining > 0
  order by received_at, id`;

function mapBatch(row) {
  return {
    id: row.id,
    unitCost: row.unit_cost,
    qtyRemaining: row.qty_remaining,
    // pg-types returns `date` columns as ISO strings, so FIFO ordering stays
    // chronological without a timezone shift.
    receivedAt: row.received_at,
    documentNo: row.document_no ?? null,
  };
}

/**
 * List the batches a FIFO preview may consume, without locking.
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {number} componentId
 * @param {number} warehouseId
 * @returns {Promise<Array<{
 *   id: number,
 *   unitCost: string,
 *   qtyRemaining: number,
 *   receivedAt: string,
 *   documentNo: string | null,
 * }>>}
 */
export async function listOpenBatches(client, componentId, warehouseId) {
  const { rows } = await client.query(OPEN_BATCHES_SQL, [componentId, warehouseId]);
  return rows.map(mapBatch);
}

/**
 * Lock the batches a posting will consume.
 *
 * `FOR UPDATE` is what makes two concurrent issues of the same component
 * serialise: the second transaction waits, then allocates against the remaining
 * quantity instead of overselling a batch it read before the first commit.
 * @param {import('pg').PoolClient} client
 * @param {number} componentId
 * @param {number} warehouseId
 * @returns {Promise<Array<{
 *   id: number,
 *   unitCost: string,
 *   qtyRemaining: number,
 *   receivedAt: string,
 *   documentNo: string | null,
 * }>>}
 */
export async function lockOpenBatches(client, componentId, warehouseId) {
  const { rows } = await client.query(`${OPEN_BATCHES_SQL} for update`, [componentId, warehouseId]);
  return rows.map(mapBatch);
}

/**
 * Record which batch a document line or inventory line consumed.
 *
 * Exactly one source is set: `lineId` for issues and transfers, or
 * `inventoryLineId` for a negative inventory adjustment, which has no stock
 * document. The `batch_consumptions_single_source` check rejects rows with zero
 * or two sources, so a caller mistake fails loudly instead of losing provenance.
 * @param {import('pg').PoolClient} client
 * @param {{
 *   lineId?: number | null,
 *   inventoryLineId?: number | null,
 *   batchId: number,
 *   qty: number,
 *   unitCost: string,
 * }} input
 * @returns {Promise<{ id: number }>}
 */
export async function insertBatchConsumption(
  client,
  { lineId = null, inventoryLineId = null, batchId, qty, unitCost },
) {
  const { rows } = await client.query(
    `insert into batch_consumptions
       (line_id, inventory_line_id, batch_id, qty, unit_cost)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [lineId, inventoryLineId, batchId, qty, unitCost],
  );

  return { id: rows[0].id };
}

/**
 * Take consumed units out of a batch.
 *
 * The `qty_remaining >= $2` guard is a last line of defence: the row is already
 * locked and FIFO checked the quantity, so no row updated means the code has a
 * bug. Failing loudly beats silently writing a negative balance.
 * @param {import('pg').PoolClient} client
 * @param {{ batchId: number, qty: number }} input
 * @returns {Promise<number>} the new remaining quantity
 */
export async function decrementBatchRemaining(client, { batchId, qty }) {
  const { rows } = await client.query(
    `update stock_batches
     set qty_remaining = qty_remaining - $2
     where id = $1 and qty_remaining >= $2
     returning qty_remaining`,
    [batchId, qty],
  );

  if (rows.length === 0) {
    throw new Error(`stock batch ${batchId} cannot be consumed by ${qty}: guard violated`);
  }

  return rows[0].qty_remaining;
}

// ---------------------------------------------------------------------------
// Read models for the stock document screens.
//
// Money columns stay PostgreSQL numeric strings: the templates format them and
// never do arithmetic. Only quantities (integer columns) are returned as JS
// numbers.
// ---------------------------------------------------------------------------

/**
 * Escape LIKE metacharacters so a literal `%` or `_` in a filter stays literal.
 * @param {string} value
 * @returns {string}
 */
function likePattern(value) {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

// Shared header projection for lists and the document card. Joining both
// warehouse roles in one query keeps a transfer row readable without a second
// round trip per warehouse.
const DOCUMENT_HEADER_SELECT = `
  select
    d.id,
    d.type,
    d.number,
    d.doc_date,
    d.reason,
    d.comment,
    d.total_cost,
    d.created_at,
    s.name as supplier_name,
    w.name as warehouse_name,
    w.city as warehouse_city,
    fw.name as from_warehouse_name,
    fw.city as from_warehouse_city,
    tw.name as to_warehouse_name,
    tw.city as to_warehouse_city,
    u.full_name as author_name,
    (
      select count(*)::integer
      from stock_document_lines l
      where l.document_id = d.id
    ) as line_count
  from stock_documents d
  left join suppliers s on s.id = d.supplier_id
  left join warehouses w on w.id = d.warehouse_id
  left join warehouses fw on fw.id = d.from_warehouse_id
  left join warehouses tw on tw.id = d.to_warehouse_id
  left join users u on u.id = d.created_by
`;

function mapDocumentHeader(row) {
  if (!row) return null;

  return {
    id: row.id,
    type: row.type,
    number: row.number,
    docDate: row.doc_date,
    reason: row.reason ?? null,
    comment: row.comment ?? null,
    totalCost: row.total_cost,
    createdAt: row.created_at,
    supplierName: row.supplier_name ?? null,
    warehouseName: row.warehouse_name ?? null,
    warehouseCity: row.warehouse_city ?? null,
    fromWarehouseName: row.from_warehouse_name ?? null,
    fromWarehouseCity: row.from_warehouse_city ?? null,
    toWarehouseName: row.to_warehouse_name ?? null,
    toWarehouseCity: row.to_warehouse_city ?? null,
    authorName: row.author_name ?? null,
    lineCount: row.line_count,
  };
}

/**
 * Build the shared WHERE clause. Every filter is optional; empty values are
 * already normalised to `null`/`''` by the controller's Zod schema, so this
 * function only has to append the conditions and their parameters.
 * @param {{
 *   type: 'receipt' | 'issue' | 'transfer',
 *   q?: string,
 *   warehouseId?: number | null,
 *   supplierId?: number | null,
 *   fromWarehouseId?: number | null,
 *   toWarehouseId?: number | null,
 *   reason?: string | null,
 *   dateFrom?: string,
 *   dateTo?: string,
 * }} filters
 */
function documentFilter(filters) {
  const conditions = ['d.type = $1'];
  const params = [filters.type];

  if (filters.q) {
    params.push(likePattern(filters.q));
    const index = params.length;
    conditions.push(
      `(d.number ilike $${index} escape '\\'
        or s.name ilike $${index} escape '\\'
        or w.name ilike $${index} escape '\\'
        or fw.name ilike $${index} escape '\\'
        or tw.name ilike $${index} escape '\\')`,
    );
  }
  if (filters.warehouseId) {
    params.push(filters.warehouseId);
    conditions.push(`d.warehouse_id = $${params.length}`);
  }
  if (filters.supplierId) {
    params.push(filters.supplierId);
    conditions.push(`d.supplier_id = $${params.length}`);
  }
  if (filters.fromWarehouseId) {
    params.push(filters.fromWarehouseId);
    conditions.push(`d.from_warehouse_id = $${params.length}`);
  }
  if (filters.toWarehouseId) {
    params.push(filters.toWarehouseId);
    conditions.push(`d.to_warehouse_id = $${params.length}`);
  }
  if (filters.reason) {
    params.push(filters.reason);
    conditions.push(`d.reason = $${params.length}`);
  }
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    conditions.push(`d.doc_date >= $${params.length}::date`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    conditions.push(`d.doc_date <= $${params.length}::date`);
  }

  return { where: conditions.join(' and '), params };
}

/**
 * One page of documents of a single type, newest first.
 * @param {Parameters<typeof documentFilter>[0] & { limit: number, offset: number }} filters
 */
export async function listDocumentViews(filters) {
  const { where, params } = documentFilter(filters);
  const limitIndex = params.length + 1;
  const offsetIndex = params.length + 2;

  const { rows } = await pool.query(
    `${DOCUMENT_HEADER_SELECT}
     where ${where}
     order by d.doc_date desc, d.id desc
     limit $${limitIndex} offset $${offsetIndex}`,
    [...params, filters.limit, filters.offset],
  );

  return rows.map(mapDocumentHeader);
}

/**
 * Total rows matching the same filters, for the pagination footer.
 * @param {Parameters<typeof documentFilter>[0]} filters
 * @returns {Promise<number>}
 */
export async function countDocumentViews(filters) {
  const { where, params } = documentFilter(filters);
  const { rows } = await pool.query(
    `select count(*)::integer as total
     from stock_documents d
     left join suppliers s on s.id = d.supplier_id
     left join warehouses w on w.id = d.warehouse_id
     left join warehouses fw on fw.id = d.from_warehouse_id
     left join warehouses tw on tw.id = d.to_warehouse_id
     where ${where}`,
    params,
  );

  return rows[0].total;
}

/**
 * One document header by id.
 * @param {number} documentId
 */
export async function findDocumentView(documentId) {
  const { rows } = await pool.query(`${DOCUMENT_HEADER_SELECT} where d.id = $1`, [documentId]);
  return mapDocumentHeader(rows[0]);
}

/**
 * Lines of a document with their consumed batches, in stored order.
 *
 * `unit_cost::text` is deliberate: a JSON number would arrive in JS as a float,
 * and money must stay a string all the way to the template.
 * @param {number} documentId
 * @returns {Promise<Array<{
 *   id: number,
 *   componentId: number,
 *   sku: string,
 *   name: string,
 *   unit: string,
 *   qty: number,
 *   unitCost: string,
 *   totalCost: string,
 *   comment: string | null,
 *   allocations: Array<{
 *     batchId: number,
 *     qty: number,
 *     unitCost: string,
 *     receivedAt: string,
 *     documentNo: string | null,
 *   }>,
 * }>>}
 */
export async function listDocumentLineViews(documentId) {
  const { rows } = await pool.query(
    `select
       l.id,
       l.qty,
       l.unit_cost,
       l.total_cost,
       l.comment,
       c.id as component_id,
       c.sku,
       c.name as component_name,
       c.unit,
       coalesce(
         jsonb_agg(
           jsonb_build_object(
             'batchId', bc.batch_id,
             'qty', bc.qty,
             'unitCost', bc.unit_cost::text,
             'receivedAt', b.received_at,
             'documentNo', b.document_no
           )
           order by bc.id
         ) filter (where bc.id is not null),
         '[]'::jsonb
       ) as allocations
     from stock_document_lines l
     join components c on c.id = l.component_id
     left join batch_consumptions bc on bc.line_id = l.id
     left join stock_batches b on b.id = bc.batch_id
     where l.document_id = $1
     group by l.id, c.id
     order by l.id`,
    [documentId],
  );

  return rows.map((row) => ({
    id: row.id,
    componentId: row.component_id,
    sku: row.sku,
    name: row.component_name,
    unit: row.unit,
    qty: row.qty,
    unitCost: row.unit_cost,
    totalCost: row.total_cost,
    comment: row.comment ?? null,
    allocations: row.allocations ?? [],
  }));
}

/**
 * Positions for the fallback `<select>` on stock forms.
 *
 * Active positions always appear. Ids passed in `includeIds` are kept even when
 * archived, so a rejected post can still show the operator the exact option the
 * server refused instead of silently replacing it with an empty field.
 *
 * @param {number[]} [includeIds]
 * @returns {Promise<Array<{
 *   id: number,
 *   sku: string,
 *   name: string,
 *   unit: string,
 *   isActive: boolean,
 * }>>}
 */
export async function listFormComponents(includeIds = []) {
  const ids = [...new Set(includeIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  const { rows } = await pool.query(
    `select id, sku, name, unit, is_active
     from components
     where is_active or id = any($1::int[])
     order by name, id`,
    [ids],
  );

  return rows.map((row) => ({
    id: row.id,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    isActive: row.is_active,
  }));
}

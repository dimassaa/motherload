import assert from 'node:assert/strict';
import test from 'node:test';
import { migrate } from '../../src/db/migrate.js';
import { pool, query } from '../../src/db/pool.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';

const CORE_TABLES = [
  'schema_migrations',
  'users',
  'warehouses',
  'categories',
  'manufacturers',
  'suppliers',
  'components',
  'stock_batches',
  'stock_documents',
  'stock_document_lines',
  'batch_consumptions',
  'stock_movements',
  'inventory_counts',
  'inventory_lines',
  'alerts',
  'audit_log',
  'document_sequences',
  'sessions',
];

const CORE_VIEWS = [
  'v_stock_balances',
  'v_stock_values',
  'v_component_stock',
  'v_component_warehouse_stock',
];

const CORE_ENUMS = [
  'user_role',
  'stock_doc_type',
  'issue_reason',
  'inventory_status',
  'alert_type',
  'alert_status',
  'alert_severity',
];

// PostgreSQL localises error messages (this server reports in Russian), so
// assertions match SQLSTATE codes instead of message text.
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

function sqlState(expected) {
  return (error) => {
    assert.equal(error.code, expected, error.message);
    return true;
  };
}

test.before(async () => {
  await setupTestDb();
});

test.beforeEach(async () => {
  await truncateAll();
});

test.after(async () => {
  await teardownTestDb();
});

async function insertWarehouse(code = 'WH-T') {
  const { rows } = await query(
    `insert into warehouses (code, name, city, address)
     values ($1, 'Тестовый склад', 'Минск', 'ул. Тестовая, 1')
     returning id`,
    [code],
  );
  return rows[0].id;
}

async function insertComponent(sku = 'SKU-T') {
  const { rows } = await query(
    `insert into components (sku, name, purchase_price, retail_price)
     values ($1, 'Тестовая позиция', 10, 15)
     returning id`,
    [sku],
  );
  return rows[0].id;
}

async function insertSupplier() {
  const { rows } = await query(
    `insert into suppliers (name, unp, lead_time_days)
     values ('ООО «Тестовый поставщик»', '190000001', 5)
     returning id`,
  );
  return rows[0].id;
}

test('migrations are idempotent and create core tables, views and enums', async () => {
  // setupTestDb already applied the schema; repeated runs must be no-ops.
  const second = await migrate(pool);
  const third = await migrate(pool);
  assert.equal(second.applied, 0);
  assert.equal(third.applied, 0);

  const tables = await query("select tablename from pg_tables where schemaname = 'public'");
  const tableNames = new Set(tables.rows.map((row) => row.tablename));
  for (const name of CORE_TABLES) {
    assert.ok(tableNames.has(name), `missing table ${name}`);
  }

  const views = await query("select viewname from pg_views where schemaname = 'public'");
  const viewNames = new Set(views.rows.map((row) => row.viewname));
  for (const name of CORE_VIEWS) {
    assert.ok(viewNames.has(name), `missing view ${name}`);
  }

  const enums = await query("select typname from pg_type where typtype = 'e'");
  const enumNames = new Set(enums.rows.map((row) => row.typname));
  for (const name of CORE_ENUMS) {
    assert.ok(enumNames.has(name), `missing enum ${name}`);
  }

  const migrationColumns = await query(
    `select column_name, data_type, is_nullable
     from information_schema.columns
     where table_schema = 'public' and table_name = 'schema_migrations'
     order by ordinal_position`,
  );
  assert.deepEqual(
    migrationColumns.rows.map((row) => row.column_name),
    ['version', 'applied_at'],
    'schema_migrations must follow spec 7.2',
  );
  assert.equal(migrationColumns.rows[0].data_type, 'text');
  assert.equal(migrationColumns.rows[1].data_type, 'timestamp with time zone');
  assert.equal(migrationColumns.rows[1].is_nullable, 'NO');
});

test('money and quantity columns use the documented PostgreSQL types', async () => {
  const { rows } = await query(
    `select table_name, column_name, data_type, numeric_precision, numeric_scale
     from information_schema.columns
     where table_schema = 'public'`,
  );
  const columns = new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));

  const exactNumeric = (name, precision, scale) => {
    const column = columns.get(name);
    assert.ok(column, `missing column ${name}`);
    assert.equal(column.data_type, 'numeric', name);
    assert.equal(column.numeric_precision, precision, name);
    assert.equal(column.numeric_scale, scale, name);
  };
  const integer = (name) => {
    const column = columns.get(name);
    assert.ok(column, `missing column ${name}`);
    assert.equal(column.data_type, 'integer', name);
  };

  exactNumeric('components.purchase_price', 12, 2);
  exactNumeric('components.retail_price', 12, 2);
  exactNumeric('stock_batches.unit_cost', 14, 4);
  exactNumeric('stock_movements.unit_cost', 14, 4);
  exactNumeric('stock_documents.total_cost', 14, 2);
  integer('stock_batches.qty_received');
  integer('stock_movements.qty_delta');
  integer('stock_document_lines.qty');
});

test('foreign keys, checks and unique constraints reject bad data', async () => {
  await assert.rejects(
    () =>
      query(
        `insert into stock_batches (component_id, warehouse_id, unit_cost, qty_received, qty_remaining, received_at)
         values (999999, 999999, 1, 1, 1, '2026-01-01')`,
      ),
    sqlState(FOREIGN_KEY_VIOLATION),
  );

  await query("insert into warehouses (code, name, city, address) values ('X','X','X','X')");
  await assert.rejects(
    () => query("insert into warehouses (code, name, city, address) values ('X','X','X','X')"),
    sqlState(UNIQUE_VIOLATION),
  );

  const warehouseId = await insertWarehouse('WH-CHECK');
  const componentId = await insertComponent('SKU-CHECK');

  await assert.rejects(
    () =>
      query(
        `insert into stock_batches (component_id, warehouse_id, unit_cost, qty_received, qty_remaining, received_at)
         values ($1, $2, 1, 1, 2, '2026-01-01')`,
        [componentId, warehouseId],
      ),
    sqlState(CHECK_VIOLATION),
  );
  await assert.rejects(
    () =>
      query(
        `insert into stock_batches (component_id, warehouse_id, unit_cost, qty_received, qty_remaining, received_at)
         values ($1, $2, -1, 1, 1, '2026-01-01')`,
        [componentId, warehouseId],
      ),
    sqlState(CHECK_VIOLATION),
  );

  await assert.rejects(
    () =>
      query(
        `insert into stock_movements (component_id, warehouse_id, qty_delta, unit_cost)
         values ($1, $2, 0, 10)`,
        [componentId, warehouseId],
      ),
    sqlState(CHECK_VIOLATION),
  );

  await assert.rejects(
    () =>
      query(
        `insert into suppliers (name, unp, lead_time_days)
         values ('ООО «Плохой УНП»', '12345', 5)`,
      ),
    sqlState(CHECK_VIOLATION),
  );
});

test('stock documents enforce per-type required fields and unique numbers', async () => {
  const warehouseId = await insertWarehouse('WH-DOC');
  const otherWarehouseId = await insertWarehouse('WH-DOC-2');
  const supplierId = await insertSupplier();

  await assert.rejects(
    () =>
      query(
        `insert into stock_documents (type, number, doc_date, warehouse_id)
         values ('receipt', 'ПР-2026-0001', '2026-11-22', $1)`,
        [warehouseId],
      ),
    sqlState(CHECK_VIOLATION),
  );

  await query(
    `insert into stock_documents (type, number, doc_date, warehouse_id, supplier_id)
     values ('receipt', 'ПР-2026-0001', '2026-11-22', $1, $2)`,
    [warehouseId, supplierId],
  );

  await assert.rejects(
    () =>
      query(
        `insert into stock_documents (type, number, doc_date, warehouse_id, supplier_id)
         values ('receipt', 'ПР-2026-0001', '2026-11-22', $1, $2)`,
        [warehouseId, supplierId],
      ),
    sqlState(UNIQUE_VIOLATION),
  );

  await assert.rejects(
    () =>
      query(
        `insert into stock_documents (type, number, doc_date, warehouse_id)
         values ('issue', 'РС-2026-0001', '2026-11-22', $1)`,
        [warehouseId],
      ),
    sqlState(CHECK_VIOLATION),
  );

  await assert.rejects(
    () =>
      query(
        `insert into stock_documents (type, number, doc_date, from_warehouse_id, to_warehouse_id)
         values ('transfer', 'ПМ-2026-0001', '2026-11-22', $1, $1)`,
        [warehouseId],
      ),
    sqlState(CHECK_VIOLATION),
  );

  await query(
    `insert into stock_documents (type, number, doc_date, from_warehouse_id, to_warehouse_id)
     values ('transfer', 'ПМ-2026-0001', '2026-11-22', $1, $2)`,
    [warehouseId, otherWarehouseId],
  );
});

test('only one active inventory count per warehouse is allowed', async () => {
  const warehouseId = await insertWarehouse('WH-INV');

  await query('insert into inventory_counts (warehouse_id) values ($1)', [warehouseId]);
  await assert.rejects(
    () => query('insert into inventory_counts (warehouse_id) values ($1)', [warehouseId]),
    sqlState(UNIQUE_VIOLATION),
  );

  await query("update inventory_counts set status = 'submitted'");
  await assert.rejects(
    () => query('insert into inventory_counts (warehouse_id) values ($1)', [warehouseId]),
    sqlState(UNIQUE_VIOLATION),
  );

  await query("update inventory_counts set status = 'approved'");
  await query('insert into inventory_counts (warehouse_id) values ($1)', [warehouseId]);

  await query("update inventory_counts set status = 'cancelled'");
  await query('insert into inventory_counts (warehouse_id) values ($1)', [warehouseId]);
});

test('only one unresolved alert per type, component and warehouse is allowed', async () => {
  const warehouseId = await insertWarehouse('WH-ALERT');
  const componentId = await insertComponent('SKU-ALERT');

  const insertAlert = (status) =>
    query(
      `insert into alerts (type, severity, component_id, warehouse_id, message, status)
       values ('low_stock', 'warning', $1, $2, 'Остаток ниже порога', $3)`,
      [componentId, warehouseId, status],
    );

  await insertAlert('open');
  await assert.rejects(() => insertAlert('acknowledged'), sqlState(UNIQUE_VIOLATION));

  await query("update alerts set status = 'resolved'");
  await insertAlert('open');
});

test('inventory lines keep the difference in sync with actual and expected', async () => {
  const warehouseId = await insertWarehouse('WH-LINE');
  const componentId = await insertComponent('SKU-LINE');
  const { rows } = await query(
    'insert into inventory_counts (warehouse_id) values ($1) returning id',
    [warehouseId],
  );
  const countId = rows[0].id;

  await assert.rejects(
    () =>
      query(
        `insert into inventory_lines (count_id, component_id, expected_qty, actual_qty, difference)
         values ($1, $2, 10, 7, 4)`,
        [countId, componentId],
      ),
    sqlState(CHECK_VIOLATION),
  );

  await query(
    `insert into inventory_lines (count_id, component_id, expected_qty, actual_qty, difference)
     values ($1, $2, 10, 7, -3)`,
    [countId, componentId],
  );

  const pendingId = await insertComponent('SKU-LINE-PENDING');
  await assert.rejects(
    () =>
      query(
        `insert into inventory_lines (count_id, component_id, expected_qty, actual_qty)
         values ($1, $2, 5, 7)`,
        [countId, pendingId],
      ),
    sqlState(CHECK_VIOLATION),
  );

  const consistentId = await insertComponent('SKU-LINE-CONSISTENT');
  await query(
    `insert into inventory_lines (count_id, component_id, expected_qty, actual_qty, difference)
     values ($1, $2, 5, 7, 2)`,
    [countId, consistentId],
  );

  await assert.rejects(
    () =>
      query(
        `insert into inventory_lines (count_id, component_id, expected_qty)
         values ($1, $2, 4)`,
        [countId, componentId],
      ),
    sqlState(UNIQUE_VIOLATION),
  );
});

test('document sequences issue numbers per document type and year', async () => {
  const first = await query(
    `insert into document_sequences (type, year, last_value) values ('receipt', 2026, 1)
     returning last_value`,
  );
  assert.equal(first.rows[0].last_value, 1);

  const second = await query(
    `insert into document_sequences (type, year, last_value) values ('receipt', 2026, 1)
     on conflict (type, year) do update set last_value = document_sequences.last_value + 1
     returning last_value`,
  );
  assert.equal(second.rows[0].last_value, 2);

  const otherYear = await query(
    `insert into document_sequences (type, year, last_value) values ('receipt', 2027, 1)
     returning last_value`,
  );
  assert.equal(otherYear.rows[0].last_value, 1);
});

test('stock views expose balances, FIFO values and cost per warehouse', async () => {
  const warehouseId = await insertWarehouse('WH-VIEW');
  const componentId = await insertComponent('SKU-VIEW');

  await query(
    `insert into stock_batches (component_id, warehouse_id, unit_cost, qty_received, qty_remaining, received_at)
     values ($1, $2, '10.0000', 10, 6, '2026-01-01'),
            ($1, $2, '12.5000', 5, 5, '2026-02-01')`,
    [componentId, warehouseId],
  );
  await query(
    `insert into stock_movements (component_id, warehouse_id, qty_delta, unit_cost)
     values ($1, $2, 10, '10.0000'),
            ($1, $2, 5, '12.5000'),
            ($1, $2, -4, '10.0000')`,
    [componentId, warehouseId],
  );

  const balances = await query(
    'select qty from v_stock_balances where component_id = $1 and warehouse_id = $2',
    [componentId, warehouseId],
  );
  assert.equal(balances.rows[0].qty, 11);

  const values = await query(
    'select qty, value, avg_cost from v_stock_values where component_id = $1 and warehouse_id = $2',
    [componentId, warehouseId],
  );
  assert.equal(values.rows[0].qty, 11);
  assert.equal(values.rows[0].value, '122.5000');
  assert.equal(values.rows[0].avg_cost, '11.1364');

  const perWarehouse = await query(
    'select qty, value, avg_cost from v_component_warehouse_stock where component_id = $1 and warehouse_id = $2',
    [componentId, warehouseId],
  );
  assert.equal(perWarehouse.rows[0].qty, 11);
  assert.equal(perWarehouse.rows[0].value, '122.5000');
  assert.equal(perWarehouse.rows[0].avg_cost, '11.1364');

  const totals = await query('select qty, value from v_component_stock where component_id = $1', [
    componentId,
  ]);
  assert.equal(totals.rows[0].qty, 11);
  assert.equal(totals.rows[0].value, '122.5000');
});

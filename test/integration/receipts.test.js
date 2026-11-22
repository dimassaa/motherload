import assert from 'node:assert/strict';
import test from 'node:test';
import { query } from '../../src/db/pool.js';
import { postReceipt } from '../../src/services/stock.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';
import { createComponentFactory, createWarehouseFactory, seedBase } from '../helpers/factories.js';

test.before(async () => {
  await setupTestDb();
});

test.beforeEach(async () => {
  await truncateAll();
});

test.after(async () => {
  await teardownTestDb();
});

/** Ledger balance for a component/warehouse pair; 0 when it never moved. */
async function balance(componentId, warehouseId) {
  const { rows } = await query(
    'select qty from v_stock_balances where component_id = $1 and warehouse_id = $2',
    [componentId, warehouseId],
  );
  return rows[0]?.qty ?? 0;
}

async function countRows(table) {
  const { rows } = await query(`select count(*)::integer as count from ${table}`);
  return rows[0].count;
}

async function receiptAudit() {
  const { rows } = await query(
    "select entity_type, entity_id, details from audit_log where action = 'stock.receipt' order by id",
  );
  return rows;
}

test('receipt creates document, batch and positive movement', async () => {
  const ctx = await seedBase();

  const result = await postReceipt({
    ...ctx.receiptInput,
    lines: [{ componentId: ctx.componentId, qty: 5, unitCost: '100.0000' }],
  });

  assert.match(result.number, /^ПР-2026-0001$/);
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 5);

  const { rows: documents } = await query('select * from stock_documents where id = $1', [
    result.documentId,
  ]);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].type, 'receipt');
  assert.equal(documents[0].number, 'ПР-2026-0001');
  assert.equal(documents[0].doc_date, '2026-11-22');
  assert.equal(documents[0].supplier_id, ctx.supplierId);
  assert.equal(documents[0].warehouse_id, ctx.warehouseId);
  assert.equal(documents[0].created_by, ctx.userId);
  assert.equal(documents[0].total_cost, '500.00');

  const { rows: lines } = await query('select * from stock_document_lines where document_id = $1', [
    result.documentId,
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].component_id, ctx.componentId);
  assert.equal(lines[0].qty, 5);
  assert.equal(lines[0].unit_cost, '100.0000');
  assert.equal(lines[0].total_cost, '500.00');

  const { rows: batches } = await query('select * from stock_batches where component_id = $1', [
    ctx.componentId,
  ]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].warehouse_id, ctx.warehouseId);
  assert.equal(batches[0].supplier_id, ctx.supplierId);
  assert.equal(batches[0].unit_cost, '100.0000');
  assert.equal(batches[0].qty_received, 5);
  assert.equal(batches[0].qty_remaining, 5);
  assert.equal(batches[0].received_at, '2026-11-22');
  assert.equal(batches[0].document_no, 'ПР-2026-0001');

  const { rows: movements } = await query('select * from stock_movements where document_id = $1', [
    result.documentId,
  ]);
  assert.equal(movements.length, 1);
  assert.equal(movements[0].component_id, ctx.componentId);
  assert.equal(movements[0].warehouse_id, ctx.warehouseId);
  assert.equal(movements[0].qty_delta, 5);
  assert.equal(movements[0].unit_cost, '100.0000');
  assert.equal(movements[0].line_id, lines[0].id);

  const audit = await receiptAudit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].entity_type, 'stock_document');
  assert.equal(audit[0].entity_id, String(result.documentId));
  assert.equal(audit[0].details.number, 'ПР-2026-0001');
  assert.equal(audit[0].details.total, '500.00');
});

test('receipt number increments without duplicates', async () => {
  const ctx = await seedBase();
  const lines = [{ componentId: ctx.componentId, qty: 2, unitCost: '10.0000' }];

  const first = await postReceipt({ ...ctx.receiptInput, lines });
  const second = await postReceipt({ ...ctx.receiptInput, lines });

  assert.equal(first.number, 'ПР-2026-0001');
  assert.equal(second.number, 'ПР-2026-0002');
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 4);

  const { rows } = await query(
    "select last_value from document_sequences where type = 'receipt' and year = 2026",
  );
  assert.equal(rows[0].last_value, 2);
});

test('concurrent receipts get distinct numbers', async () => {
  const ctx = await seedBase();
  const secondWarehouse = await createWarehouseFactory({ code: 'WH-TST-2' });
  const lines = [{ componentId: ctx.componentId, qty: 1, unitCost: '10.0000' }];

  const results = await Promise.all([
    postReceipt({ ...ctx.receiptInput, lines }),
    postReceipt({ ...ctx.receiptInput, warehouseId: secondWarehouse.id, lines }),
    postReceipt({ ...ctx.receiptInput, lines }),
  ]);

  assert.deepEqual(results.map((result) => result.number).sort(), [
    'ПР-2026-0001',
    'ПР-2026-0002',
    'ПР-2026-0003',
  ]);
  assert.equal(await countRows('stock_documents'), 3);
});

test('receipt totals are computed with decimal rounding', async () => {
  const ctx = await seedBase();
  const second = await createComponentFactory({
    // A distinct SKU is required by the unique constraint.
    sku: 'RAM-TEST-01',
    name: 'Память тестовая',
    categoryId: ctx.categoryId,
    manufacturerId: ctx.manufacturerId,
    supplierId: ctx.supplierId,
  });

  const result = await postReceipt({
    ...ctx.receiptInput,
    lines: [
      // 3 × 0.3333 = 0.9999 must round half up to 1.00.
      { componentId: ctx.componentId, qty: 3, unitCost: '0.3333' },
      // 7 × 12.3456 = 86.4192 must round to 86.42.
      { componentId: second.id, qty: 7, unitCost: '12.3456' },
    ],
  });

  const { rows: lines } = await query(
    'select component_id, unit_cost, total_cost from stock_document_lines where document_id = $1 order by id',
    [result.documentId],
  );
  assert.deepEqual(
    lines.map((line) => [line.component_id, line.unit_cost, line.total_cost]),
    [
      [ctx.componentId, '0.3333', '1.00'],
      [second.id, '12.3456', '86.42'],
    ],
  );

  const { rows: documents } = await query('select total_cost from stock_documents where id = $1', [
    result.documentId,
  ]);
  assert.equal(documents[0].total_cost, '87.42');
});

test('receipt is rejected when the warehouse has an active inventory count', async (t) => {
  for (const status of ['draft', 'submitted']) {
    await t.test(status, async () => {
      await truncateAll();
      const ctx = await seedBase();
      await query(
        'insert into inventory_counts (warehouse_id, status, started_by) values ($1, $2, $3)',
        [ctx.warehouseId, status, ctx.userId],
      );

      await assert.rejects(
        () => postReceipt(ctx.receiptInput),
        (error) => {
          assert.equal(error.status, 409);
          assert.equal(error.message, 'На складе идёт инвентаризация');
          return true;
        },
      );

      assert.equal(await countRows('stock_documents'), 0);
      assert.equal(await countRows('stock_batches'), 0);
      assert.equal(await countRows('stock_movements'), 0);
    });
  }
});

test('receipt is rejected for an inactive supplier or component', async (t) => {
  await t.test('supplier', async () => {
    await truncateAll();
    const ctx = await seedBase();
    await query('update suppliers set is_active = false where id = $1', [ctx.supplierId]);

    await assert.rejects(
      () => postReceipt(ctx.receiptInput),
      (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.message, 'Поставщик неактивен, приёмка невозможна.');
        return true;
      },
    );

    assert.equal(await countRows('stock_documents'), 0);
  });

  await t.test('component', async () => {
    await truncateAll();
    const ctx = await seedBase();
    const archived = await createComponentFactory({
      sku: 'GPU-TEST-01',
      name: 'Видеокарта тестовая',
      categoryId: ctx.categoryId,
      manufacturerId: ctx.manufacturerId,
      supplierId: ctx.supplierId,
      isActive: false,
    });

    await assert.rejects(
      () =>
        postReceipt({
          ...ctx.receiptInput,
          lines: [
            { componentId: ctx.componentId, qty: 1, unitCost: '10.0000' },
            { componentId: archived.id, qty: 1, unitCost: '10.0000' },
          ],
        }),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /GPU-TEST-01/);
        return true;
      },
    );

    assert.equal(await countRows('stock_documents'), 0);
  });
});

test('receipt writes nothing when the transaction fails midway', async () => {
  const ctx = await seedBase();
  const second = await createComponentFactory({
    sku: 'SSD-TEST-01',
    name: 'Накопитель тестовый',
    categoryId: ctx.categoryId,
    manufacturerId: ctx.manufacturerId,
    supplierId: ctx.supplierId,
  });

  // The quantity exceeds the `integer` column, so PostgreSQL rejects the second
  // line after the first line's document, batch and movement rows already exist.
  // That is the only way to prove the transaction rolls those earlier writes back.
  await assert.rejects(
    () =>
      postReceipt({
        ...ctx.receiptInput,
        lines: [
          { componentId: ctx.componentId, qty: 3, unitCost: '10.0000' },
          { componentId: second.id, qty: 3_000_000_000, unitCost: '10.0000' },
        ],
      }),
    (error) => {
      // 22003 = numeric_value_out_of_range: the failure came from PostgreSQL,
      // after the transaction had already written the first line.
      assert.equal(error.code, '22003');
      return true;
    },
  );

  assert.equal(await countRows('stock_documents'), 0);
  assert.equal(await countRows('stock_document_lines'), 0);
  assert.equal(await countRows('stock_batches'), 0);
  assert.equal(await countRows('stock_movements'), 0);
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 0);
  assert.equal(await countRows('document_sequences'), 0);
  assert.equal((await receiptAudit()).length, 0);

  // The rolled-back number must be handed out again to the next receipt.
  const retried = await postReceipt(ctx.receiptInput);
  assert.equal(retried.number, 'ПР-2026-0001');
});

test('receipt rejects malformed lines before touching the database', async () => {
  const ctx = await seedBase();

  await assert.rejects(
    () =>
      postReceipt({
        ...ctx.receiptInput,
        lines: [{ componentId: ctx.componentId, qty: 0, unitCost: '10.0000' }],
      }),
    (error) => {
      assert.equal(error.status, 400);
      return true;
    },
  );

  await assert.rejects(
    () =>
      postReceipt({
        ...ctx.receiptInput,
        lines: [{ componentId: ctx.componentId, qty: 1, unitCost: '-1' }],
      }),
    (error) => {
      assert.equal(error.status, 400);
      return true;
    },
  );

  await assert.rejects(
    () => postReceipt({ ...ctx.receiptInput, lines: [] }),
    (error) => {
      assert.equal(error.status, 400);
      return true;
    },
  );

  assert.equal(await countRows('stock_documents'), 0);
});

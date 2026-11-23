import assert from 'node:assert/strict';
import test from 'node:test';
import { query } from '../../src/db/pool.js';
import { postReceipt, postTransfer } from '../../src/services/stock.js';
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

async function countTransferDocuments() {
  const { rows } = await query(
    "select count(*)::integer as count from stock_documents where type = 'transfer'",
  );
  return rows[0].count;
}

async function transferAudit() {
  const { rows } = await query(
    "select user_id, entity_type, entity_id, details from audit_log where action = 'stock.transfer' order by id",
  );
  return rows;
}

/** Seed the shared fixtures plus a second warehouse the transfer can target. */
async function seedTransfer() {
  const ctx = await seedBase();
  const destination = await createWarehouseFactory({
    code: 'WH-GOM',
    name: 'Региональный склад Гомель',
    city: 'Гомель',
    address: 'ул. Советская, 25',
  });

  return { ...ctx, toWarehouseId: destination.id };
}

/** Post a receipt that becomes one FIFO batch on the selected warehouse. */
function receive(ctx, qty, unitCost, docDate = ctx.docDate, warehouseId = ctx.warehouseId) {
  return postReceipt({
    ...ctx.receiptInput,
    warehouseId,
    docDate,
    lines: [{ componentId: ctx.componentId, qty, unitCost }],
  });
}

/** Ready-to-use `postTransfer` payload matching `seedTransfer`. */
function transferInput(ctx, lines, overrides = {}) {
  return {
    fromWarehouseId: ctx.warehouseId,
    toWarehouseId: ctx.toWarehouseId,
    docDate: ctx.docDate,
    comment: 'Тестовое перемещение',
    userId: ctx.userId,
    lines,
    ...overrides,
  };
}

test('transfer preserves unit costs and moves stock between warehouses', async () => {
  const ctx = await seedTransfer();
  await receive(ctx, 3, '10.0000', '2026-01-01');
  await receive(ctx, 3, '20.0000', '2026-01-02');

  const result = await postTransfer(transferInput(ctx, [{ componentId: ctx.componentId, qty: 4 }]));

  assert.match(result.number, /^ПМ-2026-0001$/);
  assert.equal(result.totalCost, '50.00');
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 2);
  assert.equal(await balance(ctx.componentId, ctx.toWarehouseId), 4);

  const { rows: documents } = await query('select * from stock_documents where id = $1', [
    result.documentId,
  ]);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].type, 'transfer');
  assert.equal(documents[0].number, 'ПМ-2026-0001');
  assert.equal(documents[0].doc_date, '2026-11-22');
  assert.equal(documents[0].from_warehouse_id, ctx.warehouseId);
  assert.equal(documents[0].to_warehouse_id, ctx.toWarehouseId);
  assert.equal(documents[0].warehouse_id, null);
  assert.equal(documents[0].supplier_id, null);
  assert.equal(documents[0].reason, null);
  assert.equal(documents[0].comment, 'Тестовое перемещение');
  assert.equal(documents[0].created_by, ctx.userId);
  assert.equal(documents[0].total_cost, '50.00');

  const { rows: lines } = await query('select * from stock_document_lines where document_id = $1', [
    result.documentId,
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].component_id, ctx.componentId);
  assert.equal(lines[0].qty, 4);
  // The transfer keeps the weighted average of the consumed batches.
  assert.equal(lines[0].unit_cost, '12.5000');
  assert.equal(lines[0].total_cost, '50.00');

  // Each consumed source batch becomes a destination batch with the same unit
  // cost; the destination batch is dated by the transfer document, not the
  // original receipt, because its FIFO age starts now.
  const { rows: destinationBatches } = await query(
    `select unit_cost, qty_received, qty_remaining, received_at, supplier_id
     from stock_batches
     where warehouse_id = $1
     order by id`,
    [ctx.toWarehouseId],
  );
  assert.deepEqual(
    destinationBatches.map((row) => [
      row.unit_cost,
      row.qty_received,
      row.qty_remaining,
      row.received_at,
      row.supplier_id,
    ]),
    [
      ['10.0000', 3, 3, '2026-11-22', null],
      ['20.0000', 1, 1, '2026-11-22', null],
    ],
  );

  const { rows: sourceBatches } = await query(
    'select qty_remaining from stock_batches where warehouse_id = $1 order by id',
    [ctx.warehouseId],
  );
  assert.deepEqual(
    sourceBatches.map((row) => row.qty_remaining),
    [0, 2],
  );

  const { rows: consumptions } = await query(
    'select qty, unit_cost from batch_consumptions where line_id = $1 order by id',
    [lines[0].id],
  );
  assert.deepEqual(
    consumptions.map((row) => [row.qty, row.unit_cost]),
    [
      [3, '10.0000'],
      [1, '20.0000'],
    ],
  );

  // Two movements per allocation: -qty on the source, +qty on the destination,
  // both attached to the same document and line.
  const { rows: movements } = await query(
    `select warehouse_id, qty_delta, unit_cost, line_id
     from stock_movements
     where document_id = $1
     order by id`,
    [result.documentId],
  );
  assert.deepEqual(
    movements.map((row) => [row.warehouse_id, row.qty_delta, row.unit_cost, row.line_id]),
    [
      [ctx.warehouseId, -3, '10.0000', lines[0].id],
      [ctx.toWarehouseId, 3, '10.0000', lines[0].id],
      [ctx.warehouseId, -1, '20.0000', lines[0].id],
      [ctx.toWarehouseId, 1, '20.0000', lines[0].id],
    ],
  );

  const audit = await transferAudit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].user_id, ctx.userId);
  assert.equal(audit[0].entity_type, 'stock_document');
  assert.equal(audit[0].entity_id, String(result.documentId));
  assert.equal(audit[0].details.number, 'ПМ-2026-0001');
  assert.equal(audit[0].details.total, '50.00');
  assert.equal(audit[0].details.fromWarehouseId, ctx.warehouseId);
  assert.equal(audit[0].details.toWarehouseId, ctx.toWarehouseId);
});

test('transfer numbers increment and a transfer can carry several components', async () => {
  const ctx = await seedTransfer();
  const second = await createComponentFactory({
    sku: 'RAM-TRANSFER-01',
    name: 'Память тестовая',
    categoryId: ctx.categoryId,
    manufacturerId: ctx.manufacturerId,
    supplierId: ctx.supplierId,
  });
  await receive(ctx, 2, '10.0000');
  await postReceipt({
    ...ctx.receiptInput,
    lines: [{ componentId: second.id, qty: 2, unitCost: '20.0000' }],
  });

  const first = await postTransfer(
    transferInput(ctx, [
      { componentId: ctx.componentId, qty: 1 },
      { componentId: second.id, qty: 2 },
    ]),
  );
  const secondTransfer = await postTransfer(
    transferInput(ctx, [{ componentId: ctx.componentId, qty: 1 }]),
  );

  assert.equal(first.number, 'ПМ-2026-0001');
  assert.equal(secondTransfer.number, 'ПМ-2026-0002');
  assert.equal(first.totalCost, '50.00');
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 0);
  assert.equal(await balance(second.id, ctx.warehouseId), 0);
  assert.equal(await balance(ctx.componentId, ctx.toWarehouseId), 2);
  assert.equal(await balance(second.id, ctx.toWarehouseId), 2);
});

test('transfer rejects the same source and destination warehouse', async () => {
  const ctx = await seedBase();
  await receive(ctx, 3, '10.0000');
  const before = {
    documents: await countRows('stock_documents'),
    lines: await countRows('stock_document_lines'),
    movements: await countRows('stock_movements'),
    sequences: await countRows('document_sequences'),
  };

  await assert.rejects(
    () =>
      postTransfer(
        transferInput(ctx, [{ componentId: ctx.componentId, qty: 1 }], {
          toWarehouseId: ctx.warehouseId,
        }),
      ),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.message, 'Склад-источник и склад-назначение должны различаться.');
      return true;
    },
  );

  assert.equal(await countTransferDocuments(), 0);
  assert.equal(await countRows('stock_documents'), before.documents);
  assert.equal(await countRows('stock_document_lines'), before.lines);
  assert.equal(await countRows('stock_movements'), before.movements);
  assert.equal(await countRows('document_sequences'), before.sequences);
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 3);
  assert.equal((await transferAudit()).length, 0);
});

test('transfer is rejected while either warehouse is frozen', async (t) => {
  for (const frozen of ['source', 'destination']) {
    for (const status of ['draft', 'submitted']) {
      await t.test(`${frozen} ${status}`, async () => {
        await truncateAll();
        const ctx = await seedTransfer();
        await receive(ctx, 5, '10.0000');
        const frozenWarehouseId = frozen === 'source' ? ctx.warehouseId : ctx.toWarehouseId;
        await query(
          'insert into inventory_counts (warehouse_id, status, started_by) values ($1, $2, $3)',
          [frozenWarehouseId, status, ctx.userId],
        );

        await assert.rejects(
          () => postTransfer(transferInput(ctx, [{ componentId: ctx.componentId, qty: 1 }])),
          (error) => {
            assert.equal(error.status, 409);
            assert.equal(error.message, 'На складе идёт инвентаризация');
            return true;
          },
        );

        assert.equal(await countTransferDocuments(), 0);
        assert.equal(await countRows('stock_document_lines'), 1);
        assert.equal(await countRows('batch_consumptions'), 0);
        assert.equal(await balance(ctx.componentId, ctx.warehouseId), 5);
        assert.equal(await balance(ctx.componentId, ctx.toWarehouseId), 0);
        assert.equal((await transferAudit()).length, 0);
      });
    }
  }
});

test('transfer rejects duplicate component lines before writing anything', async () => {
  const ctx = await seedTransfer();
  await receive(ctx, 5, '10.0000');
  const before = {
    documents: await countRows('stock_documents'),
    lines: await countRows('stock_document_lines'),
    movements: await countRows('stock_movements'),
    sequences: await countRows('document_sequences'),
  };

  await assert.rejects(
    () =>
      postTransfer(
        transferInput(ctx, [
          { componentId: ctx.componentId, qty: 3 },
          { componentId: ctx.componentId, qty: 3 },
        ]),
      ),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.message, 'Позиция указана несколько раз — объедините строки.');
      return true;
    },
  );

  assert.equal(await countTransferDocuments(), 0);
  assert.equal(await countRows('stock_documents'), before.documents);
  assert.equal(await countRows('stock_document_lines'), before.lines);
  assert.equal(await countRows('batch_consumptions'), 0);
  assert.equal(await countRows('stock_movements'), before.movements);
  assert.equal(await countRows('document_sequences'), before.sequences);
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 5);
  assert.equal(await balance(ctx.componentId, ctx.toWarehouseId), 0);
});

test('insufficient stock on a later line rolls back the whole transfer', async () => {
  const ctx = await seedTransfer();
  const second = await createComponentFactory({
    sku: 'RAM-SHORT-01',
    name: 'Память дефицитная',
    categoryId: ctx.categoryId,
    manufacturerId: ctx.manufacturerId,
    supplierId: ctx.supplierId,
  });
  await receive(ctx, 5, '10.0000');
  await postReceipt({
    ...ctx.receiptInput,
    lines: [{ componentId: second.id, qty: 2, unitCost: '20.0000' }],
  });
  const before = {
    documents: await countRows('stock_documents'),
    lines: await countRows('stock_document_lines'),
    batches: await countRows('stock_batches'),
    movements: await countRows('stock_movements'),
    sequences: await countRows('document_sequences'),
  };

  await assert.rejects(
    () =>
      postTransfer(
        transferInput(ctx, [
          { componentId: ctx.componentId, qty: 3 },
          { componentId: second.id, qty: 5 },
        ]),
      ),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'INSUFFICIENT_STOCK');
      assert.equal(error.available, 2);
      assert.equal(error.message, 'На складе недостаточно: доступно 2 шт.');
      return true;
    },
  );

  assert.equal(await countTransferDocuments(), 0);
  assert.equal(await countRows('stock_documents'), before.documents);
  assert.equal(await countRows('stock_document_lines'), before.lines);
  assert.equal(await countRows('batch_consumptions'), 0);
  assert.equal(await countRows('stock_movements'), before.movements);
  assert.equal(await countRows('stock_batches'), before.batches);
  assert.equal(await countRows('document_sequences'), before.sequences);
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 5);
  assert.equal(await balance(second.id, ctx.warehouseId), 2);
  assert.equal(await balance(ctx.componentId, ctx.toWarehouseId), 0);
  assert.equal(await balance(second.id, ctx.toWarehouseId), 0);
  assert.equal((await transferAudit()).length, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { query } from '../../src/db/pool.js';
import { postIssue, postReceipt } from '../../src/services/stock.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';
import { seedBase } from '../helpers/factories.js';

test.before(async () => {
  await setupTestDb();
});

test.beforeEach(async () => {
  await truncateAll();
});

test.after(async () => {
  await teardownTestDb();
});

async function balance(componentId, warehouseId) {
  const { rows } = await query(
    'select qty from v_stock_balances where component_id = $1 and warehouse_id = $2',
    [componentId, warehouseId],
  );
  return rows[0]?.qty ?? 0;
}

test('two concurrent issues cannot oversell the same batch', async () => {
  const ctx = await seedBase();
  await postReceipt({
    supplierId: ctx.supplierId,
    warehouseId: ctx.warehouseId,
    docDate: ctx.docDate,
    userId: ctx.userId,
    lines: [{ componentId: ctx.componentId, qty: 5, unitCost: '10.0000' }],
  });

  const issue = () =>
    postIssue({
      warehouseId: ctx.warehouseId,
      docDate: ctx.docDate,
      reason: 'sale',
      userId: ctx.userId,
      lines: [{ componentId: ctx.componentId, qty: 4 }],
    });

  // Both requests are in flight together: whichever posts first consumes four
  // units, and the other must fail the FIFO allocation instead of driving the
  // batch below zero.
  const results = await Promise.allSettled([issue(), issue()]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'INSUFFICIENT_STOCK');
  assert.equal(rejected[0].reason.available, 1);
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 1);

  const { rows: batches } = await query('select qty_remaining from stock_batches');
  assert.deepEqual(
    batches.map((row) => row.qty_remaining),
    [1],
  );
  assert.ok(
    batches.every((row) => row.qty_remaining >= 0),
    'FIFO must never make a batch negative',
  );

  const { rows: documents } = await query(
    "select id, total_cost from stock_documents where type = 'issue'",
  );
  assert.equal(documents.length, 1);
  assert.equal(documents[0].total_cost, '40.00');

  const { rows: movements } = await query(
    'select sum(qty_delta)::integer as delta from stock_movements where qty_delta < 0',
  );
  assert.equal(movements[0].delta, -4);

  const { rows: consumed } = await query('select sum(qty)::integer as qty from batch_consumptions');
  assert.equal(consumed[0].qty, 4);
});

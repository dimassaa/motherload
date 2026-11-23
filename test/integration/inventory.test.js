import assert from 'node:assert/strict';
import test from 'node:test';
import { query } from '../../src/db/pool.js';
import {
  approveCount,
  cancelCount,
  createCount,
  saveCountLines,
  submitCount,
} from '../../src/services/inventory.js';
import { postReceipt } from '../../src/services/stock.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';
import { createComponentFactory, createUserFactory, seedBase } from '../helpers/factories.js';

test.before(async () => {
  await setupTestDb();
});

test.beforeEach(async () => {
  await truncateAll();
});

test.after(async () => {
  await teardownTestDb();
});

const ADMIN_EMAIL = 'admin@test.by';

/** Ledger balance for a component/warehouse pair; 0 when it never moved. */
async function balance(componentId, warehouseId) {
  const { rows } = await query(
    'select qty from v_stock_balances where component_id = $1 and warehouse_id = $2',
    [componentId, warehouseId],
  );
  return rows[0]?.qty ?? 0;
}

async function countStatus(countId) {
  const { rows } = await query('select status from inventory_counts where id = $1', [countId]);
  return rows[0]?.status ?? null;
}

async function lines(countId) {
  const { rows } = await query(
    `select l.*, c.sku
     from inventory_lines l
     join components c on c.id = l.component_id
     where l.count_id = $1
     order by c.sku`,
    [countId],
  );
  return rows;
}

async function countAudit(action) {
  const { rows } = await query(
    `select user_id, entity_type, entity_id, details
     from audit_log where action = $1 order by id`,
    [action],
  );
  return rows;
}

/** Seed the shared fixtures plus the two actors inventory flow distinguishes. */
async function seedInventory() {
  const ctx = await seedBase();
  const admin = await createUserFactory({
    email: ADMIN_EMAIL,
    role: 'admin',
    fullName: 'Алексей Ковалёв',
  });
  const { rows } = await query('select id, email, role, full_name from users where id = $1', [
    ctx.userId,
  ]);

  return { ...ctx, admin, storekeeper: rows[0] };
}

/** Add another catalogue position to the seeded category/manufacturer/supplier. */
function addComponent(ctx, overrides = {}) {
  return createComponentFactory({
    sku: 'RAM-TEST-02',
    name: 'Память тестовая',
    categoryId: ctx.categoryId,
    manufacturerId: ctx.manufacturerId,
    supplierId: ctx.supplierId,
    ...overrides,
  });
}

/** Post a receipt through the real service so the ledger and batches agree. */
function receive(ctx, qty, unitCost = '100.0000', componentId = ctx.componentId) {
  return postReceipt({
    ...ctx.receiptInput,
    lines: [{ componentId, qty, unitCost }],
  });
}

function create(ctx, overrides = {}) {
  return createCount({
    warehouseId: ctx.warehouseId,
    comment: 'Плановая инвентаризация',
    userId: ctx.userId,
    ...overrides,
  });
}

function expectStatus(status) {
  return (error) => {
    assert.equal(error.status, status, `expected ${status}, got ${error.status}: ${error.message}`);
    return true;
  };
}

test('count snapshots expected quantities and freezes the warehouse', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);

  const { countId, lineCount } = await create(ctx);

  assert.equal(lineCount, 1);
  assert.equal(await countStatus(countId), 'draft');

  const [line] = await lines(countId);
  assert.equal(line.component_id, ctx.componentId);
  assert.equal(line.expected_qty, 5);
  assert.equal(line.actual_qty, null);
  assert.equal(line.difference, null);
  // Weighted average of the only batch, four decimals; money never becomes a float.
  assert.equal(line.unit_cost, '100.0000');

  const audit = await countAudit('inventory.create');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].user_id, ctx.userId);
  assert.equal(audit[0].entity_type, 'inventory_count');
  assert.equal(audit[0].entity_id, String(countId));
  assert.equal(audit[0].details.lines, 1);
  assert.equal(audit[0].details.warehouseId, ctx.warehouseId);

  // The freeze is the whole point of the snapshot: incoming stock would make
  // expected_qty stale before the operator even starts counting.
  await assert.rejects(() => receive(ctx, 1), expectStatus(409));
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 5);
});

test('snapshot skips positions without balance or movement history', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  const idle = await addComponent(ctx);

  const { countId, lineCount } = await create(ctx);

  assert.equal(lineCount, 1);
  const [line] = await lines(countId);
  assert.equal(line.component_id, ctx.componentId);
  assert.notEqual(line.component_id, idle.id);
});

test('a warehouse accepts only one active count', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  await create(ctx);

  await assert.rejects(() => create(ctx), expectStatus(409));
});

test('submit rejects unfilled lines and accepts a fully filled count', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  const { countId } = await create(ctx);

  await assert.rejects(
    () => submitCount({ countId, userId: ctx.userId }),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /CPU-TEST-01/);
      return true;
    },
  );
  assert.equal(await countStatus(countId), 'draft');
  assert.equal((await countAudit('inventory.submit')).length, 0);

  await saveCountLines({
    countId,
    lines: [{ componentId: ctx.componentId, actualQty: 5 }],
    userId: ctx.userId,
  });
  await submitCount({ countId, userId: ctx.userId });

  assert.equal(await countStatus(countId), 'submitted');
  const { rows } = await query('select submitted_at from inventory_counts where id = $1', [
    countId,
  ]);
  assert.ok(rows[0].submitted_at instanceof Date);

  const audit = await countAudit('inventory.submit');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].entity_id, String(countId));
});

test('submit names a few missing SKUs and reports the full list in details', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 1);

  for (let index = 1; index <= 5; index += 1) {
    const extra = await addComponent(ctx, {
      sku: `SKU-EXTRA-${index}`,
      name: `Дополнительная позиция ${index}`,
    });
    await receive(ctx, 1, '10.0000', extra.id);
  }

  const { countId, lineCount } = await create(ctx);
  assert.equal(lineCount, 6);

  await assert.rejects(
    () => submitCount({ countId, userId: ctx.userId }),
    (error) => {
      assert.equal(error.status, 400);
      // The sixth missing SKU is truncated from the message but kept in details.
      assert.match(error.message, /и ещё 1\./);
      assert.equal(error.message.includes('SKU-EXTRA-5'), false);
      assert.equal(error.details.unfilled.length, 6);
      return true;
    },
  );
});

test('saveCountLines writes actual and difference atomically and clears them together', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  const { countId } = await create(ctx);

  await saveCountLines({
    countId,
    lines: [{ componentId: ctx.componentId, actualQty: 8, comment: 'Нашлась коробка' }],
    userId: ctx.userId,
  });
  let [line] = await lines(countId);
  assert.equal(line.actual_qty, 8);
  assert.equal(line.difference, 3);
  assert.equal(line.comment, 'Нашлась коробка');

  // A partial save omits the comment: the note must survive. Only an explicit
  // null clears it.
  await saveCountLines({
    countId,
    lines: [{ componentId: ctx.componentId, actualQty: 9 }],
    userId: ctx.userId,
  });
  [line] = await lines(countId);
  assert.equal(line.actual_qty, 9);
  assert.equal(line.comment, 'Нашлась коробка');

  await saveCountLines({
    countId,
    lines: [{ componentId: ctx.componentId, actualQty: 9, comment: null }],
    userId: ctx.userId,
  });
  [line] = await lines(countId);
  assert.equal(line.comment, null);

  // An empty field means "not entered", not zero: both columns must go back to
  // NULL together, otherwise submission would silently accept a zero count.
  await saveCountLines({
    countId,
    lines: [{ componentId: ctx.componentId, actualQty: null }],
    userId: ctx.userId,
  });
  [line] = await lines(countId);
  assert.equal(line.actual_qty, null);
  assert.equal(line.difference, null);

  await assert.rejects(
    () =>
      saveCountLines({
        countId,
        lines: [{ componentId: ctx.componentId, actualQty: -1 }],
        userId: ctx.userId,
      }),
    expectStatus(400),
  );
});

test('saveCountLines rejects a position outside the count and edits after submit', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  const other = await addComponent(ctx);
  const { countId } = await create(ctx);

  await assert.rejects(
    () =>
      saveCountLines({
        countId,
        lines: [{ componentId: other.id, actualQty: 1 }],
        userId: ctx.userId,
      }),
    expectStatus(400),
  );

  await saveCountLines({
    countId,
    lines: [{ componentId: ctx.componentId, actualQty: 5 }],
    userId: ctx.userId,
  });
  await submitCount({ countId, userId: ctx.userId });

  await assert.rejects(
    () =>
      saveCountLines({
        countId,
        lines: [{ componentId: ctx.componentId, actualQty: 4 }],
        userId: ctx.userId,
      }),
    expectStatus(409),
  );
});

test('approval applies positive and negative differences in one transaction', async () => {
  const ctx = await seedInventory();
  const other = await addComponent(ctx);
  await receive(ctx, 10, '100.0000');
  await receive(ctx, 10, '50.0000', other.id);

  const { countId } = await create(ctx);
  await saveCountLines({
    countId,
    lines: [
      { componentId: ctx.componentId, actualQty: 12 },
      { componentId: other.id, actualQty: 7 },
    ],
    userId: ctx.userId,
  });
  await submitCount({ countId, userId: ctx.userId });

  const result = await approveCount({ countId, user: ctx.admin });

  assert.equal(result.status, 'approved');
  assert.equal(result.adjustedLines, 2);
  // 2 extra x 100 BYN (surplus) minus 3 missing x 50 BYN (shortage) = net +50.
  assert.equal(result.surplus, '200.00');
  assert.equal(result.shortage, '150.00');
  assert.equal(result.totalAdjustment, '50.00');
  assert.equal(await countStatus(countId), 'approved');
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 12);
  assert.equal(await balance(other.id, ctx.warehouseId), 7);

  const { rows: countRows } = await query(
    'select approved_by, approved_at from inventory_counts where id = $1',
    [countId],
  );
  assert.equal(countRows[0].approved_by, ctx.admin.id);
  assert.ok(countRows[0].approved_at instanceof Date);

  // Positive difference becomes a real batch at the snapshot's weighted average.
  const { rows: addedBatches } = await query(
    'select * from stock_batches where component_id = $1 order by id',
    [ctx.componentId],
  );
  assert.equal(addedBatches.length, 2);
  assert.equal(addedBatches[1].qty_received, 2);
  assert.equal(addedBatches[1].qty_remaining, 2);
  assert.equal(addedBatches[1].unit_cost, '100.0000');
  assert.match(addedBatches[1].received_at, /^\d{4}-\d{2}-\d{2}$/);

  // Negative difference is consumed FIFO from the only batch.
  const { rows: reducedBatches } = await query(
    'select * from stock_batches where component_id = $1 order by id',
    [other.id],
  );
  assert.equal(reducedBatches.length, 1);
  assert.equal(reducedBatches[0].qty_remaining, 7);

  const { rows: movements } = await query(
    `select component_id, qty_delta, unit_cost, document_id, line_id
     from stock_movements where qty_delta in (2, -3) order by component_id`,
  );
  assert.equal(movements.length, 2);
  assert.equal(movements[0].qty_delta, 2);
  assert.equal(movements[0].unit_cost, '100.0000');
  assert.equal(movements[0].document_id, null);
  assert.equal(movements[0].line_id, null);
  assert.equal(movements[1].qty_delta, -3);
  assert.equal(movements[1].unit_cost, '50.0000');

  const audit = await countAudit('inventory.approve');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].user_id, ctx.admin.id);
  assert.equal(audit[0].details.adjustedLines, 2);
  assert.equal(audit[0].details.surplus, '200.00');
  assert.equal(audit[0].details.shortage, '150.00');
  assert.equal(audit[0].details.net, '50.00');
});

test('approval aborts when the ledger changed after the snapshot', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  const { countId } = await create(ctx);
  await saveCountLines({
    countId,
    lines: [{ componentId: ctx.componentId, actualQty: 8 }],
    userId: ctx.userId,
  });
  await submitCount({ countId, userId: ctx.userId });

  // Simulate a concurrent posting that bypassed the freeze: the receipt
  // movement becomes +6 while the snapshot still expects 5.
  await query(
    `update stock_movements set qty_delta = qty_delta + 1
     where component_id = $1 and warehouse_id = $2 and qty_delta > 0`,
    [ctx.componentId, ctx.warehouseId],
  );

  await assert.rejects(() => approveCount({ countId, user: ctx.admin }), expectStatus(409));

  assert.equal(await countStatus(countId), 'submitted');
  const { rows: batches } = await query('select id from stock_batches where component_id = $1', [
    ctx.componentId,
  ]);
  assert.equal(batches.length, 1);
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 6);
  assert.equal((await countAudit('inventory.approve')).length, 0);
});

test('approval rolls back every adjustment when one line cannot be consumed', async () => {
  const ctx = await seedInventory();
  const other = await addComponent(ctx);
  await receive(ctx, 10);
  await receive(ctx, 5, '50.0000', other.id);

  const { countId } = await create(ctx);
  await saveCountLines({
    countId,
    lines: [
      { componentId: ctx.componentId, actualQty: 12 },
      { componentId: other.id, actualQty: 1 },
    ],
    userId: ctx.userId,
  });
  await submitCount({ countId, userId: ctx.userId });

  // Ledger and batches disagree only for the second line: the positive first
  // line would be written before FIFO fails, so this proves the rollback.
  await query('update stock_batches set qty_remaining = 0 where component_id = $1', [other.id]);

  await assert.rejects(
    () => approveCount({ countId, user: ctx.admin }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'INSUFFICIENT_STOCK');
      return true;
    },
  );

  assert.equal(await countStatus(countId), 'submitted');
  // The surplus batch for the first line must not survive the failed approval.
  const { rows: batches } = await query('select id from stock_batches where component_id = $1', [
    ctx.componentId,
  ]);
  assert.equal(batches.length, 1);
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 10);
  assert.equal(await balance(other.id, ctx.warehouseId), 5);
  assert.equal((await countAudit('inventory.approve')).length, 0);
});

test('negative adjustment records FIFO provenance on the inventory line', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 3, '100.0000');
  await receive(ctx, 2, '150.0000');

  const { countId } = await create(ctx);
  await saveCountLines({
    countId,
    lines: [{ componentId: ctx.componentId, actualQty: 1 }],
    userId: ctx.userId,
  });
  await submitCount({ countId, userId: ctx.userId });

  const result = await approveCount({ countId, user: ctx.admin });

  // 3 x 100 plus 1 x 150: the shortage is signed, the net is negative.
  assert.equal(result.shortage, '450.00');
  assert.equal(result.totalAdjustment, '-450.00');

  const [line] = await lines(countId);
  const { rows: consumptions } = await query(
    `select inventory_line_id, line_id, batch_id, qty, unit_cost
     from batch_consumptions order by id`,
  );
  assert.equal(consumptions.length, 2);
  for (const consumption of consumptions) {
    // `inventory_line_id` is bigint (spec 7.2), which node-postgres returns as
    // a string, unlike the integer `inventory_lines.id`.
    assert.equal(consumption.inventory_line_id, String(line.id));
    assert.equal(consumption.line_id, null);
    assert.ok(consumption.batch_id !== null);
  }
  assert.deepEqual(
    consumptions.map((consumption) => [consumption.qty, consumption.unit_cost]),
    [
      [3, '100.0000'],
      [1, '150.0000'],
    ],
  );

  const { rows: orphans } = await query(
    `select count(*)::integer as count from batch_consumptions
     where line_id is null and inventory_line_id is null`,
  );
  assert.equal(orphans[0].count, 0);
  const { rows: total } = await query('select count(*)::integer as count from batch_consumptions');
  assert.equal(total[0].count, 2);
});

test('positive adjustment values the new batch at the weighted average cost', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 3, '100.0000');
  await receive(ctx, 2, '200.0000');

  const { countId } = await create(ctx);
  await saveCountLines({
    countId,
    lines: [{ componentId: ctx.componentId, actualQty: 7 }],
    userId: ctx.userId,
  });
  await submitCount({ countId, userId: ctx.userId });

  const result = await approveCount({ countId, user: ctx.admin });

  // (3 x 100 + 2 x 200) / 5 = 140 BYN per unit; 2 surplus units = 280 BYN.
  assert.equal(result.surplus, '280.00');
  assert.equal(result.totalAdjustment, '280.00');

  const { rows: batches } = await query(
    'select unit_cost, qty_received, qty_remaining from stock_batches where component_id = $1 order by id',
    [ctx.componentId],
  );
  assert.equal(batches.length, 3);
  assert.equal(batches[2].unit_cost, '140.0000');
  assert.equal(batches[2].qty_received, 2);
  assert.equal(batches[2].qty_remaining, 2);

  const { rows: movements } = await query(
    `select qty_delta, unit_cost from stock_movements
     where component_id = $1 and qty_delta = 2 and unit_cost = '140.0000'`,
    [ctx.componentId],
  );
  assert.equal(movements.length, 1);
  assert.equal(movements[0].unit_cost, '140.0000');
});

test('approval reads the actor role from the database', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  const { countId } = await create(ctx);
  await saveCountLines({
    countId,
    lines: [{ componentId: ctx.componentId, actualQty: 5 }],
    userId: ctx.userId,
  });
  await submitCount({ countId, userId: ctx.userId });

  await assert.rejects(
    () => approveCount({ countId, userId: ctx.storekeeper.id }),
    expectStatus(403),
  );
  // A user object without a role is not "unknown, therefore allowed".
  await assert.rejects(
    () => approveCount({ countId, user: { id: ctx.storekeeper.id } }),
    expectStatus(403),
  );
  // A stale caller claim must not override the stored role.
  await assert.rejects(
    () => approveCount({ countId, user: { id: ctx.storekeeper.id, role: 'admin' } }),
    expectStatus(403),
  );
  await assert.rejects(() => approveCount({ countId }), expectStatus(403));
  assert.equal(await countStatus(countId), 'submitted');

  await approveCount({ countId, userId: ctx.admin.id });
  assert.equal(await countStatus(countId), 'approved');
});

test('approval requires a submitted count and an admin actor', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  const { countId } = await create(ctx);

  await assert.rejects(() => approveCount({ countId, user: ctx.admin }), expectStatus(409));

  await saveCountLines({
    countId,
    lines: [{ componentId: ctx.componentId, actualQty: 5 }],
    userId: ctx.userId,
  });
  await submitCount({ countId, userId: ctx.userId });

  await assert.rejects(() => approveCount({ countId, user: ctx.storekeeper }), expectStatus(403));
  assert.equal(await countStatus(countId), 'submitted');
});

test('an approved count is terminal: no second approval, edit, submit or cancel', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  const { countId } = await create(ctx);
  await saveCountLines({
    countId,
    lines: [{ componentId: ctx.componentId, actualQty: 5 }],
    userId: ctx.userId,
  });
  await submitCount({ countId, userId: ctx.userId });
  await approveCount({ countId, user: ctx.admin });

  await assert.rejects(() => approveCount({ countId, user: ctx.admin }), expectStatus(409));
  await assert.rejects(
    () =>
      saveCountLines({
        countId,
        lines: [{ componentId: ctx.componentId, actualQty: 4 }],
        userId: ctx.userId,
      }),
    expectStatus(409),
  );
  await assert.rejects(() => submitCount({ countId, userId: ctx.userId }), expectStatus(409));
  await assert.rejects(() => cancelCount({ countId, userId: ctx.admin.id }), expectStatus(409));

  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 5);
  assert.equal((await countAudit('inventory.approve')).length, 1);
});

test('cancel is a draft action for storekeepers and an admin action after submit', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  const { countId } = await create(ctx);
  await saveCountLines({
    countId,
    lines: [{ componentId: ctx.componentId, actualQty: 5 }],
    userId: ctx.userId,
  });
  await submitCount({ countId, userId: ctx.userId });

  await assert.rejects(() => receive(ctx, 1), expectStatus(409));

  // Submitted means the count is under administrative review. A storekeeper
  // cannot unilaterally end it, and a claimed role does not override the row.
  await assert.rejects(() => cancelCount({ countId, userId: ctx.userId }), expectStatus(403));
  await assert.rejects(
    () => cancelCount({ countId, user: { id: ctx.userId, role: 'admin' } }),
    expectStatus(403),
  );
  await assert.rejects(() => cancelCount({ countId }), expectStatus(403));
  assert.equal(await countStatus(countId), 'submitted');

  await cancelCount({ countId, userId: ctx.admin.id });

  assert.equal(await countStatus(countId), 'cancelled');
  const audit = await countAudit('inventory.cancel');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].entity_id, String(countId));
  assert.equal(audit[0].user_id, ctx.admin.id);

  // The freeze is gone: stock moves again and a fresh count can be opened.
  await receive(ctx, 1);
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 6);
  const second = await create(ctx);

  // A storekeeper may still abandon their own draft.
  await cancelCount({ countId: second.countId, userId: ctx.userId });
  assert.equal(await countStatus(second.countId), 'cancelled');
  const afterDraft = await countAudit('inventory.cancel');
  assert.equal(afterDraft.length, 2);
  assert.equal(afterDraft[1].user_id, ctx.userId);
});

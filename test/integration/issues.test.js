import assert from 'node:assert/strict';
import test from 'node:test';
import { query } from '../../src/db/pool.js';
import { postIssue, postReceipt, previewIssue } from '../../src/services/stock.js';
import { createTestApp } from '../helpers/app.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';
import {
  DEFAULT_TEST_PASSWORD,
  createComponentFactory,
  createUserFactory,
  seedBase,
} from '../helpers/factories.js';
import { getCsrf, loginAs } from '../helpers/http.js';

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

async function countIssueDocuments() {
  const { rows } = await query(
    "select count(*)::integer as count from stock_documents where type = 'issue'",
  );
  return rows[0].count;
}

async function issueAudit() {
  const { rows } = await query(
    "select user_id, entity_type, entity_id, details from audit_log where action = 'stock.issue' order by id",
  );
  return rows;
}

/** Post a receipt that becomes one FIFO batch on the test warehouse. */
function receive(ctx, qty, unitCost, docDate = ctx.docDate) {
  return postReceipt({
    ...ctx.receiptInput,
    docDate,
    lines: [{ componentId: ctx.componentId, qty, unitCost }],
  });
}

/** Ready-to-use `postIssue` payload matching `seedBase`. */
function issueInput(ctx, lines, overrides = {}) {
  return {
    warehouseId: ctx.warehouseId,
    docDate: ctx.docDate,
    reason: 'sale',
    comment: 'Тестовый расход',
    userId: ctx.userId,
    lines,
    ...overrides,
  };
}

test('issue consumes oldest batches first and records total cost', async () => {
  const ctx = await seedBase();
  await receive(ctx, 3, '10.0000', '2026-01-01');
  await receive(ctx, 3, '20.0000', '2026-01-02');

  const result = await postIssue(issueInput(ctx, [{ componentId: ctx.componentId, qty: 4 }]));

  assert.match(result.number, /^РС-2026-0001$/);
  assert.equal(result.totalCost, '50.00');
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 2);

  const { rows: documents } = await query('select * from stock_documents where id = $1', [
    result.documentId,
  ]);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].type, 'issue');
  assert.equal(documents[0].number, 'РС-2026-0001');
  assert.equal(documents[0].doc_date, '2026-11-22');
  assert.equal(documents[0].warehouse_id, ctx.warehouseId);
  assert.equal(documents[0].reason, 'sale');
  assert.equal(documents[0].comment, 'Тестовый расход');
  assert.equal(documents[0].created_by, ctx.userId);
  assert.equal(documents[0].total_cost, '50.00');

  const { rows: lines } = await query('select * from stock_document_lines where document_id = $1', [
    result.documentId,
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].component_id, ctx.componentId);
  assert.equal(lines[0].qty, 4);
  // 50.00 / 4 is stored as the weighted unit cost of the line.
  assert.equal(lines[0].unit_cost, '12.5000');
  assert.equal(lines[0].total_cost, '50.00');

  const { rows: consumptions } = await query(
    `select c.qty, c.unit_cost, b.received_at
     from batch_consumptions c
     join stock_batches b on b.id = c.batch_id
     where c.line_id = $1
     order by c.id`,
    [lines[0].id],
  );
  assert.deepEqual(
    consumptions.map((row) => [row.qty, row.unit_cost, row.received_at]),
    [
      [3, '10.0000', '2026-01-01'],
      [1, '20.0000', '2026-01-02'],
    ],
  );

  const { rows: batches } = await query('select qty_remaining from stock_batches order by id');
  assert.deepEqual(
    batches.map((row) => row.qty_remaining),
    [0, 2],
  );
  assert.equal(await countRows('stock_batches'), 2);

  const { rows: movements } = await query(
    'select qty_delta, unit_cost from stock_movements where document_id = $1 order by id',
    [result.documentId],
  );
  assert.deepEqual(
    movements.map((row) => [row.qty_delta, row.unit_cost]),
    [
      [-3, '10.0000'],
      [-1, '20.0000'],
    ],
  );

  const audit = await issueAudit();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].user_id, ctx.userId);
  assert.equal(audit[0].entity_type, 'stock_document');
  assert.equal(audit[0].entity_id, String(result.documentId));
  assert.equal(audit[0].details.number, 'РС-2026-0001');
  assert.equal(audit[0].details.total, '50.00');
});

test('insufficient stock rolls back the whole document', async () => {
  const ctx = await seedBase();
  await receive(ctx, 3, '10.0000');
  const before = {
    documents: await countRows('stock_documents'),
    lines: await countRows('stock_document_lines'),
    batches: await countRows('stock_batches'),
    movements: await countRows('stock_movements'),
  };

  await assert.rejects(
    () => postIssue(issueInput(ctx, [{ componentId: ctx.componentId, qty: 999 }])),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'INSUFFICIENT_STOCK');
      assert.equal(error.available, 3);
      assert.equal(error.message, 'На складе недостаточно: доступно 3 шт.');
      return true;
    },
  );

  assert.equal(await countRows('stock_documents'), before.documents);
  assert.equal(await countRows('stock_document_lines'), before.lines);
  assert.equal(await countRows('batch_consumptions'), 0);
  assert.equal(await countRows('stock_movements'), before.movements);
  assert.equal(await countRows('stock_batches'), before.batches);
  assert.equal(await countIssueDocuments(), 0);
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 3);

  const { rows: remaining } = await query('select qty_remaining from stock_batches');
  assert.equal(remaining[0].qty_remaining, 3);

  // The failed posting must not burn a document number.
  const { rows: issueSequences } = await query(
    "select last_value from document_sequences where type = 'issue'",
  );
  assert.equal(issueSequences.length, 0);
  assert.equal((await issueAudit()).length, 0);
});

test('issue is rejected while an inventory count freezes the warehouse', async (t) => {
  for (const status of ['draft', 'submitted']) {
    await t.test(status, async () => {
      await truncateAll();
      const ctx = await seedBase();
      await receive(ctx, 5, '10.0000');
      await query(
        'insert into inventory_counts (warehouse_id, status, started_by) values ($1, $2, $3)',
        [ctx.warehouseId, status, ctx.userId],
      );

      await assert.rejects(
        () => postIssue(issueInput(ctx, [{ componentId: ctx.componentId, qty: 1 }])),
        (error) => {
          assert.equal(error.status, 409);
          assert.equal(error.message, 'На складе идёт инвентаризация');
          return true;
        },
      );

      assert.equal(await countRows('stock_document_lines'), 1);
      assert.equal(await countIssueDocuments(), 0);
      assert.equal(await countRows('batch_consumptions'), 0);
      assert.equal(await balance(ctx.componentId, ctx.warehouseId), 5);
    });
  }
});

test('issue numbers increment without duplicates', async () => {
  const ctx = await seedBase();
  await receive(ctx, 4, '10.0000');
  const lines = [{ componentId: ctx.componentId, qty: 1 }];

  const first = await postIssue(issueInput(ctx, lines));
  const second = await postIssue(issueInput(ctx, lines));

  assert.equal(first.number, 'РС-2026-0001');
  assert.equal(second.number, 'РС-2026-0002');
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 2);
});

test('issue rejects a malformed reason or quantity before writing anything', async () => {
  const ctx = await seedBase();
  await receive(ctx, 3, '10.0000');

  await assert.rejects(
    () =>
      postIssue(issueInput(ctx, [{ componentId: ctx.componentId, qty: 1 }], { reason: 'theft' })),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.message, 'Выберите причину расхода.');
      return true;
    },
  );

  await assert.rejects(
    () => postIssue(issueInput(ctx, [{ componentId: ctx.componentId, qty: 0 }])),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(
        error.message,
        'Строка 1: количество должно быть целым числом от 1 до 1 000 000 000.',
      );
      return true;
    },
  );

  assert.equal(await countIssueDocuments(), 0);
  assert.equal(await countRows('batch_consumptions'), 0);
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 3);
});

test('issue rejects duplicate component lines before writing anything', async () => {
  const ctx = await seedBase();
  await receive(ctx, 5, '10.0000');
  const before = {
    documents: await countRows('stock_documents'),
    lines: await countRows('stock_document_lines'),
    movements: await countRows('stock_movements'),
    sequences: await countRows('document_sequences'),
  };

  await assert.rejects(
    () =>
      postIssue(
        issueInput(ctx, [
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

  assert.equal(await countIssueDocuments(), 0);
  assert.equal(await countRows('stock_documents'), before.documents);
  assert.equal(await countRows('stock_document_lines'), before.lines);
  assert.equal(await countRows('batch_consumptions'), 0);
  assert.equal(await countRows('stock_movements'), before.movements);
  assert.equal(await countRows('document_sequences'), before.sequences);
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 5);

  const { rows: remaining } = await query('select qty_remaining from stock_batches');
  assert.equal(remaining[0].qty_remaining, 5);
});

test('issue accepts distinct components in one document', async () => {
  const ctx = await seedBase();
  const second = await createComponentFactory({
    sku: 'RAM-ISSUE-01',
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

  const result = await postIssue(
    issueInput(ctx, [
      { componentId: ctx.componentId, qty: 1 },
      { componentId: second.id, qty: 2 },
    ]),
  );

  assert.equal(result.totalCost, '50.00');
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 1);
  assert.equal(await balance(second.id, ctx.warehouseId), 0);
});

test('previewIssue returns FIFO allocations without writing anything', async () => {
  const ctx = await seedBase();
  await receive(ctx, 3, '10.0000', '2026-01-01');
  await receive(ctx, 3, '20.0000', '2026-01-02');
  const { rows: batches } = await query('select id from stock_batches order by id');

  const before = {
    documents: await countRows('stock_documents'),
    consumptions: await countRows('batch_consumptions'),
    movements: await countRows('stock_movements'),
    sequences: await countRows('document_sequences'),
  };

  const preview = await previewIssue({
    warehouseId: ctx.warehouseId,
    lines: [{ componentId: ctx.componentId, qty: 4 }],
  });

  assert.deepEqual(
    preview.lines[0].allocations.map((allocation) => [
      allocation.batchId,
      allocation.qty,
      allocation.unitCost,
      allocation.totalCost,
    ]),
    [
      [batches[0].id, 3, '10.0000', '30.0000'],
      [batches[1].id, 1, '20.0000', '20.0000'],
    ],
  );
  assert.equal(preview.lines[0].componentId, ctx.componentId);
  assert.equal(preview.lines[0].totalCost, '50.00');
  assert.equal(preview.totalCost, '50.00');

  assert.equal(await countRows('stock_documents'), before.documents);
  assert.equal(await countRows('batch_consumptions'), before.consumptions);
  assert.equal(await countRows('stock_movements'), before.movements);
  assert.equal(await countRows('document_sequences'), before.sequences);

  const { rows: remaining } = await query('select qty_remaining from stock_batches order by id');
  assert.deepEqual(
    remaining.map((row) => row.qty_remaining),
    [3, 3],
  );
});

test('previewIssue reports the available quantity when stock is short', async () => {
  const ctx = await seedBase();
  await receive(ctx, 2, '10.0000');

  await assert.rejects(
    () =>
      previewIssue({
        warehouseId: ctx.warehouseId,
        lines: [{ componentId: ctx.componentId, qty: 3 }],
      }),
    (error) => {
      assert.equal(error.code, 'INSUFFICIENT_STOCK');
      assert.equal(error.available, 2);
      return true;
    },
  );
});

/** Seed a signed-in storekeeper and an agent that carries its session. */
async function signInStorekeeper() {
  const ctx = await seedBase();
  const { agent } = createTestApp();
  await loginAs(agent, 'sklad@test.by', DEFAULT_TEST_PASSWORD);
  return { ctx, agent };
}

test('POST /api/fifo-preview rejects guests with 401 JSON', async () => {
  const ctx = await seedBase();
  const { agent } = createTestApp();

  const response = await agent.post('/api/fifo-preview').send({
    warehouseId: ctx.warehouseId,
    lines: [{ componentId: ctx.componentId, qty: 1 }],
  });

  assert.equal(response.status, 401);
  assert.match(response.headers['content-type'], /application\/json/);
  assert.equal(typeof response.body.error, 'string');
});

test('POST /api/fifo-preview forbids analysts with 403 JSON', async () => {
  const ctx = await seedBase();
  await createUserFactory({ email: 'analyst@test.by', role: 'analyst' });
  const { agent } = createTestApp();
  await loginAs(agent, 'analyst@test.by', DEFAULT_TEST_PASSWORD);
  const token = await getCsrf(agent, '/dashboard');

  const response = await agent
    .post('/api/fifo-preview')
    .set('X-CSRF-Token', token)
    .send({
      warehouseId: ctx.warehouseId,
      lines: [{ componentId: ctx.componentId, qty: 1 }],
    });

  assert.equal(response.status, 403);
  assert.match(response.headers['content-type'], /application\/json/);
  assert.equal(response.body.error, 'Недостаточно прав для этого действия.');
});

test('POST /api/fifo-preview requires a CSRF token', async () => {
  const ctx = await seedBase();
  const { agent } = createTestApp();
  await loginAs(agent, 'sklad@test.by', DEFAULT_TEST_PASSWORD);

  const response = await agent.post('/api/fifo-preview').send({
    warehouseId: ctx.warehouseId,
    lines: [{ componentId: ctx.componentId, qty: 1 }],
  });

  assert.equal(response.status, 403);
  assert.match(response.headers['content-type'], /application\/json/);
});

test('POST /api/fifo-preview returns allocations as JSON strings', async () => {
  const ctx = await seedBase();
  await postReceipt({
    supplierId: ctx.supplierId,
    warehouseId: ctx.warehouseId,
    docDate: '2026-01-01',
    userId: ctx.userId,
    lines: [{ componentId: ctx.componentId, qty: 3, unitCost: '10.0000' }],
  });
  await postReceipt({
    supplierId: ctx.supplierId,
    warehouseId: ctx.warehouseId,
    docDate: '2026-01-02',
    userId: ctx.userId,
    lines: [{ componentId: ctx.componentId, qty: 3, unitCost: '20.0000' }],
  });

  const { agent } = createTestApp();
  await loginAs(agent, 'sklad@test.by', DEFAULT_TEST_PASSWORD);
  const token = await getCsrf(agent, '/dashboard');

  const response = await agent
    .post('/api/fifo-preview')
    .set('X-CSRF-Token', token)
    .send({
      warehouseId: ctx.warehouseId,
      lines: [{ componentId: ctx.componentId, qty: 4 }],
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.lines.length, 1);
  assert.equal(response.body.lines[0].componentId, ctx.componentId);
  assert.equal(response.body.lines[0].totalCost, '50.00');
  assert.equal(response.body.totalCost, '50.00');
  assert.deepEqual(
    response.body.lines[0].allocations.map((allocation) => [
      allocation.qty,
      allocation.unitCost,
      allocation.totalCost,
    ]),
    [
      [3, '10.0000', '30.0000'],
      [1, '20.0000', '20.0000'],
    ],
  );
});

test('POST /api/fifo-preview reports insufficient stock as 400 JSON', async () => {
  const { ctx, agent } = await signInStorekeeper();
  await postReceipt({
    supplierId: ctx.supplierId,
    warehouseId: ctx.warehouseId,
    docDate: ctx.docDate,
    userId: ctx.userId,
    lines: [{ componentId: ctx.componentId, qty: 3, unitCost: '10.0000' }],
  });
  const token = await getCsrf(agent, '/dashboard');

  const response = await agent
    .post('/api/fifo-preview')
    .set('X-CSRF-Token', token)
    .send({
      warehouseId: ctx.warehouseId,
      lines: [{ componentId: ctx.componentId, qty: 99 }],
    });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: 'INSUFFICIENT_STOCK',
    message: 'На складе недостаточно: доступно 3 шт.',
    available: 3,
  });
});

test('POST /api/fifo-preview rejects an invalid body with 400 JSON', async () => {
  const { ctx, agent } = await signInStorekeeper();
  const token = await getCsrf(agent, '/dashboard');

  const response = await agent
    .post('/api/fifo-preview')
    .set('X-CSRF-Token', token)
    .send({
      warehouseId: ctx.warehouseId,
      lines: [{ componentId: ctx.componentId, qty: 0 }],
    });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'VALIDATION_ERROR');
  assert.equal(typeof response.body.message, 'string');
});

test('POST /api/fifo-preview rejects malformed JSON with 400 JSON', async () => {
  const { agent } = await signInStorekeeper();
  const token = await getCsrf(agent, '/dashboard');

  const response = await agent
    .post('/api/fifo-preview')
    .set('X-CSRF-Token', token)
    .set('Content-Type', 'application/json')
    .send('{"warehouseId":1,');

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: 'VALIDATION_ERROR',
    message: 'Тело запроса должно быть корректным JSON.',
  });
});

test('POST /api/fifo-preview maps body limits and encodings to 400 JSON', async () => {
  const { ctx, agent } = await signInStorekeeper();
  const token = await getCsrf(agent, '/dashboard');

  // `express.json()` keeps its default 100 kb limit; the padding pushes the
  // request over it before the route runs.
  const oversized = JSON.stringify({
    warehouseId: ctx.warehouseId,
    lines: [{ componentId: ctx.componentId, qty: 1 }],
    padding: 'x'.repeat(110_000),
  });

  const tooLarge = await agent
    .post('/api/fifo-preview')
    .set('X-CSRF-Token', token)
    .set('Content-Type', 'application/json')
    .send(oversized);

  assert.equal(tooLarge.status, 400);
  assert.deepEqual(tooLarge.body, {
    error: 'VALIDATION_ERROR',
    message: 'Тело запроса слишком большое.',
  });

  const badCharset = await agent
    .post('/api/fifo-preview')
    .set('X-CSRF-Token', token)
    .set('Content-Type', 'application/json; charset=koi8-r')
    .send('{}');

  assert.equal(badCharset.status, 400);
  assert.deepEqual(badCharset.body, {
    error: 'VALIDATION_ERROR',
    message: 'Неподдерживаемая кодировка запроса. Используйте UTF-8.',
  });
});

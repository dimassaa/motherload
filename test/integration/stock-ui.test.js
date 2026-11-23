import assert from 'node:assert/strict';
import test from 'node:test';
import { query } from '../../src/db/pool.js';
import { postReceipt } from '../../src/services/stock.js';
import { createTestApp } from '../helpers/app.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';
import { DEFAULT_TEST_PASSWORD, createUserFactory, seedBase } from '../helpers/factories.js';
import { getCsrf, loginAs } from '../helpers/http.js';

const PASSWORD = DEFAULT_TEST_PASSWORD;

test.before(async () => {
  await setupTestDb();
});

test.beforeEach(async () => {
  await truncateAll();
});

test.after(async () => {
  await teardownTestDb();
});

/** Seed a component/warehouse/supplier baseline and a way to sign a role in. */
async function seedStock() {
  const ctx = await seedBase();
  return {
    ...ctx,
    async signIn(role, email = `${role}-stock-ui@test.by`) {
      const user = await createUserFactory({ email, password: PASSWORD, role });
      const { agent } = createTestApp();
      await loginAs(agent, email, PASSWORD);
      return { agent, user };
    },
  };
}

function receive(ctx, qty, unitCost = '100.0000', componentId = ctx.componentId) {
  return postReceipt({
    ...ctx.receiptInput,
    lines: [{ componentId, qty, unitCost }],
  });
}

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

/** A second warehouse for transfer tests. */
async function secondWarehouse(code = 'WH-TST-2', name = 'Второй тестовый склад') {
  const { rows } = await query(
    `insert into warehouses (code, name, city, address)
     values ($1, $2, 'Гомель', 'ул. Советская, 25') returning id`,
    [code, name],
  );
  return rows[0].id;
}

test('stock ui: receipt form is available to storekeeper and forbidden to analyst', async () => {
  const ctx = await seedStock();

  const storekeeper = await ctx.signIn('storekeeper');
  const form = await storekeeper.agent.get('/stock/receipts/new');

  assert.equal(form.status, 200);
  assert.match(form.text, /Новая приёмка/);
  assert.match(form.text, /Поставщик/);
  assert.match(form.text, /Склад/);
  assert.match(form.text, /<meta name="csrf-token" content="[^"]+">/);
  assert.match(form.text, /name="lines\[0\]\[componentId\]"/);
  assert.match(form.text, /data-stock-lines/);
  assert.match(form.text, /\/js\/receipt-form\.js/);
  assert.match(form.text, /Включите JavaScript/);

  const receipt = await receive(ctx, 1);
  const analyst = await ctx.signIn('analyst');
  for (const path of [
    '/stock/receipts',
    '/stock/receipts/new',
    `/stock/receipts/${receipt.documentId}`,
    '/stock/issues',
    '/stock/issues/new',
    '/stock/transfers',
    '/stock/transfers/new',
  ]) {
    const denied = await analyst.agent.get(path);
    assert.equal(denied.status, 403, `${path} must be forbidden for an analyst`);
    assert.match(denied.text, /Недостаточно прав/);
  }
});

test('stock ui: POST receipt redirects to the document card and shows the number', async () => {
  const ctx = await seedStock();
  const storekeeper = await ctx.signIn('storekeeper');
  const token = await getCsrf(storekeeper.agent, '/stock/receipts/new');

  const created = await storekeeper.agent
    .post('/stock/receipts')
    .type('form')
    .send({
      supplierId: String(ctx.supplierId),
      warehouseId: String(ctx.warehouseId),
      docDate: '2026-11-22',
      comment: 'Поставка для теста',
      'lines[0][componentId]': String(ctx.componentId),
      'lines[0][qty]': '4',
      'lines[0][unitCost]': '250,50',
      _csrf: token,
    });

  assert.equal(created.status, 302);
  assert.match(created.headers.location, /^\/stock\/receipts\/\d+$/);

  const card = await storekeeper.agent.get(created.headers.location);
  assert.equal(card.status, 200);
  assert.match(card.text, /ПР-2026-0001/);
  assert.match(card.text, /Поставка для теста/);
  assert.match(card.text, /ООО «ТестПоставка»/);
  assert.match(card.text, /Тестовый склад/);
  assert.match(card.text, /CPU-TEST-01/);
  assert.match(card.text, /1\s*002,00/);
  assert.match(card.text, /Проведён/);
  assert.match(card.text, /Приёмка проведена/);
  assert.doesNotMatch(card.text, /Редактировать|Удалить документ/);

  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 4);
});

test('stock ui: invalid receipt keeps the entered values and writes nothing', async () => {
  const ctx = await seedStock();
  const storekeeper = await ctx.signIn('storekeeper');
  const token = await getCsrf(storekeeper.agent, '/stock/receipts/new');

  const response = await storekeeper.agent
    .post('/stock/receipts')
    .type('form')
    .send({
      supplierId: String(ctx.supplierId),
      warehouseId: String(ctx.warehouseId),
      docDate: '2026-11-22',
      comment: 'Комментарий не должен потеряться',
      'lines[0][componentId]': '',
      'lines[0][qty]': '',
      'lines[0][unitCost]': '',
      _csrf: token,
    });

  assert.equal(response.status, 400);
  assert.match(response.text, /Проверьте форму/);
  assert.match(response.text, /Добавьте хотя бы одну строку приёмки|выберите позицию/);
  assert.match(response.text, /Комментарий не должен потеряться/);
  assert.equal(await countRows('stock_documents'), 0);
});

test('stock ui: issue form renders and the FIFO preview returns allocations', async () => {
  const ctx = await seedStock();
  await receive(ctx, 3, '10.0000');
  await receive(ctx, 2, '20.0000');

  const storekeeper = await ctx.signIn('storekeeper');
  const form = await storekeeper.agent.get('/stock/issues/new');

  assert.equal(form.status, 200);
  assert.match(form.text, /Новый расход/);
  assert.match(form.text, /data-fifo-preview/);
  assert.match(form.text, /\/js\/issue-form\.js/);
  assert.match(form.text, /Причина/);
  // The contract for the fetch client: the endpoint and the token both exist.
  assert.match(form.text, /data-fifo-preview-url="\/api\/fifo-preview"/);

  const token = await getCsrf(storekeeper.agent, '/stock/issues/new');
  const preview = await storekeeper.agent
    .post('/api/fifo-preview')
    .set('X-CSRF-Token', token)
    .send({ warehouseId: ctx.warehouseId, lines: [{ componentId: ctx.componentId, qty: 4 }] });

  assert.equal(preview.status, 200);
  assert.equal(preview.body.totalCost, '50.00');
  assert.equal(preview.body.lines.length, 1);
  assert.deepEqual(
    preview.body.lines[0].allocations.map((allocation) => [
      allocation.qty,
      allocation.unitCost,
      allocation.totalCost,
    ]),
    [
      [3, '10.0000', '30.0000'],
      [1, '20.0000', '20.0000'],
    ],
  );
  // The form names the receipt a consumed batch came from, so the preview must
  // carry the batch metadata, not only its id and cost.
  assert.equal(preview.body.lines[0].allocations[0].receivedAt, '2026-11-22');
  assert.equal(preview.body.lines[0].allocations[0].documentNo, 'ПР-2026-0001');

  const shortage = await storekeeper.agent
    .post('/api/fifo-preview')
    .set('X-CSRF-Token', token)
    .send({ warehouseId: ctx.warehouseId, lines: [{ componentId: ctx.componentId, qty: 6 }] });

  assert.equal(shortage.status, 400);
  assert.equal(shortage.body.error, 'INSUFFICIENT_STOCK');
  assert.equal(shortage.body.available, 5);
});

test('stock ui: POST issue redirects to a card with line costs and batch allocations', async () => {
  const ctx = await seedStock();
  await receive(ctx, 3, '10.0000');
  await receive(ctx, 2, '20.0000');

  const storekeeper = await ctx.signIn('storekeeper');
  const token = await getCsrf(storekeeper.agent, '/stock/issues/new');
  const created = await storekeeper.agent
    .post('/stock/issues')
    .type('form')
    .send({
      warehouseId: String(ctx.warehouseId),
      docDate: '2026-11-22',
      reason: 'sale',
      comment: 'Продажа клиенту',
      'lines[0][componentId]': String(ctx.componentId),
      'lines[0][qty]': '4',
      _csrf: token,
    });

  assert.equal(created.status, 302);
  assert.match(created.headers.location, /^\/stock\/issues\/\d+$/);

  const card = await storekeeper.agent.get(created.headers.location);
  assert.equal(card.status, 200);
  assert.match(card.text, /РС-2026-0001/);
  assert.match(card.text, /Продажа/);
  assert.match(card.text, /50,00/);
  assert.match(card.text, /Партии списания/);
  assert.match(card.text, /ПР-2026-0001/);
  assert.match(card.text, /ПР-2026-0002/);

  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 1);
});

test('stock ui: transfer rejects identical warehouses and posts between two warehouses', async () => {
  const ctx = await seedStock();
  await receive(ctx, 5, '12.0000');
  const destinationId = await secondWarehouse();

  const storekeeper = await ctx.signIn('storekeeper');
  let token = await getCsrf(storekeeper.agent, '/stock/transfers/new');

  const same = await storekeeper.agent
    .post('/stock/transfers')
    .type('form')
    .send({
      fromWarehouseId: String(ctx.warehouseId),
      toWarehouseId: String(ctx.warehouseId),
      docDate: '2026-11-22',
      'lines[0][componentId]': String(ctx.componentId),
      'lines[0][qty]': '1',
      _csrf: token,
    });

  assert.equal(same.status, 400);
  assert.match(same.text, /должны различаться/);
  assert.equal(await countRows('stock_documents'), 1, 'only the baseline receipt exists');

  token = await getCsrf(storekeeper.agent, '/stock/transfers/new');
  const created = await storekeeper.agent
    .post('/stock/transfers')
    .type('form')
    .send({
      fromWarehouseId: String(ctx.warehouseId),
      toWarehouseId: String(destinationId),
      docDate: '2026-11-22',
      comment: 'Пополнение регионального склада',
      'lines[0][componentId]': String(ctx.componentId),
      'lines[0][qty]': '4',
      _csrf: token,
    });

  assert.equal(created.status, 302);
  assert.match(created.headers.location, /^\/stock\/transfers\/\d+$/);

  const card = await storekeeper.agent.get(created.headers.location);
  assert.equal(card.status, 200);
  assert.match(card.text, /ПМ-2026-0001/);
  assert.match(card.text, /Откуда/);
  assert.match(card.text, /Тестовый склад/);
  assert.match(card.text, /Второй тестовый склад/);
  assert.match(card.text, /48,00/);

  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 1);
  assert.equal(await balance(ctx.componentId, destinationId), 4);
});

test('stock ui: lists render filters, rows and pagination', async () => {
  const ctx = await seedStock();
  await receive(ctx, 1);

  // A second page needs 21 rows; direct inserts keep the test fast and focus on
  // the read model rather than on posting 20 documents.
  for (let index = 2; index <= 21; index += 1) {
    await query(
      `insert into stock_documents (type, number, doc_date, supplier_id, warehouse_id, total_cost, created_by)
       values ('receipt', $1, '2026-11-22', $2, $3, 100.00, $4)`,
      [`ПР-2026-${String(index).padStart(4, '0')}`, ctx.supplierId, ctx.warehouseId, ctx.userId],
    );
  }

  const storekeeper = await ctx.signIn('storekeeper');
  const first = await storekeeper.agent.get('/stock/receipts');
  assert.equal(first.status, 200);
  assert.match(first.text, /Приёмки/);
  assert.match(first.text, /ПР-2026-0021/);
  assert.match(first.text, /Страница 1 из 2/);
  assert.doesNotMatch(first.text, /ПР-2026-0001/);

  const second = await storekeeper.agent.get('/stock/receipts?page=2');
  assert.equal(second.status, 200);
  assert.match(second.text, /ПР-2026-0001/);
  assert.match(second.text, /Страница 2 из 2/);

  const filtered = await storekeeper.agent.get('/stock/receipts?q=0021&dateFrom=2026-11-22');
  assert.equal(filtered.status, 200);
  assert.match(filtered.text, /ПР-2026-0021/);
  assert.doesNotMatch(filtered.text, /ПР-2026-0001/);

  const issues = await storekeeper.agent.get('/stock/issues');
  assert.equal(issues.status, 200);
  assert.match(issues.text, /Расходы/);

  const transfers = await storekeeper.agent.get('/stock/transfers');
  assert.equal(transfers.status, 200);
  assert.match(transfers.text, /Перемещения/);
});

test('stock ui: quick action prefills the component on every new document form', async () => {
  const ctx = await seedStock();
  const storekeeper = await ctx.signIn('storekeeper');

  for (const path of ['/stock/receipts/new', '/stock/issues/new', '/stock/transfers/new']) {
    const response = await storekeeper.agent.get(`${path}?componentId=${ctx.componentId}`);
    assert.equal(response.status, 200, `${path} should render`);
    assert.match(
      response.text,
      new RegExp(`value="${ctx.componentId}"[^>]*selected`),
      `${path} should preselect the component`,
    );
    assert.match(response.text, /CPU-TEST-01/);
  }
});

test('stock ui: mutation routes are forbidden for an analyst', async () => {
  const ctx = await seedStock();
  const analyst = await ctx.signIn('analyst');
  const token = await getCsrf(analyst.agent, '/dashboard');

  const postings = [
    ['/stock/receipts', { supplierId: String(ctx.supplierId) }],
    ['/stock/issues', { warehouseId: String(ctx.warehouseId) }],
    ['/stock/transfers', { fromWarehouseId: String(ctx.warehouseId) }],
  ];

  for (const [path, body] of postings) {
    const response = await analyst.agent
      .post(path)
      .type('form')
      .send({ ...body, _csrf: token });
    assert.equal(response.status, 403, `POST ${path} must be forbidden`);
  }

  assert.equal(await countRows('stock_documents'), 0);
});

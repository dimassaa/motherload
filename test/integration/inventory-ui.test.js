import assert from 'node:assert/strict';
import test from 'node:test';
import { query } from '../../src/db/pool.js';
import { createCount, saveCountLines, submitCount } from '../../src/services/inventory.js';
import { postReceipt } from '../../src/services/stock.js';
import { createTestApp } from '../helpers/app.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';
import {
  DEFAULT_TEST_PASSWORD,
  createComponentFactory,
  createUserFactory,
  seedBase,
} from '../helpers/factories.js';
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

/** Seed the shared fixtures plus an admin, and sign the actors in on demand. */
async function seedInventory() {
  const ctx = await seedBase();
  const admin = await createUserFactory({
    email: 'admin@test.by',
    password: PASSWORD,
    role: 'admin',
    fullName: 'Алексей Ковалёв',
  });
  return { ...ctx, admin };
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

/** Log in a freshly created user of the requested role. */
async function signInAs(role, email) {
  const user = await createUserFactory({ email, password: PASSWORD, role });
  const { agent } = createTestApp();
  await loginAs(agent, email, PASSWORD);
  return { agent, user };
}

async function countStatus(countId) {
  const { rows } = await query('select status from inventory_counts where id = $1', [countId]);
  return rows[0]?.status ?? null;
}

async function balance(componentId, warehouseId) {
  const { rows } = await query(
    'select qty from v_stock_balances where component_id = $1 and warehouse_id = $2',
    [componentId, warehouseId],
  );
  return rows[0]?.qty ?? 0;
}

/** Fill every line and submit, so tests can start from a reviewable count. */
async function submitFilled(countId, lines) {
  await saveCountLines({ countId, lines, userId: null });
  await submitCount({ countId, userId: null });
}

test('inventory ui: storekeeper creates a count and sees snapshot lines', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  const { agent } = await signInAs('storekeeper', 'sklad-ui@test.by');

  const form = await agent.get('/inventory/new');
  assert.equal(form.status, 200);
  assert.match(form.text, /Склад будет заморожен/);
  assert.match(form.text, /Центральный склад|Тестовый склад/);

  const token = await getCsrf(agent, '/inventory/new');
  const created = await agent
    .post('/inventory')
    .type('form')
    .send({ warehouseId: String(ctx.warehouseId), comment: 'Плановая', _csrf: token });

  assert.equal(created.status, 302);
  assert.match(created.headers.location, /^\/inventory\/\d+$/);

  const page = await agent.get(created.headers.location);
  assert.equal(page.status, 200);
  assert.match(page.text, /CPU-TEST-01/);
  assert.match(page.text, /data-expected="5"/);
  assert.match(page.text, /Заполнить по учёту/);
  assert.match(page.text, /Черновик/);

  const list = await agent.get('/inventory');
  assert.equal(list.status, 200);
  assert.match(list.text, /ИНВ-\d{4}-\d{4}/);
  assert.match(list.text, /Тестовый склад/);
  assert.match(list.text, /Черновик/);
  assert.match(list.text, /inventory-list__discrepancies">\s*0/);
});

test('inventory ui: storekeeper sees submit but not approve; admin sees approve', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  const { countId } = await create(ctx);

  const storekeeper = await signInAs('storekeeper', 'sklad-ui@test.by');
  const draft = await storekeeper.agent.get(`/inventory/${countId}`);
  assert.equal(draft.status, 200);
  assert.match(draft.text, /Отправить на проверку/);
  assert.match(draft.text, new RegExp(`/inventory/${countId}/submit`));
  assert.doesNotMatch(draft.text, new RegExp(`/inventory/${countId}/approve`));

  await submitFilled(countId, [{ componentId: ctx.componentId, actualQty: 5 }]);

  const submittedForStorekeeper = await storekeeper.agent.get(`/inventory/${countId}`);
  assert.equal(submittedForStorekeeper.status, 200);
  assert.match(submittedForStorekeeper.text, /На проверке/);
  assert.doesNotMatch(submittedForStorekeeper.text, new RegExp(`/inventory/${countId}/approve`));
  assert.doesNotMatch(submittedForStorekeeper.text, /Утвердить инвентаризацию/);

  const admin = await signInAs('admin', 'admin-ui@test.by');
  const submittedForAdmin = await admin.agent.get(`/inventory/${countId}`);
  assert.equal(submittedForAdmin.status, 200);
  assert.match(submittedForAdmin.text, new RegExp(`/inventory/${countId}/approve`));
  assert.match(submittedForAdmin.text, /Утвердить инвентаризацию/);

  // The button is hidden, but the server must still refuse the action.
  const token = await getCsrf(storekeeper.agent, `/inventory/${countId}`);
  const forbidden = await storekeeper.agent
    .post(`/inventory/${countId}/approve`)
    .type('form')
    .send({ _csrf: token });
  assert.equal(forbidden.status, 403);
  assert.equal(await countStatus(countId), 'submitted');
});

test('inventory ui: approve action changes status and redirects with toast', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  const { countId } = await create(ctx);
  await submitFilled(countId, [{ componentId: ctx.componentId, actualQty: 8 }]);

  const { agent } = await signInAs('admin', 'admin-ui@test.by');
  const token = await getCsrf(agent, `/inventory/${countId}`);
  const approved = await agent
    .post(`/inventory/${countId}/approve`)
    .type('form')
    .send({ _csrf: token });

  assert.equal(approved.status, 302);
  assert.equal(approved.headers.location, `/inventory/${countId}`);
  assert.equal(await countStatus(countId), 'approved');
  assert.equal(await balance(ctx.componentId, ctx.warehouseId), 8);

  const page = await agent.get(`/inventory/${countId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Утверждена/);
  assert.match(page.text, /Инвентаризация утверждена/);
  assert.doesNotMatch(page.text, /Утвердить инвентаризацию/);

  const { rows } = await query(
    "select count(*)::integer as count from audit_log where action = 'inventory.approve'",
  );
  assert.equal(rows[0].count, 1);
});

test('inventory ui: analyst gets 403 on every inventory screen', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  const { countId } = await create(ctx);
  const { agent } = await signInAs('analyst', 'analyst@test.by');

  for (const path of ['/inventory', '/inventory/new', `/inventory/${countId}`]) {
    const response = await agent.get(path);
    assert.equal(response.status, 403, `GET ${path} must be forbidden for an analyst`);
    assert.match(response.text, /Недостаточно прав/);
  }
});

test('inventory ui: bulk-fill hooks and actual difference are rendered', async () => {
  const ctx = await seedInventory();
  const other = await addComponent(ctx, { sku: 'RAM-EQUAL-02', name: 'Память без расхождения' });
  await receive(ctx, 5);
  await receive(ctx, 5, '100.0000', other.id);

  const { countId } = await create(ctx);
  await saveCountLines({
    countId,
    lines: [
      { componentId: ctx.componentId, actualQty: 8 },
      { componentId: other.id, actualQty: 5 },
    ],
    userId: null,
  });

  const { agent } = await signInAs('storekeeper', 'sklad-ui@test.by');
  const page = await agent.get(`/inventory/${countId}`);

  assert.equal(page.status, 200);
  assert.match(page.text, /data-inventory-fill/);
  assert.match(page.text, /data-inventory-clear/);
  assert.match(page.text, /data-expected="5"/);
  assert.match(page.text, /\/js\/inventory-form\.js/);
  assert.match(page.text, /действуют только на видимые строки/);
  assert.match(page.text, /class="visually-hidden" for="actual-/);
  assert.match(page.text, /data-difference="3"/);
  assert.match(page.text, /data-difference="0"/);
  assert.match(page.text, /\+3/);

  const filtered = await agent.get(`/inventory/${countId}?q=CPU-TEST-01&only=discrepancy`);
  assert.equal(filtered.status, 200);
  assert.match(filtered.text, /CPU-TEST-01/);
  assert.doesNotMatch(filtered.text, /RAM-EQUAL-02/);

  const asset = await agent.get('/js/inventory-form.js');
  assert.equal(asset.status, 200);
  assert.match(asset.text, /data-inventory-fill/);
});

test('inventory ui: print act lists only discrepancies', async () => {
  const ctx = await seedInventory();
  const other = await addComponent(ctx, { sku: 'RAM-EQUAL-02', name: 'Память без расхождения' });
  await receive(ctx, 5);
  await receive(ctx, 5, '100.0000', other.id);

  const { countId } = await create(ctx);
  await submitFilled(countId, [
    { componentId: ctx.componentId, actualQty: 3, comment: 'Две единицы повреждены' },
    { componentId: other.id, actualQty: 5 },
  ]);

  const { agent } = await signInAs('storekeeper', 'sklad-ui@test.by');
  const page = await agent.get(`/inventory/${countId}`);

  assert.equal(page.status, 200);
  assert.match(page.text, /Акт расхождений/);
  assert.match(page.text, /Печать акта/);
  assert.match(page.text, /href="#inventory-act" data-inventory-print/);

  const act = page.text.slice(page.text.indexOf('id="inventory-act"'));
  assert.match(act, /CPU-TEST-01/);
  assert.match(act, /Две единицы повреждены/);
  assert.match(act, /-2/);
  assert.doesNotMatch(act, /RAM-EQUAL-02/);
});

test('inventory ui: submit with empty lines re-renders the form with an error', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  const { countId } = await create(ctx);

  const { agent } = await signInAs('storekeeper', 'sklad-ui@test.by');
  const token = await getCsrf(agent, `/inventory/${countId}`);
  const response = await agent
    .post(`/inventory/${countId}/submit`)
    .type('form')
    .send({ _csrf: token });

  assert.equal(response.status, 400);
  assert.match(response.text, /Заполните фактическое количество/);
  assert.match(response.text, /CPU-TEST-01/);
  assert.equal(await countStatus(countId), 'draft');
});

test('inventory ui: saving a draft redirects back with a success toast', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  const { countId } = await create(ctx);

  const { agent } = await signInAs('storekeeper', 'sklad-ui@test.by');
  const token = await getCsrf(agent, `/inventory/${countId}`);
  const saved = await agent
    .post(`/inventory/${countId}/lines`)
    .type('form')
    .send({
      [`lines[0][componentId]`]: String(ctx.componentId),
      [`lines[0][actualQty]`]: '4',
      [`lines[0][comment]`]: 'Одна единица на ремонте',
      _csrf: token,
    });

  assert.equal(saved.status, 302);
  assert.equal(saved.headers.location, `/inventory/${countId}`);

  const page = await agent.get(`/inventory/${countId}`);
  assert.match(page.text, /Фактические количества сохранены/);
  assert.match(page.text, /Одна единица на ремонте/);
  assert.match(page.text, /data-difference="-1"/);

  const { rows } = await query(
    'select actual_qty, difference from inventory_lines where count_id = $1',
    [countId],
  );
  assert.equal(rows[0].actual_qty, 4);
  assert.equal(rows[0].difference, -1);
});

test('inventory ui: saving under a filter keeps the hidden rows', async () => {
  const ctx = await seedInventory();
  const other = await addComponent(ctx, {
    sku: 'RAM-HIDDEN-02',
    name: 'Память скрытая фильтром',
  });
  await receive(ctx, 5);
  await receive(ctx, 5, '100.0000', other.id);
  const { countId } = await create(ctx);

  const { agent } = await signInAs('storekeeper', 'sklad-ui@test.by');
  const filtered = await agent.get(`/inventory/${countId}?q=CPU-TEST-01`);
  assert.equal(filtered.status, 200);
  assert.match(filtered.text, /CPU-TEST-01/);
  assert.doesNotMatch(filtered.text, /data-sku="RAM-HIDDEN-02"/);

  // The non-matching line is not lost: it travels as hidden inputs with its
  // original form index so the save cannot silently shrink the snapshot.
  assert.match(
    filtered.text,
    new RegExp(`name="lines\\[1\\]\\[componentId\\]"\\s+value="${other.id}"`),
  );

  const token = await getCsrf(agent, `/inventory/${countId}`);
  const saved = await agent
    .post(`/inventory/${countId}/lines`)
    .type('form')
    .send({
      [`lines[0][componentId]`]: String(ctx.componentId),
      [`lines[0][actualQty]`]: '7',
      [`lines[0][comment]`]: 'Видимая строка',
      [`lines[1][componentId]`]: String(other.id),
      [`lines[1][actualQty]`]: '4',
      [`lines[1][comment]`]: 'Скрытая строка',
      _csrf: token,
    });

  assert.equal(saved.status, 302);
  const { rows } = await query(
    `select component_id, actual_qty, difference, comment
     from inventory_lines where count_id = $1 order by component_id`,
    [countId],
  );
  assert.equal(rows.length, 2, 'the filtered save must not lose or duplicate a line');
  assert.deepEqual(
    rows.map((row) => [row.component_id, row.actual_qty, row.difference, row.comment]),
    [
      [ctx.componentId, 7, 2, 'Видимая строка'],
      [other.id, 4, -1, 'Скрытая строка'],
    ],
  );
});

test('inventory ui: submit with an empty line marks the row and the summary', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  const { countId } = await create(ctx);

  const { agent } = await signInAs('storekeeper', 'sklad-ui@test.by');
  const token = await getCsrf(agent, `/inventory/${countId}`);
  const response = await agent
    .post(`/inventory/${countId}/submit`)
    .type('form')
    .send({ _csrf: token });

  assert.equal(response.status, 400);
  assert.match(response.text, /Заполните фактическое количество/);
  assert.match(
    response.text,
    new RegExp(`aria-invalid="true" aria-describedby="actual-error-${ctx.componentId}"`),
  );
  assert.match(
    response.text,
    new RegExp(`id="actual-error-${ctx.componentId}"[^>]*>\\s*Введите фактическое количество`),
  );
});

test('inventory ui: cancel is a draft action for storekeepers and an admin action after submit', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);

  const storekeeper = await signInAs('storekeeper', 'sklad-ui@test.by');
  const draft = await create(ctx);
  let token = await getCsrf(storekeeper.agent, `/inventory/${draft.countId}`);
  let cancelled = await storekeeper.agent
    .post(`/inventory/${draft.countId}/cancel`)
    .type('form')
    .send({ _csrf: token });

  assert.equal(cancelled.status, 302);
  assert.equal(cancelled.headers.location, `/inventory/${draft.countId}`);
  assert.equal(await countStatus(draft.countId), 'cancelled');
  const flash = await storekeeper.agent.get(`/inventory/${draft.countId}`);
  assert.match(flash.text, /Инвентаризация отменена/);

  // A submitted count is an administrator's review. The button disappears for
  // the storekeeper and the server refuses the direct post.
  const submitted = await create(ctx);
  await submitFilled(submitted.countId, [{ componentId: ctx.componentId, actualQty: 5 }]);
  const submittedPage = await storekeeper.agent.get(`/inventory/${submitted.countId}`);
  assert.doesNotMatch(submittedPage.text, new RegExp(`/inventory/${submitted.countId}/cancel`));

  token = await getCsrf(storekeeper.agent, '/inventory/new');
  const forbidden = await storekeeper.agent
    .post(`/inventory/${submitted.countId}/cancel`)
    .type('form')
    .send({ _csrf: token });
  assert.equal(forbidden.status, 403);
  assert.equal(await countStatus(submitted.countId), 'submitted');

  const admin = await signInAs('admin', 'admin-cancel@test.by');
  token = await getCsrf(admin.agent, `/inventory/${submitted.countId}`);
  cancelled = await admin.agent
    .post(`/inventory/${submitted.countId}/cancel`)
    .type('form')
    .send({ _csrf: token });
  assert.equal(cancelled.status, 302);
  assert.equal(await countStatus(submitted.countId), 'cancelled');

  const analyst = await signInAs('analyst', 'analyst-cancel@test.by');
  token = await getCsrf(analyst.agent, '/dashboard');
  const denied = await analyst.agent
    .post(`/inventory/${submitted.countId}/cancel`)
    .type('form')
    .send({ _csrf: token });
  assert.equal(denied.status, 403);
});

test('inventory ui: draft act does not claim there are no discrepancies before facts are entered', async () => {
  const ctx = await seedInventory();
  await receive(ctx, 5);
  const { countId } = await create(ctx);

  const { agent } = await signInAs('storekeeper', 'sklad-ui@test.by');
  const page = await agent.get(`/inventory/${countId}`);

  assert.equal(page.status, 200);
  assert.match(page.text, /Факт введён не по всем строкам/);
  assert.match(page.text, /Акт неполный/);
  assert.doesNotMatch(page.text, /Расхождений нет/);
});

test('inventory ui: a capped list is labelled as the last 200, not as a total', async () => {
  const ctx = await seedInventory();
  await query(
    `insert into inventory_counts (warehouse_id, status, started_by, created_at)
     select $1, 'cancelled', $2, timestamptz '2026-01-01 00:00:00+03' + (g || ' minutes')::interval
     from generate_series(1, 201) as g`,
    [ctx.warehouseId, ctx.userId],
  );

  const { agent } = await signInAs('storekeeper', 'sklad-ui@test.by');
  const list = await agent.get('/inventory');

  assert.equal(list.status, 200);
  assert.match(list.text, /Последние 200 инвентаризаций/);
  assert.doesNotMatch(list.text, /Всего инвентаризаций/);
  assert.equal((list.text.match(/inventory-list__discrepancies/g) ?? []).length, 200);
});

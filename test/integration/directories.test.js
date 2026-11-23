import assert from 'node:assert/strict';
import test from 'node:test';
import { query } from '../../src/db/pool.js';
import { createTestApp } from '../helpers/app.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';
import {
  createSupplierFactory,
  createUserFactory,
  createWarehouseFactory,
} from '../helpers/factories.js';
import { getCsrf, loginAs } from '../helpers/http.js';

const PASSWORD = 'Direct!23456';

test.before(async () => {
  await setupTestDb();
});

test.beforeEach(async () => {
  await truncateAll();
});

test.after(async () => {
  await teardownTestDb();
});

/** Sign in through the real login form; every directory route is admin-only. */
async function signInAs(role = 'admin', email = `${role}@test.by`) {
  const user = await createUserFactory({ email, password: PASSWORD, role });
  const { agent } = createTestApp();
  await loginAs(agent, email, PASSWORD);
  return { agent, user };
}

function supplierPayload(overrides = {}) {
  return {
    name: 'ООО «ТестПоставка»',
    unp: '190000001',
    contactPerson: 'Иван Петров',
    phone: '+375 (17) 200-00-00',
    email: 'sales@testpostavka.by',
    address: 'г. Минск, пр-т Независимости, 1',
    leadTimeDays: '5',
    isActive: 'true',
    ...overrides,
  };
}

function warehousePayload(overrides = {}) {
  return {
    code: 'WH-NEW',
    name: 'Новый склад',
    city: 'Минск',
    address: 'ул. Купревича, 1/2',
    isActive: 'true',
    ...overrides,
  };
}

async function findSupplierByUnp(unp) {
  const { rows } = await query(
    `select id, name, unp, contact_person, phone, email, address, lead_time_days, is_active
     from suppliers where unp = $1`,
    [unp],
  );
  return rows[0] ?? null;
}

async function findAudit(action) {
  const { rows } = await query(
    'select user_id, action, entity_type, entity_id, details from audit_log where action = $1 order by id',
    [action],
  );
  return rows;
}

test('admin creates a supplier, sees it in the list and the action is audited', async () => {
  const { agent, user: admin } = await signInAs('admin');
  const token = await getCsrf(agent, '/admin/directories/suppliers');

  const res = await agent
    .post('/admin/directories/suppliers')
    .type('form')
    .send({ ...supplierPayload(), _csrf: token });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/directories/suppliers');

  const created = await findSupplierByUnp('190000001');
  assert.ok(created, 'the supplier row must exist after a successful create');
  assert.equal(created.name, 'ООО «ТестПоставка»');
  assert.equal(created.contact_person, 'Иван Петров');
  assert.equal(created.lead_time_days, 5);
  assert.equal(created.is_active, true);

  const page = await agent.get('/admin/directories/suppliers');
  assert.equal(page.status, 200);
  assert.match(page.text, /ООО «ТестПоставка»/);
  assert.match(page.text, /190000001/);

  const entries = await findAudit('directory.create');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].user_id, admin.id);
  assert.equal(entries[0].entity_type, 'supplier');
  assert.equal(entries[0].entity_id, String(created.id));
});

test('a duplicate UNP is refused with a readable message and keeps the entered values', async () => {
  await createSupplierFactory({ unp: '190000001', name: 'ООО «Первый»' });
  const { agent } = await signInAs('admin');
  const token = await getCsrf(agent, '/admin/directories/suppliers');

  const res = await agent
    .post('/admin/directories/suppliers')
    .type('form')
    .send({ ...supplierPayload({ name: 'ООО «Второй»' }), _csrf: token });

  assert.equal(res.status, 400);
  assert.match(res.text, /УНП/);
  assert.match(res.text, /ООО «Второй»/, 'the submitted name must survive the re-render');
  assert.match(
    res.text,
    /id="supplier-unp"[^>]*aria-invalid="true"/,
    'the duplicate must be marked on the UNP input',
  );
  assert.match(res.text, /id="supplier-unp-error"/);

  const { rows } = await query(
    "select count(*)::integer as count from suppliers where unp = '190000001'",
  );
  assert.equal(rows[0].count, 1, 'the duplicate must not be stored');
});

test('an UNP that is not nine digits is rejected by the form', async () => {
  const { agent } = await signInAs('admin');
  const token = await getCsrf(agent, '/admin/directories/suppliers');

  const res = await agent
    .post('/admin/directories/suppliers')
    .type('form')
    .send({ ...supplierPayload({ unp: '12345ABCD' }), _csrf: token });

  assert.equal(res.status, 400);
  assert.match(res.text, /9 цифр/);
  assert.equal(await findSupplierByUnp('12345ABCD'), null);
});

test('an unrecognized activity value is rejected instead of becoming inactive', async () => {
  const { agent } = await signInAs('admin');
  const token = await getCsrf(agent, '/admin/directories/suppliers');

  const res = await agent
    .post('/admin/directories/suppliers')
    .type('form')
    .send({ ...supplierPayload({ isActive: 'maybe' }), _csrf: token });

  assert.equal(res.status, 400);
  assert.match(res.text, /Выберите статус/);
  assert.equal(await findSupplierByUnp('190000001'), null);
});

test('a malformed edit link is a 404, not a silent create form', async () => {
  const { agent } = await signInAs('admin');

  const res = await agent.get('/admin/directories/suppliers?edit=not-a-number');

  assert.equal(res.status, 404);
  assert.match(res.text, /Запись не найдена/);
});

test('a warehouse referenced by a document cannot be deleted and the reason is shown', async () => {
  const warehouse = await createWarehouseFactory({ code: 'WH-REF' });
  const supplier = await createSupplierFactory();

  await query(
    `insert into stock_documents (type, number, doc_date, supplier_id, warehouse_id)
     values ('receipt', 'REC-0001', '2026-11-22', $1, $2)`,
    [supplier.id, warehouse.id],
  );

  const { agent } = await signInAs('admin');
  const token = await getCsrf(agent, '/admin/directories/warehouses');

  const res = await agent
    .post(`/admin/directories/warehouses/${warehouse.id}/delete`)
    .type('form')
    .send({ _csrf: token });

  assert.equal(res.status, 409);
  assert.match(res.text, /Нельзя удалить склад/);
  assert.match(res.text, /ссылаются|используется/i);
  // The admin stays on the directories shell, not the bare central error page.
  assert.match(res.text, /<h1[^>]*>Справочники<\/h1>/);
  assert.match(res.text, /class="form-errors"/);
  assert.match(res.text, /\/admin\/directories\/warehouses/);
  assert.match(res.text, /WH-REF/, 'the still-present warehouse must be listed on the page');

  const { rows } = await query('select count(*)::integer as count from warehouses where id = $1', [
    warehouse.id,
  ]);
  assert.equal(rows[0].count, 1, 'the referenced warehouse must survive the refused delete');
});

test('storekeeper cannot open or mutate the directory page', async () => {
  const { agent } = await signInAs('storekeeper');
  // The directory page is forbidden to this role, so the token comes from a
  // page the storekeeper may open; a real attacker would use their own session.
  const token = await getCsrf(agent, '/profile');

  const read = await agent.get('/admin/directories');
  assert.equal(read.status, 403);
  assert.match(read.text, /Недостаточно прав/);

  const write = await agent
    .post('/admin/directories/suppliers')
    .type('form')
    .send({ ...supplierPayload({ unp: '290000002' }), _csrf: token });
  assert.equal(write.status, 403);
  assert.equal(await findSupplierByUnp('290000002'), null);
});

test('an analyst cannot open directories', async () => {
  const { agent } = await signInAs('analyst');

  const res = await agent.get('/admin/directories/categories');

  assert.equal(res.status, 403);
  assert.match(res.text, /Недостаточно прав/);
});

test('an unreferenced warehouse can be edited and deleted, and both actions are audited', async () => {
  const warehouse = await createWarehouseFactory({ code: 'WH-EDIT' });
  const { agent } = await signInAs('admin');
  const token = await getCsrf(agent, '/admin/directories/warehouses');

  const update = await agent
    .post(`/admin/directories/warehouses/${warehouse.id}`)
    .type('form')
    .send({ ...warehousePayload({ code: 'WH-EDIT', name: 'Склад после правки' }), _csrf: token });

  assert.equal(update.status, 302);
  assert.equal(update.headers.location, '/admin/directories/warehouses');

  const edited = await query('select name, is_active from warehouses where id = $1', [
    warehouse.id,
  ]);
  assert.equal(edited.rows[0].name, 'Склад после правки');

  const remove = await agent
    .post(`/admin/directories/warehouses/${warehouse.id}/delete`)
    .type('form')
    .send({ _csrf: token });

  assert.equal(remove.status, 302);
  assert.equal(remove.headers.location, '/admin/directories/warehouses');

  const gone = await query('select count(*)::integer as count from warehouses where id = $1', [
    warehouse.id,
  ]);
  assert.equal(gone.rows[0].count, 0);

  assert.equal((await findAudit('directory.update')).length, 1);
  assert.equal((await findAudit('directory.delete')).length, 1);
});

test('category and manufacturer rows can be created and deleted through the generic paths', async () => {
  const { agent } = await signInAs('admin');

  const categoryToken = await getCsrf(agent, '/admin/directories/categories');
  const categoryCreate = await agent.post('/admin/directories/categories').type('form').send({
    name: 'Охлаждение',
    slug: 'cooling',
    description: 'Кулеры и вентиляторы',
    sortOrder: '10',
    _csrf: categoryToken,
  });

  assert.equal(categoryCreate.status, 302);
  assert.equal(categoryCreate.headers.location, '/admin/directories/categories');

  const category = await query('select id, slug, sort_order from categories where name = $1', [
    'Охлаждение',
  ]);
  assert.equal(category.rows.length, 1);
  assert.equal(category.rows[0].slug, 'cooling');
  assert.equal(category.rows[0].sort_order, 10);

  const categoryDelete = await agent
    .post(`/admin/directories/categories/${category.rows[0].id}/delete`)
    .type('form')
    .send({ _csrf: categoryToken });
  assert.equal(categoryDelete.status, 302);
  assert.equal(categoryDelete.headers.location, '/admin/directories/categories');
  assert.equal((await query('select count(*)::integer as count from categories')).rows[0].count, 0);

  const manufacturerToken = await getCsrf(agent, '/admin/directories/manufacturers');
  const manufacturerCreate = await agent
    .post('/admin/directories/manufacturers')
    .type('form')
    .send({ name: 'ТехноКорп-Тест', country: 'Беларусь', _csrf: manufacturerToken });

  assert.equal(manufacturerCreate.status, 302);
  assert.equal(manufacturerCreate.headers.location, '/admin/directories/manufacturers');

  const manufacturer = await query('select id, country from manufacturers where name = $1', [
    'ТехноКорп-Тест',
  ]);
  assert.equal(manufacturer.rows.length, 1);
  assert.equal(manufacturer.rows[0].country, 'Беларусь');

  const manufacturerDelete = await agent
    .post(`/admin/directories/manufacturers/${manufacturer.rows[0].id}/delete`)
    .type('form')
    .send({ _csrf: manufacturerToken });
  assert.equal(manufacturerDelete.status, 302);
  assert.equal(manufacturerDelete.headers.location, '/admin/directories/manufacturers');
  assert.equal(
    (await query('select count(*)::integer as count from manufacturers')).rows[0].count,
    0,
  );

  const creates = await findAudit('directory.create');
  assert.deepEqual(
    creates.map((entry) => entry.entity_type),
    ['category', 'manufacturer'],
  );
  assert.equal((await findAudit('directory.delete')).length, 2);
});

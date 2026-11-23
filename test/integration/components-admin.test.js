import assert from 'node:assert/strict';
import test from 'node:test';
import { query } from '../../src/db/pool.js';
import { createTestApp } from '../helpers/app.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';
import {
  createComponentFactory,
  createSupplierFactory,
  createUserFactory,
  createWarehouseFactory,
} from '../helpers/factories.js';
import { getCsrf, loginAs } from '../helpers/http.js';

const PASSWORD = 'Catalog!23456';

test.before(async () => {
  await setupTestDb();
});

test.beforeEach(async () => {
  await truncateAll();
});

test.after(async () => {
  await teardownTestDb();
});

/** Sign in through the real login form; the component catalog is admin-only. */
async function signInAs(role = 'admin', email = `${role}@test.by`) {
  const user = await createUserFactory({ email, password: PASSWORD, role });
  const { agent } = createTestApp();
  await loginAs(agent, email, PASSWORD);
  return { agent, user };
}

/** Reference rows the component form picks from. */
async function seedReferences() {
  const { rows: categories } = await query(
    `insert into categories (name, slug) values ('Процессоры', 'processors') returning id`,
  );
  const { rows: manufacturers } = await query(
    `insert into manufacturers (name, country) values ('Intel', 'США') returning id`,
  );
  const supplier = await createSupplierFactory({ unp: '190000777' });

  return {
    categoryId: categories[0].id,
    manufacturerId: manufacturers[0].id,
    supplierId: supplier.id,
  };
}

function componentPayload(references, overrides = {}) {
  return {
    sku: 'CPU-I7-12700',
    name: 'Процессор Intel Core i7-12700',
    categoryId: String(references.categoryId),
    manufacturerId: String(references.manufacturerId),
    defaultSupplierId: String(references.supplierId),
    unit: 'шт',
    purchasePrice: '850.00',
    retailPrice: '1099.90',
    minStock: '5',
    maxStock: '20',
    leadTimeDays: '7',
    specs: '{"socket":"LGA1700","cores":12}',
    isActive: 'true',
    ...overrides,
  };
}

async function findComponentBySku(sku) {
  const { rows } = await query('select * from components where sku = $1', [sku]);
  return rows[0] ?? null;
}

async function findAudit(action) {
  const { rows } = await query(
    'select user_id, action, entity_type, entity_id, details from audit_log where action = $1 order by id',
    [action],
  );
  return rows;
}

test('admin creates a component with specs and thresholds', async () => {
  const references = await seedReferences();
  const { agent, user: admin } = await signInAs('admin');
  const token = await getCsrf(agent, '/admin/components/new');

  const res = await agent
    .post('/admin/components')
    .type('form')
    .send({ ...componentPayload(references), _csrf: token });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/components');

  const created = await findComponentBySku('CPU-I7-12700');
  assert.ok(created, 'the component must exist after a successful create');
  assert.equal(created.name, 'Процессор Intel Core i7-12700');
  assert.equal(created.category_id, references.categoryId);
  assert.equal(created.manufacturer_id, references.manufacturerId);
  assert.equal(created.default_supplier_id, references.supplierId);
  assert.equal(created.unit, 'шт');
  assert.equal(created.purchase_price, '850.00');
  assert.equal(created.retail_price, '1099.90');
  assert.equal(created.min_stock, 5);
  assert.equal(created.max_stock, 20);
  assert.equal(created.lead_time_days, 7);
  assert.deepEqual(created.specs, { socket: 'LGA1700', cores: 12 });
  assert.equal(created.is_active, true);

  const page = await agent.get('/admin/components');
  assert.equal(page.status, 200);
  assert.match(page.text, /CPU-I7-12700/);
  assert.match(page.text, /Процессор Intel Core i7-12700/);
  assert.match(page.text, /Процессоры/);

  const entries = await findAudit('component.create');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].user_id, admin.id);
  assert.equal(entries[0].entity_type, 'component');
  assert.equal(entries[0].entity_id, String(created.id));
});

test('SKU is immutable on edit but the other fields are saved', async () => {
  const references = await seedReferences();
  const component = await createComponentFactory({
    sku: 'CPU-ORIG-01',
    name: 'Исходное имя',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });

  const { agent } = await signInAs('admin');
  const token = await getCsrf(agent, `/admin/components/${component.id}`);

  const changed = await agent
    .post(`/admin/components/${component.id}`)
    .type('form')
    .send({
      ...componentPayload(references, { sku: 'CPU-CHANGED-01', name: 'Новое имя' }),
      _csrf: token,
    });

  assert.equal(changed.status, 400);
  assert.match(changed.text, /SKU/);
  assert.match(changed.text, /изменить нельзя/i);
  assert.equal(
    (await query('select sku from components where id = $1', [component.id])).rows[0].sku,
    'CPU-ORIG-01',
    'a submitted SKU must never overwrite the stored one',
  );

  // The real edit form does not submit SKU at all; the same payload without it
  // must save normally.
  const renamed = componentPayload(references, { name: 'Новое имя' });
  delete renamed.sku;
  const saved = await agent
    .post(`/admin/components/${component.id}`)
    .type('form')
    .send({ ...renamed, _csrf: token });

  assert.equal(saved.status, 302);
  assert.equal(saved.headers.location, '/admin/components');
  assert.equal(
    (await query('select name from components where id = $1', [component.id])).rows[0].name,
    'Новое имя',
  );
  assert.equal((await findAudit('component.update')).length, 1);
});

test('a component with stock history is archived, not deleted', async () => {
  const references = await seedReferences();
  const warehouse = await createWarehouseFactory();
  const component = await createComponentFactory({
    sku: 'CPU-HIST-01',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });

  await query(
    `insert into stock_batches
       (component_id, warehouse_id, unit_cost, qty_received, qty_remaining, received_at)
     values ($1, $2, '850.0000', 10, 10, '2026-11-22')`,
    [component.id, warehouse.id],
  );

  const { agent } = await signInAs('admin');
  const token = await getCsrf(agent, '/admin/components');

  const archived = await agent
    .post(`/admin/components/${component.id}/archive`)
    .type('form')
    .send({ _csrf: token });

  assert.equal(archived.status, 302);
  assert.equal(archived.headers.location, '/admin/components');

  const afterArchive = await query('select is_active from components where id = $1', [
    component.id,
  ]);
  assert.equal(afterArchive.rows[0].is_active, false);
  assert.equal((await findAudit('component.archive')).length, 1);

  const refused = await agent
    .post(`/admin/components/${component.id}/delete`)
    .type('form')
    .send({ _csrf: token });

  assert.equal(refused.status, 409);
  assert.match(refused.text, /истори/i);
  assert.match(refused.text, /архив/i);

  const stillThere = await query(
    'select count(*)::integer as count from components where id = $1',
    [component.id],
  );
  assert.equal(stillThere.rows[0].count, 1, 'a component with history must survive delete');

  const list = await agent.get('/admin/components');
  assert.match(list.text, /В архиве/);
});

test('a component without history can be deleted', async () => {
  const references = await seedReferences();
  const component = await createComponentFactory({
    sku: 'CPU-FRESH-01',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });

  const { agent } = await signInAs('admin');
  const token = await getCsrf(agent, '/admin/components');

  const res = await agent
    .post(`/admin/components/${component.id}/delete`)
    .type('form')
    .send({ _csrf: token });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/components');

  const { rows } = await query('select count(*)::integer as count from components where id = $1', [
    component.id,
  ]);
  assert.equal(rows[0].count, 0);
  assert.equal((await findAudit('component.delete')).length, 1);
});

test('the list filters by search, category and status', async () => {
  const references = await seedReferences();
  const { rows: secondCategory } = await query(
    `insert into categories (name, slug) values ('Видеокарты', 'graphics-cards') returning id`,
  );

  await createComponentFactory({
    sku: 'CPU-FILTER-01',
    name: 'Процессор для фильтра',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });
  await createComponentFactory({
    sku: 'GPU-FILTER-01',
    name: 'Видеокарта GeForce для фильтра',
    categoryId: secondCategory[0].id,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
    isActive: false,
  });

  const { agent } = await signInAs('admin');

  const archivedInCategory = await agent.get(
    `/admin/components?q=GeForce&categoryId=${secondCategory[0].id}&isActive=false`,
  );
  assert.equal(archivedInCategory.status, 200);
  assert.match(archivedInCategory.text, /GPU-FILTER-01/);
  assert.doesNotMatch(archivedInCategory.text, /CPU-FILTER-01/);

  // The same search with the opposite status must not leak the archived row.
  const active = await agent.get('/admin/components?q=GeForce&isActive=true');
  assert.equal(active.status, 200);
  assert.doesNotMatch(active.text, /GPU-FILTER-01/);
  assert.match(active.text, /Позиции не найдены/);
});

test('the list paginates at 25 positions per page', async () => {
  const references = await seedReferences();

  for (let index = 1; index <= 26; index += 1) {
    const suffix = String(index).padStart(2, '0');
    await createComponentFactory({
      sku: `CPU-PAGE-${suffix}`,
      name: `Товар ${suffix}`,
      categoryId: references.categoryId,
      manufacturerId: references.manufacturerId,
      supplierId: references.supplierId,
    });
  }

  const { agent } = await signInAs('admin');

  const firstPage = await agent.get('/admin/components');
  assert.equal(firstPage.status, 200);
  assert.match(firstPage.text, /Товар 01/);
  assert.doesNotMatch(firstPage.text, /Товар 26/);
  assert.match(firstPage.text, /страница 1 из 2/);

  const secondPage = await agent.get('/admin/components?page=2');
  assert.equal(secondPage.status, 200);
  assert.doesNotMatch(secondPage.text, /Товар 01/);
  assert.match(secondPage.text, /Товар 26/);

  // A stale bookmark past the end must clamp to the last page, not show an
  // empty table that looks like "no positions".
  const clamped = await agent.get('/admin/components?page=999');
  assert.equal(clamped.status, 200);
  assert.match(clamped.text, /Товар 26/);
  assert.match(clamped.text, /страница 2 из 2/);
});

test('storekeeper cannot read or mutate the component administration', async () => {
  const references = await seedReferences();
  const { agent } = await signInAs('storekeeper');
  // The admin page is forbidden to this role, so the token comes from a page
  // the storekeeper may open; the server must still reject the mutation.
  const token = await getCsrf(agent, '/profile');

  const read = await agent.get('/admin/components');
  assert.equal(read.status, 403);
  assert.match(read.text, /Недостаточно прав/);

  const write = await agent
    .post('/admin/components')
    .type('form')
    .send({ ...componentPayload(references), _csrf: token });
  assert.equal(write.status, 403);
  assert.equal(await findComponentBySku('CPU-I7-12700'), null);
});

test('invalid specs JSON is refused with a readable message', async () => {
  const references = await seedReferences();
  const { agent } = await signInAs('admin');
  const token = await getCsrf(agent, '/admin/components/new');

  const res = await agent
    .post('/admin/components')
    .type('form')
    .send({
      ...componentPayload(references, { specs: '{"socket":' }),
      _csrf: token,
    });

  assert.equal(res.status, 400);
  assert.match(res.text, /Проверьте JSON/);
  assert.match(res.text, /id="component-specs"[^>]*aria-invalid="true"/);
  assert.equal(await findComponentBySku('CPU-I7-12700'), null);

  // An array is valid JSON but not a key–value object; the column contract is
  // an object, so the form must reject it instead of storing it.
  const arraySpecs = await agent
    .post('/admin/components')
    .type('form')
    .send({
      ...componentPayload(references, { specs: '[1, 2]' }),
      _csrf: token,
    });

  assert.equal(arraySpecs.status, 400);
  assert.match(arraySpecs.text, /объект/i);
  assert.equal(await findComponentBySku('CPU-I7-12700'), null);
});

test('a duplicate SKU is refused and the entered values survive', async () => {
  const references = await seedReferences();
  await createComponentFactory({
    sku: 'CPU-I7-12700',
    name: 'Уже существует',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });

  const { agent } = await signInAs('admin');
  const token = await getCsrf(agent, '/admin/components/new');

  const res = await agent
    .post('/admin/components')
    .type('form')
    .send({
      ...componentPayload(references, { name: 'Второй процессор' }),
      _csrf: token,
    });

  assert.equal(res.status, 400);
  assert.match(res.text, /SKU/);
  assert.match(res.text, /Второй процессор/, 'the submitted name must survive the re-render');
  assert.match(res.text, /id="component-sku"[^>]*aria-invalid="true"/);

  const { rows } = await query(
    "select count(*)::integer as count from components where sku = 'CPU-I7-12700'",
  );
  assert.equal(rows[0].count, 1, 'the duplicate must not be stored');
});

test('thresholds and prices are validated before anything is written', async () => {
  const references = await seedReferences();
  const { agent } = await signInAs('admin');
  const token = await getCsrf(agent, '/admin/components/new');

  const badThreshold = await agent
    .post('/admin/components')
    .type('form')
    .send({
      ...componentPayload(references, { minStock: '10', maxStock: '4' }),
      _csrf: token,
    });

  assert.equal(badThreshold.status, 400);
  assert.match(badThreshold.text, /Максимальный запас/);

  const badPrice = await agent
    .post('/admin/components')
    .type('form')
    .send({
      ...componentPayload(references, { purchasePrice: '-1' }),
      _csrf: token,
    });

  assert.equal(badPrice.status, 400);
  assert.match(badPrice.text, /цена/i);
  assert.equal(await findComponentBySku('CPU-I7-12700'), null);
});

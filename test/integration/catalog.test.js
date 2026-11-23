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
import { loginAs } from '../helpers/http.js';

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

/** Reference rows shared by every catalog test. Ids are looked up by name/code. */
async function seedReferences() {
  const { rows: categories } = await query(
    `insert into categories (name, slug) values
       ('Процессоры', 'processors'),
       ('Накопители', 'storage')
     returning id, name`,
  );
  const { rows: manufacturers } = await query(
    `insert into manufacturers (name, country) values
       ('ТехноКорп', 'Беларусь'),
       ('МинскЧип', 'Беларусь')
     returning id, name`,
  );

  const supplier = await createSupplierFactory({ unp: '190000901' });
  const minsk = await createWarehouseFactory({
    code: 'WH-MSK',
    name: 'Центральный склад',
    city: 'Минск',
  });
  const gomel = await createWarehouseFactory({
    code: 'WH-GOM',
    name: 'Региональный склад Гомель',
    city: 'Гомель',
  });
  const brest = await createWarehouseFactory({
    code: 'WH-BRE',
    name: 'Региональный склад Брест',
    city: 'Брест',
  });

  const categoryByName = Object.fromEntries(categories.map((row) => [row.name, row.id]));
  const manufacturerByName = Object.fromEntries(manufacturers.map((row) => [row.name, row.id]));

  return {
    categoryId: categoryByName['Процессоры'],
    storageCategoryId: categoryByName['Накопители'],
    manufacturerId: manufacturerByName['ТехноКорп'],
    secondManufacturerId: manufacturerByName['МинскЧип'],
    supplierId: supplier.id,
    warehouses: { minsk, gomel, brest },
  };
}

/**
 * Write a batch and its ledger movement. A batch alone is not a balance: the
 * per-warehouse view reads quantities from `stock_movements` and values from
 * `stock_batches`, so tests must write both to keep the read model coherent.
 */
async function insertStock({
  componentId,
  warehouseId,
  qty,
  unitCost = '100.0000',
  receivedAt = '2026-11-01',
  supplierId = null,
  documentNo = null,
  documentId = null,
}) {
  await query(
    `insert into stock_batches
       (component_id, warehouse_id, supplier_id, unit_cost, qty_received, qty_remaining,
        received_at, document_no)
     values ($1, $2, $3, $4, $5, $5, $6, $7)`,
    [componentId, warehouseId, supplierId, unitCost, qty, receivedAt, documentNo],
  );

  await query(
    `insert into stock_movements
       (component_id, warehouse_id, qty_delta, unit_cost, document_id, created_at)
     values ($1, $2, $3, $4, $5, $6::timestamptz)`,
    [componentId, warehouseId, qty, unitCost, documentId, `${receivedAt}T10:00:00+03:00`],
  );
}

/** Insert an issue document and a negative movement, i.e. real consumption. */
async function insertIssue({ componentId, warehouseId, qty, at, number, userId }) {
  const { rows } = await query(
    `insert into stock_documents
       (type, number, doc_date, warehouse_id, reason, total_cost, created_by)
     values ('issue', $1, $2, $3, 'sale', 0, $4)
     returning id`,
    [number, at.slice(0, 10), warehouseId, userId],
  );

  await query(
    `insert into stock_movements
       (component_id, warehouse_id, qty_delta, unit_cost, document_id, created_at)
     values ($1, $2, $3, '100.0000', $4, $5::timestamptz)`,
    [componentId, warehouseId, -qty, rows[0].id, at],
  );
}

async function signInAs(role, email = `${role}@test.by`) {
  const user = await createUserFactory({ email, password: PASSWORD, role });
  const { agent } = createTestApp();
  await loginAs(agent, email, PASSWORD);
  return { agent, user };
}

test('catalog filters by SKU, name, category and manufacturer', async () => {
  const references = await seedReferences();
  await createComponentFactory({
    sku: 'SSD-990-PRO',
    name: 'Накопитель Samsung 990 PRO',
    categoryId: references.storageCategoryId,
    manufacturerId: references.secondManufacturerId,
    supplierId: references.supplierId,
  });
  await createComponentFactory({
    sku: 'CPU-I7-12700',
    name: 'Процессор Intel Core i7-12700',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });

  const { agent } = await signInAs('analyst');

  const bySku = await agent.get('/components?q=SSD-990');
  assert.equal(bySku.status, 200);
  assert.match(bySku.text, /SSD-990-PRO/);
  assert.doesNotMatch(bySku.text, /CPU-I7-12700/);

  const byName = await agent.get('/components?q=Samsung');
  assert.equal(byName.status, 200);
  assert.match(byName.text, /SSD-990-PRO/);
  assert.doesNotMatch(byName.text, /CPU-I7-12700/);

  const byCategory = await agent.get(`/components?categoryId=${references.storageCategoryId}`);
  assert.equal(byCategory.status, 200);
  assert.match(byCategory.text, /SSD-990-PRO/);
  assert.doesNotMatch(byCategory.text, /CPU-I7-12700/);

  const byManufacturer = await agent.get(
    `/components?manufacturerId=${references.secondManufacturerId}`,
  );
  assert.equal(byManufacturer.status, 200);
  assert.match(byManufacturer.text, /SSD-990-PRO/);
  assert.doesNotMatch(byManufacturer.text, /CPU-I7-12700/);
});

test('catalog warehouse filter and stock status follow per-warehouse thresholds', async () => {
  const references = await seedReferences();
  const { minsk, gomel } = references.warehouses;

  const low = await createComponentFactory({
    sku: 'CPU-LOW-01',
    name: 'Процессор с дефицитом',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
    minStock: 5,
  });
  const healthy = await createComponentFactory({
    sku: 'CPU-OK-01',
    name: 'Процессор в норме',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
    minStock: 0,
  });
  await createComponentFactory({
    sku: 'CPU-EMPTY-01',
    name: 'Процессор без остатка',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
    minStock: 0,
  });
  const overstock = await createComponentFactory({
    sku: 'CPU-MAX-01',
    name: 'Процессор с избытком',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
    minStock: 0,
    maxStock: 4,
  });

  // 3 < min_stock 5 in Minsk, so the summary status is "below minimum" even
  // though Gomel has enough: the worst participating warehouse wins.
  await insertStock({ componentId: low.id, warehouseId: minsk.id, qty: 3 });
  await insertStock({ componentId: low.id, warehouseId: gomel.id, qty: 7 });
  await insertStock({ componentId: healthy.id, warehouseId: minsk.id, qty: 10 });
  await insertStock({ componentId: overstock.id, warehouseId: minsk.id, qty: 10 });

  const { agent } = await signInAs('analyst');

  const belowMin = await agent.get('/components?status=below_min');
  assert.equal(belowMin.status, 200);
  assert.match(belowMin.text, /CPU-LOW-01/);
  assert.match(belowMin.text, /Ниже минимума/);
  assert.doesNotMatch(belowMin.text, /CPU-OK-01/);
  assert.doesNotMatch(belowMin.text, /CPU-MAX-01/);

  const overstockRows = await agent.get('/components?status=overstock');
  assert.equal(overstockRows.status, 200);
  assert.match(overstockRows.text, /CPU-MAX-01/);
  assert.match(overstockRows.text, /Избыток/);
  assert.doesNotMatch(overstockRows.text, /CPU-LOW-01/);

  const zeroRows = await agent.get('/components?status=zero');
  assert.equal(zeroRows.status, 200);
  assert.match(zeroRows.text, /CPU-EMPTY-01/);
  assert.match(zeroRows.text, /Нет остатка/);
  assert.doesNotMatch(zeroRows.text, /CPU-LOW-01/);

  // The same component is healthy on the Gomel warehouse, which proves status
  // is computed for the selected warehouse rather than from the global total.
  const gomelHealthy = await agent.get(`/components?warehouseId=${gomel.id}&q=CPU-LOW-01`);
  assert.equal(gomelHealthy.status, 200);
  assert.match(gomelHealthy.text, /CPU-LOW-01/);
  assert.match(gomelHealthy.text, /В норме/);

  const minskLow = await agent.get(`/components?warehouseId=${minsk.id}&status=below_min`);
  assert.equal(minskLow.status, 200);
  assert.match(minskLow.text, /CPU-LOW-01/);
  assert.doesNotMatch(minskLow.text, /CPU-OK-01/);

  // A warehouse with no row for a position reads as zero, not as a missing
  // component: the filter still returns every component without stock there.
  const gomelZero = await agent.get(`/components?warehouseId=${gomel.id}&status=zero`);
  assert.equal(gomelZero.status, 200);
  assert.match(gomelZero.text, /CPU-EMPTY-01/);
  assert.doesNotMatch(gomelZero.text, /CPU-LOW-01/);

  // `ok` is not a filter value; an unknown status must fall back to the full
  // catalog instead of producing an empty page the user cannot explain.
  const invalidStatus = await agent.get('/components?status=not-a-status');
  assert.equal(invalidStatus.status, 200);
  assert.match(invalidStatus.text, /CPU-LOW-01/);
  assert.match(invalidStatus.text, /CPU-EMPTY-01/);
});

test('zero stock wins over below_min in the catalog summary and on the card', async () => {
  const references = await seedReferences();
  const { minsk, gomel } = references.warehouses;

  const zeroed = await createComponentFactory({
    sku: 'CPU-ZERO-01',
    name: 'Процессор опустошённый',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
    minStock: 5,
  });
  await insertStock({ componentId: zeroed.id, warehouseId: minsk.id, qty: 5 });
  await query(
    'update stock_batches set qty_remaining = 0 where component_id = $1 and warehouse_id = $2',
    [zeroed.id, minsk.id],
  );
  await query(
    `insert into stock_movements
       (component_id, warehouse_id, qty_delta, unit_cost, created_at)
     values ($1, $2, -5, '100.0000', '2026-11-06T10:00:00+03:00')`,
    [zeroed.id, minsk.id],
  );

  // A position with stock in Gomel but a zero-stock active warehouse in Minsk
  // must summarise as zero: the empty warehouse is the most severe status.
  const partial = await createComponentFactory({
    sku: 'CPU-PARTIAL-01',
    name: 'Процессор частично пустой',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
    minStock: 0,
  });
  await insertStock({ componentId: partial.id, warehouseId: gomel.id, qty: 4 });
  await query(
    `insert into stock_movements
       (component_id, warehouse_id, qty_delta, unit_cost, created_at)
     values
       ($1, $2, 2, '100.0000', '2026-11-05T10:00:00+03:00'),
       ($1, $2, -2, '100.0000', '2026-11-06T10:00:00+03:00')`,
    [partial.id, minsk.id],
  );

  const { agent } = await signInAs('analyst');

  const zeroList = await agent.get('/components?status=zero&q=CPU-ZERO-01');
  assert.equal(zeroList.status, 200);
  assert.match(zeroList.text, /CPU-ZERO-01/);
  assert.match(zeroList.text, /Нет остатка/);

  const partialZero = await agent.get('/components?status=zero&q=CPU-PARTIAL-01');
  assert.equal(partialZero.status, 200);
  assert.match(partialZero.text, /CPU-PARTIAL-01/);

  // Zero stock must not masquerade as below-minimum: the threshold is not the
  // reason the position needs attention.
  const belowMin = await agent.get('/components?status=below_min&q=CPU-ZERO-01');
  assert.equal(belowMin.status, 200);
  assert.doesNotMatch(belowMin.text, /Процессор опустошённый/);

  const card = await agent.get(`/components/${zeroed.id}`);
  assert.equal(card.status, 200);
  assert.match(card.text, /Центральный склад/);
  assert.match(card.text, /Нет остатка/);
});

test('catalog sorts by value descending', async () => {
  const references = await seedReferences();
  const { minsk } = references.warehouses;

  const small = await createComponentFactory({
    sku: 'CPU-SMALL-01',
    name: 'Альфа процессор',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });
  const large = await createComponentFactory({
    sku: 'CPU-LARGE-01',
    name: 'Бета процессор',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });

  await insertStock({
    componentId: small.id,
    warehouseId: minsk.id,
    qty: 2,
    unitCost: '1000.0000',
  });
  await insertStock({ componentId: large.id, warehouseId: minsk.id, qty: 7 });

  const { agent } = await signInAs('analyst');

  const byValue = await agent.get('/components?sort=value&dir=desc');
  assert.equal(byValue.status, 200);
  // Both rows appear; the more valuable position must be first. Comparing
  // positions keeps the assertion independent of the surrounding chrome.
  assert.ok(
    byValue.text.indexOf('CPU-SMALL-01') < byValue.text.indexOf('CPU-LARGE-01'),
    'a value-descending sort must put the 2 000 BYN position before the 700 BYN one',
  );
});

test('search treats LIKE wildcards as literal characters', async () => {
  const references = await seedReferences();
  await createComponentFactory({
    sku: 'CPU-PERCENT-01',
    name: 'Процессор со скидкой 100%',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });
  await createComponentFactory({
    sku: 'CPU-PLAIN-01',
    name: 'Обычный процессор',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });
  await createComponentFactory({
    sku: 'CPU_UNDERSCORE',
    name: 'Процессор с подчёркиванием',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });

  const { agent } = await signInAs('analyst');

  const percent = await agent.get('/components').query({ q: '%' });
  assert.equal(percent.status, 200);
  assert.match(percent.text, /CPU-PERCENT-01/);
  assert.doesNotMatch(percent.text, /CPU-PLAIN-01/);

  const underscore = await agent.get('/components').query({ q: '_' });
  assert.equal(underscore.status, 200);
  assert.match(underscore.text, /CPU_UNDERSCORE/);
  assert.doesNotMatch(underscore.text, /CPU-PLAIN-01/);

  // The stock-form type-ahead shares the same escaping helper.
  const search = await agent.get('/api/components/search').query({ q: '%' });
  assert.equal(search.status, 200);
  assert.deepEqual(
    search.body.map((item) => item.sku),
    ['CPU-PERCENT-01'],
  );
});

test('catalog paginates at 25 positions per page', async () => {
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

  const { agent } = await signInAs('analyst');

  const firstPage = await agent.get('/components');
  assert.equal(firstPage.status, 200);
  assert.match(firstPage.text, /Товар 01/);
  assert.doesNotMatch(firstPage.text, /Товар 26/);
  assert.match(firstPage.text, /страница 1 из 2/i);

  const secondPage = await agent.get('/components?page=2');
  assert.equal(secondPage.status, 200);
  assert.doesNotMatch(secondPage.text, /Товар 01/);
  assert.match(secondPage.text, /Товар 26/);

  const clamped = await agent.get('/components?page=999');
  assert.equal(clamped.status, 200);
  assert.match(clamped.text, /Товар 26/);
});

test('component card shows balances and values from the stock views', async () => {
  const references = await seedReferences();
  const { minsk, gomel } = references.warehouses;
  const component = await createComponentFactory({
    sku: 'CPU-CARD-01',
    name: 'Процессор для карточки',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
    purchasePrice: '850.00',
    retailPrice: '1099.90',
    minStock: 2,
  });

  await insertStock({
    componentId: component.id,
    warehouseId: minsk.id,
    qty: 10,
    unitCost: '100.0000',
  });
  await insertStock({
    componentId: component.id,
    warehouseId: gomel.id,
    qty: 5,
    unitCost: '200.0000',
  });

  const { agent } = await signInAs('analyst');
  const card = await agent.get(`/components/${component.id}`);

  assert.equal(card.status, 200);
  assert.match(card.text, /CPU-CARD-01/);
  assert.match(card.text, /Процессор для карточки/);
  assert.match(card.text, /Центральный склад/);
  assert.match(card.text, /Региональный склад Гомель/);
  // 10 * 100 + 5 * 200 = 2 000,00 BYN; the weighted average is 133,33.
  assert.match(card.text, /2 000,00/);
  assert.match(card.text, /133,33/);
  assert.match(card.text, /1 099,90/);
});

test('component card lists batches and movement history with warehouse and user', async () => {
  const references = await seedReferences();
  const { minsk } = references.warehouses;
  const component = await createComponentFactory({
    sku: 'CPU-HISTORY-01',
    name: 'Процессор с историей',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });
  const { agent, user } = await signInAs('storekeeper');

  const { rows: receipts } = await query(
    `insert into stock_documents
       (type, number, doc_date, supplier_id, warehouse_id, total_cost, created_by)
     values ('receipt', 'ПР-2026-0001', '2026-11-01', $1, $2, 8500, $3)
     returning id`,
    [references.supplierId, minsk.id, user.id],
  );

  await query(
    `insert into stock_batches
       (component_id, warehouse_id, supplier_id, unit_cost, qty_received, qty_remaining,
        received_at, document_no)
     values ($1, $2, $3, '850.0000', 10, 10, '2026-11-01', 'ПР-2026-0001')`,
    [component.id, minsk.id, references.supplierId],
  );
  await query(
    `insert into stock_movements
       (component_id, warehouse_id, qty_delta, unit_cost, document_id, created_at)
     values ($1, $2, 10, '850.0000', $3, '2026-11-01T10:30:00+03:00')`,
    [component.id, minsk.id, receipts[0].id],
  );
  await insertIssue({
    componentId: component.id,
    warehouseId: minsk.id,
    qty: 2,
    at: '2026-11-10T09:00:00+03:00',
    number: 'РС-2026-0001',
    userId: user.id,
  });

  const card = await agent.get(`/components/${component.id}`);

  assert.equal(card.status, 200);
  assert.match(card.text, /ПР-2026-0001/);
  assert.match(card.text, /РС-2026-0001/);
  assert.match(card.text, /Приёмка/);
  assert.match(card.text, /Расход/);
  assert.match(card.text, /ООО «ТестПоставка»/);
  assert.match(card.text, /Тестовый сотрудник/);
});

test('component card paginates the last 50 movements', async () => {
  const references = await seedReferences();
  const { minsk } = references.warehouses;
  const component = await createComponentFactory({
    sku: 'CPU-MANY-01',
    name: 'Процессор с длинной историей',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });

  await query(
    `insert into stock_movements (component_id, warehouse_id, qty_delta, unit_cost, created_at)
     select $1, $2, 1, '100.0000',
            timestamptz '2026-11-01 10:00:00+03' + (value || ' minutes')::interval
     from generate_series(1, 55) as value`,
    [component.id, minsk.id],
  );

  const { agent } = await signInAs('analyst');
  const firstPage = await agent.get(`/components/${component.id}`);
  assert.equal(firstPage.status, 200);
  assert.match(firstPage.text, /Движения: 55/);
  assert.match(firstPage.text, /Страница 1 из 2/);

  const secondPage = await agent.get(`/components/${component.id}?movementsPage=2`);
  assert.equal(secondPage.status, 200);
  assert.match(secondPage.text, /Страница 2 из 2/);
  // The warehouse visibility toggle must not send the reader back to page 1.
  assert.match(secondPage.text, /showAll=1&amp;movementsPage=2/);
});

test('component card caps the batch list at the most recent 200', async () => {
  const references = await seedReferences();
  const { minsk } = references.warehouses;
  const component = await createComponentFactory({
    sku: 'CPU-BATCHES-01',
    name: 'Процессор с длинной историей партий',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });

  await query(
    `insert into stock_batches
       (component_id, warehouse_id, unit_cost, qty_received, qty_remaining, received_at)
     select $1, $2, '100.0000', 1, 0, date '2026-01-01' + value
     from generate_series(1, 205) as value`,
    [component.id, minsk.id],
  );

  const { agent } = await signInAs('analyst');
  const card = await agent.get(`/components/${component.id}`);

  assert.equal(card.status, 200);
  assert.match(card.text, /Показаны последние 200 партий\./);
  // The five oldest batches are dropped; value 6 (7 January) is the oldest
  // visible row.
  assert.doesNotMatch(card.text, /06\.01\.2026/);
  assert.match(card.text, /07\.01\.2026/);
});

test('component card hides idle warehouses unless showAll is requested', async () => {
  const references = await seedReferences();
  const { minsk } = references.warehouses;
  const component = await createComponentFactory({
    sku: 'CPU-IDLE-01',
    name: 'Процессор на одном складе',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });

  await insertStock({
    componentId: component.id,
    warehouseId: minsk.id,
    qty: 4,
    unitCost: '100.0000',
  });

  const { agent } = await signInAs('analyst');

  const compact = await agent.get(`/components/${component.id}`);
  assert.equal(compact.status, 200);
  // Brest appears once in the consumption warehouse selector; the balance table
  // must still hide it until `showAll` is requested.
  assert.equal(compact.text.split('Региональный склад Брест').length - 1, 1);

  const full = await agent.get(`/components/${component.id}?showAll=1`);
  assert.equal(full.status, 200);
  assert.equal(full.text.split('Региональный склад Брест').length - 1, 2);
});

test('component card shows six-month consumption for all warehouses or one', async () => {
  const references = await seedReferences();
  const { minsk, gomel } = references.warehouses;
  const component = await createComponentFactory({
    sku: 'CPU-CONSUME-01',
    name: 'Процессор с расходом',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });
  const { agent, user } = await signInAs('analyst');

  await insertIssue({
    componentId: component.id,
    warehouseId: minsk.id,
    qty: 3,
    at: '2026-08-15T09:00:00+03:00',
    number: 'РС-2026-0002',
    userId: user.id,
  });
  await insertIssue({
    componentId: component.id,
    warehouseId: gomel.id,
    qty: 5,
    at: '2026-09-10T09:00:00+03:00',
    number: 'РС-2026-0003',
    userId: user.id,
  });

  const all = await agent.get(`/components/${component.id}`);
  assert.equal(all.status, 200);
  // Six buckets ending with the analytics reference month, not the real date.
  assert.match(all.text, /Расход по месяцам: все склады/);
  assert.match(all.text, /июнь 2026/);
  assert.match(all.text, /август 2026/);
  assert.match(all.text, /ноябрь 2026/);
  assert.match(all.text, /Итого за 6 месяцев: 8 шт/);
  assert.match(all.text, /aria-label="август 2026: 3 шт"/);
  assert.match(all.text, /aria-label="сентябрь 2026: 5 шт"/);

  const minskOnly = await agent.get(`/components/${component.id}?warehouseId=${minsk.id}`);
  assert.equal(minskOnly.status, 200);
  assert.match(minskOnly.text, /Расход по месяцам: Центральный склад/);
  assert.match(minskOnly.text, /Итого за 6 месяцев: 3 шт/);
  assert.doesNotMatch(minskOnly.text, /Итого за 6 месяцев: 8 шт/);

  const gomelOnly = await agent.get(`/components/${component.id}?warehouseId=${gomel.id}`);
  assert.equal(gomelOnly.status, 200);
  assert.match(gomelOnly.text, /Расход по месяцам: Региональный склад Гомель/);
  assert.match(gomelOnly.text, /Итого за 6 месяцев: 5 шт/);

  // A stale or malformed warehouse id falls back to every warehouse instead of
  // rendering an empty chart that looks like "no consumption".
  const invalid = await agent.get(`/components/${component.id}?warehouseId=999999`);
  assert.equal(invalid.status, 200);
  assert.match(invalid.text, /Расход по месяцам: все склады/);
  assert.match(invalid.text, /Итого за 6 месяцев: 8 шт/);

  const malformed = await agent.get(`/components/${component.id}?warehouseId=abc`);
  assert.equal(malformed.status, 200);
  assert.match(malformed.text, /Расход по месяцам: все склады/);
  assert.match(malformed.text, /Итого за 6 месяцев: 8 шт/);
});

test('unknown component returns a 404 page', async () => {
  await seedReferences();
  const { agent } = await signInAs('analyst');

  const response = await agent.get('/components/999999');
  assert.equal(response.status, 404);
  assert.match(response.text, /Позиция не найдена/);

  const malformed = await agent.get('/components/not-a-number');
  assert.equal(malformed.status, 404);
});

test('analyst can read the catalog and card but does not get stock actions', async () => {
  const references = await seedReferences();
  const component = await createComponentFactory({
    sku: 'CPU-ANALYST-01',
    name: 'Процессор для аналитика',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });

  const { agent } = await signInAs('analyst');

  const list = await agent.get('/components');
  assert.equal(list.status, 200);
  assert.match(list.text, /CPU-ANALYST-01/);

  const card = await agent.get(`/components/${component.id}`);
  assert.equal(card.status, 200);
  assert.doesNotMatch(card.text, /\/stock\/receipts\/new/);
  assert.doesNotMatch(card.text, /\/stock\/issues\/new/);
  assert.doesNotMatch(card.text, /\/stock\/transfers\/new/);
});

test('admin gets prefilled quick actions on the component card', async () => {
  const references = await seedReferences();
  const component = await createComponentFactory({
    sku: 'CPU-ACTION-01',
    name: 'Процессор для действий',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
  });

  const { agent } = await signInAs('admin');
  const card = await agent.get(`/components/${component.id}`);

  assert.equal(card.status, 200);
  assert.match(card.text, new RegExp(`/stock/receipts/new\\?componentId=${component.id}`));
  assert.match(card.text, new RegExp(`/stock/issues/new\\?componentId=${component.id}`));
  assert.match(card.text, new RegExp(`/stock/transfers/new\\?componentId=${component.id}`));
});

test('component search is authenticated, active-only and capped at 20 rows', async () => {
  const references = await seedReferences();

  for (let index = 1; index <= 25; index += 1) {
    const suffix = String(index).padStart(3, '0');
    await createComponentFactory({
      sku: `SRCH-${suffix}`,
      name: `Поисковый товар ${suffix}`,
      categoryId: references.categoryId,
      manufacturerId: references.manufacturerId,
      supplierId: references.supplierId,
    });
  }
  await createComponentFactory({
    sku: 'SRCH-ARCHIVED',
    name: 'Поисковый архивный товар',
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplierId,
    isActive: false,
  });

  const guest = createTestApp();
  const unauthorised = await guest.agent.get('/api/components/search').query({ q: 'Поисковый' });
  assert.equal(unauthorised.status, 401);
  assert.match(unauthorised.headers['content-type'], /application\/json/);

  const { agent } = await signInAs('analyst');
  const response = await agent.get('/api/components/search').query({ q: 'Поисковый' });

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /application\/json/);
  assert.ok(Array.isArray(response.body));
  assert.equal(response.body.length, 20);
  assert.equal(
    response.body.some((item) => item.sku === 'SRCH-ARCHIVED'),
    false,
    'archived positions must never reach stock forms',
  );

  const shape = response.body[0];
  assert.deepEqual(Object.keys(shape).sort(), ['id', 'name', 'sku']);

  const bySku = await agent.get('/api/components/search').query({ q: 'SRCH-001' });
  assert.equal(bySku.status, 200);
  assert.equal(bySku.body.length, 1);
  assert.equal(bySku.body[0].sku, 'SRCH-001');
});

test('catalog shows a human empty state when nothing matches', async () => {
  await seedReferences();
  const { agent } = await signInAs('analyst');

  const empty = await agent.get('/components');
  assert.equal(empty.status, 200);
  assert.match(empty.text, /Каталог пуст/);
  assert.match(empty.text, /Сбросить фильтры/);

  const noMatch = await agent.get('/components?q=нет-такого-sku');
  assert.equal(noMatch.status, 200);
  assert.match(noMatch.text, /Ничего не найдено/);
});

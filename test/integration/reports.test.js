import assert from 'node:assert/strict';
import test from 'node:test';
// Must stay first among local imports: it pins the analytics date before
// `src/config/env.js` is evaluated by the imports below.
import '../helpers/pin-analytics-date.js';
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

const PASSWORD = 'Reports!23456';

test.before(async () => {
  await setupTestDb();
});

test.beforeEach(async () => {
  await truncateAll();
});

test.after(async () => {
  await teardownTestDb();
});

/**
 * Minimal references for every report.
 *
 * The reference date is pinned to 2026-11-22. Batch and movement timestamps are
 * written explicitly so the default movement window and the analytics windows
 * never depend on the real clock.
 */
async function seedReferences() {
  const admin = await createUserFactory({
    email: 'admin@test.by',
    password: PASSWORD,
    role: 'admin',
    fullName: 'Алексей Ковалёв',
  });
  const analyst = await createUserFactory({
    email: 'analyst@test.by',
    password: PASSWORD,
    role: 'analyst',
    fullName: 'Дмитрий Лебедев',
  });
  const storekeeper = await createUserFactory({
    email: 'sklad@test.by',
    password: PASSWORD,
    role: 'storekeeper',
    fullName: 'Марина Сидорова',
  });
  const supplier = await createSupplierFactory({ unp: '190000921' });
  const warehouse = await createWarehouseFactory({
    code: 'WH-MSK',
    name: 'Центральный склад',
    city: 'Минск',
  });

  const { rows: categories } = await query(
    `insert into categories (name, slug) values ('Процессоры', 'processors') returning id, name`,
  );
  const { rows: manufacturers } = await query(
    `insert into manufacturers (name, country) values ('ТехноКорп', 'Беларусь') returning id`,
  );

  return {
    admin,
    analyst,
    storekeeper,
    supplier,
    warehouse,
    categoryId: categories[0].id,
    manufacturerId: manufacturers[0].id,
  };
}

function createComponent(references, overrides = {}) {
  return createComponentFactory({
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplier.id,
    ...overrides,
  });
}

/** A remaining batch plus its positive ledger movement. */
async function insertStock({ componentId, warehouseId, qty, unitCost = '1234.5000' }) {
  const { rows } = await query(
    `insert into stock_batches
       (component_id, warehouse_id, unit_cost, qty_received, qty_remaining, received_at)
     values ($1, $2, $3, $4, $4, '2026-11-01')
     returning id`,
    [componentId, warehouseId, unitCost, qty],
  );
  await query(
    `insert into stock_movements
       (component_id, warehouse_id, qty_delta, unit_cost, created_at)
     values ($1, $2, $3, $4, '2026-11-01T10:00:00+03:00')`,
    [componentId, warehouseId, qty, unitCost],
  );
  return rows[0].id;
}

/** An issue document with a negative movement, i.e. real consumption. */
async function insertIssue({ componentId, warehouseId, qty, at, userId, number, batchId = null }) {
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
  if (batchId !== null) {
    await query('update stock_batches set qty_remaining = qty_remaining - $2 where id = $1', [
      batchId,
      qty,
    ]);
  }
}

async function signIn(user) {
  const { agent } = createTestApp();
  await loginAs(agent, user.email, PASSWORD);
  return agent;
}

function assertCsvResponse(response, filename) {
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/csv; charset=utf-8$/);
  assert.equal(response.headers['content-disposition'], `attachment; filename="${filename}"`);
  assert.ok(response.text.startsWith('\uFEFF'), 'CSV must start with a UTF-8 BOM');
  assert.ok(response.text.includes('\r\n'), 'CSV must use CRLF line endings');
}

/** One component with stock, one issue inside the default window and an inventory act. */
async function seedReportData(references) {
  const component = await createComponent(references, {
    sku: 'RPT-CPU',
    name: 'Процессор отчётный',
    minStock: 5,
    maxStock: 100,
  });
  const batchId = await insertStock({
    componentId: component.id,
    warehouseId: references.warehouse.id,
    qty: 14,
    unitCost: '1234.5000',
  });
  await insertIssue({
    componentId: component.id,
    warehouseId: references.warehouse.id,
    qty: 2,
    at: '2026-11-20T10:30:00+03:00',
    userId: references.analyst.id,
    number: 'РС-2026-0001',
    batchId,
  });

  const second = await createComponent(references, {
    sku: 'INV-LINE-02',
    name: 'Позиция вторая',
  });

  const { rows: counts } = await query(
    `insert into inventory_counts (warehouse_id, status, started_by, created_at)
     values ($1, 'submitted', $2, '2026-11-20T09:00:00+03:00')
     returning id`,
    [references.warehouse.id, references.storekeeper.id],
  );
  const countId = counts[0].id;
  await query(
    `insert into inventory_lines
       (count_id, component_id, expected_qty, actual_qty, difference, unit_cost, comment)
     values
       ($1, $2, 3, null, null, '100.0000', null),
       ($1, $3, 3, 5, 2, '100.0000', 'Нашли на полке')`,
    [countId, component.id, second.id],
  );

  return { component, second, countId };
}

test('reports page lists every CSV card and hides audit from non-admins', async () => {
  const references = await seedReferences();
  await seedReportData(references);

  const analyst = await signIn(references.analyst);
  const page = await analyst.get('/reports');
  assert.equal(page.status, 200);
  assert.match(page.text, /Отчёты/);
  assert.match(page.text, /Экспорт данных/);
  for (const type of ['stock', 'movements', 'abc', 'xyz', 'reorder', 'inventory']) {
    assert.match(page.text, new RegExp(`/reports/export/${type}`));
  }
  assert.doesNotMatch(page.text, /\/reports\/export\/audit/);
  assert.match(page.text, /name="dateFrom"/);
  assert.match(page.text, /name="countId"/);

  // Every authenticated role sees the reports entry in the navigation.
  const dashboard = await analyst.get('/dashboard');
  assert.match(dashboard.text, /href="\/reports"/);

  const admin = await signIn(references.admin);
  const adminPage = await admin.get('/reports');
  assert.equal(adminPage.status, 200);
  assert.match(adminPage.text, /\/reports\/export\/audit/);
});

test('stock export renders balances with Russian money and grouped quantities', async () => {
  const references = await seedReferences();
  await seedReportData(references);

  const analyst = await signIn(references.analyst);
  const response = await analyst.get('/reports/export/stock');

  assertCsvResponse(response, 'motherload-stock-2026-11-22.csv');
  assert.match(response.text, /Артикул;Название;Категория;Склад;Остаток;Ед\./);
  assert.match(
    response.text,
    /RPT-CPU;Процессор отчётный;Процессоры;Центральный склад;12;шт;1 234,50;14 814,00;5;100/,
  );

  const storekeeper = await signIn(references.storekeeper);
  const byStorekeeper = await storekeeper.get('/reports/export/stock');
  assert.equal(byStorekeeper.status, 200);
});

test('movements export respects the date range and keeps the ledger readable', async () => {
  const references = await seedReferences();
  const component = await createComponent(references, {
    sku: 'MOV-CPU',
    name: 'Процессор движения',
  });
  await insertIssue({
    componentId: component.id,
    warehouseId: references.warehouse.id,
    qty: 2,
    at: '2026-11-20T10:30:00+03:00',
    userId: references.analyst.id,
    number: 'РС-2026-0007',
  });
  await insertIssue({
    componentId: component.id,
    warehouseId: references.warehouse.id,
    qty: 99,
    at: '2026-09-01T10:30:00+03:00',
    userId: references.analyst.id,
    number: 'РС-2026-0008',
  });

  const analyst = await signIn(references.analyst);
  const response = await analyst.get(
    '/reports/export/movements?dateFrom=2026-11-19&dateTo=2026-11-21',
  );

  assertCsvResponse(response, 'motherload-movements-2026-11-21.csv');
  assert.match(response.text, /Дата и время;Тип;Документ;Артикул;Позиция;Склад;Количество/);
  assert.match(response.text, /20\.11\.2026 10:30;Расход;РС-2026-0007;MOV-CPU;Процессор движения/);
  assert.doesNotMatch(response.text, /РС-2026-0008/);

  // Without query parameters the page default of the last 30 days applies.
  const defaultRange = await analyst.get('/reports/export/movements');
  assertCsvResponse(defaultRange, 'motherload-movements-2026-11-22.csv');
  assert.match(defaultRange.text, /РС-2026-0007/);
  assert.doesNotMatch(defaultRange.text, /РС-2026-0008/);
});

test('ABC, XYZ and reorder exports reuse the analytics read models', async () => {
  const references = await seedReferences();
  await seedReportData(references);
  const analyst = await signIn(references.analyst);

  const abc = await analyst.get('/reports/export/abc');
  assertCsvResponse(abc, 'motherload-abc-2026-11-22.csv');
  assert.match(
    abc.text,
    /Место;Артикул;Название;Категория;Остаток;Ед\.;Стоимость, BYN;Доля, %;Накопленная доля, %;Класс/,
  );
  assert.match(abc.text, /1;RPT-CPU;Процессор отчётный;Процессоры;12;шт;14 814,00;100,00;100,00;C/);

  const xyz = await analyst.get('/reports/export/xyz');
  assertCsvResponse(xyz, 'motherload-xyz-2026-11-22.csv');
  assert.match(xyz.text, /май 2026;июнь 2026;июль 2026;август 2026;сентябрь 2026;октябрь 2026/);
  assert.match(xyz.text, /RPT-CPU;Процессор отчётный;Процессоры;0;0;0;0;0;0;0/);

  const reorder = await analyst.get('/reports/export/reorder');
  assertCsvResponse(reorder, 'motherload-reorder-2026-11-22.csv');
  assert.match(reorder.text, /Средний расход;Страховой запас;ROP;EOQ;Заказать/);
  assert.match(reorder.text, /RPT-CPU;Процессор отчётный;Процессоры;1;/);
  assert.match(reorder.text, /Мало данных|Нет остатка|Ниже точки заказа|В норме/);
});

test('inventory export renders one act by count id and leaves an empty fact blank', async () => {
  const references = await seedReferences();
  const { countId } = await seedReportData(references);
  const analyst = await signIn(references.analyst);

  const response = await analyst.get(`/reports/export/inventory?countId=${countId}`);

  assertCsvResponse(response, 'motherload-inventory-2026-11-22.csv');
  assert.match(response.text, /Документ;Артикул;Название;Склад;Учёт;Факт;Разница/);
  assert.match(
    response.text,
    new RegExp(`ИНВ-2026-0001;RPT-CPU;Процессор отчётный;Центральный склад;3;;;`),
  );
  assert.match(
    response.text,
    /INV-LINE-02;Позиция вторая;Центральный склад;3;5;2;100,00;200,00;Нашли на полке/,
  );

  const missing = await analyst.get('/reports/export/inventory');
  assert.equal(missing.status, 400);
  assert.match(missing.text, /Укажите номер инвентаризации/);

  const absent = await analyst.get('/reports/export/inventory?countId=999');
  assert.equal(absent.status, 404);
  assert.match(absent.text, /Инвентаризация не найдена/);
});

test('audit export is admin-only and every export writes an audit row', async () => {
  const references = await seedReferences();
  await seedReportData(references);

  const analyst = await signIn(references.analyst);
  const forbidden = await analyst.get('/reports/export/audit');
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.text, /доступен только администратору/);

  await analyst.get('/reports/export/stock');

  const admin = await signIn(references.admin);
  const response = await admin.get('/reports/export/audit');
  assertCsvResponse(response, 'motherload-audit-2026-11-22.csv');
  assert.match(response.text, /Дата и время;Пользователь;Email;Действие;Тип сущности;ID;IP;Детали/);
  assert.match(response.text, /report\.export/);

  const { rows } = await query(
    `select action, entity_type, entity_id, details, user_id
     from audit_log
     where action = 'report.export'
     order by id`,
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => [row.entity_type, row.entity_id, row.details.type]),
    [
      ['report', 'stock', 'stock'],
      ['report', 'audit', 'audit'],
    ],
  );
  assert.equal(rows[0].user_id, references.analyst.id);
  assert.equal(rows[1].user_id, references.admin.id);
  assert.deepEqual(rows[0].details.filters, {});
});

test('an unknown report type is a 404, not a 500', async () => {
  const references = await seedReferences();
  const analyst = await signIn(references.analyst);

  const response = await analyst.get('/reports/export/unknown');
  assert.equal(response.status, 404);
  assert.match(response.text, /Отчёт не найден/);
});

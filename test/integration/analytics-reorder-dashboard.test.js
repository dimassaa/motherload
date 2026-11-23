import assert from 'node:assert/strict';
import test from 'node:test';
// Must stay first among local imports: it pins the analytics date before
// `src/config/env.js` is evaluated by the imports below.
import '../helpers/pin-analytics-date.js';
import { query } from '../../src/db/pool.js';
import { getDashboard, getReorder } from '../../src/services/analytics.js';
import { createTestApp } from '../helpers/app.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';
import {
  createComponentFactory,
  createSupplierFactory,
  createUserFactory,
  createWarehouseFactory,
} from '../helpers/factories.js';
import { loginAs } from '../helpers/http.js';

const PASSWORD = 'Analytics!23456';

// The reference date is pinned to 22.11.2026, so the 90-day demand window is
// 25.08.2026–22.11.2026 inclusive. Every fixture writes explicit timestamps
// instead of relying on the real clock.
const REFERENCE = '2026-11-22';
const WINDOW_START = '2026-08-25';

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
 * Reference rows shared by the scenarios below.
 *
 * The categories match the real demo vocabulary so the rendered page and the
 * chart labels read like the product, not like test scaffolding.
 */
async function seedReferences() {
  const user = await createUserFactory({
    email: 'analyst@test.by',
    password: PASSWORD,
    role: 'analyst',
  });
  const supplier = await createSupplierFactory({ unp: '190000911', leadTimeDays: 5 });
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

  const { rows: categories } = await query(
    `insert into categories (name, slug) values
       ('Процессоры', 'processors'),
       ('Накопители', 'storage')
     returning id, name`,
  );
  const { rows: manufacturers } = await query(
    `insert into manufacturers (name, country) values ('ТехноКорп', 'Беларусь') returning id`,
  );

  const categoryByName = Object.fromEntries(categories.map((row) => [row.name, row.id]));

  return {
    user,
    supplier,
    minsk,
    gomel,
    categoryId: categoryByName['Процессоры'],
    storageCategoryId: categoryByName['Накопители'],
    manufacturerId: manufacturers[0].id,
  };
}

function createComponent(references, overrides) {
  return createComponentFactory({
    categoryId: references.categoryId,
    manufacturerId: references.manufacturerId,
    supplierId: references.supplier.id,
    ...overrides,
  });
}

/**
 * Write a receipt batch plus its positive ledger movement.
 *
 * `qtyReceived` and `qtyRemaining` are separate on purpose: a scenario with
 * 90 days of demand needs a receipt large enough to fund it while the batch
 * that survives today is only what the FIFO consumption left behind.
 */
async function insertReceipt({
  componentId,
  warehouseId,
  qtyReceived,
  qtyRemaining = qtyReceived,
  unitCost = '100.0000',
  receivedAt = '2026-08-01',
}) {
  await query(
    `insert into stock_batches
       (component_id, warehouse_id, unit_cost, qty_received, qty_remaining, received_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [componentId, warehouseId, unitCost, qtyReceived, qtyRemaining, receivedAt],
  );
  await query(
    `insert into stock_movements
       (component_id, warehouse_id, qty_delta, unit_cost, created_at)
     values ($1, $2, $3, $4, $5::timestamptz)`,
    [componentId, warehouseId, qtyReceived, unitCost, `${receivedAt}T10:00:00+03:00`],
  );
}

let issueSequence = 0;

/** Insert an issue document and the matching negative ledger movement. */
async function insertIssue({ componentId, warehouseId, qty, at, userId, unitCost = '100.0000' }) {
  issueSequence += 1;
  const number = `РС-Т19-${String(issueSequence).padStart(4, '0')}`;
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
     values ($1, $2, $3, $4, $5, $6::timestamptz)`,
    [componentId, warehouseId, -qty, unitCost, rows[0].id, at],
  );
}

/** A 2-unit issue on each of the 90 days in the demand window. */
async function insertDailyDemand({ componentId, warehouseId, quantity, userId }) {
  const [year, month, day] = WINDOW_START.split('-').map(Number);
  const start = Date.UTC(year, month - 1, day);

  for (let index = 0; index < 90; index += 1) {
    const calendar = new Date(start + index * 24 * 60 * 60 * 1000);
    const iso = calendar.toISOString().slice(0, 10);
    await insertIssue({
      componentId,
      warehouseId,
      qty: quantity,
      at: `${iso}T10:00:00+03:00`,
      userId,
    });
  }
}

/**
 * The predictable component of this file:
 * 2 units/day for 90 days, 5-day lead time, unit cost 100, balance 5.
 *
 * avgDaily = 2, stddev = 0, safety = 0, ROP = 10,
 * EOQ = sqrt(2 * 730 * 50 / (100 * 0.20)) = 60.42, suggested = ceil(EOQ) = 61.
 */
async function seedSteadyDemand(references) {
  const component = await createComponent(references, {
    sku: 'CPU-ROP-01',
    name: 'Процессор с точкой заказа',
    minStock: 0,
  });
  await insertReceipt({
    componentId: component.id,
    warehouseId: references.minsk.id,
    qtyReceived: 185,
    qtyRemaining: 5,
  });
  await insertDailyDemand({
    componentId: component.id,
    warehouseId: references.minsk.id,
    quantity: 2,
    userId: references.user.id,
  });
  return component;
}

async function signInAsAnalyst(references) {
  const { agent } = createTestApp();
  await loginAs(agent, references.user.email, PASSWORD);
  return agent;
}

test('reorder row shows ROP, safety stock and suggested quantity', async () => {
  const references = await seedReferences();
  const component = await seedSteadyDemand(references);

  const { rows, window } = await getReorder({ warehouseId: references.minsk.id });

  assert.equal(window.start, WINDOW_START);
  assert.equal(window.end, REFERENCE);
  assert.equal(window.days, 90);

  const row = rows.find((item) => item.componentId === component.id);
  assert.ok(row, 'the participating component must be listed');
  assert.equal(row.sku, 'CPU-ROP-01');
  assert.equal(row.warehouse.warehouseId, references.minsk.id);
  assert.equal(row.balance, 5);
  assert.equal(row.avgDaily, 2);
  assert.equal(row.stddev, 0);
  assert.equal(row.safetyStock, 0);
  assert.equal(row.rop, 10);
  assert.equal(row.eoq, 60.42);
  assert.equal(row.suggested, 61);
  assert.equal(row.lowData, false);
  assert.equal(row.status, 'below_rop');

  // A warehouse with no stock and no movement must not create a phantom row.
  const gomel = await getReorder({ warehouseId: references.gomel.id });
  assert.deepEqual(gomel.rows, []);

  // Without a warehouse filter the pairs are aggregated: ROP and suggested are
  // summed, EOQ is the maximum of one order size, never a sum.
  const aggregated = await getReorder({});
  assert.equal(aggregated.rows.length, 1);
  assert.equal(aggregated.rows[0].balance, 5);
  assert.equal(aggregated.rows[0].rop, 10);
  assert.equal(aggregated.rows[0].suggested, 61);
  assert.equal(aggregated.rows[0].eoq, 60.42);
  assert.equal(aggregated.rows[0].warehouses.length, 1);

  const byCategory = await getReorder({ categoryId: references.storageCategoryId });
  assert.deepEqual(byCategory.rows, []);
});

test('reorder marks a position with thin history as low data', async () => {
  const references = await seedReferences();
  const component = await createComponent(references, {
    sku: 'CPU-NEW-01',
    name: 'Новая позиция',
    minStock: 12,
  });
  await insertReceipt({
    componentId: component.id,
    warehouseId: references.minsk.id,
    qtyReceived: 6,
    qtyRemaining: 4,
    receivedAt: '2026-11-10',
  });
  // Only four calendar days of demand history: below the 14-day trust floor.
  await insertIssue({
    componentId: component.id,
    warehouseId: references.minsk.id,
    qty: 2,
    at: '2026-11-19T10:00:00+03:00',
    userId: references.user.id,
  });

  const { rows } = await getReorder({});
  const row = rows.find((item) => item.componentId === component.id);
  assert.ok(row);
  assert.equal(row.lowData, true);
  // Fallback from §6.6: ROP = min_stock, suggested tops the balance up to it.
  assert.equal(row.rop, 12);
  assert.equal(row.suggested, 8);
  assert.equal(row.balance, 4);

  const agent = await signInAsAnalyst(references);
  const page = await agent.get('/analytics/reorder');
  assert.equal(page.status, 200);
  assert.match(page.text, /Точка заказа/);
  assert.match(page.text, /CPU-NEW-01/);
  assert.match(page.text, /мало данных/);
  assert.match(page.text, /1,645/);
  assert.match(page.text, /90 дней/);
  assert.doesNotMatch(page.text, /NaN/);
});

test('dashboard KPI cards, attention table, matrix and feed render', async () => {
  const references = await seedReferences();
  const steady = await seedSteadyDemand(references);

  // No issues ever: the whole batch value is dead stock, and a zero min_stock
  // keeps it out of the below-ROP attention list.
  const dead = await createComponent(references, {
    sku: 'SSD-DEAD-01',
    name: 'Накопитель без расхода',
    categoryId: references.storageCategoryId,
    minStock: 0,
  });
  await insertReceipt({
    componentId: dead.id,
    warehouseId: references.minsk.id,
    qtyReceived: 10,
    qtyRemaining: 10,
    unitCost: '50.0000',
    receivedAt: '2026-11-01',
  });

  const { kpis, categoryValues, attention, matrix, recentMovements } = await getDashboard();

  assert.equal(kpis.stockValue, '1000.0000');
  assert.equal(kpis.cogs90, '18000.0000');
  assert.equal(kpis.deadValue, '500.0000');
  assert.equal(kpis.belowRopCount, 1);
  assert.equal(kpis.turnoverYear, 72);
  assert.equal(kpis.coverageDays, 5);

  assert.equal(categoryValues.length, 2);
  assert.equal(categoryValues.find((item) => item.name === 'Процессоры').value, '500.0000');
  assert.equal(categoryValues.find((item) => item.name === 'Накопители').value, '500.0000');

  assert.equal(attention.length, 1);
  assert.equal(attention[0].sku, 'CPU-ROP-01');
  assert.equal(attention[0].warehouseName, 'Центральный склад');
  assert.equal(attention[0].balance, 5);
  assert.equal(attention[0].rop, 10);
  assert.equal(attention[0].suggested, 61);

  assert.equal(matrix.total, 2);
  const cell = (abc, xyz) =>
    matrix.rows.find((row) => row.abc === abc).cells.find((item) => item.xyz === xyz).count;
  // Equal values put the first position at 50 % (A) and the second at 100 %
  // (C, since it crosses the 95 % boundary). Both have no steady demand, so the
  // matrix cell is Z.
  assert.equal(cell('A', 'Z'), 1);
  assert.equal(cell('C', 'Z'), 1);
  assert.equal(cell('B', 'Z'), 0);

  assert.equal(recentMovements.length, 8);
  assert.equal(recentMovements[0].componentName, steady.name);
  assert.equal(recentMovements[0].documentType, 'issue');
  assert.equal(recentMovements[0].qtyDelta, -2);

  const agent = await signInAsAnalyst(references);
  const page = await agent.get('/dashboard');
  assert.equal(page.status, 200);
  assert.match(page.text, /Обзор склада/);
  assert.match(page.text, /Стоимость запасов/);
  assert.match(page.text, /Позиций ниже ROP/);
  assert.match(page.text, /Стоимость неликвидов/);
  assert.match(page.text, /Оборачиваемость за 90 дней/);
  assert.match(page.text, /1 000,00/);
  assert.match(page.text, /500,00/);
  assert.match(page.text, /72,00/);
  assert.match(page.text, /Требуют внимания/);
  assert.match(page.text, /CPU-ROP-01/);
  assert.match(page.text, /61/);
  assert.match(page.text, /Матрица ABC × XYZ/);
  assert.match(page.text, /Последние движения/);
  assert.match(page.text, /Центральный склад/);
  assert.match(page.text, /data-chart="/);
  assert.match(page.text, /\/js\/charts\.js/);
  assert.match(page.text, /href="\/analytics\/reorder"/);
  assert.match(page.text, /href="\/analytics\/abc"/);
  assert.match(page.text, /href="\/analytics\/xyz"/);
  assert.doesNotMatch(page.text, /NaN/);
});

test('dashboard and reorder are empty-safe on a fresh database', async () => {
  const references = await seedReferences();

  const { kpis, categoryValues, attention, matrix, recentMovements } = await getDashboard();
  assert.equal(kpis.stockValue, '0.0000');
  assert.equal(kpis.cogs90, '0.0000');
  assert.equal(kpis.deadValue, '0.0000');
  assert.equal(kpis.belowRopCount, 0);
  assert.equal(kpis.turnoverYear, null);
  assert.equal(kpis.coverageDays, null);
  assert.deepEqual(categoryValues, []);
  assert.deepEqual(attention, []);
  assert.equal(matrix.total, 0);
  assert.deepEqual(recentMovements, []);

  const reorder = await getReorder({});
  assert.deepEqual(reorder.rows, []);

  const agent = await signInAsAnalyst(references);

  const dashboard = await agent.get('/dashboard');
  assert.equal(dashboard.status, 200);
  assert.doesNotMatch(dashboard.text, /NaN/);
  assert.doesNotMatch(dashboard.text, /data-chart/);
  assert.doesNotMatch(dashboard.text, /\/js\/charts\.js/);
  assert.match(dashboard.text, /Пока нет движений/);
  assert.match(dashboard.text, /нет данных/);

  const reorderPage = await agent.get('/analytics/reorder');
  assert.equal(reorderPage.status, 200);
  assert.doesNotMatch(reorderPage.text, /NaN/);
  assert.match(reorderPage.text, /Нет данных для планирования закупок/);
});

test('analyst can read dashboard and reorder while guests are redirected', async () => {
  const references = await seedReferences();
  await seedSteadyDemand(references);

  const agent = await signInAsAnalyst(references);
  const dashboard = await agent.get('/dashboard');
  assert.equal(dashboard.status, 200);
  const reorder = await agent.get('/analytics/reorder');
  assert.equal(reorder.status, 200);
  assert.match(reorder.text, /href="\/analytics\/abc"/);
  assert.match(reorder.text, /href="\/analytics\/xyz"/);
  // The reorder table is the product; it must not download the chart bundle.
  assert.doesNotMatch(reorder.text, /\/js\/charts\.js/);

  const guest = createTestApp().agent;
  const deniedDashboard = await guest.get('/dashboard');
  assert.equal(deniedDashboard.status, 302);
  assert.equal(deniedDashboard.headers.location, '/');
  const deniedReorder = await guest.get('/analytics/reorder');
  assert.equal(deniedReorder.status, 302);
  assert.equal(deniedReorder.headers.location, '/');
});

test('catalog below_rop filter uses the reorder calculation and keeps other statuses', async () => {
  const references = await seedReferences();
  await seedSteadyDemand(references);

  // Positive balance and no demand: min_stock is 0, so ROP is 0 and the row is
  // healthy even though it never sold.
  const healthy = await createComponent(references, {
    sku: 'CPU-OK-01',
    name: 'Процессор в норме',
    minStock: 0,
  });
  await insertReceipt({
    componentId: healthy.id,
    warehouseId: references.minsk.id,
    qtyReceived: 100,
    qtyRemaining: 100,
  });

  // Fully consumed position: stock status stays `zero`, while the below-ROP
  // filter uses the reorder point, not the stock chip.
  const empty = await createComponent(references, {
    sku: 'CPU-ZERO-01',
    name: 'Процессор без остатка',
    minStock: 0,
  });
  await insertReceipt({
    componentId: empty.id,
    warehouseId: references.minsk.id,
    qtyReceived: 5,
    qtyRemaining: 0,
    receivedAt: '2026-11-01',
  });
  await insertIssue({
    componentId: empty.id,
    warehouseId: references.minsk.id,
    qty: 5,
    at: '2026-11-20T10:00:00+03:00',
    userId: references.user.id,
  });

  const agent = await signInAsAnalyst(references);

  const belowRop = await agent.get('/components?status=below_rop');
  assert.equal(belowRop.status, 200);
  assert.match(belowRop.text, /CPU-ROP-01/);
  assert.doesNotMatch(belowRop.text, /CPU-OK-01/);
  // The fully consumed position has no threshold (min_stock 0) and its first
  // issue is only days old, so the low-data fallback keeps ROP at 0 and it is
  // not in the below-ROP list; the stock-status filter still reaches it.
  assert.doesNotMatch(belowRop.text, /CPU-ZERO-01/);

  const zero = await agent.get('/components?status=zero');
  assert.equal(zero.status, 200);
  assert.match(zero.text, /CPU-ZERO-01/);
  assert.doesNotMatch(zero.text, /CPU-ROP-01/);
  assert.doesNotMatch(zero.text, /CPU-OK-01/);

  // A stale or unknown status still falls back to the full catalog.
  const fallback = await agent.get('/components?status=not-a-status');
  assert.equal(fallback.status, 200);
  assert.match(fallback.text, /CPU-ROP-01/);
  assert.match(fallback.text, /CPU-OK-01/);
});

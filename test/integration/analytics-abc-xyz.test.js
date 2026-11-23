import assert from 'node:assert/strict';
import test from 'node:test';
// Must stay first among local imports: it pins the analytics date before
// `src/config/env.js` is evaluated by the imports below.
import '../helpers/pin-analytics-date.js';
import { query } from '../../src/db/pool.js';
import { getAbc, getXyz } from '../../src/services/analytics.js';
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
 * Reference data shared by the analytics scenarios.
 *
 * The reference date is pinned by `ANALYTICS_REFERENCE_DATE=2026-11-22`, so the
 * XYZ window is May–October 2026. Tests write movement timestamps explicitly
 * instead of relying on the real clock.
 */
async function seedReferences() {
  const user = await createUserFactory({
    email: 'analyst@test.by',
    password: PASSWORD,
    role: 'analyst',
  });
  const supplier = await createSupplierFactory({ unp: '190000902' });
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
 * Write a batch and its positive ledger movement. ABC reads `qty_remaining`;
 * XYZ inclusion reads both the batch and the movement ledger.
 */
async function insertStock({ componentId, warehouseId, qty, unitCost = '100.0000' }) {
  await query(
    `insert into stock_batches
       (component_id, warehouse_id, unit_cost, qty_received, qty_remaining, received_at)
     values ($1, $2, $3, $4, $4, '2026-11-01')`,
    [componentId, warehouseId, unitCost, qty],
  );
  await query(
    `insert into stock_movements
       (component_id, warehouse_id, qty_delta, unit_cost, created_at)
     values ($1, $2, $3, $4, '2026-11-01T10:00:00+03:00')`,
    [componentId, warehouseId, qty, unitCost],
  );
}

let issueSequence = 0;

/** Insert an issue document and its negative movement, i.e. real consumption. */
async function insertIssue({ componentId, warehouseId, qty, at, userId }) {
  issueSequence += 1;
  const number = `РС-2026-${String(issueSequence).padStart(4, '0')}`;
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

async function signInAsAnalyst(references) {
  const { agent } = createTestApp();
  await loginAs(agent, references.user.email, PASSWORD);
  return agent;
}

test('ABC ranks by stock value from batches and respects warehouse filter', async () => {
  const references = await seedReferences();
  const { minsk, gomel } = references;

  // 1 000 / 600 / 300 / 100: the first two cross the 80 % boundary together,
  // so the cumulative rule produces A, A, B, C without rounding luck.
  const values = [
    { sku: 'ABC-P1', value: 1000, unitCost: '100.0000' },
    { sku: 'ABC-P2', value: 600, unitCost: '60.0000' },
    { sku: 'ABC-P3', value: 300, unitCost: '30.0000' },
    { sku: 'ABC-P4', value: 100, unitCost: '10.0000' },
  ];
  const components = [];
  for (const item of values) {
    const component = await createComponent(references, {
      sku: item.sku,
      name: `Позиция ${item.sku}`,
    });
    await insertStock({
      componentId: component.id,
      warehouseId: minsk.id,
      qty: 10,
      unitCost: item.unitCost,
    });
    components.push(component);
  }

  // A much more valuable position on another warehouse must not leak into a
  // filtered selection.
  const gomelComponent = await createComponent(references, {
    sku: 'ABC-GOMEL',
    name: 'Позиция ABC-GOMEL',
  });
  await insertStock({
    componentId: gomelComponent.id,
    warehouseId: gomel.id,
    qty: 10,
    unitCost: '500.0000',
  });

  const { rows, summary } = await getAbc({ warehouseId: minsk.id });

  assert.deepEqual(
    rows.map((row) => row.sku),
    ['ABC-P1', 'ABC-P2', 'ABC-P3', 'ABC-P4'],
  );
  assert.deepEqual(
    rows.map((row) => row.class),
    ['A', 'A', 'B', 'C'],
  );
  assert.deepEqual(
    rows.map((row) => row.rank),
    [1, 2, 3, 4],
  );
  assert.equal(rows[0].value, '1000.0000');
  assert.equal(rows[0].share, 0.5);
  assert.equal(rows[1].cumulativeShare, 0.8);
  assert.equal(rows[2].cumulativeShare, 0.95);
  assert.equal(rows[3].cumulativeShare, 1);

  assert.deepEqual(
    [summary.A.count, summary.A.value, summary.B.count, summary.B.value],
    [2, '1600.0000', 1, '300.0000'],
  );
  assert.deepEqual(
    [summary.C.count, summary.C.value, summary.total.count, summary.total.value],
    [1, '100.0000', 4, '2000.0000'],
  );

  const allWarehouses = await getAbc({});
  assert.equal(allWarehouses.rows.length, 5);
  assert.equal(allWarehouses.rows[0].sku, 'ABC-GOMEL');
  assert.equal(allWarehouses.summary.total.value, '7000.0000');

  const storage = await createComponent(references, {
    sku: 'ABC-STORAGE',
    name: 'Накопитель тестовый',
    categoryId: references.storageCategoryId,
  });
  await insertStock({
    componentId: storage.id,
    warehouseId: minsk.id,
    qty: 5,
    unitCost: '10.0000',
  });

  const byCategory = await getAbc({
    warehouseId: minsk.id,
    categoryId: references.storageCategoryId,
  });
  assert.deepEqual(
    byCategory.rows.map((row) => row.sku),
    ['ABC-STORAGE'],
  );
});

test('ABC guards a zero total from NaN and renders it as class C', async () => {
  const references = await seedReferences();
  const zeroCost = await createComponent(references, {
    sku: 'ABC-ZERO',
    name: 'Бесплатная позиция',
  });
  await insertStock({
    componentId: zeroCost.id,
    warehouseId: references.minsk.id,
    qty: 5,
    unitCost: '0.0000',
  });

  const { rows, summary } = await getAbc({});

  assert.equal(rows.length, 1);
  assert.equal(rows[0].class, 'C');
  assert.equal(rows[0].share, 0);
  assert.equal(rows[0].cumulativeShare, 0);
  assert.equal(rows[0].value, '0.0000');
  assert.equal(summary.total.value, '0.0000');
  assert.equal(summary.A.count, 0);
  assert.equal(summary.B.count, 0);
  assert.equal(summary.C.count, 1);

  const agent = await signInAsAnalyst(references);
  const page = await agent.get('/analytics/abc');
  assert.equal(page.status, 200);
  assert.match(page.text, /ABC-ZERO/);
  assert.doesNotMatch(page.text, /NaN/);
});

test('XYZ uses six full months ending before the reference month', async () => {
  const references = await seedReferences();
  const steady = await createComponent(references, {
    sku: 'XYZ-STEADY',
    name: 'Ровный спрос',
  });

  for (const month of ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
    await insertIssue({
      componentId: steady.id,
      warehouseId: references.minsk.id,
      qty: 10,
      at: `${month}-10T10:00:00+03:00`,
      userId: references.user.id,
    });
  }

  // November is the reference month and therefore not a full month: this issue
  // must not enter the window.
  await insertIssue({
    componentId: steady.id,
    warehouseId: references.minsk.id,
    qty: 100,
    at: '2026-11-05T10:00:00+03:00',
    userId: references.user.id,
  });

  const { rows, window } = await getXyz({});

  assert.equal(window.start, '2026-05-01');
  assert.equal(window.end, '2026-11-01');
  assert.equal(window.referenceDate, '2026-11-22');
  assert.deepEqual(
    window.months.map((month) => month.key),
    ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'],
  );

  const row = rows.find((item) => item.id === steady.id);
  assert.ok(row);
  assert.deepEqual(row.monthly, [10, 10, 10, 10, 10, 10]);
  assert.equal(row.total, 60);
  assert.equal(row.mean, 10);
  assert.equal(row.stddev, 0);
  assert.equal(row.cv, 0);
  assert.equal(row.class, 'X');

  const filtered = await getXyz({ warehouseId: references.gomel.id });
  assert.deepEqual(filtered.rows, []);
  assert.equal(filtered.matrix.total, 0);
});

test('XYZ treats zero demand as class Z without a variation coefficient', async () => {
  const references = await seedReferences();
  const stocked = await createComponent(references, {
    sku: 'XYZ-STOCKED',
    name: 'Есть остаток, нет расхода',
  });
  await insertStock({
    componentId: stocked.id,
    warehouseId: references.minsk.id,
    qty: 7,
    unitCost: '10.0000',
  });

  const springOnly = await createComponent(references, {
    sku: 'XYZ-SPRING',
    name: 'Расход только весной',
  });
  await insertStock({
    componentId: springOnly.id,
    warehouseId: references.minsk.id,
    qty: 3,
    unitCost: '10.0000',
  });
  await insertIssue({
    componentId: springOnly.id,
    warehouseId: references.minsk.id,
    qty: 5,
    at: '2026-04-20T10:00:00+03:00',
    userId: references.user.id,
  });

  const { rows } = await getXyz({});
  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const component of [stocked, springOnly]) {
    const row = byId.get(component.id);
    assert.ok(row, `${component.sku} must be classified even with no demand`);
    assert.equal(row.class, 'Z');
    assert.equal(row.cv, null);
    assert.equal(row.total, 0);
    assert.equal(row.mean, 0);
    assert.equal(row.stddev, 0);
    assert.deepEqual(row.monthly, [0, 0, 0, 0, 0, 0]);
  }
});

test('XYZ matrix counts every position across ABC and XYZ classes', async () => {
  const references = await seedReferences();

  const definitions = [
    {
      sku: 'MX-A1',
      unitCost: '100.0000',
      categoryId: references.categoryId,
      monthly: [10, 10, 10, 10, 10, 10],
    },
    {
      sku: 'MX-A2',
      unitCost: '60.0000',
      categoryId: references.categoryId,
      monthly: [10, 10, 10, 10, 10, 10],
    },
    {
      sku: 'MX-B1',
      unitCost: '30.0000',
      categoryId: references.storageCategoryId,
      monthly: [4, 5, 5, 5, 5, 6],
    },
    { sku: 'MX-C1', unitCost: '10.0000', categoryId: references.categoryId, monthly: [] },
  ];

  for (const definition of definitions) {
    const component = await createComponent(references, {
      sku: definition.sku,
      name: `Позиция ${definition.sku}`,
      categoryId: definition.categoryId,
    });
    await insertStock({
      componentId: component.id,
      warehouseId: references.minsk.id,
      qty: 10,
      unitCost: definition.unitCost,
    });

    for (const [index, qty] of definition.monthly.entries()) {
      const month = String(5 + index).padStart(2, '0');
      await insertIssue({
        componentId: component.id,
        warehouseId: references.minsk.id,
        qty,
        at: `2026-${month}-10T10:00:00+03:00`,
        userId: references.user.id,
      });
    }
  }

  const { rows, matrix } = await getXyz({});

  assert.equal(rows.length, 4);
  assert.equal(matrix.total, 4);
  assert.deepEqual(
    matrix.rows.map((row) => row.abc),
    ['A', 'B', 'C'],
  );

  const count = (abc, xyz) =>
    matrix.rows.find((row) => row.abc === abc).cells.find((cell) => cell.xyz === xyz).count;

  assert.equal(count('A', 'X'), 2);
  assert.equal(count('B', 'Y'), 1);
  assert.equal(count('C', 'Z'), 1);
  assert.equal(count('A', 'Y'), 0);

  const totalCells = matrix.rows
    .flatMap((row) => row.cells)
    .reduce((sum, cell) => sum + cell.count, 0);
  assert.equal(totalCells, matrix.total);

  // Both XYZ queries filter by category with a different parameter order, so
  // the split also proves the monthly-issue query receives the ids it expects.
  const processors = await getXyz({ categoryId: references.categoryId });
  assert.deepEqual(processors.rows.map((row) => row.sku).sort(), ['MX-A1', 'MX-A2', 'MX-C1']);
  assert.equal(processors.matrix.total, 3);

  const storage = await getXyz({ categoryId: references.storageCategoryId });
  assert.deepEqual(
    storage.rows.map((row) => row.sku),
    ['MX-B1'],
  );
  assert.equal(storage.rows[0].class, 'Y');
  assert.equal(storage.rows[0].total, 30);
  assert.equal(storage.matrix.total, 1);
  // The filtered ABC range contains one position, so its cumulative share is
  // 100 % and the matrix reclassifies it as C instead of reusing the full list.
  assert.equal(
    storage.matrix.rows.find((row) => row.abc === 'C').cells.find((cell) => cell.xyz === 'Y').count,
    1,
  );
});

test('analytics pages show an empty state for a warehouse without stock', async () => {
  const references = await seedReferences();
  const agent = await signInAsAnalyst(references);

  const abc = await getAbc({ warehouseId: references.minsk.id });
  assert.deepEqual(abc.rows, []);
  assert.deepEqual(abc.summary.total, { count: 0, value: '0.0000' });
  assert.equal(abc.chart.labels.length, 0);

  const xyz = await getXyz({ warehouseId: references.minsk.id });
  assert.deepEqual(xyz.rows, []);
  assert.equal(xyz.matrix.total, 0);
  assert.equal(
    xyz.matrix.rows.flatMap((row) => row.cells).every((cell) => cell.count === 0),
    true,
  );

  const abcPage = await agent.get(`/analytics/abc?warehouseId=${references.minsk.id}`);
  assert.equal(abcPage.status, 200);
  assert.match(abcPage.text, /Пока нет остатков/);
  assert.doesNotMatch(abcPage.text, /data-chart/);
  assert.doesNotMatch(abcPage.text, /\/js\/charts\.js/);

  const xyzPage = await agent.get(`/analytics/xyz?warehouseId=${references.minsk.id}`);
  assert.equal(xyzPage.status, 200);
  assert.match(xyzPage.text, /Нет данных для XYZ-анализа/);
});

test('analyst can read ABC and XYZ pages while guests are redirected', async () => {
  const references = await seedReferences();
  const component = await createComponent(references, {
    sku: 'PAGE-ABC-01',
    name: 'Процессор для страницы',
  });
  await insertStock({
    componentId: component.id,
    warehouseId: references.minsk.id,
    qty: 10,
    unitCost: '100.0000',
  });

  // A mild but non-zero variation gives the XYZ table a CV to format.
  for (const [index, qty] of [3, 4, 3, 4, 3, 4].entries()) {
    const month = String(5 + index).padStart(2, '0');
    await insertIssue({
      componentId: component.id,
      warehouseId: references.minsk.id,
      qty,
      at: `2026-${month}-10T10:00:00+03:00`,
      userId: references.user.id,
    });
  }

  const agent = await signInAsAnalyst(references);

  const abc = await agent.get('/analytics/abc');
  assert.equal(abc.status, 200);
  assert.match(abc.text, /ABC-анализ/);
  assert.match(abc.text, /PAGE-ABC-01/);
  assert.match(abc.text, /Парето/);
  assert.match(abc.text, /data-chart="/);
  assert.match(abc.text, /\/js\/charts\.js/);
  assert.match(abc.text, /Центральный склад/);
  assert.match(abc.text, /href="\/analytics\/xyz/);
  assert.match(abc.text, /href="\/analytics\/abc"\s+aria-current="page"/);
  assert.match(abc.text, /100,00%/);

  const xyz = await agent.get('/analytics/xyz');
  assert.equal(xyz.status, 200);
  assert.match(xyz.text, /XYZ-анализ/);
  assert.match(xyz.text, /Матрица ABC/);
  assert.match(xyz.text, /Коэффициент вариации/);
  assert.match(xyz.text, /Стандартное отклонение/);
  assert.match(xyz.text, /PAGE-ABC-01/);
  assert.match(xyz.text, /0,1429/);
  assert.match(xyz.text, /href="\/analytics\/abc/);
  assert.match(xyz.text, /href="\/analytics\/abc"\s+aria-current="page"/);
  assert.doesNotMatch(xyz.text, /\/js\/charts\.js/);
  assert.match(xyz.text, /href="\/analytics\/abc/);

  // The chart bundle is page-scoped: other screens must not pay for it.
  const dashboard = await agent.get('/dashboard');
  assert.equal(dashboard.status, 200);
  assert.doesNotMatch(dashboard.text, /\/js\/charts\.js/);

  const guest = createTestApp().agent;
  const denied = await guest.get('/analytics/abc');
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.location, '/');
});

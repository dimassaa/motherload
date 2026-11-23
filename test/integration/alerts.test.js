import assert from 'node:assert/strict';
import test from 'node:test';
// Must stay first among local imports: it pins the analytics reference date
// before `src/config/env.js` is evaluated by the imports below.
import '../helpers/pin-analytics-date.js';
import { query } from '../../src/db/pool.js';
import { acknowledge, list, recalculate, resolve } from '../../src/services/alerts.js';
import { createTestApp } from '../helpers/app.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';
import {
  createComponentFactory,
  createSupplierFactory,
  createUserFactory,
  createWarehouseFactory,
} from '../helpers/factories.js';
import { getCsrf, loginAs } from '../helpers/http.js';

const PASSWORD = 'Alerts!23456';

// The reference date is pinned to 22.11.2026. Alerts reuse the same analytics
// clock so the 90-day dead-stock window and the 180-day activity window never
// depend on the machine clock.
const ACTIVITY_START = '2026-05-26';

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
 * Reference rows shared by every scenario.
 *
 * The warehouse names and addresses match the demo vocabulary so the stored
 * alert messages read like the product rather than like test scaffolding.
 */
async function seedReferences() {
  const admin = await createUserFactory({
    email: 'admin@alerts.test.by',
    password: PASSWORD,
    role: 'admin',
    fullName: 'Алексей Ковалёв',
  });
  const storekeeper = await createUserFactory({
    email: 'sklad@alerts.test.by',
    password: PASSWORD,
    role: 'storekeeper',
    fullName: 'Марина Сидорова',
  });
  const analyst = await createUserFactory({
    email: 'analyst@alerts.test.by',
    password: PASSWORD,
    role: 'analyst',
    fullName: 'Дмитрий Лебедев',
  });
  const supplier = await createSupplierFactory({ unp: '190000920', leadTimeDays: 5 });
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
    `insert into categories (name, slug) values ('Процессоры', 'processors') returning id`,
  );
  const { rows: manufacturers } = await query(
    `insert into manufacturers (name, country) values ('ТехноКорп', 'Беларусь') returning id`,
  );

  return {
    admin,
    storekeeper,
    analyst,
    supplier,
    minsk,
    gomel,
    categoryId: categories[0].id,
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
 * Receive stock and write the matching positive ledger movement.
 *
 * The movement timestamp is what the activity window reads; the batch row only
 * feeds FIFO and value. Keeping both in one helper prevents a scenario where a
 * balance exists but the pair is excluded from the alert scope.
 */
async function receive({
  componentId,
  warehouseId,
  qty,
  remaining = qty,
  unitCost = '100.0000',
  receivedAt = '2026-11-20',
}) {
  await query(
    `insert into stock_batches
       (component_id, warehouse_id, unit_cost, qty_received, qty_remaining, received_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [componentId, warehouseId, unitCost, qty, remaining, receivedAt],
  );
  await query(
    `insert into stock_movements (component_id, warehouse_id, qty_delta, unit_cost, created_at)
     values ($1, $2, $3, $4, $5::timestamptz)`,
    [componentId, warehouseId, qty, unitCost, `${receivedAt}T10:00:00+03:00`],
  );
}

let issueSequence = 0;

/** Post an issue document and its negative ledger movement. */
async function issue({ componentId, warehouseId, qty, at, userId, unitCost = '100.0000' }) {
  issueSequence += 1;
  const number = `РС-Т20-${String(issueSequence).padStart(4, '0')}`;
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

/** Thresholds live on the component and are compared per component+warehouse pair. */
async function setThresholds(componentId, { minStock, maxStock = null }) {
  await query('update components set min_stock = $1, max_stock = $2 where id = $3', [
    minStock,
    maxStock,
    componentId,
  ]);
}

async function alertRows() {
  const { rows } = await query(
    `select a.*, c.sku, c.name as component_name, w.name as warehouse_name
     from alerts a
     join components c on c.id = a.component_id
     join warehouses w on w.id = a.warehouse_id
     order by a.id`,
  );
  return rows;
}

async function openAlertCount() {
  const { rows } = await query(
    `select count(*)::integer as count from alerts where status <> 'resolved'`,
  );
  return rows[0].count;
}

async function signIn(references, role) {
  const user = references[role];
  const { agent } = createTestApp();
  await loginAs(agent, user.email, PASSWORD);
  return agent;
}

test('alert recalculation creates low_stock and stockout alerts idempotently', async () => {
  const references = await seedReferences();

  const low = await createComponent(references, {
    sku: 'CPU-ALERT-LOW',
    name: 'Процессор Kingston FURY 16GB',
  });
  await setThresholds(low.id, { minStock: 10 });
  await receive({ componentId: low.id, warehouseId: references.minsk.id, qty: 2 });

  const empty = await createComponent(references, {
    sku: 'CPU-ALERT-EMPTY',
    name: 'Процессор без остатка',
  });
  await receive({
    componentId: empty.id,
    warehouseId: references.minsk.id,
    qty: 5,
    remaining: 0,
    receivedAt: '2026-11-10',
  });
  await issue({
    componentId: empty.id,
    warehouseId: references.minsk.id,
    qty: 5,
    at: '2026-11-15T10:00:00+03:00',
    userId: references.storekeeper.id,
  });

  const first = await recalculate();
  const second = await recalculate();

  assert.equal(first.created, 2);
  assert.equal(first.resolved, 0);
  assert.equal(second.created, 0);
  assert.equal(second.resolved, 0);
  assert.equal(await openAlertCount(), 2);

  const rows = await alertRows();
  assert.equal(rows.length, 2, 'a second run must not duplicate open alerts');

  const lowRow = rows.find((row) => row.type === 'low_stock');
  assert.ok(lowRow, 'the below-minimum pair must raise low_stock');
  assert.equal(lowRow.severity, 'warning');
  assert.equal(lowRow.status, 'open');
  assert.equal(lowRow.warehouse_id, references.minsk.id);
  assert.match(lowRow.message, /CPU-ALERT-LOW/);
  assert.match(lowRow.message, /Процессор Kingston FURY 16GB/);
  assert.match(lowRow.message, /остаток 2 шт\. при минимуме 10/);
  assert.match(lowRow.message, /Центральный склад/);

  const stockoutRow = rows.find((row) => row.type === 'stockout');
  assert.ok(stockoutRow, 'a consumed pair with history must raise stockout');
  assert.equal(stockoutRow.severity, 'critical');
  assert.match(stockoutRow.message, /остаток 0 шт\./);
  assert.match(stockoutRow.message, /CPU-ALERT-EMPTY/);

  const { rows: auditRows } = await query(
    `select details from audit_log where action = 'alerts.recalculate' order by id`,
  );
  assert.equal(auditRows.length, 2, 'each recalculation is audited');
  assert.equal(auditRows[0].details.created, 2);
  assert.equal(auditRows[0].details.resolved, 0);
  assert.equal(auditRows[1].details.created, 0);
});

test('alert recalculation ignores warehouses with no history and archived components', async () => {
  const references = await seedReferences();

  const component = await createComponent(references, {
    sku: 'CPU-SCOPE-01',
    name: 'Процессор только на центральном складе',
  });
  await setThresholds(component.id, { minStock: 10 });
  await receive({ componentId: component.id, warehouseId: references.minsk.id, qty: 2 });

  // An archived position keeps its history but is outside the alert scope.
  const archived = await createComponent(references, {
    sku: 'CPU-ARCH-01',
    name: 'Архивная позиция',
    isActive: false,
  });
  await setThresholds(archived.id, { minStock: 10 });
  await receive({ componentId: archived.id, warehouseId: references.minsk.id, qty: 1 });

  const result = await recalculate();
  assert.equal(result.created, 1);

  const rows = await alertRows();
  assert.equal(rows.length, 1, 'only the active component on its own warehouse is flagged');
  assert.equal(rows[0].component_id, component.id);
  assert.equal(rows[0].warehouse_id, references.minsk.id);

  const gomelRows = rows.filter((row) => row.warehouse_id === references.gomel.id);
  assert.deepEqual(gomelRows, [], 'a warehouse that never held the position is not flagged');

  // The 180-day activity boundary stays inclusive, matching the reorder window.
  const boundary = await createComponent(references, {
    sku: 'CPU-EDGE-180',
    name: 'Позиция на границе окна',
  });
  await setThresholds(boundary.id, { minStock: 5 });
  await query(
    `insert into stock_movements (component_id, warehouse_id, qty_delta, unit_cost, created_at)
     values ($1, $2, 10, '10.0000', $3::timestamptz),
            ($1, $2, -10, '10.0000', $3::timestamptz)`,
    [boundary.id, references.minsk.id, `${ACTIVITY_START}T10:00:00+03:00`],
  );

  const stale = await createComponent(references, {
    sku: 'CPU-STALE-181',
    name: 'Позиция за окном активности',
  });
  await setThresholds(stale.id, { minStock: 5 });
  await query(
    `insert into stock_movements (component_id, warehouse_id, qty_delta, unit_cost, created_at)
     values ($1, $2, 10, '10.0000', $3::timestamptz),
            ($1, $2, -10, '10.0000', $3::timestamptz)`,
    [stale.id, references.minsk.id, '2026-05-25T10:00:00+03:00'],
  );

  await recalculate();
  const edgeRows = await alertRows();
  assert.ok(
    edgeRows.some((row) => row.sku === 'CPU-EDGE-180'),
    'the boundary day still participates',
  );
  assert.ok(
    !edgeRows.some((row) => row.sku === 'CPU-STALE-181'),
    'a movement 181 days old must not create an alert',
  );
});

test('alert recalculation keeps manual acknowledgement and auto-resolves a gone condition', async () => {
  const references = await seedReferences();

  const component = await createComponent(references, {
    sku: 'CPU-ACK-01',
    name: 'Процессор для подтверждения',
  });
  await setThresholds(component.id, { minStock: 10 });
  await receive({ componentId: component.id, warehouseId: references.minsk.id, qty: 2 });

  await recalculate();
  const [alert] = await alertRows();

  await acknowledge({ alertId: alert.id, user: references.storekeeper });
  let [acknowledged] = await alertRows();
  assert.equal(acknowledged.status, 'acknowledged');
  assert.equal(acknowledged.acknowledged_by, references.storekeeper.id);
  assert.ok(acknowledged.acknowledged_at);

  // A repeated run must not reopen or duplicate the acknowledged alert.
  const repeated = await recalculate();
  assert.equal(repeated.created, 0);
  [acknowledged] = await alertRows();
  assert.equal(acknowledged.status, 'acknowledged');

  // Restock above the minimum: the condition disappeared, so the alert closes
  // even though a human acknowledged it earlier.
  await receive({
    componentId: component.id,
    warehouseId: references.minsk.id,
    qty: 20,
    receivedAt: '2026-11-21',
  });
  const resolved = await recalculate();
  assert.equal(resolved.resolved, 1);
  assert.equal(await openAlertCount(), 0);

  const [closed] = await alertRows();
  assert.equal(closed.status, 'resolved');
  assert.ok(closed.resolved_at);

  await assert.rejects(
    () => acknowledge({ alertId: closed.id, user: references.storekeeper }),
    /уже закрыт/i,
  );

  // If the condition comes back, a fresh open alert is created next to the
  // resolved history instead of resurrecting the old row.
  await issue({
    componentId: component.id,
    warehouseId: references.minsk.id,
    qty: 20,
    at: '2026-11-22T10:00:00+03:00',
    userId: references.storekeeper.id,
  });
  const refreshed = await recalculate();
  assert.equal(refreshed.created, 1);
  const rows = await alertRows();
  assert.equal(rows.filter((row) => row.status === 'resolved').length, 1);
  assert.equal(rows.filter((row) => row.status === 'open').length, 1);

  const { rows: recalcAudit } = await query(
    `select details from audit_log where action = 'alerts.recalculate' order by id`,
  );
  assert.ok(
    recalcAudit.some((row) => row.details.resolved === 1),
    'auto-resolution must be recorded in the audit details',
  );
});

test('alert manual resolve is transient and recalculation reopens a true condition', async () => {
  const references = await seedReferences();

  const component = await createComponent(references, {
    sku: 'CPU-RESOLVE-01',
    name: 'Процессор с ручным закрытием',
  });
  await setThresholds(component.id, { minStock: 10 });
  await receive({ componentId: component.id, warehouseId: references.minsk.id, qty: 2 });

  await recalculate();
  const [alert] = await alertRows();

  await resolve({ alertId: alert.id, user: references.admin });
  let rows = await alertRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'resolved');

  // Manual resolution is not a suppression rule: the condition is still true,
  // so the next recalculation opens a fresh alert next to the closed history.
  const next = await recalculate();
  assert.equal(next.created, 1);
  rows = await alertRows();
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => row.status === 'resolved').length, 1);
  assert.equal(rows.filter((row) => row.status === 'open').length, 1);
  assert.equal(await openAlertCount(), 1);

  const { rows: auditRows } = await query(
    `select action from audit_log where action in ('alert.resolve', 'alerts.recalculate') order by id`,
  );
  assert.ok(auditRows.some((row) => row.action === 'alert.resolve'));
});

test('alert recalculation uses stock age for dead stock, not prior demand', async () => {
  const references = await seedReferences();

  // Received 200 days before the reference date and never issued: the classic
  // frozen inventory case must be flagged even though demand history is empty.
  const old = await createComponent(references, {
    sku: 'CPU-OLD-200',
    name: 'Позиция без расхода 200 дней',
  });
  await receive({
    componentId: old.id,
    warehouseId: references.minsk.id,
    qty: 10,
    receivedAt: '2026-05-06',
  });

  // The old batch was fully consumed and the latest issue is 100 days old, but
  // the remaining stock arrived yesterday: it is not dead yet.
  const restocked = await createComponent(references, {
    sku: 'CPU-RESTOCK-01',
    name: 'Позиция с давним расходом и свежим остатком',
  });
  await receive({
    componentId: restocked.id,
    warehouseId: references.minsk.id,
    qty: 10,
    remaining: 0,
    receivedAt: '2026-06-01',
  });
  await issue({
    componentId: restocked.id,
    warehouseId: references.minsk.id,
    qty: 10,
    at: '2026-08-14T10:00:00+03:00',
    userId: references.storekeeper.id,
  });
  await receive({
    componentId: restocked.id,
    warehouseId: references.minsk.id,
    qty: 5,
    receivedAt: '2026-11-21',
  });

  const result = await recalculate();
  assert.equal(result.created, 1);

  const rows = await alertRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'dead_stock');
  assert.equal(rows[0].component_id, old.id);
  assert.match(rows[0].message, /не списывался 90\+ дней/);
  assert.ok(!rows.some((row) => row.component_id === restocked.id));
});

test('alert recalculation treats a negative balance as stockout', async () => {
  const references = await seedReferences();

  const component = await createComponent(references, {
    sku: 'CPU-NEGATIVE-01',
    name: 'Позиция с отрицательным учётом',
  });
  await setThresholds(component.id, { minStock: 10 });
  await receive({
    componentId: component.id,
    warehouseId: references.minsk.id,
    qty: 2,
    remaining: 0,
    receivedAt: '2026-11-10',
  });
  await issue({
    componentId: component.id,
    warehouseId: references.minsk.id,
    qty: 3,
    at: '2026-11-15T10:00:00+03:00',
    userId: references.storekeeper.id,
  });

  const result = await recalculate();
  assert.equal(result.created, 1);

  const rows = await alertRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'stockout', 'a negative ledger balance is empty stock, not low stock');
  assert.equal(rows[0].severity, 'critical');
  assert.match(rows[0].message, /остаток 0 шт\./);
  assert.ok(!rows.some((row) => row.type === 'low_stock'));
});

test('alert recalculation flags overstock and dead stock without false positives', async () => {
  const references = await seedReferences();

  const stale = await createComponent(references, {
    sku: 'CPU-DEAD-01',
    name: 'Процессор с избытком и без расхода',
  });
  await setThresholds(stale.id, { minStock: 0, maxStock: 5 });
  await receive({
    componentId: stale.id,
    warehouseId: references.minsk.id,
    qty: 10,
    remaining: 9,
    receivedAt: '2026-06-01',
  });
  // One issue more than 90 days before the reference date, but inside the
  // 180-day activity window: the pair participates and the stock is dead.
  await issue({
    componentId: stale.id,
    warehouseId: references.minsk.id,
    qty: 1,
    at: '2026-07-01T10:00:00+03:00',
    userId: references.storekeeper.id,
  });

  const fresh = await createComponent(references, {
    sku: 'CPU-FRESH-01',
    name: 'Свежая позиция без расхода',
  });
  await receive({
    componentId: fresh.id,
    warehouseId: references.minsk.id,
    qty: 4,
    receivedAt: '2026-11-20',
  });

  const obsolete = await createComponent(references, {
    sku: 'CPU-OBSOLETE-01',
    name: 'Позиция вне окна активности',
  });
  await receive({
    componentId: obsolete.id,
    warehouseId: references.minsk.id,
    qty: 5,
    remaining: 0,
    receivedAt: '2026-04-01',
  });
  await issue({
    componentId: obsolete.id,
    warehouseId: references.minsk.id,
    qty: 5,
    at: '2026-04-15T10:00:00+03:00',
    userId: references.storekeeper.id,
  });

  const result = await recalculate();
  assert.equal(result.created, 2, 'overstock and dead_stock are two distinct conditions');

  const rows = await alertRows();
  assert.deepEqual(rows.map((row) => row.type).sort(), ['dead_stock', 'overstock']);
  for (const row of rows) {
    assert.equal(row.component_id, stale.id);
    assert.equal(row.severity, 'info');
  }

  const overstock = rows.find((row) => row.type === 'overstock');
  assert.match(overstock.message, /остаток 9 шт\. при максимуме 5/);
  assert.match(overstock.message, /Центральный склад/);

  const dead = rows.find((row) => row.type === 'dead_stock');
  assert.match(dead.message, /остаток 9 шт\./);
  assert.match(dead.message, /не списывался 90\+ дней/);

  // Freshly received stock is not dead: it has not been sitting for the full
  // window, and a never-issued position carries no demand history to compare.
  assert.ok(!rows.some((row) => row.component_id === fresh.id));
  // A pair whose last movement is older than 180 days is outside the scope even
  // though its balance is zero.
  assert.ok(!rows.some((row) => row.component_id === obsolete.id));
});

test('alert page lists, filters and renders role-appropriate actions', async () => {
  const references = await seedReferences();

  const low = await createComponent(references, {
    sku: 'CPU-PAGE-LOW',
    name: 'Процессор ниже минимума',
  });
  await setThresholds(low.id, { minStock: 10 });
  await receive({ componentId: low.id, warehouseId: references.minsk.id, qty: 2 });

  const over = await createComponent(references, {
    sku: 'SSD-PAGE-OVER',
    name: 'Накопитель с избытком',
  });
  await setThresholds(over.id, { minStock: 0, maxStock: 2 });
  await receive({ componentId: over.id, warehouseId: references.gomel.id, qty: 6 });

  await recalculate();

  const analyst = await signIn(references, 'analyst');
  const page = await analyst.get('/alerts');
  assert.equal(page.status, 200);
  assert.match(page.text, /CPU-PAGE-LOW/);
  assert.match(page.text, /остаток 2 шт\. при минимуме 10/);
  assert.match(page.text, /SSD-PAGE-OVER/);
  assert.match(page.text, /Открытых/);
  assert.doesNotMatch(page.text, /action="\/alerts\/recalculate"/);
  assert.doesNotMatch(page.text, /action="\/alerts\/\d+\/acknowledge"/);
  assert.doesNotMatch(page.text, /action="\/alerts\/\d+\/resolve"/);
  assert.doesNotMatch(page.text, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(page.text, /\sstyle="/);

  // The badge is present only in the authenticated chrome and counts every
  // unresolved alert.
  assert.match(page.text, /class="app-nav__badge"/);
  assert.match(page.text, /class="visually-hidden"> открытых алертов/);
  const badgeMatch = /class="app-nav__badge"[^>]*>\s*(\d+)\s*</.exec(page.text);
  assert.ok(badgeMatch, 'the navigation badge must render its count');
  assert.equal(badgeMatch[1], '2');

  const filtered = await analyst.get('/alerts?type=low_stock');
  assert.equal(filtered.status, 200);
  assert.match(filtered.text, /CPU-PAGE-LOW/);
  assert.doesNotMatch(filtered.text, /SSD-PAGE-OVER/);

  const byWarehouse = await analyst.get(`/alerts?warehouseId=${references.gomel.id}`);
  assert.equal(byWarehouse.status, 200);
  assert.match(byWarehouse.text, /SSD-PAGE-OVER/);
  assert.doesNotMatch(byWarehouse.text, /CPU-PAGE-LOW/);

  const resolvedPage = await analyst.get('/alerts?status=resolved');
  assert.equal(resolvedPage.status, 200);
  assert.match(resolvedPage.text, /Нет алертов/);

  const guest = createTestApp().agent;
  const denied = await guest.get('/alerts');
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.location, '/');
});

test('alert actions enforce RBAC for analyst, storekeeper and admin', async () => {
  const references = await seedReferences();

  const component = await createComponent(references, {
    sku: 'CPU-RBAC-01',
    name: 'Процессор для проверки прав',
  });
  await setThresholds(component.id, { minStock: 10 });
  await receive({ componentId: component.id, warehouseId: references.minsk.id, qty: 2 });
  await recalculate();

  const [alert] = await alertRows();
  const analyst = await signIn(references, 'analyst');
  const analystToken = await getCsrf(analyst, '/alerts');

  const analystAck = await analyst
    .post(`/alerts/${alert.id}/acknowledge`)
    .type('form')
    .send({ _csrf: analystToken });
  assert.equal(analystAck.status, 403, 'an analyst must not acknowledge an alert');

  const analystResolve = await analyst
    .post(`/alerts/${alert.id}/resolve`)
    .type('form')
    .send({ _csrf: analystToken });
  assert.equal(analystResolve.status, 403, 'an analyst must not resolve an alert');

  const analystRecalc = await analyst
    .post('/alerts/recalculate')
    .type('form')
    .send({ _csrf: analystToken });
  assert.equal(analystRecalc.status, 403, 'an analyst must not recalculate alerts');

  const storekeeper = await signIn(references, 'storekeeper');
  const storeToken = await getCsrf(storekeeper, '/alerts');

  const storeResolve = await storekeeper
    .post(`/alerts/${alert.id}/resolve`)
    .type('form')
    .send({ _csrf: storeToken });
  assert.equal(storeResolve.status, 403, 'a storekeeper must not resolve an alert');

  const storeAck = await storekeeper
    .post(`/alerts/${alert.id}/acknowledge`)
    .type('form')
    .send({ _csrf: storeToken });
  assert.equal(storeAck.status, 302);
  let [row] = await alertRows();
  assert.equal(row.status, 'acknowledged');
  assert.equal(row.acknowledged_by, references.storekeeper.id);

  const admin = await signIn(references, 'admin');
  const adminToken = await getCsrf(admin, '/alerts');

  const adminResolve = await admin
    .post(`/alerts/${alert.id}/resolve`)
    .type('form')
    .send({ _csrf: adminToken });
  assert.equal(adminResolve.status, 302);
  [row] = await alertRows();
  assert.equal(row.status, 'resolved');
  assert.ok(row.resolved_at);

  const adminRecalc = await admin
    .post('/alerts/recalculate')
    .type('form')
    .send({ _csrf: adminToken });
  assert.equal(adminRecalc.status, 302);
  assert.equal(await openAlertCount(), 1, 'the still-true condition opens a fresh alert');

  const { rows: auditRows } = await query(
    `select details from audit_log where action = 'alert.acknowledge' order by id desc limit 1`,
  );
  assert.equal(auditRows.length, 1, 'acknowledgement is audited');

  const deniedAck = await storekeeper
    .post(`/alerts/${alert.id}/acknowledge`)
    .type('form')
    .send({ _csrf: storeToken });
  assert.equal(deniedAck.status, 302, 'a resolved alert cannot be acknowledged again');
  assert.equal(deniedAck.headers.location, '/alerts');
});

test('alert list filters by type, status and warehouse', async () => {
  const references = await seedReferences();

  const low = await createComponent(references, { sku: 'CPU-LIST-LOW', name: 'Низкий остаток' });
  await setThresholds(low.id, { minStock: 10 });
  await receive({ componentId: low.id, warehouseId: references.minsk.id, qty: 2 });

  const over = await createComponent(references, { sku: 'SSD-LIST-OVER', name: 'Избыток' });
  await setThresholds(over.id, { minStock: 0, maxStock: 2 });
  await receive({ componentId: over.id, warehouseId: references.gomel.id, qty: 6 });

  await recalculate();

  const all = await list({});
  assert.equal(all.alerts.length, 2);
  assert.equal(all.openCount, 2);

  const lowOnly = await list({ type: 'low_stock' });
  assert.equal(lowOnly.alerts.length, 1);
  assert.equal(lowOnly.alerts[0].sku, 'CPU-LIST-LOW');

  const warehouseOnly = await list({ warehouseId: references.gomel.id });
  assert.equal(warehouseOnly.alerts.length, 1);
  assert.equal(warehouseOnly.alerts[0].sku, 'SSD-LIST-OVER');

  const openOnly = await list({ status: 'open' });
  assert.equal(openOnly.alerts.length, 2);

  const [alert] = await alertRows();
  await resolve({ alertId: alert.id, user: references.admin });

  const active = await list({});
  assert.equal(active.alerts.length, 1);
  assert.equal(active.openCount, 1);

  const resolved = await list({ status: 'resolved' });
  assert.equal(resolved.alerts.length, 1);
  assert.equal(resolved.alerts[0].id, alert.id);

  const everything = await list({ status: 'all' });
  assert.equal(everything.alerts.length, 2);
});

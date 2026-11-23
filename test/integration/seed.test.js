import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
// Must stay first among local imports: it pins the analytics reference date
// before `src/config/env.js` is evaluated by the imports below.
import '../helpers/pin-analytics-date.js';
import { resetDatabase } from '../../scripts/reset-db.js';
import { query } from '../../src/db/pool.js';
import { seed } from '../../src/db/seed.js';
import { getAbc, getDashboard } from '../../src/services/analytics.js';
import { login } from '../../src/services/auth.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';

const REFERENCE_DATE = '2026-11-22';
const SYSTEM_REQUEST = { ip: null, get: () => null };

// A full demo seed posts roughly a thousand real receipt/issue documents. It is
// seeded once per suite; the idempotency test deliberately runs it a second
// time, and the reset test a third, because "skip unless forced" and "force
// truncates everything" are the contract this suite exists to protect.
before(async () => {
  await setupTestDb();
  await truncateAll();
  await seed({ referenceDate: REFERENCE_DATE });
});

after(async () => {
  await teardownTestDb();
});

test('seed is idempotent and creates the AGENTS §3 demo catalogue', async () => {
  const secondRun = await seed({ referenceDate: REFERENCE_DATE });
  assert.equal(secondRun.skipped, true, 'a populated database must not be seeded again');

  const { rows } = await query(
    `select
       (select count(*)::int from warehouses) as warehouses,
       (select count(*)::int from categories) as categories,
       (select count(*)::int from manufacturers) as manufacturers,
       (select count(*)::int from suppliers) as suppliers,
       (select count(*)::int from components) as components,
       (select count(*)::int from users) as users,
       (select count(*)::int from stock_documents) as documents`,
  );

  assert.equal(rows[0].warehouses, 3);
  assert.equal(rows[0].categories, 10);
  assert.equal(rows[0].manufacturers, 15);
  assert.equal(rows[0].suppliers, 6);
  assert.equal(rows[0].components, 60);
  assert.equal(rows[0].users, 3);
  assert.ok(rows[0].documents > 0, 'history must contain stock documents');
  assert.ok(rows[0].documents <= 2000, 'the demo history must stay under ~2000 documents');

  const dates = await query(
    `select max(doc_date)::text as latest, min(doc_date)::text as earliest
     from stock_documents`,
  );
  assert.equal(dates.rows[0].latest, REFERENCE_DATE);
  assert.ok(dates.rows[0].earliest <= REFERENCE_DATE);
});

test('all three demo accounts can sign in with the documented passwords', async () => {
  const accounts = [
    ['admin@motherload.by', 'Admin!23456', 'admin'],
    ['sklad@motherload.by', 'Sklad!23456', 'storekeeper'],
    ['analyst@motherload.by', 'Analyst!2345', 'analyst'],
  ];

  for (const [email, password, role] of accounts) {
    const user = await login({ email, password, req: SYSTEM_REQUEST });
    assert.equal(user.email, email);
    assert.equal(user.role, role);
  }
});

test('demo data produces low-stock, dead-stock and overstock cases', async () => {
  const low = await query(
    `select count(*)::int as count
     from v_component_warehouse_stock
     where qty > 0 and qty < min_stock`,
  );
  const overstock = await query(
    `select count(*)::int as count
     from v_component_warehouse_stock
     where max_stock is not null and qty > max_stock`,
  );
  const alerts = await query(
    `select type, count(*)::int as count
     from alerts
     where status <> 'resolved'
     group by type`,
  );
  const byType = Object.fromEntries(alerts.rows.map((row) => [row.type, row.count]));

  assert.ok(low.rows[0].count > 0, 'at least one warehouse pair must be below minimum');
  assert.ok(overstock.rows[0].count > 0, 'at least one warehouse pair must exceed maximum');
  assert.ok((byType.low_stock ?? 0) > 0, 'recalculation must open low-stock alerts');
  assert.ok((byType.dead_stock ?? 0) > 0, 'recalculation must open dead-stock alerts');
  assert.ok((byType.overstock ?? 0) > 0, 'recalculation must open overstock alerts');
});

test('demo dashboard is populated instead of empty', async () => {
  const dashboard = await getDashboard();

  assert.notEqual(dashboard.kpis.stockValue, '0.0000');
  assert.ok(dashboard.categoryValues.length > 0);
  assert.ok(dashboard.recentMovements.length > 0);
  assert.ok(dashboard.matrix.total > 0);
});

test('ABC classification is stable across a forced reseed', async () => {
  const before = await getAbc({});
  assert.ok(before.rows.length > 0);

  await seed({ referenceDate: REFERENCE_DATE, force: true });

  const after = await getAbc({});
  assert.deepEqual(
    after.rows.map((row) => [row.sku, row.class]),
    before.rows.map((row) => [row.sku, row.class]),
  );
});

test('reset script truncates, migrates and reseeds a working demo', async () => {
  const result = await resetDatabase({ referenceDate: REFERENCE_DATE });

  assert.equal(result.skipped, false);
  assert.equal(result.counts.components, 60);
  assert.equal(result.counts.users, 3);
  assert.ok(result.counts.stock_documents > 0);
  assert.ok(result.counts.stock_movements > result.counts.stock_documents);

  const alerts = await query(
    `select count(*)::int as count from alerts where status <> 'resolved'`,
  );
  assert.ok(alerts.rows[0].count > 0, 'a reset must recalculate alerts');
});

import { migrate } from '../../src/db/migrate.js';
import { closePool, pool, query } from '../../src/db/pool.js';

// Every table that holds mutable application data. `schema_migrations` is owned
// by the migration runner and must survive between test runs, otherwise every
// test would re-apply the schema.
const MUTABLE_TABLES = [
  'inventory_lines',
  'inventory_counts',
  'batch_consumptions',
  'stock_movements',
  'stock_document_lines',
  'stock_documents',
  'stock_batches',
  'alerts',
  'audit_log',
  'document_sequences',
  'components',
  'categories',
  'manufacturers',
  'suppliers',
  'warehouses',
  'sessions',
  'users',
];

/** Bring the test database schema up to date before a suite runs. */
export async function setupTestDb() {
  await migrate(pool);
}

/** Reset all mutable data while keeping the schema in place. */
export async function truncateAll() {
  await query(`TRUNCATE ${MUTABLE_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

/** Release database connections so the test process can exit cleanly. */
export async function teardownTestDb() {
  await closePool();
}

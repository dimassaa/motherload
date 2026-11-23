/**
 * Application tables that hold mutable data, in dependency-safe truncate order.
 *
 * The demo seeder (`src/db/seed.js`) and the integration-test reset
 * (`test/helpers/db.js`) must wipe exactly the same set: a table added to one
 * list but not the other leaves stale rows behind and makes the seed "skip"
 * against data it did not create. Keeping the list in one module is the only
 * way that cannot drift.
 *
 * `schema_migrations` is deliberately absent: it belongs to the migration
 * runner and must survive both a demo reset and a test truncate.
 */
export const APPLICATION_TABLES = [
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

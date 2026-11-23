import { APPLICATION_TABLES } from '../../src/db/application-tables.js';
import { migrate } from '../../src/db/migrate.js';
import { closePool, pool, query } from '../../src/db/pool.js';

/** Bring the test database schema up to date before a suite runs. */
export async function setupTestDb() {
  await migrate(pool);
}

/** Reset all mutable data while keeping the schema in place. */
export async function truncateAll() {
  await query(`TRUNCATE ${APPLICATION_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

/** Release database connections so the test process can exit cleanly. */
export async function teardownTestDb() {
  await closePool();
}

/**
 * Reset the development database (`npm run db:reset`).
 *
 * The script brings the schema up to date and then reseeds with `force`, which
 * truncates every application table first. It refuses to run in production:
 * losing demo data is cheap, losing a live warehouse ledger is not.
 */

import { pathToFileURL } from 'node:url';
import { isProduction } from '../src/config/env.js';
import { migrate } from '../src/db/migrate.js';
import { closePool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { logger } from '../src/lib/logger.js';

/**
 * Drop all application data, re-apply pending migrations and seed fresh demo
 * data. `ANALYTICS_REFERENCE_DATE` (or the current Minsk day) decides the
 * history window.
 * @param {{ referenceDate?: string }} [options]
 * @returns {Promise<{
 *   skipped: boolean,
 *   referenceDate: string,
 *   counts: Record<string, number>,
 *   documents?: { receipts: number, issues: number, total: number },
 *   alerts?: { created: number, resolved: number },
 *   migrations: { applied: number, known: number },
 * }>} the seed result plus the migration counters
 * @throws {Error} in production, where a reset would destroy real inventory
 */
export async function resetDatabase({ referenceDate } = {}) {
  if (isProduction) {
    throw new Error('Сброс базы запрещён в production: скрипт удаляет все складские данные.');
  }

  const migrations = await migrate();
  const result = await seed({ referenceDate, force: true });

  return { ...result, migrations };
}

const isDirectRun =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  try {
    const result = await resetDatabase();
    process.stdout.write(
      `reset: ${result.counts.components} components, ${result.counts.stock_documents} documents\n`,
    );
  } catch (error) {
    logger.error({ err: error }, 'database reset failed');
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

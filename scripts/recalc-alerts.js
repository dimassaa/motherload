/**
 * Recompute stock alerts from the command line (`npm run alerts`).
 *
 * The pass has no session: it is a system action, so the audit row carries no
 * user and no request metadata apart from the synthetic empty request. Cron and
 * the Docker entrypoint can call it without creating an administrator identity.
 */
import { closePool } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';
import { recalculate } from '../src/services/alerts.js';

const SYSTEM_REQUEST = { ip: null, get: () => null };

async function main() {
  const result = await recalculate({ user: null, userId: null, req: SYSTEM_REQUEST });
  logger.info({ created: result.created, resolved: result.resolved }, 'alerts recalculated');
  process.stdout.write(`alerts: created ${result.created}, resolved ${result.resolved}\n`);
}

try {
  await main();
} catch (error) {
  logger.error({ err: error }, 'alert recalculation failed');
  process.exitCode = 1;
} finally {
  await closePool();
}

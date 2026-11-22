import { setTimeout as delay } from 'node:timers/promises';
import { closePool, query } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';

const MAX_ATTEMPTS = 30;
const RETRY_DELAY_MS = 1000;

async function waitForDatabase() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await query('SELECT 1');
      logger.info({ attempt }, 'database is reachable');
      return;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
      logger.warn({ attempt, maxAttempts: MAX_ATTEMPTS }, 'database is not ready, retrying');
      await delay(RETRY_DELAY_MS);
    }
  }
}

try {
  await waitForDatabase();
} catch (error) {
  logger.error({ err: error, maxAttempts: MAX_ATTEMPTS }, 'database did not become ready');
  process.exitCode = 1;
} finally {
  await closePool();
}

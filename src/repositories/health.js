import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';

/**
 * Health probe for /healthz. Returns false instead of throwing because the
 * endpoint must report an outage as a status code, and the reason is logged.
 * @returns {Promise<boolean>}
 */
export async function isDatabaseUp() {
  try {
    await query('SELECT 1');
    return true;
  } catch (error) {
    logger.warn({ err: error }, 'database health check failed');
    return false;
  }
}

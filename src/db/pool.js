import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const { Pool, types } = pg;

// `date` columns describe a calendar day, not an instant. The default pg parser
// builds a JS Date in local time, which shifts the day around midnight and would
// break document dates and analytics windows. Keep the ISO string instead.
types.setTypeParser(types.builtins.DATE, (value) => value);

/** Shared connection pool for the whole process. */
export const pool = new Pool({ connectionString: env.databaseUrl });

// Idle clients can fail outside of any request (network drop, server restart).
// Without this listener pg would emit an unhandled 'error' event and kill the process.
pool.on('error', (error) => {
  logger.error({ err: error }, 'idle database client failed');
});

/**
 * Run a single parameterised statement.
 * @param {string} text SQL with $1..$n placeholders
 * @param {unknown[]} [params]
 */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run work inside a transaction. The client is always released; any throw
 * rolls back before propagating, so partial document writes are impossible.
 * @template T
 * @param {(client: pg.PoolClient) => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Keep the original failure as the thrown error: a dead connection during
      // rollback must not hide why the transaction failed.
      error.rollbackError = rollbackError;
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Close the pool once; safe to call from tests and CLI scripts after repeated runs. */
export async function closePool() {
  if (pool.ended) return;
  await pool.end();
}

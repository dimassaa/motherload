import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool as defaultPool, closePool } from './pool.js';
import { logger } from '../lib/logger.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

async function listMigrationFiles() {
  try {
    const entries = await readdir(MIGRATIONS_DIR);
    return entries.filter((name) => name.endsWith('.sql')).sort();
  } catch (error) {
    // Task 1 ships without migrations; an absent directory is an empty history,
    // not a startup failure.
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function rollback(client, cause) {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    cause.rollbackError = rollbackError;
  }
}

/**
 * Apply every not-yet-applied migration in filename order. Each file runs in its
 * own transaction together with its schema_migrations row, so a failed migration
 * leaves no half-applied schema.
 * @param {import('pg').Pool} [poolOverride]
 * @returns {Promise<{ applied: number, known: number }>}
 */
export async function migrate(poolOverride = defaultPool) {
  const client = await poolOverride.connect();
  try {
    await client.query(CREATE_MIGRATIONS_TABLE);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const appliedNames = new Set(rows.map((row) => row.version));
    const files = await listMigrationFiles();
    let applied = 0;

    for (const file of files) {
      if (appliedNames.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await rollback(client, error);
        throw error;
      }
      applied += 1;
      logger.info({ file }, 'migration applied');
    }

    return { applied, known: files.length };
  } finally {
    client.release();
  }
}

const isDirectRun =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  try {
    const { applied, known } = await migrate();
    logger.info({ applied, known }, 'database schema is up to date');
  } catch (error) {
    logger.error({ err: error }, 'migrations failed');
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

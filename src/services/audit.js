import { pool } from '../db/pool.js';
import {
  countAuditEntries,
  insertAuditEntry,
  listAuditActions,
  listAuditEntries,
  listAuditEntityTypes,
} from '../repositories/audit.js';
import { listUsers } from '../repositories/users.js';

/** One audit page fits comfortably on a laptop and stays cheap to render. */
const PAGE_SIZE = 25;

/**
 * Record a security-relevant action with request metadata.
 *
 * Callers must pass only non-secret context: passwords, password hashes and
 * CSRF tokens are never written to `details`, because the audit page is visible
 * to administrators and the rows outlive the session.
 *
 * Inside a mutation, pass the `client` from `withTransaction`. The audit row then
 * shares the transaction and an insert failure rolls the mutation back instead
 * of leaving a committed change without its audit trail. Omitting `client` uses
 * the pool, which keeps the Task 4 authentication calls working.
 * @param {{
 *   userId?: number | null,
 *   action: string,
 *   entityType?: string | null,
 *   entityId?: string | number | null,
 *   details?: Record<string, unknown>,
 *   req?: import('express').Request,
 * }} entry
 * @param {{ client?: import('pg').PoolClient | null }} [options]
 */
export async function record(
  { userId, action, entityType, entityId, details, req },
  { client } = {},
) {
  await insertAuditEntry(
    {
      userId: userId ?? req?.user?.id ?? null,
      action,
      entityType: entityType ?? null,
      entityId: entityId === null || entityId === undefined ? null : String(entityId),
      details: details ?? {},
      ip: req?.ip ?? null,
      userAgent: req?.get?.('user-agent') ?? null,
    },
    client ?? pool,
  );
}

/**
 * Read the audit page for the administration screen.
 *
 * The page is clamped into `[1, totalPages]`. A stale bookmark like `?page=999`
 * must show the last page, not an empty table that looks like "no records".
 * Filters arrive already validated and trimmed by the controller, so this
 * function only maps them to the repository contract.
 * @param {{
 *   userId?: number | null,
 *   action?: string | null,
 *   entityType?: string | null,
 *   from?: string | null,
 *   to?: string | null,
 *   page?: number,
 * }} [filters]
 */
export async function list({
  userId = null,
  action = null,
  entityType = null,
  from = null,
  to = null,
  page = 1,
} = {}) {
  const requestedPage = Number.isInteger(page) && page > 0 ? page : 1;
  const query = { userId, action, entityType, from, to };

  // The count comes first because the requested page may need clamping before
  // its offset is safe to compute.
  const total = await countAuditEntries(query);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(requestedPage, totalPages);

  const entries = await listAuditEntries({
    ...query,
    limit: PAGE_SIZE,
    offset: (currentPage - 1) * PAGE_SIZE,
  });

  return {
    entries,
    page: currentPage,
    total,
    totalPages,
    pageSize: PAGE_SIZE,
  };
}

/** Options for the filter selects: users who can appear in the log and the values it contains. */
export async function filterOptions() {
  const [actions, entityTypes, users] = await Promise.all([
    listAuditActions(),
    listAuditEntityTypes(),
    listUsers(),
  ]);

  return { actions, entityTypes, users };
}

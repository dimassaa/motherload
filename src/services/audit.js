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
 * @param {{
 *   userId?: number | null,
 *   action: string,
 *   entityType?: string | null,
 *   entityId?: string | number | null,
 *   details?: Record<string, unknown>,
 *   req?: import('express').Request,
 * }} entry
 */
export async function record({ userId, action, entityType, entityId, details, req }) {
  await insertAuditEntry({
    userId: userId ?? req?.user?.id ?? null,
    action,
    entityType: entityType ?? null,
    entityId: entityId === null || entityId === undefined ? null : String(entityId),
    details: details ?? {},
    ip: req?.ip ?? null,
    userAgent: req?.get?.('user-agent') ?? null,
  });
}

/**
 * Read the audit page for the administration screen.
 *
 * `page` is clamped to at least 1; an out-of-range page factor of the URL must
 * not produce a negative OFFSET. Filters arrive already validated and trimmed by
 * the controller, so this function only maps them to the repository contract.
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
  const currentPage = Number.isInteger(page) && page > 0 ? page : 1;
  const query = { userId, action, entityType, from, to };

  const [entries, total] = await Promise.all([
    listAuditEntries({ ...query, limit: PAGE_SIZE, offset: (currentPage - 1) * PAGE_SIZE }),
    countAuditEntries(query),
  ]);

  return {
    entries,
    page: currentPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
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

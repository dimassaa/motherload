import { query } from '../db/pool.js';

/**
 * Append one audit record. The repository deliberately accepts raw columns:
 * the service layer decides which request metadata is safe to persist.
 * @param {{
 *   userId?: number | null,
 *   action: string,
 *   entityType?: string | null,
 *   entityId?: string | null,
 *   details?: Record<string, unknown>,
 *   ip?: string | null,
 *   userAgent?: string | null,
 * }} entry
 */
export async function insertAuditEntry({
  userId = null,
  action,
  entityType = null,
  entityId = null,
  details = {},
  ip = null,
  userAgent = null,
}) {
  await query(
    `insert into audit_log (user_id, action, entity_type, entity_id, details, ip, user_agent)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, action, entityType, entityId, JSON.stringify(details), ip, userAgent],
  );
}

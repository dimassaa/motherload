import { insertAuditEntry } from '../repositories/audit.js';

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

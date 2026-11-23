import { pool, query } from '../db/pool.js';

/**
 * Append one audit record. The repository deliberately accepts raw columns:
 * the service layer decides which request metadata is safe to persist.
 *
 * The second argument is the transaction client. Task 5 user/profile mutations
 * and Task 11 stock documents call this with their transaction client so the
 * mutation and its audit row commit or roll back together. The pool remains the
 * default, which keeps the Task 4 authentication calls unchanged.
 * @param {{
 *   userId?: number | null,
 *   action: string,
 *   entityType?: string | null,
 *   entityId?: string | null,
 *   details?: Record<string, unknown>,
 *   ip?: string | null,
 *   userAgent?: string | null,
 * }} entry
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 */
export async function insertAuditEntry(
  {
    userId = null,
    action,
    entityType = null,
    entityId = null,
    details = {},
    ip = null,
    userAgent = null,
  },
  client = pool,
) {
  await client.query(
    `insert into audit_log (user_id, action, entity_type, entity_id, details, ip, user_agent)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, action, entityType, entityId, JSON.stringify(details), ip, userAgent],
  );
}

const DETAILS_COLUMNS = `
  a.id, a.user_id, a.action, a.entity_type, a.entity_id, a.details, a.ip, a.created_at,
  u.full_name as user_full_name, u.email as user_email
`;

// The audit page shows wall-clock dates in Europe/Minsk, not the database
// session's timezone. The explicit conversion keeps a "from" date meaning local
// midnight in Minsk even when PostgreSQL runs with a different TimeZone.
const LOCAL_MIDNIGHT = "::timestamp at time zone 'Europe/Minsk'";

function mapAuditEntry(row) {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_full_name,
    userEmail: row.user_email,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    details: row.details ?? {},
    ip: row.ip,
    createdAt: row.created_at,
  };
}

/**
 * Build the shared WHERE clause for the list and count queries.
 * Every value is parameterised; only fixed SQL fragments are concatenated.
 */
function buildFilterClause({ userId, action, entityType, from, to }) {
  const conditions = [];
  const values = [];

  if (userId) {
    values.push(userId);
    conditions.push(`a.user_id = $${values.length}`);
  }
  if (action) {
    values.push(action);
    conditions.push(`a.action = $${values.length}`);
  }
  if (entityType) {
    values.push(entityType);
    conditions.push(`a.entity_type = $${values.length}`);
  }
  if (from) {
    values.push(from);
    conditions.push(`a.created_at >= ($${values.length}::date${LOCAL_MIDNIGHT})`);
  }
  if (to) {
    // `to` is inclusive: everything before local midnight of the next day.
    values.push(to);
    const nextDayStart = `((($${values.length}::date + 1)::timestamp) at time zone 'Europe/Minsk')`;
    conditions.push(`a.created_at < ${nextDayStart}`);
  }

  return {
    where: conditions.length > 0 ? `where ${conditions.join(' and ')}` : '',
    values,
  };
}

/**
 * Read one page of audit records, newest first, with the acting user resolved.
 * @param {{
 *   userId?: number | null,
 *   action?: string | null,
 *   entityType?: string | null,
 *   from?: string | null,
 *   to?: string | null,
 *   limit: number,
 *   offset: number,
 * }} filters
 */
export async function listAuditEntries(filters) {
  const { where, values } = buildFilterClause(filters);
  values.push(filters.limit, filters.offset);

  const { rows } = await query(
    `select ${DETAILS_COLUMNS}
     from audit_log a
     left join users u on u.id = a.user_id
     ${where}
     order by a.created_at desc, a.id desc
     limit $${values.length - 1} offset $${values.length}`,
    values,
  );

  return rows.map(mapAuditEntry);
}

/** @param {Parameters<typeof buildFilterClause>[0]} filters */
export async function countAuditEntries(filters) {
  const { where, values } = buildFilterClause(filters);
  const { rows } = await query(
    `select count(*)::integer as count from audit_log a ${where}`,
    values,
  );
  return rows[0].count;
}

/** Distinct actions that actually occur, for the filter select. */
export async function listAuditActions() {
  const { rows } = await query('select distinct action from audit_log order by action');
  return rows.map((row) => row.action);
}

/** Distinct entity types that actually occur, for the filter select. */
export async function listAuditEntityTypes() {
  const { rows } = await query(
    'select distinct entity_type from audit_log where entity_type is not null order by entity_type',
  );
  return rows.map((row) => row.entity_type);
}

import { pool } from '../db/pool.js';

const PUBLIC_COLUMNS =
  'id, email, full_name, role, phone, is_active, last_login_at, created_at, updated_at';

// Every function accepts an optional transaction client. Task 5 mutations and
// the audit row they write must share one transaction, and Task 11 receipts need
// the same primitives inside theirs. Without a client the shared pool is used,
// so read paths and Task 4 auth keep their existing signatures.
function db(client) {
  return client ?? pool;
}

function mapUser(row, { includePasswordHash = false } = {}) {
  if (!row) return null;

  const user = {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    phone: row.phone,
    isActive: row.is_active,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (includePasswordHash) user.passwordHash = row.password_hash;
  return user;
}

/**
 * Find a user by email. Email comparison uses `citext`, so casing is handled by
 * PostgreSQL. The password hash is included because only the login flow needs it.
 * @param {string} email
 * @param {import('pg').PoolClient | null} [client]
 */
export async function findByEmail(email, client = null) {
  const { rows } = await db(client).query(
    `select ${PUBLIC_COLUMNS}, password_hash from users where email = $1`,
    [email],
  );
  return mapUser(rows[0], { includePasswordHash: true });
}

/**
 * Find a user by id. The password hash is excluded by default because session
 * middleware calls this on every request; only the password-change flow opts in.
 * @param {number} id
 * @param {{ includePasswordHash?: boolean, client?: import('pg').PoolClient | null }} [options]
 */
export async function findById(id, { includePasswordHash = false, client = null } = {}) {
  const columns = includePasswordHash ? `${PUBLIC_COLUMNS}, password_hash` : PUBLIC_COLUMNS;
  const { rows } = await db(client).query(`select ${columns} from users where id = $1`, [id]);
  return mapUser(rows[0], { includePasswordHash });
}

/**
 * Lock one user row for the duration of a transaction. Used before a role change
 * or deactivation so the decision is made against a row no concurrent request
 * can rewrite under it.
 * @param {number} id
 * @param {import('pg').PoolClient} client
 */
export async function lockById(id, client) {
  const { rows } = await client.query(
    `select ${PUBLIC_COLUMNS} from users where id = $1 for update`,
    [id],
  );
  return mapUser(rows[0]);
}

/**
 * Lock every active administrator row. The lock is the concurrency boundary for
 * the "at least one active admin" invariant: a second transaction waits here,
 * then re-reads the rows committed by the first, so two simultaneous demotions
 * cannot both pass a stale count.
 * @param {import('pg').PoolClient} client
 * @returns {Promise<Array<{ id: number, role: string, isActive: boolean }>>}
 */
export async function lockActiveAdmins(client) {
  const { rows } = await client.query(
    `select id, role, is_active
     from users
     where role = 'admin' and is_active
     order by id
     for update`,
  );

  return rows.map((row) => ({ id: row.id, role: row.role, isActive: row.is_active }));
}

/** @param {number} id @param {import('pg').PoolClient | null} [client] */
export async function touchLastLogin(id, client = null) {
  const { rows } = await db(client).query(
    'update users set last_login_at = now(), updated_at = now() where id = $1 returning id',
    [id],
  );
  return rows[0]?.id ?? null;
}

/**
 * Insert a user with an already-hashed password.
 * Hashing stays in the auth service so this repository never sees plain secrets.
 * @param {{
 *   email: string,
 *   passwordHash: string,
 *   fullName: string,
 *   role: 'admin' | 'storekeeper' | 'analyst',
 *   phone?: string | null,
 *   isActive?: boolean,
 * }} input
 * @param {import('pg').PoolClient | null} [client]
 */
export async function createUser(
  { email, passwordHash, fullName, role, phone = null, isActive = true },
  client = null,
) {
  const { rows } = await db(client).query(
    `insert into users (email, password_hash, full_name, role, phone, is_active)
     values ($1, $2, $3, $4, $5, $6)
     returning ${PUBLIC_COLUMNS}`,
    [email, passwordHash, fullName, role, phone, isActive],
  );
  return mapUser(rows[0]);
}

/**
 * Replace a user's password hash.
 * @param {number} id
 * @param {string} passwordHash
 * @param {import('pg').PoolClient | null} [client]
 */
export async function updatePassword(id, passwordHash, client = null) {
  const { rows } = await db(client).query(
    `update users set password_hash = $2, updated_at = now()
     where id = $1
     returning ${PUBLIC_COLUMNS}`,
    [id, passwordHash],
  );
  return mapUser(rows[0]);
}

/**
 * Activate or deactivate a user. Deactivation keeps history (audit, documents)
 * intact, which is why users are never deleted.
 * @param {number} id
 * @param {boolean} isActive
 * @param {import('pg').PoolClient | null} [client]
 */
export async function setActive(id, isActive, client = null) {
  const { rows } = await db(client).query(
    `update users set is_active = $2, updated_at = now()
     where id = $1
     returning ${PUBLIC_COLUMNS}`,
    [id, isActive],
  );
  return mapUser(rows[0]);
}

/**
 * Every account for the administration table. Ordered by name so the list is
 * stable between renders and easy to scan.
 * @param {import('pg').PoolClient | null} [client]
 */
export async function listUsers(client = null) {
  const { rows } = await db(client).query(
    `select ${PUBLIC_COLUMNS} from users order by full_name, id`,
  );
  return rows.map((row) => mapUser(row));
}

/**
 * Apply the fields an administrator may change. Email is absent on purpose:
 * it is the login identifier and the specification forbids changing it.
 * @param {number} id
 * @param {{ fullName: string, role: 'admin' | 'storekeeper' | 'analyst', phone: string | null }} input
 * @param {import('pg').PoolClient | null} [client]
 */
export async function updateUser(id, { fullName, role, phone }, client = null) {
  const { rows } = await db(client).query(
    `update users set full_name = $2, role = $3, phone = $4, updated_at = now()
     where id = $1
     returning ${PUBLIC_COLUMNS}`,
    [id, fullName, role, phone],
  );
  return mapUser(rows[0]);
}

/**
 * Apply the fields a user may change on their own profile. Role and email stay
 * with the administrator; a user cannot promote themselves.
 * @param {number} id
 * @param {{ fullName: string, phone: string | null }} input
 * @param {import('pg').PoolClient | null} [client]
 */
export async function updateProfile(id, { fullName, phone }, client = null) {
  const { rows } = await db(client).query(
    `update users set full_name = $2, phone = $3, updated_at = now()
     where id = $1
     returning ${PUBLIC_COLUMNS}`,
    [id, fullName, phone],
  );
  return mapUser(rows[0]);
}

/**
 * Delete the stored sessions of a user, optionally sparing one session id.
 *
 * connect-pg-simple keeps the whole session payload in the `sess` JSON column,
 * so the user is located there rather than by a dedicated column. The current
 * session is spared when a user changes their own password: the spec requires
 * that session to survive while every other device is signed out.
 * @param {number} userId
 * @param {{ exceptSid?: string | null, client?: import('pg').PoolClient | null }} [options]
 * @returns {Promise<number>} number of deleted sessions
 */
export async function deleteSessionsForUser(userId, { exceptSid = null, client = null } = {}) {
  const { rowCount } = await db(client).query(
    `delete from sessions
     where sess ->> 'userId' = $1
       and ($2::text is null or sid <> $2)`,
    [String(userId), exceptSid],
  );
  return rowCount;
}

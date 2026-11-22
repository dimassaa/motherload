import { query } from '../../src/db/pool.js';
import { hashPassword } from '../../src/services/auth.js';

export const DEFAULT_TEST_PASSWORD = 'Test!23456';

/**
 * Insert a user with a real Argon2id hash, so login tests exercise the same
 * password path as production instead of mocking verification.
 * @param {{
 *   email: string,
 *   password?: string,
 *   fullName?: string,
 *   role?: 'admin' | 'storekeeper' | 'analyst',
 *   phone?: string | null,
 *   isActive?: boolean,
 * }} overrides
 * @returns {Promise<{
 *   id: number,
 *   email: string,
 *   full_name: string,
 *   role: string,
 *   phone: string | null,
 *   is_active: boolean,
 * }>}
 */
export async function createUserFactory(overrides) {
  const {
    email,
    password = DEFAULT_TEST_PASSWORD,
    fullName = 'Тестовый сотрудник',
    role = 'storekeeper',
    phone = null,
    isActive = true,
  } = overrides;

  if (!email) throw new TypeError('createUserFactory: email is required');

  const passwordHash = await hashPassword(password);
  const { rows } = await query(
    `insert into users (email, password_hash, full_name, role, phone, is_active)
     values ($1, $2, $3, $4, $5, $6)
     returning id, email, full_name, role, phone, is_active`,
    [email, passwordHash, fullName, role, phone, isActive],
  );

  return rows[0];
}

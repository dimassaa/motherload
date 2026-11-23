import { withTransaction } from '../db/pool.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import * as users from '../repositories/users.js';
import * as audit from './audit.js';
import { hashPassword, verifyPassword } from './auth.js';

// PostgreSQL unique violation. Only the email column on `users` is unique, so
// this code can be translated into a readable duplicate-address message.
const UNIQUE_VIOLATION = '23505';

const LAST_ADMIN_DEACTIVATE_MESSAGE =
  'Нельзя деактивировать последнего администратора: в системе должен остаться хотя бы один активный администратор.';

const LAST_ADMIN_DEMOTE_MESSAGE =
  'Нельзя снять роль администратора с последнего администратора: в системе должен остаться хотя бы один активный администратор.';

/**
 * Every account for the administration table, sorted by name.
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export function list() {
  return users.listUsers();
}

/**
 * Load one account or fail with a human message.
 * @param {number} id
 * @throws {NotFoundError}
 */
export async function getById(id) {
  const user = await users.findById(id);
  if (!user) throw new NotFoundError('Пользователь не найден.');
  return user;
}

/**
 * Create an account on behalf of an administrator.
 *
 * The password policy runs inside `hashPassword`, so a weak password is rejected
 * before any row is written. The user row and its audit entry share one
 * transaction: an audit failure rolls the account creation back instead of
 * leaving an untracked user.
 * @param {{
 *   fullName: string,
 *   email: string,
 *   role: 'admin' | 'storekeeper' | 'analyst',
 *   phone: string | null,
 *   password: string,
 * }} input
 * @param {{ req: import('express').Request }} context
 * @throws {ValidationError} on a password policy failure or a duplicate email
 */
export async function create({ fullName, email, role, phone, password }, { req }) {
  const passwordHash = await hashPassword(password);

  try {
    return await withTransaction(async (client) => {
      const created = await users.createUser(
        { email, passwordHash, fullName, role, phone },
        client,
      );

      await audit.record(
        {
          action: 'user.create',
          entityType: 'user',
          entityId: created.id,
          details: { email: created.email, role: created.role, fullName: created.fullName },
          req,
        },
        { client },
      );

      return created;
    });
  } catch (error) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new ValidationError('Пользователь с таким email уже существует. Укажите другой адрес.');
    }
    throw error;
  }
}

/**
 * Change the fields an administrator owns. Email is not part of the input: it is
 * the login and stays immutable, while the SQL update never touches it.
 *
 * The active-administrator rows are locked before the decision, so a concurrent
 * demotion waits instead of counting the same stale set of admins. The update
 * and its audit row commit together.
 * @param {number} id
 * @param {{ fullName: string, role: 'admin' | 'storekeeper' | 'analyst', phone: string | null }} input
 * @param {{ req: import('express').Request }} context
 * @throws {NotFoundError | ValidationError}
 */
export async function update(id, { fullName, role, phone }, { req }) {
  return withTransaction(async (client) => {
    const activeAdmins = await users.lockActiveAdmins(client);
    const current = await users.lockById(id, client);
    if (!current) throw new NotFoundError('Пользователь не найден.');

    // Demoting the last active admin locks the system exactly like deactivating
    // them, so the same invariant is enforced for a role change.
    if (current.isActive && current.role === 'admin' && role !== 'admin') {
      if (activeAdmins.length <= 1) throw new ValidationError(LAST_ADMIN_DEMOTE_MESSAGE);
    }

    const updated = await users.updateUser(id, { fullName, role, phone }, client);
    if (!updated) throw new NotFoundError('Пользователь не найден.');

    await audit.record(
      {
        action: 'user.update',
        entityType: 'user',
        entityId: id,
        details: { fullName, role, phone },
        req,
      },
      { client },
    );

    return updated;
  });
}

/**
 * Flip an account between active and inactive.
 *
 * Deactivation is refused for the acting administrator and for the last active
 * administrator, because either would remove the ability to administer the
 * system. The active-admin rows are locked before the count, so two admins
 * deactivating each other at the same moment cannot both pass; the second
 * transaction waits, then sees the admin set the first one committed.
 * @param {number} id
 * @param {{ req: import('express').Request }} context
 * @throws {NotFoundError | ValidationError}
 */
export async function toggleActive(id, { req }) {
  return withTransaction(async (client) => {
    const activeAdmins = await users.lockActiveAdmins(client);
    const user = await users.lockById(id, client);
    if (!user) throw new NotFoundError('Пользователь не найден.');

    const nextActive = !user.isActive;

    if (!nextActive) {
      if (user.role === 'admin' && activeAdmins.length <= 1) {
        throw new ValidationError(LAST_ADMIN_DEACTIVATE_MESSAGE);
      }

      if (user.id === req.user?.id) {
        throw new ValidationError('Нельзя деактивировать собственную учётную запись.');
      }
    }

    const updated = await users.setActive(id, nextActive, client);
    if (!updated) throw new NotFoundError('Пользователь не найден.');

    await audit.record(
      {
        action: 'user.toggle',
        entityType: 'user',
        entityId: id,
        details: { email: user.email, isActive: nextActive },
        req,
      },
      { client },
    );

    return updated;
  });
}

/**
 * Replace another user's password from the administration screen.
 *
 * Every stored session of the target is deleted: a reset is the action taken
 * when an account may be compromised, so leaving old cookies valid would defeat
 * its purpose. When an administrator resets their own password the submitting
 * session is spared, because the request that performed the reset must not log
 * itself out. Password hashing happens before the transaction opens: it is slow
 * and does not need the locks.
 * @param {number} id
 * @param {string} password
 * @param {{ req: import('express').Request, sessionId?: string | null }} context
 * @throws {NotFoundError | ValidationError}
 */
export async function adminResetPassword(id, password, { req, sessionId = null }) {
  const passwordHash = await hashPassword(password);

  return withTransaction(async (client) => {
    const user = await users.lockById(id, client);
    if (!user) throw new NotFoundError('Пользователь не найден.');

    const keepsCurrentSession = user.id === req.user?.id;

    await users.updatePassword(id, passwordHash, client);
    await users.deleteSessionsForUser(id, {
      exceptSid: keepsCurrentSession ? sessionId : null,
      client,
    });

    await audit.record(
      {
        action: 'user.password_reset',
        entityType: 'user',
        entityId: id,
        details: { email: user.email },
        req,
      },
      { client },
    );

    return { user, keepsCurrentSession };
  });
}

/**
 * Change the authenticated user's own password.
 *
 * The account is re-read by id, not email, and the hash is verified before the
 * transaction so a stolen open session cannot silently rotate the password.
 * Every other session is deleted; the session that performed the change is
 * kept, matching the profile spec. The write and audit row commit together.
 * @param {{ id: number }} user
 * @param {{
 *   currentPassword: string,
 *   newPassword: string,
 *   sessionId: string | null,
 *   req: import('express').Request,
 * }} input
 * @throws {NotFoundError | ValidationError}
 */
export async function changeOwnPassword(user, { currentPassword, newPassword, sessionId, req }) {
  const account = await users.findById(user.id, { includePasswordHash: true });
  if (!account) throw new NotFoundError('Пользователь не найден.');

  const matches = await verifyPassword(account.passwordHash, currentPassword);
  if (!matches) {
    throw new ValidationError(
      'Текущий пароль не совпадает. Проверьте раскладку и попробуйте снова.',
    );
  }

  const passwordHash = await hashPassword(newPassword);

  return withTransaction(async (client) => {
    await users.updatePassword(user.id, passwordHash, client);
    await users.deleteSessionsForUser(user.id, { exceptSid: sessionId, client });

    await audit.record(
      {
        action: 'profile.password',
        entityType: 'user',
        entityId: user.id,
        req,
      },
      { client },
    );
  });
}

/**
 * Update the fields a user owns on their own profile. The update and audit row
 * share a transaction.
 * @param {{ id: number }} user
 * @param {{ fullName: string, phone: string | null }} input
 * @param {{ req: import('express').Request }} context
 * @throws {NotFoundError}
 */
export async function updateOwnProfile(user, { fullName, phone }, { req }) {
  return withTransaction(async (client) => {
    const updated = await users.updateProfile(user.id, { fullName, phone }, client);
    if (!updated) throw new NotFoundError('Пользователь не найден.');

    await audit.record(
      {
        action: 'profile.update',
        entityType: 'user',
        entityId: user.id,
        details: { fullName, phone },
        req,
      },
      { client },
    );

    return updated;
  });
}

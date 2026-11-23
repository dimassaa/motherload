import { NotFoundError, ValidationError } from '../domain/errors.js';
import * as users from '../repositories/users.js';
import * as audit from './audit.js';
import { hashPassword, verifyPassword } from './auth.js';

// PostgreSQL unique violation. Only the email column on `users` is unique, so
// this code can be translated into a readable duplicate-address message.
const UNIQUE_VIOLATION = '23505';

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
 * The password policy runs inside `hashPassword`, so a weak password is rejected
 * before any row is written. The audit entry records the new account's identity
 * and role but never the password.
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

  let created;
  try {
    created = await users.createUser({ email, passwordHash, fullName, role, phone });
  } catch (error) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new ValidationError('Пользователь с таким email уже существует. Укажите другой адрес.');
    }
    throw error;
  }

  await audit.record({
    action: 'user.create',
    entityType: 'user',
    entityId: created.id,
    details: { email: created.email, role: created.role, fullName: created.fullName },
    req,
  });

  return created;
}

/**
 * Change the fields an administrator owns. Email is not part of the input: it is
 * the login and stays immutable, while the SQL update never touches it.
 * @param {number} id
 * @param {{ fullName: string, role: 'admin' | 'storekeeper' | 'analyst', phone: string | null }} input
 * @param {{ req: import('express').Request }} context
 * @throws {NotFoundError}
 */
export async function update(id, { fullName, role, phone }, { req }) {
  const current = await getById(id);

  // Demoting the last active admin locks the system exactly like deactivating
  // them, so the same invariant is enforced for a role change.
  if (current.isActive && current.role === 'admin' && role !== 'admin') {
    const activeAdmins = await users.countActiveAdmins();
    if (activeAdmins <= 1) {
      throw new ValidationError(
        'Нельзя снять роль администратора с последнего администратора: в системе должен остаться хотя бы один активный администратор.',
      );
    }
  }

  const updated = await users.updateUser(id, { fullName, role, phone });
  if (!updated) throw new NotFoundError('Пользователь не найден.');

  await audit.record({
    action: 'user.update',
    entityType: 'user',
    entityId: id,
    details: { fullName, role, phone },
    req,
  });

  return updated;
}

/**
 * Flip an account between active and inactive.
 *
 * Deactivation is refused for the acting administrator and for the last active
 * administrator, because either would remove the ability to administer the
 * system. The last-admin check runs first: it is the stronger, less obvious
 * guard and its message explains the actual risk.
 * @param {number} id
 * @param {{ req: import('express').Request }} context
 * @throws {NotFoundError | ValidationError}
 */
export async function toggleActive(id, { req }) {
  const user = await getById(id);
  const nextActive = !user.isActive;

  if (!nextActive) {
    if (user.role === 'admin') {
      const activeAdmins = await users.countActiveAdmins();
      if (activeAdmins <= 1) {
        throw new ValidationError(
          'Нельзя деактивировать последнего администратора: в системе должен остаться хотя бы один активный администратор.',
        );
      }
    }

    if (user.id === req.user?.id) {
      throw new ValidationError('Нельзя деактивировать собственную учётную запись.');
    }
  }

  const updated = await users.setActive(id, nextActive);
  if (!updated) throw new NotFoundError('Пользователь не найден.');

  await audit.record({
    action: 'user.toggle',
    entityType: 'user',
    entityId: id,
    details: { email: user.email, isActive: nextActive },
    req,
  });

  return updated;
}

/**
 * Replace another user's password from the administration screen.
 *
 * Every stored session of the target is deleted: a reset is the action taken
 * when an account may be compromised, so leaving old cookies valid would defeat
 * its purpose. The current administrator's session is untouched unless the
 * target is the administrator themselves.
 * @param {number} id
 * @param {string} password
 * @param {{ req: import('express').Request }} context
 * @throws {NotFoundError | ValidationError}
 */
export async function adminResetPassword(id, password, { req }) {
  const user = await getById(id);
  const passwordHash = await hashPassword(password);

  await users.updatePassword(id, passwordHash);
  await users.deleteSessionsForUser(id);

  await audit.record({
    action: 'user.password_reset',
    entityType: 'user',
    entityId: id,
    details: { email: user.email },
    req,
  });

  return user;
}

/**
 * Change the authenticated user's own password.
 *
 * The current password is verified before the policy and the write, so a stolen
 * open session cannot silently rotate the password. Other sessions are deleted
 * and the session that performed the change is kept, matching the profile spec.
 * @param {{ id: number, email: string }} user
 * @param {{
 *   currentPassword: string,
 *   newPassword: string,
 *   sessionId: string | null,
 *   req: import('express').Request,
 * }} input
 * @throws {NotFoundError | ValidationError}
 */
export async function changeOwnPassword(user, { currentPassword, newPassword, sessionId, req }) {
  const account = await users.findByEmail(user.email);
  if (!account) throw new NotFoundError('Пользователь не найден.');

  const matches = await verifyPassword(account.passwordHash, currentPassword);
  if (!matches) {
    throw new ValidationError(
      'Текущий пароль не совпадает. Проверьте раскладку и попробуйте снова.',
    );
  }

  const passwordHash = await hashPassword(newPassword);
  await users.updatePassword(user.id, passwordHash);
  await users.deleteSessionsForUser(user.id, { exceptSid: sessionId });

  await audit.record({
    action: 'profile.password',
    entityType: 'user',
    entityId: user.id,
    req,
  });
}

/**
 * Update the fields a user owns on their own profile.
 * @param {{ id: number }} user
 * @param {{ fullName: string, phone: string | null }} input
 * @param {{ req: import('express').Request }} context
 * @throws {NotFoundError}
 */
export async function updateOwnProfile(user, { fullName, phone }, { req }) {
  const updated = await users.updateProfile(user.id, { fullName, phone });
  if (!updated) throw new NotFoundError('Пользователь не найден.');

  await audit.record({
    action: 'profile.update',
    entityType: 'user',
    entityId: user.id,
    details: { fullName, phone },
    req,
  });

  return updated;
}

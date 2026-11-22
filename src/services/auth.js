import argon2 from 'argon2';
import { NotFoundError, UnauthorizedError, ValidationError } from '../domain/errors.js';
import * as users from '../repositories/users.js';
import * as audit from './audit.js';

const MIN_PASSWORD_LENGTH = 10;

export const PASSWORD_POLICY_MESSAGE =
  'Пароль должен быть не короче 10 символов и содержать строчную и заглавную буквы, цифру.';

const INVALID_CREDENTIALS_MESSAGE = 'Неверный email или пароль';

// A real Argon2id hash of a throwaway string, used only when the email does not
// exist. Verifying against it costs the same as a real account, so response
// timing cannot be used to enumerate emails. It belongs to no user and is never
// accepted as a credential.
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$PMACdyaTWJzEVGRxCVmhTQ$9UdQRy8j2AqoWENp/0LQtlmnOUNVH6mifXTmrtjWDkA';

/**
 * Enforce the storage policy for every new or changed password.
 * The check deliberately does not run when verifying a login attempt: an
 * existing account must still be able to sign in after a policy change.
 * @param {unknown} password
 * @throws {ValidationError} with a Russian, user-facing message
 */
export function assertPasswordPolicy(password) {
  if (
    typeof password !== 'string' ||
    password.length < MIN_PASSWORD_LENGTH ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/[0-9]/.test(password)
  ) {
    throw new ValidationError(PASSWORD_POLICY_MESSAGE);
  }
}

/**
 * Hash a password with Argon2id using library defaults.
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  assertPasswordPolicy(password);
  return argon2.hash(password, { type: argon2.argon2id });
}

/**
 * Compare a password against a stored Argon2id hash.
 * A malformed stored hash cannot match any input, so it is treated as a failed
 * verification instead of turning a login attempt into a 500 response.
 * @param {string} hash
 * @param {unknown} password
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(hash, password) {
  if (typeof hash !== 'string' || hash === '' || typeof password !== 'string') return false;

  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * Create a user, hashing the password before it reaches the repository.
 * @param {{
 *   email: string,
 *   password: string,
 *   fullName: string,
 *   role: 'admin' | 'storekeeper' | 'analyst',
 *   phone?: string | null,
 *   isActive?: boolean,
 * }} input
 */
export async function createUser(input) {
  const passwordHash = await hashPassword(input.password);

  return users.createUser({
    email: input.email,
    passwordHash,
    fullName: input.fullName,
    role: input.role,
    phone: input.phone ?? null,
    isActive: input.isActive ?? true,
  });
}

/**
 * Replace a user's password after checking the policy.
 * @param {number} id
 * @param {string} password
 * @throws {NotFoundError} when the user does not exist
 */
export async function updatePassword(id, password) {
  const passwordHash = await hashPassword(password);
  const user = await users.updatePassword(id, passwordHash);

  if (!user) throw new NotFoundError('Пользователь не найден.');
  return user;
}

/**
 * Activate or deactivate a user.
 * @param {number} id
 * @param {boolean} isActive
 * @throws {NotFoundError} when the user does not exist
 */
export async function setActive(id, isActive) {
  const user = await users.setActive(id, isActive);
  if (!user) throw new NotFoundError('Пользователь не найден.');
  return user;
}

/**
 * Authenticate an email and password pair.
 *
 * The same generic error is returned for an unknown email, a wrong password and
 * an inactive account, so the login form cannot be used to enumerate users.
 * Both outcomes are audited; the password never reaches the audit record.
 * @param {{ email: string, password: string, req: import('express').Request }} input
 * @returns {Promise<ReturnType<typeof users.findById>>}
 * @throws {UnauthorizedError} on any credential failure
 */
export async function login({ email, password, req }) {
  const normalizedEmail = typeof email === 'string' ? email.trim() : '';
  const user = normalizedEmail === '' ? null : await users.findByEmail(normalizedEmail);

  // Hash verification always runs, including for unknown and inactive
  // accounts: skipping it would make the response time reveal which emails
  // exist. The dummy hash keeps the unknown-email path at one full verify.
  const passwordMatches = await verifyPassword(user?.passwordHash ?? DUMMY_PASSWORD_HASH, password);

  if (!user || !user.isActive || !passwordMatches) {
    await audit.record({
      userId: user?.id ?? null,
      action: 'auth.login_failed',
      details: { email: normalizedEmail },
      req,
    });
    throw new UnauthorizedError(INVALID_CREDENTIALS_MESSAGE);
  }

  await users.touchLastLogin(user.id);
  await audit.record({ userId: user.id, action: 'auth.login', req });

  return users.findById(user.id);
}

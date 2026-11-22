import { env } from './env.js';

export const SESSION_COOKIE_NAME = 'motherload.sid';

/**
 * Cookie attributes shared by express-session and `res.clearCookie`.
 *
 * `maxAge` is intentionally not part of this object: express-session adds it
 * when creating the session, while `res.clearCookie` sets its own epoch expiry
 * and an inherited `Max-Age` would fight with it.
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.https,
    path: '/',
  };
}

export const SESSION_COOKIE_MAX_AGE_MS = env.sessionTtlHours * 3600 * 1000;

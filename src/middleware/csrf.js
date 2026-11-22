import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ForbiddenError } from '../domain/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOKEN_BYTES = 32;

const CSRF_ERROR_MESSAGE =
  'Не удалось подтвердить безопасность формы. Обновите страницу и попробуйте снова.';

function createToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Constant-time comparison. Length is checked first because `timingSafeEqual`
 * throws on differently sized buffers.
 * @param {unknown} expected
 * @param {unknown} received
 */
function tokensMatch(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;

  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);

  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

/** Read the token from the header first so fetch clients do not need a body. */
function readSubmittedToken(req) {
  const headerToken = req.get?.('x-csrf-token');
  if (typeof headerToken === 'string' && headerToken !== '') return headerToken;

  const bodyToken = req.body?._csrf;
  return typeof bodyToken === 'string' ? bodyToken : null;
}

/**
 * Session-bound CSRF protection.
 *
 * The token is generated once per session and accepted from a hidden `_csrf`
 * field or the `X-CSRF-Token` header. Safe methods always pass; mutating methods
 * fail with 403 when the token is missing or does not match.
 *
 * Must run after the session middleware and before any route that mutates state.
 * The web router mounts it for every route. A future API router must do the
 * same, otherwise header-based fetch mutations would bypass the check.
 */
export function csrfProtection(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = createToken();

  const expectedToken = req.session.csrfToken;
  // Expose it to templates and fetch code even on pages without a form.
  res.locals.csrfToken = expectedToken;

  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  if (!tokensMatch(expectedToken, readSubmittedToken(req))) {
    next(new ForbiddenError(CSRF_ERROR_MESSAGE));
    return;
  }

  next();
}

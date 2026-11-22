import { ForbiddenError, UnauthorizedError } from '../domain/errors.js';
import { findById } from '../repositories/users.js';

/**
 * Load the user referenced by the session on every request.
 *
 * A user deactivated after signing in loses access immediately: the stale
 * session id is dropped instead of trusted. `attachLocals` runs later and
 * publishes the result as `currentUser`.
 */
export async function attachUser(req, res, next) {
  req.user = null;
  const userId = req.session?.userId;

  if (!userId) {
    next();
    return;
  }

  try {
    const user = await findById(userId);
    if (!user || !user.isActive) {
      delete req.session.userId;
      next();
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Reject guests. Browser navigations return to the landing page with a hint;
 * non-GET callers get 401 so an API client is not silently redirected.
 */
export function requireAuth(req, res, next) {
  if (req.user) {
    next();
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (typeof req.flash === 'function') req.flash('info', 'Войдите, чтобы продолжить.');
    res.redirect('/');
    return;
  }

  next(new UnauthorizedError('Войдите, чтобы продолжить.'));
}

/**
 * Require one of the given roles. This is the server-side check; hiding a link
 * in a template is convenience only and never a security boundary.
 * @param {...('admin' | 'storekeeper' | 'analyst')} roles
 */
export function requireRole(...roles) {
  return function roleGuard(req, res, next) {
    if (!req.user) {
      requireAuth(req, res, next);
      return;
    }

    if (!roles.includes(req.user.role)) {
      next(new ForbiddenError('Недостаточно прав для этого действия.'));
      return;
    }

    next();
  };
}

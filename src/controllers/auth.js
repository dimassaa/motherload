import { z } from 'zod';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '../config/session.js';
import { UnauthorizedError } from '../domain/errors.js';
import { login as loginService } from '../services/auth.js';
import * as audit from '../services/audit.js';

const LANDING_TITLE = 'Motherload — складской терминал';
const LOGIN_FORM_ERROR = 'Введите email и пароль.';

const loginSchema = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
});

function renderLanding(res, { status = 200, email = '', error = null } = {}) {
  res.status(status).render('pages/landing', {
    title: LANDING_TITLE,
    email,
    loginError: error,
  });
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * `GET /` — public landing and login card.
 * An existing session skips the form and goes straight to the dashboard.
 */
export function showLanding(req, res) {
  if (req.user) {
    res.redirect('/dashboard');
    return;
  }

  renderLanding(res);
}

/**
 * `POST /login` — authenticate, rotate the session id to prevent fixation and
 * persist only the user id. Bad credentials re-render the form with the same
 * generic message for every failure mode.
 */
export async function login(req, res, next) {
  const parsed = loginSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    renderLanding(res, {
      status: 400,
      email: typeof req.body?.email === 'string' ? req.body.email : '',
      error: LOGIN_FORM_ERROR,
    });
    return;
  }

  try {
    const user = await loginService({
      email: parsed.data.email,
      password: parsed.data.password,
      req,
    });

    await regenerateSession(req);
    req.session.userId = user.id;
    await saveSession(req);

    res.redirect('/dashboard');
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      renderLanding(res, { status: 401, email: parsed.data.email, error: error.message });
      return;
    }

    next(error);
  }
}

/**
 * `POST /logout` — audit the authenticated user, then destroy the server-side
 * session. CSRF protection already ran as part of the web router.
 */
export async function logout(req, res, next) {
  try {
    if (req.user) await audit.record({ action: 'auth.logout', req });
    await destroySession(req);
    // Destroying the session row already invalidates the id; clearing the cookie
    // as well stops the browser from sending a dead value for the next 8 hours.
    res.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions());
    res.redirect('/');
  } catch (error) {
    next(error);
  }
}

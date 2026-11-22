import { rateLimit } from 'express-rate-limit';

const WINDOW_MS = 60 * 1000;

/**
 * Build fresh limiter instances for one application.
 *
 * The stores are in-memory and therefore app-scoped: tests build many apps in a
 * single process, and a shared counter would leak a 429 from one test into the
 * next. Production creates the app once, so one store is enough.
 * @returns {{
 *   globalLimiter: import('express').RequestHandler,
 *   loginLimiter: import('express').RequestHandler,
 * }}
 */
export function createRateLimiters() {
  const globalLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Слишком много запросов. Подождите минуту и попробуйте снова.',
  });

  const loginLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Слишком много попыток входа. Подождите минуту и попробуйте снова.',
  });

  return { globalLimiter, loginLimiter };
}

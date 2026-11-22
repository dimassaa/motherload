import { Router } from 'express';
import * as authController from '../controllers/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';
import { isDatabaseUp } from '../repositories/health.js';

/**
 * Web routes.
 *
 * `/healthz` is registered before the CSRF middleware so monitoring probes do
 * not create a session row on every poll; every other route renders forms or
 * mutates state and must carry a token.
 * @param {{ loginLimiter: import('express').RequestHandler }} limiters
 */
export function createWebRouter({ loginLimiter }) {
  const router = Router();

  router.get('/healthz', async (req, res) => {
    const up = await isDatabaseUp();
    res.status(up ? 200 : 503).json({
      status: up ? 'ok' : 'degraded',
      db: up ? 'up' : 'down',
    });
  });

  router.use(csrfProtection);

  router.get('/', authController.showLanding);
  router.post('/login', loginLimiter, authController.login);
  router.post('/logout', authController.logout);
  router.get('/dashboard', requireAuth, authController.showDashboard);

  return router;
}

import { Router } from 'express';
import * as adminController from '../controllers/admin.js';
import * as adminDirectoriesController from '../controllers/admin-directories.js';
import * as authController from '../controllers/auth.js';
import * as profileController from '../controllers/profile.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
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

  router.get('/profile', requireAuth, profileController.showProfile);
  router.post('/profile', requireAuth, profileController.updateProfile);
  router.post('/profile/password', requireAuth, profileController.changePassword);

  // `/admin/users/new` is registered before `/:id` so the literal segment is not
  // swallowed by the id parameter. The form posts to the collection endpoint;
  // the `/new` POST alias keeps the URL the brief lists working as well.
  router.get('/admin/users', requireRole('admin'), adminController.showUsers);
  router.get('/admin/users/new', requireRole('admin'), adminController.showNewUser);
  router.post('/admin/users', requireRole('admin'), adminController.createUser);
  router.post('/admin/users/new', requireRole('admin'), adminController.createUser);
  router.get('/admin/users/:id', requireRole('admin'), adminController.showEditUser);
  router.post('/admin/users/:id', requireRole('admin'), adminController.updateUser);
  router.post('/admin/users/:id/password', requireRole('admin'), adminController.resetPassword);
  router.post('/admin/users/:id/toggle', requireRole('admin'), adminController.toggleUser);
  router.get('/admin/audit', requireRole('admin'), adminController.showAudit);

  // Reference data is one screen with tabs; the tab is part of the URL so a
  // bookmark and the back button both return to the same directory.
  router.get(
    '/admin/directories',
    requireRole('admin'),
    adminDirectoriesController.showDirectories,
  );
  router.get(
    '/admin/directories/:entity',
    requireRole('admin'),
    adminDirectoriesController.showDirectories,
  );
  router.post(
    '/admin/directories/:entity',
    requireRole('admin'),
    adminDirectoriesController.createDirectory,
  );
  router.post(
    '/admin/directories/:entity/:id/delete',
    requireRole('admin'),
    adminDirectoriesController.deleteDirectory,
  );
  router.post(
    '/admin/directories/:entity/:id',
    requireRole('admin'),
    adminDirectoriesController.updateDirectory,
  );

  return router;
}

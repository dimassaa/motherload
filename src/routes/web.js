import { Router } from 'express';
import * as adminController from '../controllers/admin.js';
import * as adminComponentsController from '../controllers/admin-components.js';
import * as adminDirectoriesController from '../controllers/admin-directories.js';
import * as analyticsController from '../controllers/analytics.js';
import * as authController from '../controllers/auth.js';
import * as componentsController from '../controllers/components.js';
import * as dashboardController from '../controllers/dashboard.js';
import * as inventoryController from '../controllers/inventory.js';
import * as profileController from '../controllers/profile.js';
import * as stockController from '../controllers/stock.js';
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
  router.get('/dashboard', requireAuth, dashboardController.showDashboard);

  // The catalog is readable by every role. Archiving and editing stay on the
  // admin routes so the read model cannot be used to mutate a position.
  router.get('/components', requireAuth, componentsController.showList);
  router.get('/components/:id', requireAuth, componentsController.showCard);

  // Analytics is read-only for every role: analysts need it without stock
  // rights, and admins/storekeepers read the same numbers. There are no POST
  // routes, so there is nothing to protect beyond authentication.
  router.get('/analytics/abc', requireAuth, analyticsController.showAbc);
  router.get('/analytics/xyz', requireAuth, analyticsController.showXyz);
  router.get('/analytics/reorder', requireAuth, analyticsController.showReorder);

  // Stock operations are a storekeeper/admin workflow. Every route enforces
  // the role on the server; the navigation only hides the links. `/stock`
  // itself is a bookmark-friendly entry point into the receipts list. `/new`
  // is registered before `/:id` so the literal segment is not swallowed by the
  // id parameter. Documents are immutable: there are no edit or delete routes.
  router.get('/stock', requireRole('admin', 'storekeeper'), stockController.showStock);
  router.get('/stock/receipts', requireRole('admin', 'storekeeper'), stockController.showReceipts);
  router.get(
    '/stock/receipts/new',
    requireRole('admin', 'storekeeper'),
    stockController.showReceiptForm,
  );
  router.post(
    '/stock/receipts',
    requireRole('admin', 'storekeeper'),
    stockController.createReceipt,
  );
  router.get(
    '/stock/receipts/:id',
    requireRole('admin', 'storekeeper'),
    stockController.showReceipt,
  );

  router.get('/stock/issues', requireRole('admin', 'storekeeper'), stockController.showIssues);
  router.get(
    '/stock/issues/new',
    requireRole('admin', 'storekeeper'),
    stockController.showIssueForm,
  );
  router.post('/stock/issues', requireRole('admin', 'storekeeper'), stockController.createIssue);
  router.get('/stock/issues/:id', requireRole('admin', 'storekeeper'), stockController.showIssue);

  router.get(
    '/stock/transfers',
    requireRole('admin', 'storekeeper'),
    stockController.showTransfers,
  );
  router.get(
    '/stock/transfers/new',
    requireRole('admin', 'storekeeper'),
    stockController.showTransferForm,
  );
  router.post(
    '/stock/transfers',
    requireRole('admin', 'storekeeper'),
    stockController.createTransfer,
  );
  router.get(
    '/stock/transfers/:id',
    requireRole('admin', 'storekeeper'),
    stockController.showTransfer,
  );

  // Inventory is a storekeeper/admin workflow; approval is a separate admin
  // right, so the approve route narrows the role instead of relying on the
  // hidden button. `/new` is registered before `/:id` to keep it literal.
  router.get('/inventory', requireRole('admin', 'storekeeper'), inventoryController.showList);
  router.get('/inventory/new', requireRole('admin', 'storekeeper'), inventoryController.showNew);
  router.post('/inventory', requireRole('admin', 'storekeeper'), inventoryController.createCount);
  router.get('/inventory/:id', requireRole('admin', 'storekeeper'), inventoryController.showCount);
  router.post(
    '/inventory/:id/lines',
    requireRole('admin', 'storekeeper'),
    inventoryController.saveLines,
  );
  router.post(
    '/inventory/:id/submit',
    requireRole('admin', 'storekeeper'),
    inventoryController.submitCount,
  );
  router.post('/inventory/:id/approve', requireRole('admin'), inventoryController.approveCount);
  router.post(
    '/inventory/:id/cancel',
    requireRole('admin', 'storekeeper'),
    inventoryController.cancelCount,
  );

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

  // Component administration. `/new` is registered before `/:id` so the
  // literal segment is not swallowed by the id parameter.
  router.get('/admin/components', requireRole('admin'), adminComponentsController.showList);
  router.get('/admin/components/new', requireRole('admin'), adminComponentsController.showNew);
  router.post('/admin/components', requireRole('admin'), adminComponentsController.createComponent);
  router.get('/admin/components/:id', requireRole('admin'), adminComponentsController.showEdit);
  router.post(
    '/admin/components/:id',
    requireRole('admin'),
    adminComponentsController.updateComponent,
  );
  router.post(
    '/admin/components/:id/archive',
    requireRole('admin'),
    adminComponentsController.archiveComponent,
  );
  router.post(
    '/admin/components/:id/delete',
    requireRole('admin'),
    adminComponentsController.deleteComponent,
  );

  return router;
}

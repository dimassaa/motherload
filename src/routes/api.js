import express, { Router } from 'express';
import * as stockController from '../controllers/stock.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';

// Body-parser failure types that are the caller's fault. They all become a 400
// in the API shape; without this map they reach the central middleware as
// unknown errors and look like a server failure.
const BODY_ERROR_MESSAGES = new Map([
  ['entity.parse.failed', 'Тело запроса должно быть корректным JSON.'],
  ['entity.too.large', 'Тело запроса слишком большое.'],
  ['charset.unsupported', 'Неподдерживаемая кодировка запроса. Используйте UTF-8.'],
  ['encoding.unsupported', 'Неподдерживаемая кодировка запроса. Используйте UTF-8.'],
]);

/**
 * Answer unprocessable request bodies in the API shape.
 *
 * It is mounted at the end of the API router, so only an authenticated client
 * that passed CSRF can reach it: a guest with malformed JSON still gets 401 and
 * a missing token still gets 403.
 */
function apiJsonErrorHandler(error, req, res, next) {
  const message = BODY_ERROR_MESSAGES.get(error.type);
  if (message) {
    res.status(400).json({ error: 'VALIDATION_ERROR', message });
    return;
  }

  next(error);
}

/**
 * JSON API used by progressive enhancement on stock forms.
 *
 * `requireAuth` runs before `csrfProtection` so an unauthenticated fetch gets a
 * 401 instead of a CSRF lecture. The preview exposes purchase costs, so it is
 * limited to the roles that may issue stock (admin, storekeeper); an analyst
 * gets 403. The web router mounts CSRF separately; this router must do the same,
 * otherwise header-based fetch calls would bypass double-submit.
 *
 * JSON parsing lives after CSRF because the token travels in `X-CSRF-Token`; a
 * malformed body from an unauthorised caller is then rejected before the parser
 * spends work on it and cannot mask the 401/403.
 */
export function createApiRouter() {
  const router = Router();

  router.use(requireAuth);
  router.use(requireRole('admin', 'storekeeper'));
  router.use(csrfProtection);
  router.use(express.json());

  router.post('/fifo-preview', stockController.previewFifo);

  router.use(apiJsonErrorHandler);

  return router;
}

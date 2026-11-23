import express, { Router } from 'express';
import * as stockController from '../controllers/stock.js';
import { requireAuth } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';

/**
 * Answer body-parser failures in the API shape.
 *
 * It is mounted at the end of the API router, so only an authenticated client
 * that passed CSRF can reach it: a guest with malformed JSON still gets 401 and
 * a missing token still gets 403. Without this handler the parse error reaches
 * the central middleware as an unknown failure and becomes a 500, although the
 * client's request is unprocessable.
 */
function apiJsonErrorHandler(error, req, res, next) {
  if (error.type === 'entity.parse.failed') {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Тело запроса должно быть корректным JSON.',
    });
    return;
  }

  next(error);
}

/**
 * JSON API used by progressive enhancement on stock forms.
 *
 * `requireAuth` runs before `csrfProtection` so an unauthenticated fetch gets a
 * 401 instead of a CSRF lecture. Both are required: the API mutates nothing
 * today, but a preview still exposes purchase costs and must not be readable by
 * a guest. The web router mounts CSRF separately; this router must do the same,
 * otherwise header-based fetch calls would bypass double-submit.
 *
 * JSON parsing lives after CSRF because the token travels in `X-CSRF-Token`; a
 * malformed body from an unauthorised caller is then rejected before the parser
 * spends work on it and cannot mask the 401/403.
 */
export function createApiRouter() {
  const router = Router();

  router.use(requireAuth);
  router.use(csrfProtection);
  router.use(express.json());

  router.post('/fifo-preview', stockController.previewFifo);

  router.use(apiJsonErrorHandler);

  return router;
}

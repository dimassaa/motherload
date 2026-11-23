import { z } from 'zod';
import { ConflictError, NotFoundError } from '../domain/errors.js';
import * as alerts from '../services/alerts.js';
import * as directories from '../services/directories.js';

/** `/alerts` is the only list the page shows; mutations redirect back here. */
const BASE_PATH = '/alerts';

/**
 * Query parsing for the alert list.
 *
 * A stale bookmark with `?type=foo` or `?status=bar` falls back to the default
 * selection instead of producing an empty table the user cannot explain. The
 * same tolerant filter pattern is used by the catalog and analytics screens.
 */
const filterSchema = z.object({
  type: z.preprocess(
    (value) => (typeof value === 'string' && value !== '' ? value : 'all'),
    z.enum(['all', ...alerts.ALERT_TYPES]).catch('all'),
  ),
  status: z.preprocess(
    (value) => (typeof value === 'string' && value !== '' ? value : 'active'),
    z.enum([...alerts.ALERT_STATUS_FILTERS]).catch('active'),
  ),
  warehouseId: z.preprocess(
    (value) => (value === undefined || value === null || value === '' ? null : value),
    z.union([z.null(), z.coerce.number().int().positive()]).catch(null),
  ),
});

/** A malformed or vanished `:id` names no alert, so it is a 404, not a 500. */
function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError('Алерт не найден.');
  return id;
}

function renderList(res, result, options) {
  const role = res.locals.currentUser?.role;

  res.render('pages/alerts', {
    title: 'Алерты — Motherload',
    ...result,
    typeLabels: alerts.ALERT_TYPE_LABELS,
    options,
    canAcknowledge: role === 'admin' || role === 'storekeeper',
    canResolve: role === 'admin',
    canRecalculate: role === 'admin',
  });
}

async function loadOptions() {
  const warehouses = await directories.list('warehouses');
  return { warehouses };
}

/** `GET /alerts` — open conditions with type, status and warehouse filters. */
export async function showAlerts(req, res, next) {
  try {
    const query = filterSchema.parse(req.query ?? {});
    const [result, options] = await Promise.all([
      alerts.list({
        type: query.type === 'all' ? null : query.type,
        status: query.status,
        warehouseId: query.warehouseId,
      }),
      loadOptions(),
    ]);

    renderList(res, result, options);
  } catch (error) {
    next(error);
  }
}

/** `POST /alerts/recalculate` — admin-triggered reconciliation. */
export async function recalculate(req, res, next) {
  try {
    const result = await alerts.recalculate({ user: req.user, req });
    req.flash(
      'success',
      `Алерты пересчитаны: создано ${result.created}, закрыто ${result.resolved}.`,
    );
    res.redirect(BASE_PATH);
  } catch (error) {
    next(error);
  }
}

/** `POST /alerts/:id/acknowledge` — admin/storekeeper marks the alert as seen. */
export async function acknowledge(req, res, next) {
  try {
    const alertId = parseId(req.params.id);
    await alerts.acknowledge({ alertId, user: req.user, req });
    req.flash('success', 'Алерт подтверждён.');
    res.redirect(BASE_PATH);
  } catch (error) {
    // The condition may have been resolved by a recalculation between the page
    // render and the click. A flash on the list explains what happened; a raw
    // 409 page would lose the context.
    if (error instanceof ConflictError) {
      req.flash('error', error.message);
      res.redirect(BASE_PATH);
      return;
    }
    next(error);
  }
}

/** `POST /alerts/:id/resolve` — admin closes the alert manually. */
export async function resolve(req, res, next) {
  try {
    const alertId = parseId(req.params.id);
    await alerts.resolve({ alertId, user: req.user, req });
    req.flash('success', 'Алерт закрыт.');
    res.redirect(BASE_PATH);
  } catch (error) {
    if (error instanceof ConflictError) {
      req.flash('error', error.message);
      res.redirect(BASE_PATH);
      return;
    }
    next(error);
  }
}

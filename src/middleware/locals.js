import { logger } from '../lib/logger.js';
import { countOpen } from '../services/alerts.js';
import * as helpers from '../views/helpers.js';

/**
 * Attach the small set of values every EJS template may rely on.
 *
 * `req.user` is populated by the auth middleware; guests get the public chrome
 * and no badge query. Authenticated requests pay one indexed count so the
 * navigation can show open alerts on every screen; the count is published as
 * `openAlertsCount` and mirrored to the legacy `alertCount` local.
 *
 * The helpers are bound here so templates can call them as plain functions
 * (`formatMoney(...)`) without importing anything or receiving them page by page.
 */
export async function attachLocals(req, res, next) {
  res.locals.currentUser = req.user ?? null;
  res.locals.currentPath = req.path;
  res.locals.alertCount = res.locals.alertCount ?? 0;
  res.locals.openAlertsCount = res.locals.openAlertsCount ?? res.locals.alertCount;

  res.locals.formatMoney = helpers.formatMoney;
  res.locals.formatQty = helpers.formatQty;
  res.locals.formatNumber = helpers.formatNumber;
  res.locals.formatDate = helpers.formatDate;
  res.locals.formatDateTime = helpers.formatDateTime;
  res.locals.formatAge = helpers.formatAge;
  res.locals.formatPct = helpers.formatPct;
  res.locals.money = helpers.money;
  res.locals.roleLabel = helpers.roleLabel;
  res.locals.statusChip = helpers.statusChip;
  res.locals.queryString = helpers.queryString;

  // The CSRF token lives on the session, which only the request knows about.
  res.locals.csrfField = () => helpers.csrfField(req);

  if (!req.user) {
    next();
    return;
  }

  try {
    const openAlertsCount = await countOpen();
    res.locals.alertCount = openAlertsCount;
    res.locals.openAlertsCount = openAlertsCount;
    next();
  } catch (error) {
    // The badge is cosmetic. A count failure must not take down every
    // authenticated page: log it, show zero, and let the page render.
    (req.log ?? logger).warn({ err: error }, 'open alert count failed');
    res.locals.alertCount = 0;
    res.locals.openAlertsCount = 0;
    next();
  }
}

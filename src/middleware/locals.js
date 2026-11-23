import * as helpers from '../views/helpers.js';

/**
 * Attach the small set of values every EJS template may rely on.
 *
 * `req.user` is populated by the auth middleware in Task 4; until then it is
 * simply absent and templates render the public chrome. The helpers are bound
 * here so templates can call them as plain functions (`formatMoney(...)`)
 * without importing anything or receiving them page by page.
 */
export function attachLocals(req, res, next) {
  res.locals.currentUser = req.user ?? null;
  res.locals.currentPath = req.path;
  res.locals.alertCount = res.locals.alertCount ?? 0;

  res.locals.formatMoney = helpers.formatMoney;
  res.locals.formatQty = helpers.formatQty;
  res.locals.formatNumber = helpers.formatNumber;
  res.locals.formatDate = helpers.formatDate;
  res.locals.formatDateTime = helpers.formatDateTime;
  res.locals.formatPct = helpers.formatPct;
  res.locals.money = helpers.money;
  res.locals.roleLabel = helpers.roleLabel;
  res.locals.statusChip = helpers.statusChip;
  res.locals.queryString = helpers.queryString;

  // The CSRF token lives on the session, which only the request knows about.
  res.locals.csrfField = () => helpers.csrfField(req);

  next();
}

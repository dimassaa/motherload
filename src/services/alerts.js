import { env } from '../config/env.js';
import { ACTIVITY_WINDOW_DAYS, DEAD_STOCK_DAYS } from '../config/inventory.js';
import { withTransaction } from '../db/pool.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.js';
import * as repository from '../repositories/alerts.js';
import * as users from '../repositories/users.js';
import * as audit from './audit.js';

/**
 * Stock alerts.
 *
 * Alerts are a derived read model, not a source of truth: recalculation compares
 * the ledger with the catalogue thresholds and reconciles the `alerts` table.
 * Every rule here comes from spec §6.8.
 */

export const ALERT_TYPES = Object.freeze(['stockout', 'low_stock', 'overstock', 'dead_stock']);

export const ALERT_TYPE_LABELS = Object.freeze({
  stockout: 'Нет остатка',
  low_stock: 'Ниже минимума',
  overstock: 'Избыток',
  dead_stock: 'Без расхода',
});

export const ALERT_STATUS_FILTERS = Object.freeze([
  'active',
  'open',
  'acknowledged',
  'resolved',
  'all',
]);

const ALERT_SEVERITY = Object.freeze({
  stockout: 'critical',
  low_stock: 'warning',
  overstock: 'info',
  dead_stock: 'info',
});

const INTEGER_MAX = 2_147_483_647;
const DAY_MS = 24 * 60 * 60 * 1000;

const quantityFormatter = new Intl.NumberFormat('ru-BY', {
  maximumFractionDigits: 0,
});

/** Plain spaces keep the stored message predictable when copied into a report. */
function formatQty(value) {
  return quantityFormatter.format(value).replaceAll('\u00A0', ' ');
}

/** Calendar arithmetic stays on ISO strings so no local timezone leaks in. */
function addDays(iso, days) {
  const [year, month, day] = iso.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

/**
 * "Today" for the alert windows.
 *
 * Demo and test runs pin `ANALYTICS_REFERENCE_DATE`; production falls back to
 * the current Europe/Minsk calendar day. The same convention as the analytics
 * service keeps an alert and the reorder page describing the same period.
 */
function referenceDate() {
  if (env.analyticsReferenceDate) return env.analyticsReferenceDate;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Minsk',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

/**
 * Resolve the acting user. Routes pass `user`; the CLI has no session and may
 * pass nothing at all, because a system recalculation is a legitimate actor.
 * @param {{ user?: { id?: number } | null, userId?: number | null }} input
 * @returns {number | null}
 */
function readActorId({ user = null, userId = null }) {
  const raw = user?.id ?? userId ?? null;
  if (raw === null || raw === undefined) return null;

  if (!Number.isSafeInteger(raw) || raw < 1 || raw > INTEGER_MAX) {
    throw new ValidationError('Не удалось определить пользователя.');
  }

  return raw;
}

/** @param {unknown} value */
function readAlertId(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > INTEGER_MAX) {
    throw new NotFoundError('Алерт не найден.');
  }

  return value;
}

/**
 * Normalise a query filter instead of failing a bookmarked URL. The controller
 * validates too; this keeps direct service callers and scripts on the same
 * contract.
 * @param {unknown} value
 */
function normalizeType(value) {
  return typeof value === 'string' && ALERT_TYPES.includes(value) ? value : null;
}

/** @param {unknown} value */
function normalizeStatus(value) {
  return typeof value === 'string' && ALERT_STATUS_FILTERS.includes(value) ? value : 'active';
}

/** @param {unknown} value */
function normalizeWarehouseId(value) {
  const number = typeof value === 'string' && value !== '' ? Number(value) : value;
  return Number.isSafeInteger(number) && number > 0 && number <= INTEGER_MAX ? number : null;
}

/**
 * Russian explanation of one condition.
 *
 * The message is stored rather than assembled in the template: filters, reports
 * and the audit trail all need the same wording, and the numbers that produced
 * the alert must stay legible after a later recalculation changes them. Every
 * message names the SKU, the warehouse and the numbers that triggered it.
 * @param {{
 *   type: string, name: string, sku: string, unit: string,
 *   balance: number, minStock: number, maxStock: number | null,
 *   warehouseName: string,
 * }} pair
 * @returns {string}
 */
function buildMessage(pair) {
  const label = `${pair.name} (${pair.sku})`;
  const warehouse = `Склад: «${pair.warehouseName}».`;

  if (pair.type === 'stockout') {
    if (pair.minStock > 0) {
      return `${label}: остаток 0 ${pair.unit}. при минимуме ${formatQty(pair.minStock)} ${pair.unit}. ${warehouse}`;
    }
    return `${label}: остаток 0 ${pair.unit}., движения по складу были — позиция закончилась. ${warehouse}`;
  }

  if (pair.type === 'low_stock') {
    return `${label}: остаток ${formatQty(pair.balance)} ${pair.unit}. при минимуме ${formatQty(pair.minStock)} ${pair.unit}. ${warehouse}`;
  }

  if (pair.type === 'overstock') {
    return `${label}: остаток ${formatQty(pair.balance)} ${pair.unit}. при максимуме ${formatQty(pair.maxStock)} ${pair.unit}. ${warehouse}`;
  }

  return `${label}: остаток ${formatQty(pair.balance)} ${pair.unit}. без движения ${DEAD_STOCK_DAYS}+ дней. ${warehouse}`;
}

/**
 * Turn every participating pair into zero or more alert conditions.
 *
 * `stockout` and `low_stock` are mutually exclusive by construction, and a
 * non-positive balance is a stockout: showing a negative quantity under
 * "below minimum" would hide an impossible ledger state behind a softer label.
 *
 * Dead stock is about frozen capital, not about demand history: the stock must
 * itself be at least 90 days old and have no issue inside the 90-day window.
 * A position received yesterday after an old issue is not dead, while stock
 * received 200 days ago and never issued is exactly the case the alert exists
 * for. Stock age comes from the oldest positive receipt, not from when the
 * catalogue row was created.
 *
 * @param {Awaited<ReturnType<typeof repository.listCandidatePairs>>} pairs
 * @param {{ deadStart: string, stockDeadline: string }} window
 *   `deadStart` is the inclusive first day of the 90-day issue window;
 *   `stockDeadline` is the latest receipt date that makes stock 90 days old
 */
function buildCandidates(pairs, { deadStart, stockDeadline }) {
  const candidates = [];

  for (const pair of pairs) {
    const base = {
      componentId: pair.componentId,
      warehouseId: pair.warehouseId,
      name: pair.name,
      sku: pair.sku,
      unit: pair.unit,
      balance: pair.balance,
      minStock: pair.minStock,
      maxStock: pair.maxStock,
      warehouseName: pair.warehouseName,
    };

    if (pair.balance <= 0) {
      candidates.push({
        type: 'stockout',
        severity: ALERT_SEVERITY.stockout,
        componentId: pair.componentId,
        warehouseId: pair.warehouseId,
        message: buildMessage({ ...base, type: 'stockout' }),
      });
    } else if (pair.balance < pair.minStock) {
      candidates.push({
        type: 'low_stock',
        severity: ALERT_SEVERITY.low_stock,
        componentId: pair.componentId,
        warehouseId: pair.warehouseId,
        message: buildMessage({ ...base, type: 'low_stock' }),
      });
    }

    if (pair.maxStock !== null && pair.balance > pair.maxStock) {
      candidates.push({
        type: 'overstock',
        severity: ALERT_SEVERITY.overstock,
        componentId: pair.componentId,
        warehouseId: pair.warehouseId,
        message: buildMessage({ ...base, type: 'overstock' }),
      });
    }

    const noRecentIssue = pair.lastIssueDate === null || pair.lastIssueDate < deadStart;
    const stockIsOld = pair.stockSinceDate !== null && pair.stockSinceDate <= stockDeadline;

    if (pair.balance > 0 && noRecentIssue && stockIsOld) {
      candidates.push({
        type: 'dead_stock',
        severity: ALERT_SEVERITY.dead_stock,
        componentId: pair.componentId,
        warehouseId: pair.warehouseId,
        message: buildMessage({ ...base, type: 'dead_stock' }),
      });
    }
  }

  return candidates;
}

/** Uniqueness of a condition is exactly the partial unique index. */
function conditionKey({ type, componentId, warehouseId }) {
  return `${type}:${componentId}:${warehouseId}`;
}

/**
 * Recompute every alert condition and reconcile the open rows.
 *
 * The whole pass runs in one transaction. Existing unresolved alerts are locked,
 * new conditions are inserted with `ON CONFLICT DO NOTHING`, and rows whose
 * condition disappeared are resolved. Acknowledged alerts are left untouched
 * while their condition is true; manually acknowledging an alert is not a way
 * to stop it from auto-resolving later.
 *
 * @param {{
 *   user?: { id?: number, role?: string } | null,
 *   userId?: number | null,
 *   req?: import('express').Request,
 * }} [input]
 * @returns {Promise<{ created: number, resolved: number }>}
 * @throws {ForbiddenError} when an explicit actor is not an administrator
 */
export async function recalculate({ user = null, userId = null, req } = {}) {
  const actorId = readActorId({ user, userId });
  const reference = referenceDate();
  const activityStart = addDays(reference, -ACTIVITY_WINDOW_DAYS);
  const deadStart = addDays(reference, -(DEAD_STOCK_DAYS - 1));
  const stockDeadline = addDays(reference, -DEAD_STOCK_DAYS);

  return withTransaction(async (client) => {
    // The role is read from the database, not trusted from the session object.
    // A CLI pass has no actor and is deliberately allowed as a system action.
    if (actorId !== null) {
      const actor = await users.findById(actorId, { client });
      if (actor?.role !== 'admin') {
        throw new ForbiddenError('Пересчитывать алерты может только администратор.');
      }
    }

    const pairs = await repository.listCandidatePairs(client, { activityStart });
    const candidates = buildCandidates(pairs, { deadStart, stockDeadline });
    const existing = await repository.listActiveAlerts(client);
    const existingByKey = new Map(existing.map((alert) => [conditionKey(alert), alert]));

    let created = 0;

    for (const candidate of candidates) {
      const current = existingByKey.get(conditionKey(candidate));

      if (current) {
        if (current.message !== candidate.message || current.severity !== candidate.severity) {
          await repository.updateAlertContent(client, {
            id: current.id,
            severity: candidate.severity,
            message: candidate.message,
          });
        }
        continue;
      }

      const insertedId = await repository.insertOpenAlert(client, candidate);
      if (insertedId !== null) created += 1;
    }

    const candidateKeys = new Set(candidates.map(conditionKey));
    let resolved = 0;

    for (const alert of existing) {
      if (candidateKeys.has(conditionKey(alert))) continue;
      const changed = await repository.resolveAlert(client, alert.id);
      if (changed) resolved += 1;
    }

    await audit.record(
      {
        userId: actorId,
        action: 'alerts.recalculate',
        entityType: 'alert',
        details: { created, resolved },
        req,
      },
      { client },
    );

    return { created, resolved };
  });
}

/**
 * Alerts for the page, plus the unresolved count used by the badge.
 * @param {{ type?: string | null, status?: string, warehouseId?: number | string | null }} [filters]
 * @returns {Promise<{
 *   alerts: Awaited<ReturnType<typeof repository.listAlerts>>,
 *   openCount: number,
 *   filters: { type: string | null, status: string, warehouseId: number | null },
 * }>}
 */
export async function list(filters = {}) {
  const normalized = {
    type: normalizeType(filters.type),
    status: normalizeStatus(filters.status),
    warehouseId: normalizeWarehouseId(filters.warehouseId),
  };

  const [alerts, openCount] = await Promise.all([
    repository.listAlerts(normalized),
    repository.countOpenAlerts(),
  ]);

  return { alerts, openCount, filters: normalized };
}

/** Count unresolved alerts for the navigation badge. */
export function countOpen() {
  return repository.countOpenAlerts();
}

/**
 * Acknowledge an alert as admin or storekeeper.
 *
 * Acknowledging records that a human has seen the problem; it does not change
 * the stock and therefore does not resolve the condition. Only an open alert can
 * be acknowledged, which makes a double submit a clear 409 instead of silently
 * rewriting who saw it first.
 *
 * @param {{
 *   alertId: number,
 *   user?: { id?: number, role?: string } | null,
 *   userId?: number | null,
 *   req?: import('express').Request,
 * }} input
 * @returns {Promise<{ alertId: number, status: 'acknowledged' }>}
 */
export async function acknowledge({ alertId, user = null, userId = null, req }) {
  const id = readAlertId(alertId);
  const actorId = readActorId({ user, userId });

  return withTransaction(async (client) => {
    const actor = actorId === null ? null : await users.findById(actorId, { client });
    if (actor?.role !== 'admin' && actor?.role !== 'storekeeper') {
      throw new ForbiddenError('Подтверждать алерты может администратор или кладовщик.');
    }

    const alert = await repository.findAlertById(client, id, { forUpdate: true });
    if (!alert) throw new NotFoundError('Алерт не найден.');
    if (alert.status === 'resolved') throw new ConflictError('Алерт уже закрыт.');
    if (alert.status !== 'open') throw new ConflictError('Алерт уже подтверждён.');

    const changed = await repository.acknowledgeAlert(client, { alertId: id, userId: actor.id });
    if (!changed) throw new ConflictError('Алерт уже подтверждён или закрыт.');

    await audit.record(
      {
        userId: actor.id,
        action: 'alert.acknowledge',
        entityType: 'alert',
        entityId: id,
        details: {
          type: alert.type,
          componentId: alert.componentId,
          warehouseId: alert.warehouseId,
        },
        req,
      },
      { client },
    );

    return { alertId: id, status: 'acknowledged' };
  });
}

/**
 * Close an alert manually. Admin only: a storekeeper can mark a shortage as
 * seen, but closing it is an administrative decision about the condition.
 * Automatic resolution stays available to every role through recalculation.
 *
 * @param {{
 *   alertId: number,
 *   user?: { id?: number, role?: string } | null,
 *   userId?: number | null,
 *   req?: import('express').Request,
 * }} input
 * @returns {Promise<{ alertId: number, status: 'resolved' }>}
 */
export async function resolve({ alertId, user = null, userId = null, req }) {
  const id = readAlertId(alertId);
  const actorId = readActorId({ user, userId });

  return withTransaction(async (client) => {
    const actor = actorId === null ? null : await users.findById(actorId, { client });
    if (actor?.role !== 'admin') {
      throw new ForbiddenError('Закрывать алерты может только администратор.');
    }

    const alert = await repository.findAlertById(client, id, { forUpdate: true });
    if (!alert) throw new NotFoundError('Алерт не найден.');
    if (alert.status === 'resolved') throw new ConflictError('Алерт уже закрыт.');

    const changed = await repository.resolveAlert(client, id);
    if (!changed) throw new ConflictError('Алерт уже закрыт.');

    await audit.record(
      {
        userId: actor.id,
        action: 'alert.resolve',
        entityType: 'alert',
        entityId: id,
        details: {
          type: alert.type,
          previousStatus: alert.status,
          componentId: alert.componentId,
          warehouseId: alert.warehouseId,
        },
        req,
      },
      { client },
    );

    return { alertId: id, status: 'resolved' };
  });
}

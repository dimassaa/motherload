import { env } from '../config/env.js';
import { withTransaction } from '../db/pool.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.js';
import { allocateFifo } from '../domain/fifo.js';
import { d } from '../domain/money.js';
import * as inventory from '../repositories/inventory.js';
import * as stock from '../repositories/stock.js';
import * as users from '../repositories/users.js';
import * as audit from './audit.js';

// Mirrors the `integer` quantity columns and the bounds used by the stock
// services. Out-of-range input would reach PostgreSQL as 22003 and surface as an
// opaque 500 instead of a Russian 400.
const INTEGER_MAX = 2_147_483_647;
const QTY_MAX = 1_000_000_000;

const FROZEN_WAREHOUSE_MESSAGE = 'На складе уже идёт инвентаризация';

// Adjustment batches take a calendar-day stamp. The app runs on Europe/Minsk
// time, and `toISOString()` would roll back to the previous day between 00:00
// and 03:00 local time.
const MINSK_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Minsk' });
const MINSK_YEAR = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Minsk',
  year: 'numeric',
});

function todayInMinsk() {
  return MINSK_DATE.format(new Date());
}

/**
 * The screen identifier for a count.
 *
 * `inventory_counts` has no persisted document number, unlike receipts and
 * issues, so the UI derives a stable, human-readable label from the primary key
 * and the year the count started. The value is never written back or parsed.
 * @param {{ id: number, createdAt: Date }} count
 * @returns {string} e.g. `ИНВ-2026-0007`
 */
export function displayNumber(count) {
  return `ИНВ-${MINSK_YEAR.format(count.createdAt)}-${String(count.id).padStart(4, '0')}`;
}

/**
 * @param {unknown} value
 * @param {string} message Russian, user-facing text
 * @returns {number}
 */
function readId(value, message) {
  if (!Number.isSafeInteger(value) || value < 1 || value > INTEGER_MAX) {
    throw new ValidationError(message);
  }

  return value;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function readCountId(value) {
  return readId(value, 'Инвентаризация не найдена.');
}

/**
 * The nullable actor is allowed for seeds and scripts; when present it must fit
 * the `integer` columns.
 * @param {unknown} value
 * @returns {number | null}
 */
function readUserId(value) {
  if (value === null || value === undefined) return null;
  return readId(value, 'Не удалось определить пользователя.');
}

/**
 * Resolve the acting user. The optional `user` object is what route controllers
 * already have; the flat `userId` keeps scripts and the brief's examples simple.
 * @param {{ user?: { id?: number, role?: string } | null, userId?: number | null }} input
 * @returns {{ id: number | null, role: string | null }}
 */
function resolveActor({ user = null, userId = null }) {
  if (user && typeof user === 'object') {
    return { id: readUserId(user.id), role: user.role ?? null };
  }

  return { id: readUserId(userId), role: null };
}

/**
 * @param {unknown} comment
 * @returns {string | null} trimmed text, or null for an empty field
 */
function readComment(comment) {
  if (comment === null || comment === undefined) return null;
  if (typeof comment !== 'string') {
    throw new ValidationError('Комментарий должен быть текстом.');
  }

  const trimmed = comment.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * A factual quantity is either NULL ("not entered") or a whole, non-negative
 * number. Both bounds are explicit so an empty form field can never become 0.
 * @param {unknown} value
 * @param {number} position 1-based line number used in the error message
 * @returns {number | null}
 */
function readActualQty(value, position) {
  if (value === null || value === undefined) return null;

  if (!Number.isSafeInteger(value) || value < 0 || value > QTY_MAX) {
    throw new ValidationError(
      `Строка ${position}: фактическое количество должно быть целым числом от 0 до 1 000 000 000.`,
    );
  }

  return value;
}

/**
 * Validate and de-duplicate the editable lines of a draft count.
 * @param {unknown} lines
 * @returns {Array<{
 *   componentId: number,
 *   actualQty: number | null,
 *   comment: string | null | undefined,
 * }>} an omitted comment stays `undefined` so a partial save does not wipe it
 */
function prepareLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ValidationError('Добавьте хотя бы одну строку инвентаризации.');
  }

  const prepared = [];
  const seen = new Set();

  for (const [index, line] of lines.entries()) {
    const componentId = readId(line?.componentId, `Строка ${index + 1}: выберите позицию.`);

    // One component appears once in the count; repeated input would make the
    // last value silently win and is always a client bug.
    if (seen.has(componentId)) {
      throw new ValidationError('Позиция указана несколько раз — объедините строки.');
    }
    seen.add(componentId);

    prepared.push({
      componentId,
      actualQty: readActualQty(line?.actualQty, index + 1),
      comment: line?.comment === undefined ? undefined : readComment(line.comment),
    });
  }

  return prepared;
}

/**
 * Assert the count is editable and load its lines keyed by component.
 * @param {import('pg').PoolClient} client
 * @param {{ id: number, status: string }} count locked count row
 * @returns {Promise<Map<number, { id: number, expectedQty: number }>>}
 * @throws {ConflictError} when the count is no longer a draft
 */
async function assertDraft(client, count) {
  if (count.status !== 'draft') {
    const messages = {
      submitted: 'Инвентаризация отправлена — редактирование недоступно.',
      approved: 'Инвентаризация утверждена — редактирование недоступно.',
      cancelled: 'Инвентаризация отменена — редактирование недоступно.',
    };
    throw new ConflictError(messages[count.status] ?? 'Инвентаризация недоступна для правки.');
  }

  const lines = await inventory.listLines(client, count.id);
  return new Map(lines.map((line) => [line.componentId, line]));
}

/**
 * Counts for the `/inventory` list.
 * @returns {Promise<{
 *   counts: Array<{
 *     id: number,
 *     warehouseId: number,
 *     warehouseName: string,
 *     warehouseCity: string,
 *     status: 'draft' | 'submitted' | 'approved' | 'cancelled',
 *     createdAt: Date,
 *     submittedAt: Date | null,
 *     approvedAt: Date | null,
 *     comment: string | null,
 *     startedByName: string | null,
 *     approvedByName: string | null,
 *     lineCount: number,
 *     enteredCount: number,
 *     discrepancyCount: number,
 *   }>,
 *   capped: boolean,
 * }>} `capped` means older counts exist outside the list window
 */
export async function listCounts() {
  const counts = await inventory.listCountViews();
  return { counts, capped: counts.length === inventory.COUNT_LIST_LIMIT };
}

/**
 * Read model for `/inventory/:id`.
 *
 * The discrepancy list and the quantity summary are derived here rather than in
 * the template: the act must print the same numbers the operator sees, and a
 * view-local sum would drift from the stored differences.
 *
 * @param {number} countId
 * @returns {Promise<{
 *   count: Awaited<ReturnType<typeof inventory.findCountView>>,
 *   lines: Array<Awaited<ReturnType<typeof inventory.listLinesView>>[number]>,
 *   discrepancies: Array<{ difference: number }>,
 *   summary: {
 *     lineCount: number,
 *     enteredCount: number,
 *     discrepancyCount: number,
 *     unfilledCount: number,
 *     surplusLines: number,
 *     shortageLines: number,
 *     surplusQty: number,
 *     shortageQty: number,
 *     netQty: number,
 *   },
 * }>}
 * @throws {NotFoundError} when the count does not exist
 */
export async function getCountDetail(countId) {
  const id = readCountId(countId);
  const [count, lines] = await Promise.all([
    inventory.findCountView(id),
    inventory.listLinesView(id),
  ]);
  if (!count) throw new NotFoundError('Инвентаризация не найдена.');

  const discrepancies = lines.filter((line) => line.difference !== null && line.difference !== 0);
  const surplus = discrepancies.filter((line) => line.difference > 0);
  const shortage = discrepancies.filter((line) => line.difference < 0);

  const summary = {
    lineCount: lines.length,
    enteredCount: lines.filter((line) => line.actualQty !== null).length,
    discrepancyCount: discrepancies.length,
    unfilledCount: lines.filter((line) => line.actualQty === null).length,
    surplusLines: surplus.length,
    shortageLines: shortage.length,
    surplusQty: surplus.reduce((total, line) => total + line.difference, 0),
    shortageQty: shortage.reduce((total, line) => total - line.difference, 0),
    netQty: discrepancies.reduce((total, line) => total + line.difference, 0),
  };

  return { count, lines, discrepancies, summary };
}

/**
 * Start an inventory count and freeze the warehouse in one transaction.
 *
 * The warehouse row lock is the same one stock postings take, so a receipt can
 * either finish before the snapshot or see the freeze — never slip between the
 * freeze check and the `expected_qty` read. The partial unique index is a second
 * line of defence and its violation is translated into the same 409.
 *
 * @param {{
 *   warehouseId: number,
 *   comment?: string | null,
 *   user?: { id?: number, role?: string } | null,
 *   userId?: number | null,
 *   req?: import('express').Request,
 * }} input
 * @returns {Promise<{ countId: number, lineCount: number }>}
 * @throws {NotFoundError} when the warehouse does not exist
 * @throws {ValidationError} when the warehouse is archived or input is malformed
 * @throws {ConflictError} when an active count already freezes the warehouse
 */
export async function createCount({
  warehouseId,
  comment = null,
  user = null,
  userId = null,
  req,
}) {
  const warehouse = readId(warehouseId, 'Выберите склад.');
  const actor = resolveActor({ user, userId });
  const countComment = readComment(comment);

  return withTransaction(async (client) => {
    const lockedWarehouse = await stock.lockWarehouse(client, warehouse);
    if (!lockedWarehouse) throw new NotFoundError('Склад не найден.');
    if (!lockedWarehouse.isActive) {
      throw new ValidationError('Склад неактивен, инвентаризация недоступна.');
    }

    const active = await inventory.getActiveCount(client, warehouse);
    if (active) throw new ConflictError(FROZEN_WAREHOUSE_MESSAGE);

    let created;
    try {
      created = await inventory.insertCount(client, {
        warehouseId: warehouse,
        comment: countComment,
        userId: actor.id,
      });
    } catch (error) {
      // A race that slipped past the row lock still must not surface as a 500.
      if (error.code === '23505') throw new ConflictError(FROZEN_WAREHOUSE_MESSAGE);
      throw error;
    }

    const lineCount = await inventory.snapshotLines(client, {
      countId: created.id,
      warehouseId: warehouse,
      // Demo mode pins the window to the reference date; production uses today.
      asOf: env.analyticsReferenceDate ?? todayInMinsk(),
    });

    await audit.record(
      {
        userId: actor.id,
        action: 'inventory.create',
        entityType: 'inventory_count',
        entityId: created.id,
        details: { warehouseId: warehouse, lines: lineCount },
        req,
      },
      { client },
    );

    return { countId: created.id, lineCount };
  });
}

/**
 * Save factual quantities and comments on a draft count.
 *
 * Only `draft` counts are editable: submission hands the count to an
 * administrator, after which changing numbers would invalidate what was
 * reviewed. Each line's difference is derived by the same SQL statement as its
 * actual quantity, satisfying the database consistency check.
 *
 * @param {{
 *   countId: number,
 *   lines: Array<{ componentId: number, actualQty: number | null, comment?: string | null }>,
 *   user?: { id?: number, role?: string } | null,
 *   userId?: number | null,
 *   req?: import('express').Request,
 * }} input
 * @returns {Promise<{ countId: number, saved: number }>}
 * @throws {ValidationError} on malformed input or a component outside the count
 * @throws {NotFoundError} when the count does not exist
 * @throws {ConflictError} when the count is no longer a draft
 */
export async function saveCountLines({ countId, lines, user = null, userId = null, req }) {
  const id = readCountId(countId);
  const actor = resolveActor({ user, userId });
  const prepared = prepareLines(lines);

  return withTransaction(async (client) => {
    const count = await inventory.findCountById(client, id, { forUpdate: true });
    if (!count) throw new NotFoundError('Инвентаризация не найдена.');

    const countLines = await assertDraft(client, count);

    for (const line of prepared) {
      if (!countLines.has(line.componentId)) {
        throw new ValidationError(
          `Позиция с кодом ${line.componentId} не входит в эту инвентаризацию.`,
        );
      }

      const updated = await inventory.updateLineActual(client, {
        countId: id,
        componentId: line.componentId,
        actualQty: line.actualQty,
        comment: line.comment ?? null,
        // An omitted comment means "leave the existing note alone"; an explicit
        // null is how the form clears it.
        touchComment: line.comment !== undefined,
      });
      // Membership was just checked under the count row lock; a missing row
      // would mean the count and its lines diverged in the database.
      if (!updated)
        throw new Error(`inventory line ${line.componentId} disappeared from count ${id}`);
    }

    await audit.record(
      {
        userId: actor.id,
        action: 'inventory.lines',
        entityType: 'inventory_count',
        entityId: id,
        details: { lines: prepared.length },
        req,
      },
      { client },
    );

    return { countId: id, saved: prepared.length };
  });
}

/**
 * Submit a draft count for approval.
 *
 * Every line must carry an entered fact. The list of missing SKUs is returned in
 * the 400 details so the form can point at the exact rows; an empty input is not
 * zero and is never auto-filled here.
 *
 * @param {{
 *   countId: number,
 *   user?: { id?: number, role?: string } | null,
 *   userId?: number | null,
 *   req?: import('express').Request,
 * }} input
 * @returns {Promise<{ countId: number, status: 'submitted', lines: number }>}
 * @throws {NotFoundError} when the count does not exist
 * @throws {ValidationError} when lines are unfilled
 * @throws {ConflictError} when the count is not a draft
 */
export async function submitCount({ countId, user = null, userId = null, req }) {
  const id = readCountId(countId);
  const actor = resolveActor({ user, userId });

  return withTransaction(async (client) => {
    const count = await inventory.findCountById(client, id, { forUpdate: true });
    if (!count) throw new NotFoundError('Инвентаризация не найдена.');

    if (count.status !== 'draft') {
      throw new ConflictError('Инвентаризация уже отправлена или завершена.');
    }

    const unfilled = await inventory.findUnfilledLines(client, id);
    if (unfilled.length > 0) {
      // The message names a few rows; the full list travels in details so the
      // screen can mark every missing field without a wall of text.
      const shown = unfilled
        .slice(0, 5)
        .map((line) => line.sku)
        .join(', ');
      const remaining = unfilled.length - 5;
      const suffix = remaining > 0 ? ` и ещё ${remaining}` : '';
      throw new ValidationError(`Заполните фактическое количество: ${shown}${suffix}.`, {
        details: { unfilled },
      });
    }

    const totalLines = await inventory.countLines(client, id);
    const submitted = await inventory.markSubmitted(client, id);
    if (!submitted) throw new ConflictError('Инвентаризация уже отправлена или завершена.');

    await audit.record(
      {
        userId: actor.id,
        action: 'inventory.submit',
        entityType: 'inventory_count',
        entityId: id,
        details: { lines: totalLines },
        req,
      },
      { client },
    );

    return { countId: id, status: 'submitted', lines: totalLines };
  });
}

/**
 * Approve a submitted count and write the adjustments.
 *
 * The warehouse is frozen from creation, so the ledger cannot move between the
 * snapshot and this transaction. The whole document is still re-checked against
 * the ledger before anything is written: a bypassed freeze, a direct SQL fix or
 * a bug elsewhere must abort with 409 instead of silently discarding movements
 * the operator never counted. All adjustments are applied in the same
 * transaction — a failure on one line leaves the count `submitted` and stock
 * untouched.
 *
 * Positive differences create a batch valued at the snapshot's weighted average
 * cost. Negative differences consume batches FIFO and record one
 * `batch_consumptions` row per consumed batch against the inventory line, so an
 * adjustment keeps the same provenance as an issue even though it has no stock
 * document.
 *
 * `totalAdjustment` is the signed net (`surplus - shortage`); the audit entry
 * keeps both sides separately as well.
 *
 * @param {{
 *   countId: number,
 *   user?: { id?: number, role?: string } | null,
 *   userId?: number | null,
 *   req?: import('express').Request,
 * }} input `user` carries the actor when the service is called from a route
 * @returns {Promise<{
 *   countId: number,
 *   status: 'approved',
 *   adjustedLines: number,
 *   surplus: string,
 *   shortage: string,
 *   totalAdjustment: string,
 * }>} money values are two-decimal strings
 * @throws {ForbiddenError} when the actor is missing or is not an admin in the database
 * @throws {NotFoundError} when the count or its warehouse does not exist
 * @throws {ConflictError} on a non-submitted count, a repeated approval or ledger drift
 */
export async function approveCount({ countId, user = null, userId = null, req }) {
  const id = readCountId(countId);
  const actor = resolveActor({ user, userId });

  return withTransaction(async (client) => {
    // The role is read from the database, not trusted from the caller: a route
    // could pass a stale session object, and a script could pass any role.
    const actorRow = actor.id === null ? null : await users.findById(actor.id, { client });
    if (actorRow?.role !== 'admin') {
      throw new ForbiddenError('Утверждать инвентаризацию может только администратор.');
    }

    const count = await inventory.findCountById(client, id);
    if (!count) throw new NotFoundError('Инвентаризация не найдена.');

    assertApprovable(count);

    // Lock order matches stock postings (warehouse first), so an approval and a
    // posting cannot deadlock while waiting for each other.
    const warehouse = await stock.lockWarehouse(client, count.warehouseId);
    if (!warehouse) throw new NotFoundError('Склад не найден.');

    const locked = await inventory.findCountById(client, id, { forUpdate: true });
    if (!locked) throw new NotFoundError('Инвентаризация не найдена.');
    assertApprovable(locked);

    const lines = await inventory.listLinesWithBalance(client, id, count.warehouseId);
    const drift = lines.filter((line) => line.currentQty !== line.expectedQty);
    if (drift.length > 0) {
      const [first] = drift;
      throw new ConflictError(
        `Остаток позиции ${first.sku} изменился с момента снимка: учёт ${first.expectedQty}, сейчас ${first.currentQty}. Создайте новую инвентаризацию.`,
        { details: { drift: drift.map(mapDriftLine) } },
      );
    }

    let adjustedLines = 0;
    let surplus = d(0);
    let shortage = d(0);

    for (const line of lines) {
      // Submission guarantees a number; a NULL here means the rows were changed
      // outside the service, and applying half a count is not an option.
      if (line.difference === null) {
        throw new ConflictError('В инвентаризации есть незаполненные строки. Отправьте её заново.');
      }
      if (line.difference === 0) continue;

      adjustedLines += 1;

      if (line.difference > 0) {
        surplus = surplus.plus(await applyIncrease(client, line, count.warehouseId));
      } else {
        shortage = shortage.plus(await applyDecrease(client, line, count.warehouseId));
      }
    }

    const approved = await inventory.markApproved(client, {
      countId: id,
      approvedBy: actor.id,
    });
    if (!approved) throw new ConflictError('Инвентаризация уже утверждена.');

    // Signed net: a shortage reduces the stock value, a surplus increases it.
    const surplusText = surplus.toFixed(2);
    const shortageText = shortage.toFixed(2);
    const net = surplus.minus(shortage).toFixed(2);

    await audit.record(
      {
        userId: actor.id,
        action: 'inventory.approve',
        entityType: 'inventory_count',
        entityId: id,
        details: {
          lines: lines.length,
          adjustedLines,
          surplus: surplusText,
          shortage: shortageText,
          net,
        },
        req,
      },
      { client },
    );

    return {
      countId: id,
      status: 'approved',
      adjustedLines,
      surplus: surplusText,
      shortage: shortageText,
      totalAdjustment: net,
    };
  });
}

/**
 * @param {{ status: string }} count
 * @throws {ConflictError} unless the count is submitted
 */
function assertApprovable(count) {
  if (count.status === 'approved') {
    throw new ConflictError('Инвентаризация уже утверждена.');
  }
  if (count.status !== 'submitted') {
    throw new ConflictError('Утвердить можно только отправленную инвентаризацию.');
  }
}

/**
 * @param {{ componentId: number, sku: string, expectedQty: number, currentQty: number }} line
 * @returns {{ componentId: number, sku: string, expectedQty: number, currentQty: number }}
 */
function mapDriftLine(line) {
  return {
    componentId: line.componentId,
    sku: line.sku,
    expectedQty: line.expectedQty,
    currentQty: line.currentQty,
  };
}

/**
 * Create the surplus batch and its positive movement.
 * @param {import('pg').PoolClient} client
 * @param {{ componentId: number, difference: number, unitCost: string }} line
 * @param {number} warehouseId
 * @returns {Promise<string>} four-decimal cost of the adjustment
 */
async function applyIncrease(client, line, warehouseId) {
  const qty = line.difference;

  await stock.insertBatch(client, {
    componentId: line.componentId,
    warehouseId,
    unitCost: line.unitCost,
    qty,
    receivedAt: todayInMinsk(),
  });

  await stock.insertMovement(client, {
    componentId: line.componentId,
    warehouseId,
    qtyDelta: qty,
    unitCost: line.unitCost,
  });

  return d(line.unitCost).times(qty).toFixed(4);
}

/**
 * Consume the shortage FIFO, record each consumed batch against the inventory
 * line, decrement the batches and write one negative movement per consumed
 * batch, mirroring an issue posting.
 * @param {import('pg').PoolClient} client
 * @param {{ id: number, componentId: number, difference: number }} line
 *   `id` is the inventory line that owns the consumption; difference is negative
 * @param {number} warehouseId
 * @returns {Promise<string>} four-decimal cost of the consumed batches
 */
async function applyDecrease(client, line, warehouseId) {
  const deficit = -line.difference;
  const batches = await stock.lockOpenBatches(client, line.componentId, warehouseId);
  const allocation = allocateFifo(batches, deficit);

  for (const consumed of allocation.allocations) {
    // Inventory adjustments have no stock document, so provenance points at the
    // inventory line. The database check allows exactly one source per row.
    await stock.insertBatchConsumption(client, {
      inventoryLineId: line.id,
      batchId: consumed.batchId,
      qty: consumed.qty,
      unitCost: consumed.unitCost,
    });

    await stock.decrementBatchRemaining(client, {
      batchId: consumed.batchId,
      qty: consumed.qty,
    });

    await stock.insertMovement(client, {
      componentId: line.componentId,
      warehouseId,
      qtyDelta: -consumed.qty,
      unitCost: consumed.unitCost,
    });
  }

  return allocation.totalCost;
}

/**
 * Cancel a draft or submitted count and release the warehouse freeze.
 *
 * Approval is terminal; cancellation is not allowed after it because the
 * adjustments are already reflected in the ledger.
 *
 * Separation of duties applies to cancellation too: a storekeeper may abandon
 * their own draft, but a count already submitted is an administrator's review
 * and only an administrator may end it. The role is read from the database
 * inside the transaction, not trusted from the caller's session object.
 *
 * @param {{
 *   countId: number,
 *   user?: { id?: number, role?: string } | null,
 *   userId?: number | null,
 *   req?: import('express').Request,
 * }} input
 * @returns {Promise<{ countId: number, status: 'cancelled' }>}
 * @throws {ForbiddenError} when the actor is not an administrator or storekeeper,
 *   or a storekeeper tries to cancel a submitted count
 * @throws {NotFoundError} when the count does not exist
 * @throws {ConflictError} when the count is already approved or cancelled
 */
export async function cancelCount({ countId, user = null, userId = null, req }) {
  const id = readCountId(countId);
  const actor = resolveActor({ user, userId });

  return withTransaction(async (client) => {
    // Same source of truth as approval: a stale session or a direct script call
    // must not grant a role the database does not hold.
    const actorRow = actor.id === null ? null : await users.findById(actor.id, { client });
    const role = actorRow?.role;
    if (role !== 'admin' && role !== 'storekeeper') {
      throw new ForbiddenError('Отменять инвентаризацию может администратор или кладовщик.');
    }

    const count = await inventory.findCountById(client, id);
    if (!count) throw new NotFoundError('Инвентаризация не найдена.');

    // Same lock order as approval: warehouse first, then the count. Cancelling
    // does not touch stock, but taking the warehouse lock keeps every status
    // change of an active count serialised with postings and with approval.
    const warehouse = await stock.lockWarehouse(client, count.warehouseId);
    if (!warehouse) throw new NotFoundError('Склад не найден.');

    const locked = await inventory.findCountById(client, id, { forUpdate: true });
    if (!locked) throw new NotFoundError('Инвентаризация не найдена.');

    if (locked.status !== 'draft' && locked.status !== 'submitted') {
      throw new ConflictError('Завершённую инвентаризацию нельзя отменить.');
    }
    if (locked.status === 'submitted' && role !== 'admin') {
      throw new ForbiddenError('Отменить отправленную инвентаризацию может только администратор.');
    }

    const cancelled = await inventory.markCancelled(client, id);
    if (!cancelled) throw new ConflictError('Завершённую инвентаризацию нельзя отменить.');

    await audit.record(
      {
        userId: actor.id,
        action: 'inventory.cancel',
        entityType: 'inventory_count',
        entityId: id,
        details: { previousStatus: locked.status },
        req,
      },
      { client },
    );

    return { countId: id, status: 'cancelled' };
  });
}

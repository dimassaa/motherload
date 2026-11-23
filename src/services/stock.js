import { pool, withTransaction } from '../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { allocateFifo } from '../domain/fifo.js';
import { d, toCost } from '../domain/money.js';
import * as stock from '../repositories/stock.js';
import * as audit from './audit.js';

// Documents are stored as ISO `YYYY-MM-DD` (the format of `<input type="date">`
// and of the `date` columns); the Russian дд.мм.гггг form is a display concern.
const DOC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const FROZEN_WAREHOUSE_MESSAGE = 'На складе идёт инвентаризация';

// Column bounds from db/migrations/001_init.sql. Input outside them would come
// back from PostgreSQL as 22003/23514 and reach the user as an opaque 500, so
// every field is bounded here, where the answer is still a Russian 400.
const INTEGER_MAX = 2_147_483_647;
const QTY_MAX = 1_000_000_000;
const UNIT_COST_MAX = '9999999999.9999';
const UNIT_COST_SCALE = 4;
const LINE_TOTAL_MAX = '999999999999.99';
const DOCUMENT_YEAR_MIN = 2000;
const DOCUMENT_YEAR_MAX = 2999;

// Must stay in sync with the `issue_reason` enum in db/migrations/001_init.sql.
const ISSUE_REASONS = new Set(['sale', 'defect', 'supplier_return', 'internal', 'other']);

/**
 * Lock the warehouse and refuse stock operations while an inventory count is
 * live. The row lock is taken first on purpose: inventory count creation takes
 * the same lock before freezing the warehouse, so a posting cannot pass the
 * check and then race the snapshot.
 *
 * Shared by receipts, issues, transfers and inventory counts.
 *
 * @param {import('pg').PoolClient} client client inside the stock transaction
 * @param {number} warehouseId
 * @returns {Promise<{ id: number, code: string, name: string }>}
 * @throws {NotFoundError} when the warehouse does not exist
 * @throws {ValidationError} when the warehouse is archived
 * @throws {ConflictError} when a draft or submitted inventory count holds the warehouse
 */
export async function assertWarehouseNotFrozen(client, warehouseId) {
  const warehouse = await stock.lockWarehouse(client, warehouseId);
  if (!warehouse) throw new NotFoundError('Склад не найден.');
  if (!warehouse.isActive) throw new ValidationError('Склад неактивен, операции с ним недоступны.');

  const activeCountId = await stock.findActiveInventoryCount(client, warehouse.id);
  if (activeCountId !== null) throw new ConflictError(FROZEN_WAREHOUSE_MESSAGE);

  return warehouse;
}

/**
 * Validate one receipt line and round its money the way the database stores it:
 * unit cost with four decimals, line total with two, half up.
 *
 * @param {{ componentId: number, qty: number, unitCost: string | number }} line
 * @param {number} position 1-based line number used in error messages
 * @returns {{ componentId: number, qty: number, unitCost: string, totalCost: string }}
 */
function prepareLine(line, position) {
  const componentId = readId(line?.componentId, `Строка ${position}: выберите позицию.`);
  const qty = readQty(line?.qty, position);

  // `d` also rejects NaN, Infinity and non-numeric strings with a ValidationError.
  const unitCost = d(line?.unitCost);
  if (unitCost.isNegative()) {
    throw new ValidationError(`Строка ${position}: цена не может быть отрицательной.`);
  }
  if (unitCost.decimalPlaces() > UNIT_COST_SCALE) {
    throw new ValidationError(
      `Строка ${position}: цена указывается не более чем с 4 знаками после запятой.`,
    );
  }
  if (unitCost.greaterThan(UNIT_COST_MAX)) {
    throw new ValidationError(`Строка ${position}: цена слишком большая.`);
  }

  const lineTotal = unitCost.times(qty);
  if (lineTotal.greaterThan(LINE_TOTAL_MAX)) {
    throw new ValidationError(`Строка ${position}: сумма строки слишком большая.`);
  }

  return {
    componentId,
    qty,
    unitCost: toCost(unitCost),
    totalCost: lineTotal.toFixed(2),
  };
}

/**
 * Require a database identifier that fits the `integer` columns.
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
 * Require a whole, positive issue quantity within the `integer` column range.
 * @param {unknown} value
 * @param {number} position 1-based line number used in the error message
 * @returns {number}
 */
function readQty(value, position) {
  if (!Number.isSafeInteger(value) || value < 1 || value > QTY_MAX) {
    throw new ValidationError(
      `Строка ${position}: количество должно быть целым числом от 1 до 1 000 000 000.`,
    );
  }

  return value;
}

/**
 * @param {unknown[]} lines
 * @returns {Array<{ componentId: number, qty: number, unitCost: string, totalCost: string }>}
 */
function prepareLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ValidationError('Добавьте хотя бы одну строку приёмки.');
  }

  return lines.map((line, index) => prepareLine(line, index + 1));
}

/**
 * Validate one issue line. Unlike a receipt, an issue carries no price: cost is
 * derived from the consumed FIFO batches.
 * @param {{ componentId: number, qty: number }} line
 * @param {number} position 1-based line number used in error messages
 * @returns {{ componentId: number, qty: number }}
 */
function prepareIssueLine(line, position) {
  return {
    componentId: readId(line?.componentId, `Строка ${position}: выберите позицию.`),
    qty: readQty(line?.qty, position),
  };
}

/**
 * @param {unknown[]} lines
 * @returns {Array<{ componentId: number, qty: number }>}
 */
function prepareIssueLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ValidationError('Добавьте хотя бы одну строку расхода.');
  }

  return lines.map((line, index) => prepareIssueLine(line, index + 1));
}

/**
 * @param {unknown} reason
 * @returns {'sale' | 'defect' | 'supplier_return' | 'internal' | 'other'}
 * @throws {ValidationError} when the reason is outside the `issue_reason` enum
 */
function readIssueReason(reason) {
  if (typeof reason !== 'string' || !ISSUE_REASONS.has(reason)) {
    throw new ValidationError('Выберите причину расхода.');
  }

  return reason;
}

/**
 * Round a FIFO allocation total to the stored `numeric(14,2)` line total.
 * @param {string} totalCost four-decimal sum produced by `allocateFifo`
 * @param {number} position 1-based line number used in error messages
 * @returns {string}
 */
function toIssueLineTotal(totalCost, position) {
  const rounded = d(totalCost).toFixed(2);
  if (d(rounded).greaterThan(LINE_TOTAL_MAX)) {
    throw new ValidationError(`Строка ${position}: сумма строки слишком большая.`);
  }

  return rounded;
}

/**
 * @param {string} docDate ISO calendar date
 * @returns {number} document year used for the number sequence
 * @throws {ValidationError} on a malformed or impossible date such as 2026-02-30
 */
function readDocumentYear(docDate) {
  if (typeof docDate !== 'string' || !DOC_DATE_PATTERN.test(docDate)) {
    throw new ValidationError('Укажите дату документа.');
  }

  const parsed = new Date(`${docDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== docDate) {
    throw new ValidationError('Укажите существующую дату документа.');
  }

  const year = Number(docDate.slice(0, 4));
  // The same range the `document_sequences.year` check enforces; a document
  // dated outside it would otherwise fail on the sequence insert with a 500.
  if (year < DOCUMENT_YEAR_MIN || year > DOCUMENT_YEAR_MAX) {
    throw new ValidationError('Год документа должен быть от 2000 до 2999.');
  }

  return year;
}

/**
 * The stock document author is optional for scripts and seeds; when present it
 * must be a real database identifier.
 * @param {unknown} userId
 * @returns {number | null}
 */
function readUserId(userId) {
  if (userId === null || userId === undefined) return null;
  return readId(userId, 'Не удалось определить автора документа.');
}

/**
 * Check the found rows against the requested ids and archive flags.
 * Runs before any write, so a receipt naming an archived component writes nothing.
 */
function assertSupplierUsable(supplier) {
  if (!supplier) throw new NotFoundError('Поставщик не найден.');
  if (!supplier.isActive) throw new ValidationError('Поставщик неактивен, приёмка невозможна.');
}

function assertComponentsUsable(lines, components, operation) {
  const componentsById = new Map(components.map((component) => [component.id, component]));

  for (const line of lines) {
    const component = componentsById.get(line.componentId);
    if (!component) throw new NotFoundError(`Позиция с кодом ${line.componentId} не найдена.`);
    if (!component.isActive) {
      throw new ValidationError(`Позиция ${component.sku} неактивна, ${operation} невозможна.`);
    }
  }
}

/**
 * Post a receipt: document, lines, batches and positive movements in one
 * transaction. There is no draft state — a document either exists fully
 * conducted or not at all.
 *
 * @param {{
 *   supplierId: number,
 *   warehouseId: number,
 *   docDate: string,
 *   comment?: string | null,
 *   lines: Array<{ componentId: number, qty: number, unitCost: string | number }>,
 *   userId?: number | null,
 *   req?: import('express').Request,
 * }} input
 * @returns {Promise<{ documentId: number, number: string }>}
 * @throws {ValidationError} on malformed input, archived entities or empty lines
 * @throws {NotFoundError} when supplier, warehouse or component is missing
 * @throws {ConflictError} when an inventory count freezes the warehouse
 */
export async function postReceipt({
  supplierId,
  warehouseId,
  docDate,
  comment = null,
  lines,
  userId = null,
  req,
}) {
  const preparedLines = prepareLines(lines);
  const year = readDocumentYear(docDate);
  const supplier = readId(supplierId, 'Выберите поставщика.');
  const warehouse = readId(warehouseId, 'Выберите склад.');
  const author = readUserId(userId);

  // Line totals are stored rounded to kopecks, so the document total is the sum
  // of the stored line totals — otherwise the printed document would not add up.
  const totalCost = preparedLines.reduce((sum, line) => sum.plus(line.totalCost), d(0)).toFixed(2);
  if (d(totalCost).greaterThan(LINE_TOTAL_MAX)) {
    throw new ValidationError('Сумма документа слишком большая.');
  }

  const document = await withTransaction(async (client) => {
    await assertWarehouseNotFrozen(client, warehouse);
    assertSupplierUsable(await stock.findSupplierById(client, supplier));

    const components = await stock.findComponentsByIds(
      client,
      preparedLines.map((line) => line.componentId),
    );
    assertComponentsUsable(preparedLines, components, 'приёмка');

    const number = await stock.nextDocumentNumber(client, 'receipt', year);
    const inserted = await stock.insertDocument(client, {
      type: 'receipt',
      number,
      docDate,
      supplierId: supplier,
      warehouseId: warehouse,
      comment,
      totalCost,
      createdBy: author,
    });

    for (const line of preparedLines) {
      const documentLine = await stock.insertDocumentLine(client, {
        documentId: inserted.id,
        componentId: line.componentId,
        qty: line.qty,
        unitCost: line.unitCost,
        totalCost: line.totalCost,
      });

      await stock.insertBatch(client, {
        componentId: line.componentId,
        warehouseId: warehouse,
        supplierId: supplier,
        unitCost: line.unitCost,
        qty: line.qty,
        receivedAt: docDate,
        documentNo: number,
      });

      await stock.insertMovement(client, {
        componentId: line.componentId,
        warehouseId: warehouse,
        qtyDelta: line.qty,
        unitCost: line.unitCost,
        documentId: inserted.id,
        lineId: documentLine.id,
      });
    }

    // Audited inside the transaction: an audit insert failure must undo the
    // receipt, and a conducted document must never exist without its audit row.
    // `req` stays optional because seeds and scripts call this service directly.
    await audit.record(
      {
        userId: author,
        action: 'stock.receipt',
        entityType: 'stock_document',
        entityId: inserted.id,
        details: { number, total: totalCost },
        req,
      },
      { client },
    );

    return { documentId: inserted.id, number };
  });

  return document;
}

/**
 * Post an issue: consume batches FIFO, write `batch_consumptions`, decrement the
 * batch balances, write one negative movement per consumed batch, and record the
 * document, its line and the audit row in the same transaction.
 *
 * There is no draft state. Any failure — including insufficient stock — rolls
 * back the document number, the movements and the batch decrements together.
 *
 * @param {{
 *   warehouseId: number,
 *   docDate: string,
 *   reason: 'sale' | 'defect' | 'supplier_return' | 'internal' | 'other',
 *   comment?: string | null,
 *   lines: Array<{ componentId: number, qty: number }>,
 *   userId?: number | null,
 *   req?: import('express').Request,
 * }} input
 * @returns {Promise<{ documentId: number, number: string, totalCost: string }>}
 * @throws {ValidationError} on malformed input, an archived component or empty lines
 * @throws {NotFoundError} when the warehouse or a component is missing
 * @throws {ConflictError} when an inventory count freezes the warehouse
 * @throws {InsufficientStockError} when the batches cannot cover a line
 */
export async function postIssue({
  warehouseId,
  docDate,
  reason,
  comment = null,
  lines,
  userId = null,
  req,
}) {
  const preparedLines = prepareIssueLines(lines);
  const year = readDocumentYear(docDate);
  const warehouse = readId(warehouseId, 'Выберите склад.');
  const issueReason = readIssueReason(reason);
  const author = readUserId(userId);

  return withTransaction(async (client) => {
    await assertWarehouseNotFrozen(client, warehouse);

    const components = await stock.findComponentsByIds(
      client,
      preparedLines.map((line) => line.componentId),
    );
    assertComponentsUsable(preparedLines, components, 'расход');

    // Allocate before writing anything: a shortage must abort here, before the
    // document number is reserved or a single row is touched. `lockOpenBatches`
    // serialises concurrent issues of the same component and warehouse.
    const plannedLines = [];
    for (const [index, line] of preparedLines.entries()) {
      const batches = await stock.lockOpenBatches(client, line.componentId, warehouse);
      const allocation = allocateFifo(batches, line.qty);
      plannedLines.push({
        line,
        allocations: allocation.allocations,
        totalCost: toIssueLineTotal(allocation.totalCost, index + 1),
      });
    }

    const totalCost = plannedLines
      .reduce((sum, planned) => sum.plus(planned.totalCost), d(0))
      .toFixed(2);
    if (d(totalCost).greaterThan(LINE_TOTAL_MAX)) {
      throw new ValidationError('Сумма документа слишком большая.');
    }

    const number = await stock.nextDocumentNumber(client, 'issue', year);
    const inserted = await stock.insertDocument(client, {
      type: 'issue',
      number,
      docDate,
      warehouseId: warehouse,
      reason: issueReason,
      comment,
      totalCost,
      createdBy: author,
    });

    for (const planned of plannedLines) {
      const { line, allocations, totalCost: lineTotal } = planned;
      // The line keeps the weighted average of the consumed batches; the
      // authoritative split remains in `batch_consumptions`.
      const unitCost = d(lineTotal)
        .dividedBy(line.qty)
        .toDecimalPlaces(UNIT_COST_SCALE)
        .toFixed(UNIT_COST_SCALE);

      const documentLine = await stock.insertDocumentLine(client, {
        documentId: inserted.id,
        componentId: line.componentId,
        qty: line.qty,
        unitCost,
        totalCost: lineTotal,
      });

      for (const allocation of allocations) {
        await stock.insertBatchConsumption(client, {
          lineId: documentLine.id,
          batchId: allocation.batchId,
          qty: allocation.qty,
          unitCost: allocation.unitCost,
        });

        await stock.decrementBatchRemaining(client, {
          batchId: allocation.batchId,
          qty: allocation.qty,
        });

        await stock.insertMovement(client, {
          componentId: line.componentId,
          warehouseId: warehouse,
          qtyDelta: -allocation.qty,
          unitCost: allocation.unitCost,
          documentId: inserted.id,
          lineId: documentLine.id,
        });
      }
    }

    await audit.record(
      {
        userId: author,
        action: 'stock.issue',
        entityType: 'stock_document',
        entityId: inserted.id,
        details: { number, reason: issueReason, total: totalCost },
        req,
      },
      { client },
    );

    return { documentId: inserted.id, number, totalCost };
  });
}

/**
 * Predict how an issue would consume batches, without locking or writing.
 *
 * The preview is advisory: a posting can consume the batches before the operator
 * submits the form, so the real allocation is decided inside `postIssue` under
 * `FOR UPDATE`. Reads go through the pool because no transaction is needed.
 *
 * @param {{ warehouseId: number, lines: Array<{ componentId: number, qty: number }> }} input
 * @returns {Promise<{
 *   lines: Array<{
 *     componentId: number,
 *     allocations: Array<{ batchId: number, qty: number, unitCost: string, totalCost: string }>,
 *     totalCost: string,
 *   }>,
 *   totalCost: string,
 * }>} money values are strings; allocations keep four decimals
 * @throws {ValidationError} on malformed input, an inactive warehouse or component
 * @throws {NotFoundError} when the warehouse or a component is missing
 * @throws {InsufficientStockError} when the batches cannot cover a line
 */
export async function previewIssue({ warehouseId, lines }) {
  const preparedLines = prepareIssueLines(lines);
  const warehouse = readId(warehouseId, 'Выберите склад.');

  const foundWarehouse = await stock.findWarehouseById(pool, warehouse);
  if (!foundWarehouse) throw new NotFoundError('Склад не найден.');
  if (!foundWarehouse.isActive) {
    throw new ValidationError('Склад неактивен, операции с ним недоступны.');
  }

  const components = await stock.findComponentsByIds(
    pool,
    preparedLines.map((line) => line.componentId),
  );
  assertComponentsUsable(preparedLines, components, 'расход');

  const previewLines = [];
  for (const [index, line] of preparedLines.entries()) {
    const batches = await stock.listOpenBatches(pool, line.componentId, warehouse);
    const allocation = allocateFifo(batches, line.qty);
    previewLines.push({
      componentId: line.componentId,
      allocations: allocation.allocations,
      totalCost: toIssueLineTotal(allocation.totalCost, index + 1),
    });
  }

  const totalCost = previewLines.reduce((sum, line) => sum.plus(line.totalCost), d(0)).toFixed(2);

  return { lines: previewLines, totalCost };
}

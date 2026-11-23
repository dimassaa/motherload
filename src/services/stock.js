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
 * Lock warehouses and refuse stock operations while an inventory count is live
 * on any of them. The row locks are taken first on purpose: inventory count
 * creation takes the same locks before freezing the warehouse, so a posting
 * cannot pass the check and then race the snapshot.
 *
 * Locks are always taken in ascending id order. A transfer needs both its
 * warehouses locked, and two opposite A→B / B→A transfers locking in call order
 * would each hold one row and wait for the other. The freeze check runs after
 * all locks are held, so no count can slip in between them.
 *
 * @param {import('pg').PoolClient} client client inside the stock transaction
 * @param {number[]} warehouseIds
 * @returns {Promise<Array<{ id: number, code: string, name: string }>>}
 * @throws {NotFoundError} when a warehouse does not exist
 * @throws {ValidationError} when a warehouse is archived
 * @throws {ConflictError} when a draft or submitted inventory count holds a warehouse
 */
async function lockWarehousesNotFrozen(client, warehouseIds) {
  const warehouses = [];

  for (const warehouseId of [...new Set(warehouseIds)].sort((left, right) => left - right)) {
    const warehouse = await stock.lockWarehouse(client, warehouseId);
    if (!warehouse) throw new NotFoundError('Склад не найден.');
    if (!warehouse.isActive) {
      throw new ValidationError('Склад неактивен, операции с ним недоступны.');
    }
    warehouses.push(warehouse);
  }

  for (const warehouse of warehouses) {
    const activeCountId = await stock.findActiveInventoryCount(client, warehouse.id);
    if (activeCountId !== null) throw new ConflictError(FROZEN_WAREHOUSE_MESSAGE);
  }

  return warehouses;
}

/**
 * Lock the warehouse and refuse stock operations while an inventory count is
 * live.
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
  const [warehouse] = await lockWarehousesNotFrozen(client, [warehouseId]);
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
 * Validate one line that only carries a component and a quantity. Unlike a
 * receipt, an issue and a transfer derive cost from the consumed FIFO batches.
 * @param {{ componentId: number, qty: number }} line
 * @param {number} position 1-based line number used in error messages
 * @returns {{ componentId: number, qty: number }}
 */
function prepareQuantityLine(line, position) {
  return {
    componentId: readId(line?.componentId, `Строка ${position}: выберите позицию.`),
    qty: readQty(line?.qty, position),
  };
}

/**
 * @param {unknown[]} lines
 * @param {string} emptyMessage Russian, user-facing text naming the document
 * @returns {Array<{ componentId: number, qty: number }>}
 * @throws {ValidationError} on an empty list, a malformed line or a repeated component
 */
function prepareQuantityLines(lines, emptyMessage) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new ValidationError(emptyMessage);
  }

  const preparedLines = [];
  const seenComponentIds = new Set();

  for (const [index, line] of lines.entries()) {
    const prepared = prepareQuantityLine(line, index + 1);

    // Two rows for one component would each be planned against the same batch
    // snapshot, and the second guarded decrement would overdraw the batch. The
    // form can merge the quantities, so reject the ambiguity before any write.
    if (seenComponentIds.has(prepared.componentId)) {
      throw new ValidationError('Позиция указана несколько раз — объедините строки.');
    }

    seenComponentIds.add(prepared.componentId);
    preparedLines.push(prepared);
  }

  return preparedLines;
}

/** @param {unknown[]} lines @returns {Array<{ componentId: number, qty: number }>} */
function prepareIssueLines(lines) {
  return prepareQuantityLines(lines, 'Добавьте хотя бы одну строку расхода.');
}

/** @param {unknown[]} lines @returns {Array<{ componentId: number, qty: number }>} */
function prepareTransferLines(lines) {
  return prepareQuantityLines(lines, 'Добавьте хотя бы одну строку перемещения.');
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
function toLineTotal(totalCost, position) {
  const rounded = d(totalCost).toFixed(2);
  if (d(rounded).greaterThan(LINE_TOTAL_MAX)) {
    throw new ValidationError(`Строка ${position}: сумма строки слишком большая.`);
  }

  return rounded;
}

/**
 * Store the weighted average of the consumed batches on the document line. The
 * authoritative split stays in `batch_consumptions`, so this value is a display
 * and reporting convenience, not the source of cost.
 * @param {string} lineTotal stored two-decimal total
 * @param {number} qty whole units on the line
 * @returns {string}
 */
function weightedUnitCost(lineTotal, qty) {
  return d(lineTotal).dividedBy(qty).toDecimalPlaces(UNIT_COST_SCALE).toFixed(UNIT_COST_SCALE);
}

/**
 * Allocate every line of an issue or transfer against locked source batches.
 * Nothing is written here: a shortage must abort the whole document before its
 * number is reserved or a single row is touched.
 * @param {import('pg').PoolClient} client
 * @param {Array<{ componentId: number, qty: number }>} lines
 * @param {number} warehouseId warehouse the stock leaves
 * @returns {Promise<Array<{
 *   line: { componentId: number, qty: number },
 *   allocations: Array<{ batchId: number, qty: number, unitCost: string, totalCost: string }>,
 *   totalCost: string,
 * }>>}
 */
async function planFifoLines(client, lines, warehouseId) {
  const plannedLines = [];

  for (const [index, line] of lines.entries()) {
    const batches = await stock.lockOpenBatches(client, line.componentId, warehouseId);
    const allocation = allocateFifo(batches, line.qty);
    plannedLines.push({
      line,
      allocations: allocation.allocations,
      totalCost: toLineTotal(allocation.totalCost, index + 1),
    });
  }

  return plannedLines;
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
    const plannedLines = await planFifoLines(client, preparedLines, warehouse);

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
      const unitCost = weightedUnitCost(lineTotal, line.qty);

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
 * Post an inter-warehouse transfer: consume the source batches FIFO, recreate
 * them on the destination with the same unit costs, and write both movements in
 * one transaction.
 *
 * Cost is preserved, never recalculated: each consumed allocation becomes one
 * destination batch at its own `unit_cost`, dated by the transfer document so its
 * FIFO age starts on arrival. There is no draft state; any failure — including
 * insufficient stock — rolls back the document number, both warehouses and every
 * batch change together.
 *
 * @param {{
 *   fromWarehouseId: number,
 *   toWarehouseId: number,
 *   docDate: string,
 *   comment?: string | null,
 *   lines: Array<{ componentId: number, qty: number }>,
 *   userId?: number | null,
 *   req?: import('express').Request,
 * }} input
 * @returns {Promise<{ documentId: number, number: string, totalCost: string }>}
 * @throws {ValidationError} on malformed input, equal warehouses, an archived component or empty lines
 * @throws {NotFoundError} when a warehouse or a component is missing
 * @throws {ConflictError} when an inventory count freezes either warehouse
 * @throws {InsufficientStockError} when the source batches cannot cover a line
 */
export async function postTransfer({
  fromWarehouseId,
  toWarehouseId,
  docDate,
  comment = null,
  lines,
  userId = null,
  req,
}) {
  const preparedLines = prepareTransferLines(lines);
  const year = readDocumentYear(docDate);
  const from = readId(fromWarehouseId, 'Выберите склад-источник.');
  const to = readId(toWarehouseId, 'Выберите склад-назначение.');
  const author = readUserId(userId);

  // The database enforces this too, but failing here keeps the answer a 400
  // with a field-level message instead of a constraint violation.
  if (from === to) {
    throw new ValidationError('Склад-источник и склад-назначение должны различаться.');
  }

  return withTransaction(async (client) => {
    await lockWarehousesNotFrozen(client, [from, to]);

    const components = await stock.findComponentsByIds(
      client,
      preparedLines.map((line) => line.componentId),
    );
    assertComponentsUsable(preparedLines, components, 'перемещение');

    const plannedLines = await planFifoLines(client, preparedLines, from);

    const totalCost = plannedLines
      .reduce((sum, planned) => sum.plus(planned.totalCost), d(0))
      .toFixed(2);
    if (d(totalCost).greaterThan(LINE_TOTAL_MAX)) {
      throw new ValidationError('Сумма документа слишком большая.');
    }

    const number = await stock.nextDocumentNumber(client, 'transfer', year);
    const inserted = await stock.insertDocument(client, {
      type: 'transfer',
      number,
      docDate,
      fromWarehouseId: from,
      toWarehouseId: to,
      comment,
      totalCost,
      createdBy: author,
    });

    for (const planned of plannedLines) {
      const { line, allocations, totalCost: lineTotal } = planned;
      const unitCost = weightedUnitCost(lineTotal, line.qty);

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

        // One destination batch per allocation is what keeps the cost exact: a
        // single merged batch would need a weighted average and drift by
        // rounding whenever the source batches had different prices.
        await stock.insertBatch(client, {
          componentId: line.componentId,
          warehouseId: to,
          unitCost: allocation.unitCost,
          qty: allocation.qty,
          receivedAt: docDate,
          documentNo: number,
        });

        await stock.insertMovement(client, {
          componentId: line.componentId,
          warehouseId: from,
          qtyDelta: -allocation.qty,
          unitCost: allocation.unitCost,
          documentId: inserted.id,
          lineId: documentLine.id,
        });

        await stock.insertMovement(client, {
          componentId: line.componentId,
          warehouseId: to,
          qtyDelta: allocation.qty,
          unitCost: allocation.unitCost,
          documentId: inserted.id,
          lineId: documentLine.id,
        });
      }
    }

    await audit.record(
      {
        userId: author,
        action: 'stock.transfer',
        entityType: 'stock_document',
        entityId: inserted.id,
        details: {
          number,
          fromWarehouseId: from,
          toWarehouseId: to,
          total: totalCost,
        },
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
 *     allocations: Array<{
 *       batchId: number,
 *       qty: number,
 *       unitCost: string,
 *       totalCost: string,
 *       receivedAt: string | null,
 *       documentNo: string | null,
 *     }>,
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

    // `allocateFifo` only needs id, cost and quantity. The form shows the
    // operator which receipt a consumed batch came from, so the batch metadata
    // is joined back here rather than widening the pure domain function.
    const batchesById = new Map(batches.map((batch) => [batch.id, batch]));
    previewLines.push({
      componentId: line.componentId,
      allocations: allocation.allocations.map((consumed) => ({
        ...consumed,
        receivedAt: batchesById.get(consumed.batchId)?.receivedAt ?? null,
        documentNo: batchesById.get(consumed.batchId)?.documentNo ?? null,
      })),
      totalCost: toLineTotal(allocation.totalCost, index + 1),
    });
  }

  const totalCost = previewLines.reduce((sum, line) => sum.plus(line.totalCost), d(0)).toFixed(2);

  return { lines: previewLines, totalCost };
}

// ---------------------------------------------------------------------------
// Read models for the stock document screens.
// ---------------------------------------------------------------------------

const DOCUMENT_PAGE_SIZE = 20;

const DOCUMENT_TYPES = new Set(['receipt', 'issue', 'transfer']);

/**
 * One page of documents of a single type.
 *
 * The page number is clamped to the last page instead of returning an empty
 * table: a stale bookmark after documents were deleted should still show the
 * newest rows rather than a blank screen.
 *
 * @param {'receipt' | 'issue' | 'transfer'} type
 * @param {{
 *   q?: string,
 *   warehouseId?: number | null,
 *   supplierId?: number | null,
 *   fromWarehouseId?: number | null,
 *   toWarehouseId?: number | null,
 *   reason?: string | null,
 *   dateFrom?: string,
 *   dateTo?: string,
 *   page?: number,
 * }} [filters]
 * @returns {Promise<{
 *   items: Awaited<ReturnType<typeof stock.listDocumentViews>>,
 *   total: number,
 *   page: number,
 *   pages: number,
 * }>}
 */
export async function listDocuments(type, filters = {}) {
  if (!DOCUMENT_TYPES.has(type)) {
    throw new TypeError(`listDocuments: unknown document type "${type}"`);
  }

  const query = {
    type,
    q: filters.q ?? '',
    warehouseId: filters.warehouseId ?? null,
    supplierId: filters.supplierId ?? null,
    fromWarehouseId: filters.fromWarehouseId ?? null,
    toWarehouseId: filters.toWarehouseId ?? null,
    reason: filters.reason && filters.reason !== 'all' ? filters.reason : null,
    dateFrom: filters.dateFrom ?? '',
    dateTo: filters.dateTo ?? '',
  };

  const total = await stock.countDocumentViews(query);
  const pages = Math.max(1, Math.ceil(total / DOCUMENT_PAGE_SIZE));
  const requested = Number.isInteger(filters.page) && filters.page > 0 ? filters.page : 1;
  const page = Math.min(requested, pages);

  const items = await stock.listDocumentViews({
    ...query,
    limit: DOCUMENT_PAGE_SIZE,
    offset: (page - 1) * DOCUMENT_PAGE_SIZE,
  });

  return { items, total, page, pages };
}

/**
 * Header and lines of one stock document.
 *
 * The expected type is checked here so `/stock/receipts/:id` cannot render an
 * issue under a receipt URL: a wrong type is indistinguishable from a missing
 * document to the caller.
 *
 * @param {number} documentId
 * @param {'receipt' | 'issue' | 'transfer'} type
 * @returns {Promise<{
 *   document: NonNullable<Awaited<ReturnType<typeof stock.findDocumentView>>>,
 *   lines: Awaited<ReturnType<typeof stock.listDocumentLineViews>>,
 *   totalQty: number,
 * }>}
 * @throws {NotFoundError} when the document does not exist or has another type
 */
export async function getDocumentDetail(documentId, type) {
  if (!DOCUMENT_TYPES.has(type)) {
    throw new TypeError(`getDocumentDetail: unknown document type "${type}"`);
  }

  const id = readId(documentId, 'Документ не найден.');
  const document = await stock.findDocumentView(id);
  if (!document || document.type !== type) throw new NotFoundError('Документ не найден.');

  const lines = await stock.listDocumentLineViews(id);
  const totalQty = lines.reduce((sum, line) => sum + line.qty, 0);

  return { document, lines, totalQty };
}

/**
 * Positions for the no-JavaScript fallback select on stock forms.
 *
 * Archived positions are included only when their ids are passed in, which is
 * how a rejected post keeps the submitted option visible with an
 * «(неактивен)» label.
 * @param {number[]} [includeIds]
 * @returns {Promise<Array<{
 *   id: number,
 *   sku: string,
 *   name: string,
 *   unit: string,
 *   isActive: boolean,
 * }>>}
 */
export function listFormComponents(includeIds = []) {
  return stock.listFormComponents(includeIds);
}

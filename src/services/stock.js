import { withTransaction } from '../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { d, toCost } from '../domain/money.js';
import { logger } from '../lib/logger.js';
import * as stock from '../repositories/stock.js';
import * as audit from './audit.js';

// Documents are stored as ISO `YYYY-MM-DD` (the format of `<input type="date">`
// and of the `date` columns); the Russian дд.мм.гггг form is a display concern.
const DOC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const FROZEN_WAREHOUSE_MESSAGE = 'На складе идёт инвентаризация';

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
  const componentId = line?.componentId;
  if (!Number.isSafeInteger(componentId) || componentId <= 0) {
    throw new ValidationError(`Строка ${position}: выберите позицию.`);
  }

  const qty = line?.qty;
  if (!Number.isSafeInteger(qty) || qty <= 0) {
    throw new ValidationError(
      `Строка ${position}: количество должно быть целым положительным числом.`,
    );
  }

  const unitCost = d(line?.unitCost);
  if (unitCost.isNegative()) {
    throw new ValidationError(`Строка ${position}: цена не может быть отрицательной.`);
  }

  return {
    componentId,
    qty,
    unitCost: toCost(unitCost),
    totalCost: unitCost.times(qty).toFixed(2),
  };
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

  return Number(docDate.slice(0, 4));
}

/**
 * Check the found rows against the requested ids and archive flags.
 * Runs before any write, so a receipt naming an archived component writes nothing.
 */
function assertSupplierUsable(supplier) {
  if (!supplier) throw new NotFoundError('Поставщик не найден.');
  if (!supplier.isActive) throw new ValidationError('Поставщик неактивен, приёмка невозможна.');
}

function assertComponentsUsable(lines, components) {
  const componentsById = new Map(components.map((component) => [component.id, component]));

  for (const line of lines) {
    const component = componentsById.get(line.componentId);
    if (!component) throw new NotFoundError(`Позиция с кодом ${line.componentId} не найдена.`);
    if (!component.isActive) {
      throw new ValidationError(`Позиция ${component.sku} неактивна, приёмка невозможна.`);
    }
  }
}

/**
 * Write the receipt audit entry after the stock transaction has committed.
 *
 * The receipt is durable by then: surfacing an audit failure as a request error
 * would tell the operator the receipt failed and invite a duplicate submission.
 * The gap is logged with the document id so it can be reconciled by hand.
 */
async function recordReceiptAudit({ document, totalCost, userId, req }) {
  try {
    await audit.record({
      userId,
      action: 'stock.receipt',
      entityType: 'stock_document',
      entityId: document.documentId,
      details: { number: document.number, total: totalCost },
      req,
    });
  } catch (error) {
    (req?.log ?? logger).error(
      { err: error, documentId: document.documentId },
      'stock receipt audit entry failed',
    );
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

  // Line totals are stored rounded to kopecks, so the document total is the sum
  // of the stored line totals — otherwise the printed document would not add up.
  const totalCost = preparedLines.reduce((sum, line) => sum.plus(line.totalCost), d(0)).toFixed(2);

  const document = await withTransaction(async (client) => {
    await assertWarehouseNotFrozen(client, warehouseId);
    assertSupplierUsable(await stock.findSupplierById(client, supplierId));

    const components = await stock.findComponentsByIds(
      client,
      preparedLines.map((line) => line.componentId),
    );
    assertComponentsUsable(preparedLines, components);

    const number = await stock.nextDocumentNumber(client, 'receipt', year);
    const inserted = await stock.insertDocument(client, {
      type: 'receipt',
      number,
      docDate,
      supplierId,
      warehouseId,
      comment,
      totalCost,
      createdBy: userId,
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
        warehouseId,
        supplierId,
        unitCost: line.unitCost,
        qty: line.qty,
        receivedAt: docDate,
        documentNo: number,
      });

      await stock.insertMovement(client, {
        componentId: line.componentId,
        warehouseId,
        qtyDelta: line.qty,
        unitCost: line.unitCost,
        documentId: inserted.id,
        lineId: documentLine.id,
      });
    }

    return { documentId: inserted.id, number };
  });

  await recordReceiptAudit({ document, totalCost, userId, req });
  return document;
}

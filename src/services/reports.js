import { env } from '../config/env.js';
import { csvFilename, toCsv } from '../domain/csv.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.js';
import { d, formatMoney, formatQty } from '../domain/money.js';
import { listAuditEntries } from '../repositories/audit.js';
import * as reportRepository from '../repositories/reports.js';
import * as audit from './audit.js';
import { getAbc, getReorder, getXyz } from './analytics.js';
import { getCountDetail } from './inventory.js';

/**
 * CSV report builders.
 *
 * Every export reuses the read model that owns the numbers on screen: ABC, XYZ
 * and reorder come from the analytics service, the inventory act from the
 * inventory service, and the audit log from the audit repository. Formatting is
 * repeated here only as presentation: money keeps decimal.js grouping, dates
 * are rendered in Europe/Minsk, and quantities use the Russian space separator.
 */

export const REPORT_TYPES = Object.freeze([
  'stock',
  'movements',
  'abc',
  'xyz',
  'reorder',
  'inventory',
  'audit',
]);

const DEFAULT_RANGE_DAYS = 30;
const AUDIT_PAGE_SIZE = 1000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const GROUP_SPACES = /[\u00A0\u2009\u202F]/g;

const MINSK_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Minsk',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const MINSK_YEAR = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Minsk',
  year: 'numeric',
});

const MINSK_DATE_TIME = new Intl.DateTimeFormat('ru-BY', {
  timeZone: 'Europe/Minsk',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const MOVEMENT_TYPE_LABELS = Object.freeze({
  receipt: 'Приёмка',
  issue: 'Расход',
  transfer: 'Перемещение',
});

const REORDER_STATUS_LABELS = Object.freeze({
  zero: 'Нет остатка',
  below_rop: 'Ниже точки заказа',
  ok: 'В норме',
});

function todayInMinsk() {
  return MINSK_DATE.format(new Date());
}

/** Analytics windows are pinned in demo and test runs, just like every page. */
function referenceDate() {
  return env.analyticsReferenceDate ?? todayInMinsk();
}

function addDays(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function isRealIsoDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function formatTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return MINSK_DATE_TIME.format(date).replace(', ', ' ');
}

function formatDecimal(value, fractionDigits) {
  const formatter = new Intl.NumberFormat('ru-BY', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  return formatter.format(value).replaceAll(GROUP_SPACES, ' ');
}

function formatPercent(fraction) {
  return formatDecimal(fraction * 100, 2);
}

/**
 * Optional report filter identifiers.
 * @param {unknown} value
 * @param {string} label Russian field name used in the error
 * @returns {number|null}
 */
function readOptionalId(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ValidationError(`${label}: некорректный идентификатор.`);
  }
  return id;
}

function normalizeFilters(filters = {}) {
  return {
    warehouseId: readOptionalId(filters.warehouseId, 'Склад'),
    categoryId: readOptionalId(filters.categoryId, 'Категория'),
  };
}

/**
 * Resolve the inclusive movement range.
 *
 * The page defaults to the last 30 days. A single supplied bound is completed
 * from the reference date rather than silently widening the range, and a
 * reversed pair is a 400 instead of an empty export nobody can explain.
 *
 * @param {{ dateFrom?: string, dateTo?: string }} [filters]
 * @returns {{ dateFrom: string, dateTo: string }}
 * @throws {ValidationError} on a malformed or reversed range
 */
export function resolveMovementRange(filters = {}) {
  const reference = referenceDate();
  let dateFrom = filters.dateFrom ?? null;
  let dateTo = filters.dateTo ?? null;

  if (!dateFrom && !dateTo) {
    dateTo = reference;
    dateFrom = addDays(dateTo, -(DEFAULT_RANGE_DAYS - 1));
  } else if (!dateFrom) {
    dateFrom = addDays(dateTo, -(DEFAULT_RANGE_DAYS - 1));
  } else if (!dateTo) {
    dateTo = reference;
  }

  for (const value of [dateFrom, dateTo]) {
    if (!isRealIsoDate(value)) {
      throw new ValidationError('Укажите дату в формате ГГГГ-ММ-ДД.');
    }
  }
  if (dateFrom > dateTo) {
    throw new ValidationError('Дата начала не может быть позже даты окончания.');
  }

  return { dateFrom, dateTo };
}

/** Page-facing defaults so the date inputs and the export agree. */
export function defaultMovementRange() {
  return resolveMovementRange({});
}

/* --------------------------------------------------------------- Builders */

async function buildStock(filters) {
  const rows = await reportRepository.listStockBalances(filters);
  const columns = [
    { key: 'sku', label: 'Артикул' },
    { key: 'name', label: 'Название' },
    { key: 'categoryName', label: 'Категория' },
    { key: 'warehouseName', label: 'Склад' },
    { key: 'qty', label: 'Остаток', format: (row) => formatQty(row.qty) },
    { key: 'unit', label: 'Ед.' },
    {
      key: 'avgCost',
      label: 'Себестоимость, BYN',
      format: (row) => (row.avgCost === null ? '' : formatMoney(row.avgCost)),
    },
    { key: 'value', label: 'Стоимость, BYN', format: (row) => formatMoney(row.value) },
    { key: 'minStock', label: 'Минимум', format: (row) => formatQty(row.minStock) },
    {
      key: 'maxStock',
      label: 'Максимум',
      format: (row) => (row.maxStock === null ? '' : formatQty(row.maxStock)),
    },
  ];

  return {
    filename: csvFilename('stock', referenceDate()),
    content: toCsv(rows, columns),
    auditFilters: compactFilters(filters),
  };
}

async function buildMovements(filters) {
  const range = resolveMovementRange(filters);
  const rows = await reportRepository.listMovements({ ...filters, ...range });
  const columns = [
    { key: 'createdAt', label: 'Дата и время', format: (row) => formatTimestamp(row.createdAt) },
    {
      key: 'documentType',
      label: 'Тип',
      format: (row) => MOVEMENT_TYPE_LABELS[row.documentType] ?? 'Корректировка',
    },
    {
      key: 'documentNumber',
      label: 'Документ',
      format: (row) => row.documentNumber ?? '',
    },
    { key: 'sku', label: 'Артикул' },
    { key: 'componentName', label: 'Позиция' },
    { key: 'warehouseName', label: 'Склад' },
    { key: 'qtyDelta', label: 'Количество', format: (row) => formatQty(row.qtyDelta) },
    { key: 'unit', label: 'Ед.' },
    { key: 'unitCost', label: 'Себестоимость, BYN', format: (row) => formatMoney(row.unitCost) },
    {
      key: 'amount',
      label: 'Сумма, BYN',
      format: (row) => formatMoney(d(row.qtyDelta).times(row.unitCost)),
    },
    { key: 'userName', label: 'Пользователь', format: (row) => row.userName ?? '' },
  ];

  return {
    filename: csvFilename('movements', range.dateTo),
    content: toCsv(rows, columns),
    auditFilters: { ...compactFilters(filters), ...range },
  };
}

async function buildAbc(filters) {
  const { rows } = await getAbc(filters);
  const columns = [
    { key: 'rank', label: 'Место' },
    { key: 'sku', label: 'Артикул' },
    { key: 'name', label: 'Название' },
    { key: 'categoryName', label: 'Категория' },
    { key: 'qty', label: 'Остаток', format: (row) => formatQty(row.qty) },
    { key: 'unit', label: 'Ед.' },
    { key: 'value', label: 'Стоимость, BYN', format: (row) => formatMoney(row.value) },
    { key: 'share', label: 'Доля, %', format: (row) => formatPercent(row.share) },
    {
      key: 'cumulativeShare',
      label: 'Накопленная доля, %',
      format: (row) => formatPercent(row.cumulativeShare),
    },
    { key: 'class', label: 'Класс' },
  ];

  return {
    filename: csvFilename('abc', referenceDate()),
    content: toCsv(rows, columns),
    auditFilters: compactFilters(filters),
  };
}

async function buildXyz(filters) {
  const { rows, window } = await getXyz(filters);
  const columns = [
    { key: 'sku', label: 'Артикул' },
    { key: 'name', label: 'Название' },
    { key: 'categoryName', label: 'Категория' },
    ...window.months.map((month, index) => ({
      key: `month-${month.key}`,
      label: month.label,
      format: (row) => formatQty(row.monthly[index]),
    })),
    { key: 'total', label: 'Итого', format: (row) => formatQty(row.total) },
    { key: 'mean', label: 'Средний расход', format: (row) => formatDecimal(row.mean, 2) },
    {
      key: 'stddev',
      label: 'Стандартное отклонение',
      format: (row) => formatDecimal(row.stddev, 2),
    },
    {
      key: 'cv',
      label: 'Коэффициент вариации',
      format: (row) => (row.cv === null ? '' : formatDecimal(row.cv, 4)),
    },
    { key: 'class', label: 'Класс' },
  ];

  return {
    filename: csvFilename('xyz', referenceDate()),
    content: toCsv(rows, columns),
    auditFilters: compactFilters(filters),
  };
}

async function buildReorder(filters) {
  const { rows } = await getReorder(filters);
  const columns = [
    { key: 'sku', label: 'Артикул' },
    { key: 'name', label: 'Название' },
    { key: 'categoryName', label: 'Категория' },
    { key: 'warehouseCount', label: 'Складов', format: (row) => formatQty(row.warehouseCount) },
    { key: 'balance', label: 'Остаток', format: (row) => formatQty(row.balance) },
    { key: 'unit', label: 'Ед.' },
    { key: 'avgDaily', label: 'Средний расход', format: (row) => formatDecimal(row.avgDaily, 3) },
    {
      key: 'safetyStock',
      label: 'Страховой запас',
      format: (row) => formatDecimal(row.safetyStock, 2),
    },
    { key: 'rop', label: 'ROP', format: (row) => formatDecimal(row.rop, 2) },
    { key: 'eoq', label: 'EOQ', format: (row) => formatQty(row.eoq) },
    { key: 'suggested', label: 'Заказать', format: (row) => formatQty(row.suggested) },
    {
      key: 'status',
      label: 'Статус',
      format: (row) => REORDER_STATUS_LABELS[row.status] ?? row.status,
    },
    { key: 'lowData', label: 'Мало данных', format: (row) => (row.lowData ? 'да' : 'нет') },
  ];

  return {
    filename: csvFilename('reorder', referenceDate()),
    content: toCsv(rows, columns),
    auditFilters: compactFilters(filters),
  };
}

function displayInventoryNumber(count) {
  const year = MINSK_YEAR.format(count.createdAt);
  return `ИНВ-${year}-${String(count.id).padStart(4, '0')}`;
}

async function buildInventory(filters) {
  const countId = Number(filters.countId);
  if (!Number.isSafeInteger(countId) || countId < 1) {
    throw new ValidationError('Укажите номер инвентаризации.');
  }

  const { count, lines } = await getCountDetail(countId);
  const documentNumber = displayInventoryNumber(count);
  const rows = lines.map((line) => ({
    ...line,
    documentNumber,
    warehouseName: count.warehouseName,
    differenceAmount:
      line.difference === null ? null : d(line.difference).times(line.unitCost).toFixed(4),
  }));

  const columns = [
    { key: 'documentNumber', label: 'Документ' },
    { key: 'sku', label: 'Артикул' },
    { key: 'name', label: 'Название' },
    { key: 'warehouseName', label: 'Склад' },
    { key: 'expectedQty', label: 'Учёт', format: (row) => formatQty(row.expectedQty) },
    {
      key: 'actualQty',
      label: 'Факт',
      format: (row) => (row.actualQty === null ? '' : formatQty(row.actualQty)),
    },
    {
      key: 'difference',
      label: 'Разница',
      format: (row) => (row.difference === null ? '' : formatQty(row.difference)),
    },
    {
      key: 'unitCost',
      label: 'Себестоимость, BYN',
      format: (row) => formatMoney(row.unitCost),
    },
    {
      key: 'differenceAmount',
      label: 'Сумма разницы, BYN',
      format: (row) => (row.differenceAmount === null ? '' : formatMoney(row.differenceAmount)),
    },
    { key: 'comment', label: 'Комментарий', format: (row) => row.comment ?? '' },
  ];

  return {
    filename: csvFilename('inventory', referenceDate()),
    content: toCsv(rows, columns),
    auditFilters: { countId },
  };
}

/** Read every page of the audit log so the export is not capped like the screen. */
async function listAllAuditEntries() {
  const entries = [];
  for (let offset = 0; ; offset += AUDIT_PAGE_SIZE) {
    const page = await listAuditEntries({ limit: AUDIT_PAGE_SIZE, offset });
    entries.push(...page);
    if (page.length < AUDIT_PAGE_SIZE) return entries;
  }
}

async function buildAudit() {
  const rows = await listAllAuditEntries();
  const columns = [
    { key: 'createdAt', label: 'Дата и время', format: (row) => formatTimestamp(row.createdAt) },
    {
      key: 'userName',
      label: 'Пользователь',
      format: (row) => row.userName ?? row.userEmail ?? 'Система',
    },
    { key: 'userEmail', label: 'Email', format: (row) => row.userEmail ?? '' },
    { key: 'action', label: 'Действие' },
    { key: 'entityType', label: 'Тип сущности', format: (row) => row.entityType ?? '' },
    { key: 'entityId', label: 'ID', format: (row) => row.entityId ?? '' },
    { key: 'ip', label: 'IP', format: (row) => row.ip ?? '' },
    {
      key: 'details',
      label: 'Детали',
      format: (row) => JSON.stringify(row.details ?? {}),
    },
  ];

  return {
    filename: csvFilename('audit', referenceDate()),
    content: toCsv(rows, columns),
    auditFilters: {},
  };
}

/** Only the filters explicitly supplied belong in the audit trail. */
function compactFilters(filters) {
  const compact = {};
  if (filters.warehouseId !== null && filters.warehouseId !== undefined) {
    compact.warehouseId = filters.warehouseId;
  }
  if (filters.categoryId !== null && filters.categoryId !== undefined) {
    compact.categoryId = filters.categoryId;
  }
  return compact;
}

const BUILDERS = Object.freeze({
  stock: buildStock,
  movements: buildMovements,
  abc: buildAbc,
  xyz: buildXyz,
  reorder: buildReorder,
  inventory: buildInventory,
  audit: buildAudit,
});

/**
 * Build one CSV report and write the export to the audit trail.
 *
 * @param {'stock'|'movements'|'abc'|'xyz'|'reorder'|'inventory'|'audit'} type
 * @param {{
 *   warehouseId?: number|null,
 *   categoryId?: number|null,
 *   dateFrom?: string,
 *   dateTo?: string,
 *   countId?: number,
 * }} [filters]
 * @param {{ user?: { id?: number, role?: string }|null, req?: import('express').Request }} [ctx]
 * @returns {Promise<{ filename: string, content: string }>}
 * @throws {NotFoundError} for an unknown report type
 * @throws {ForbiddenError} when a non-admin requests the audit report
 * @throws {ValidationError} on malformed filters or an invalid range
 */
async function exportReport(type, filters = {}, ctx = {}) {
  if (!REPORT_TYPES.includes(type)) throw new NotFoundError('Отчёт не найден.');

  const user = ctx.user ?? ctx.req?.user ?? null;
  if (type === 'audit' && user?.role !== 'admin') {
    throw new ForbiddenError('Экспорт аудита доступен только администратору.');
  }

  const preparedFilters = normalizeFilters(filters);
  const { filename, content, auditFilters } = await BUILDERS[type]({
    ...preparedFilters,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    countId: filters.countId,
  });

  await audit.record({
    userId: user?.id ?? null,
    action: 'report.export',
    entityType: 'report',
    entityId: type,
    details: { type, filters: auditFilters },
    req: ctx.req,
  });

  return { filename, content };
}

export { exportReport as export };

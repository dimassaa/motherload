import { z } from 'zod';
import { AppError } from '../lib/app-error.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { fieldErrorsFromZod, messagesFromZod } from '../middleware/validate.js';
import * as directories from '../services/directories.js';
import {
  getDocumentDetail,
  listDocuments,
  listFormComponents,
  postIssue,
  postReceipt,
  postTransfer,
  previewIssue,
} from '../services/stock.js';

// Upper bounds match the `integer` columns: a larger id or quantity could only
// fail in PostgreSQL with an opaque 22003, so it is rejected at the boundary.
const INTEGER_MAX = 2_147_483_647;
const QTY_MAX = 1_000_000_000;
const COMMENT_MAX = 500;
const FILTER_MAX = 120;

const idSchema = z.coerce.number().int().min(1).max(INTEGER_MAX);

const ISSUE_REASONS = Object.freeze([
  { value: 'sale', label: 'Продажа' },
  { value: 'defect', label: 'Брак' },
  { value: 'supplier_return', label: 'Возврат поставщику' },
  { value: 'internal', label: 'Внутреннее использование' },
  { value: 'other', label: 'Другое' },
]);

const ISSUE_REASON_VALUES = ISSUE_REASONS.map((reason) => reason.value);

const ISSUE_REASON_LABELS = Object.freeze(
  Object.fromEntries(ISSUE_REASONS.map((reason) => [reason.value, reason.label])),
);

/**
 * Screen metadata per document type: titles, paths and the templates that
 * render each screen. Keeping it in one table is what lets the list, form and
 * card handlers stay one shape instead of three near-copies.
 */
const DOCUMENT_META = Object.freeze({
  receipt: {
    label: 'Приёмка',
    plural: 'Приёмки',
    listPath: '/stock/receipts',
    listTemplate: 'receipts',
    newTemplate: 'receipt-new',
    newTitle: 'Новая приёмка',
    createdMessage: 'Приёмка проведена',
  },
  issue: {
    label: 'Расход',
    plural: 'Расходы',
    listPath: '/stock/issues',
    listTemplate: 'issues',
    newTemplate: 'issue-new',
    newTitle: 'Новый расход',
    createdMessage: 'Расход проведён',
  },
  transfer: {
    label: 'Перемещение',
    plural: 'Перемещения',
    listPath: '/stock/transfers',
    listTemplate: 'transfers',
    newTemplate: 'transfer-new',
    newTitle: 'Новое перемещение',
    createdMessage: 'Перемещение проведено',
  },
});

// Document dates are calendar dates in Europe/Minsk. `toISOString()` would
// shift them for a server in another timezone, so the day is taken explicitly.
const MINSK_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Minsk' });

function todayInMinsk() {
  return MINSK_DATE.format(new Date());
}

/** Read a form or query value as a trimmed string; anything else is empty. */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A malformed, out-of-range or vanished `:id` names no document, so it is a
 * 404, not a database 22003 behind a 500. The upper bound is the same as the
 * `integer` columns and the query schema.
 */
function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0 || id > INTEGER_MAX) {
    throw new NotFoundError('Документ не найден.');
  }
  return id;
}

// ---------------------------------------------------------------------------
// Query and form schemas
// ---------------------------------------------------------------------------

const optionalFilterId = z.preprocess(
  (value) => (value === undefined || value === null || value === '' ? null : value),
  z.union([z.null(), z.coerce.number().int().positive()]).catch(null),
);

const optionalFilterDate = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : ''),
  z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).catch(''),
);

/**
 * Filters never fail a page. A stale bookmark with an unknown reason or a
 * malformed date falls back to the unfiltered list instead of a 400 the user
 * cannot fix from the URL.
 */
const listQuerySchema = z.object({
  q: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : ''),
    z.string().max(FILTER_MAX).catch(''),
  ),
  page: z.preprocess(
    (value) => (value === undefined || value === '' || value === null ? 1 : value),
    z.coerce.number().int().min(1).catch(1),
  ),
  warehouseId: optionalFilterId,
  supplierId: optionalFilterId,
  fromWarehouseId: optionalFilterId,
  toWarehouseId: optionalFilterId,
  reason: z.preprocess(
    (value) => (typeof value === 'string' ? value : 'all'),
    z.enum(['all', ...ISSUE_REASON_VALUES]).catch('all'),
  ),
  dateFrom: optionalFilterDate,
  dateTo: optionalFilterDate,
});

const requiredId = (message) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    z.coerce.number({ error: message }).int(message).min(1, message).max(INTEGER_MAX, message),
  );

const docDateSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : ''),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Укажите дату документа в формате ГГГГ-ММ-ДД.'),
);

const commentSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : ''),
  z.string().max(COMMENT_MAX, `Комментарий — не длиннее ${COMMENT_MAX} символов.`),
);

const receiptSchema = z.object({
  supplierId: requiredId('Выберите поставщика.'),
  warehouseId: requiredId('Выберите склад.'),
  docDate: docDateSchema,
  comment: commentSchema,
});

const issueSchema = z.object({
  warehouseId: requiredId('Выберите склад.'),
  docDate: docDateSchema,
  reason: z.preprocess(
    (value) => (typeof value === 'string' ? value : ''),
    z.enum(ISSUE_REASON_VALUES, { error: 'Выберите причину расхода.' }),
  ),
  comment: commentSchema,
});

const transferSchema = z.object({
  fromWarehouseId: requiredId('Выберите склад-источник.'),
  toWarehouseId: requiredId('Выберите склад-назначение.'),
  docDate: docDateSchema,
  comment: commentSchema,
});

// ---------------------------------------------------------------------------
// Submitted line rows
// ---------------------------------------------------------------------------

/**
 * Read the nested `lines[i][...]` fields as a dense array.
 *
 * The raw strings are kept for re-rendering: a rejected form must show the
 * operator exactly what they typed, including an empty trailing row.
 * @param {unknown} bodyLines
 * @returns {Array<{ componentId: string, qty: string, unitCost: string }>}
 */
function submittedRows(bodyLines) {
  if (!bodyLines || typeof bodyLines !== 'object') return [];

  return Object.values(bodyLines)
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      componentId: text(row.componentId),
      qty: text(row.qty),
      unitCost: text(row.unitCost),
    }));
}

/**
 * `1250,50` from the decimal input becomes `1250.50`; the service's Decimal
 * parser expects a dot and there is no locale-aware input type that preserves
 * four-decimal unit costs.
 */
function normalizeDecimal(value) {
  return value.replaceAll(' ', '').replaceAll(',', '.');
}

/**
 * Validate the editable rows into service input.
 *
 * The service remains the source of truth for storage bounds and business
 * rules. This pass only converts the form strings and produces Russian field
 * messages before a transaction is opened, so a typo cannot reach PostgreSQL.
 *
 * @param {Array<{ componentId: string, qty: string, unitCost: string }>} rows
 * @param {{ withCost: boolean, allowDuplicates: boolean, emptyMessage: string }} options
 * @returns {{
 *   lines: Array<{ componentId: number, qty: number, unitCost?: string }>,
 *   errors: string[],
 *   lineErrors: Record<number, { componentId?: string, qty?: string, unitCost?: string }>,
 * }}
 */
function prepareRows(rows, { withCost, allowDuplicates, emptyMessage }) {
  const errors = [];
  const lineErrors = {};
  const lines = [];
  const seen = new Set();
  let filledRows = 0;

  /** Attach the message both to the summary and to the offending input. */
  const addError = (index, field, message) => {
    errors.push(message);
    lineErrors[index] = { ...(lineErrors[index] ?? {}), [field]: message };
  };

  for (const [index, row] of rows.entries()) {
    const hasValue = row.componentId !== '' || row.qty !== '' || row.unitCost !== '';
    if (!hasValue) continue;

    filledRows += 1;
    const position = index + 1;

    const componentId = Number(row.componentId);
    const validComponent = /^\d+$/.test(row.componentId) && Number.isSafeInteger(componentId);
    if (!validComponent || componentId < 1) {
      addError(index, 'componentId', `Строка ${position}: выберите позицию.`);
    }

    const qty = Number(row.qty);
    const validQty = /^\d+$/.test(row.qty) && Number.isSafeInteger(qty) && qty >= 1;
    if (!validQty || qty > QTY_MAX) {
      addError(index, 'qty', `Строка ${position}: количество — целое число от 1 до 1 000 000 000.`);
    }

    if (!allowDuplicates && validComponent && seen.has(componentId)) {
      addError(
        index,
        'componentId',
        `Строка ${position}: позиция указана несколько раз — объедините строки.`,
      );
    }
    if (validComponent) seen.add(componentId);

    let unitCost;
    if (withCost) {
      unitCost = normalizeDecimal(row.unitCost);
      if (unitCost === '') {
        addError(index, 'unitCost', `Строка ${position}: укажите цену за единицу.`);
      } else if (!/^\d+(\.\d+)?$/.test(unitCost)) {
        addError(
          index,
          'unitCost',
          `Строка ${position}: цена должна быть числом, например 1250,50.`,
        );
      }
    }

    lines.push({ componentId, qty, ...(withCost ? { unitCost } : {}) });
  }

  if (filledRows === 0) errors.push(emptyMessage);

  return { lines, errors, lineErrors };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * @param {import('express').Response} res
 * @param {'receipt' | 'issue' | 'transfer'} type
 * @param {{
 *   status?: number,
 *   values?: Record<string, unknown>,
 *   fieldErrors?: Record<string, string>,
 *   lineErrors?: Record<number, { componentId?: string, qty?: string, unitCost?: string }>,
 *   errors?: string[],
 *   prefillComponentId?: unknown,
 * }} [state]
 */
async function renderNew(res, type, state = {}) {
  const {
    status = 200,
    values = {},
    fieldErrors = {},
    lineErrors = {},
    errors = [],
    prefillComponentId,
  } = state;
  const meta = DOCUMENT_META[type];

  // A rejected post may name an archived position or supplier. Loading it back
  // keeps the operator's choice visible with an explicit label instead of
  // silently resetting the field to its placeholder.
  const submittedComponentIds = (Array.isArray(values.rows) ? values.rows : [])
    .map((row) => Number(row.componentId))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  const submittedSupplierId = Number(values.supplierId);

  const [warehouses, suppliers, components] = await Promise.all([
    directories.list('warehouses'),
    directories.list('suppliers'),
    listFormComponents(submittedComponentIds),
  ]);

  const requested = Number(prefillComponentId);
  const prefilled =
    components.find((component) => component.id === requested && component.isActive) ?? null;
  const defaultRow = { componentId: prefilled ? String(prefilled.id) : '', qty: '', unitCost: '' };
  const visibleSuppliers = suppliers.filter(
    (supplier) => supplier.isActive || supplier.id === submittedSupplierId,
  );

  const formValues = {
    supplierId: '',
    warehouseId: '',
    fromWarehouseId: '',
    toWarehouseId: '',
    docDate: todayInMinsk(),
    reason: 'sale',
    comment: '',
    ...values,
    rows: Array.isArray(values.rows) && values.rows.length > 0 ? values.rows : [defaultRow],
  };

  res.status(status).render(`pages/stock/${meta.newTemplate}`, {
    title: `${meta.newTitle} — Motherload`,
    type,
    meta,
    warehouses: warehouses.filter((warehouse) => warehouse.isActive),
    suppliers: visibleSuppliers,
    components,
    reasons: ISSUE_REASONS,
    values: formValues,
    fieldErrors,
    lineErrors,
    errors,
  });
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {'receipt' | 'issue' | 'transfer'} type
 */
async function renderList(req, res, type) {
  const filters = listQuerySchema.parse(req.query ?? {});
  const meta = DOCUMENT_META[type];

  // Only the receipt list filters by supplier; loading the directory for
  // issues and transfers would be a query whose result no template reads.
  const [result, warehouses, suppliers] = await Promise.all([
    listDocuments(type, filters),
    directories.list('warehouses'),
    type === 'receipt' ? directories.list('suppliers') : [],
  ]);

  const params = {
    q: filters.q,
    warehouseId: filters.warehouseId,
    supplierId: filters.supplierId,
    fromWarehouseId: filters.fromWarehouseId,
    toWarehouseId: filters.toWarehouseId,
    reason: filters.reason === 'all' ? '' : filters.reason,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
  };

  res.render(`pages/stock/${meta.listTemplate}`, {
    title: `${meta.plural} — Motherload`,
    type,
    meta,
    items: result.items,
    total: result.total,
    page: result.page,
    pages: result.pages,
    filters,
    params,
    warehouses,
    suppliers,
    reasons: ISSUE_REASONS,
    reasonLabel: (value) => ISSUE_REASON_LABELS[value] ?? '—',
  });
}

/**
 * @param {import('express').Response} res
 * @param {'receipt' | 'issue' | 'transfer'} type
 * @param {string} rawId
 */
async function renderDetail(res, type, rawId) {
  const meta = DOCUMENT_META[type];
  const detail = await getDocumentDetail(parseId(rawId), type);

  res.render('pages/stock/document', {
    title: `${detail.document.number} — Motherload`,
    type,
    meta,
    ...detail,
    reasonLabel: ISSUE_REASON_LABELS[detail.document.reason] ?? null,
  });
}

// ---------------------------------------------------------------------------
// GET handlers
// ---------------------------------------------------------------------------

/** `GET /stock` — stable entry point for the «Остатки» navigation item. */
export function showStock(req, res) {
  res.redirect(302, '/stock/receipts');
}

/** `GET /stock/receipts` — receipt documents with filters and pagination. */
export async function showReceipts(req, res, next) {
  try {
    await renderList(req, res, 'receipt');
  } catch (error) {
    next(error);
  }
}

/** `GET /stock/issues` — issue documents with filters and pagination. */
export async function showIssues(req, res, next) {
  try {
    await renderList(req, res, 'issue');
  } catch (error) {
    next(error);
  }
}

/** `GET /stock/transfers` — transfer documents with filters and pagination. */
export async function showTransfers(req, res, next) {
  try {
    await renderList(req, res, 'transfer');
  } catch (error) {
    next(error);
  }
}

/** `GET /stock/receipts/new` — receipt form, optionally prefilled from the catalog. */
export async function showReceiptForm(req, res, next) {
  try {
    await renderNew(res, 'receipt', { prefillComponentId: req.query?.componentId });
  } catch (error) {
    next(error);
  }
}

/** `GET /stock/issues/new` — issue form with the FIFO preview hook. */
export async function showIssueForm(req, res, next) {
  try {
    await renderNew(res, 'issue', { prefillComponentId: req.query?.componentId });
  } catch (error) {
    next(error);
  }
}

/** `GET /stock/transfers/new` — transfer form, optionally prefilled. */
export async function showTransferForm(req, res, next) {
  try {
    await renderNew(res, 'transfer', { prefillComponentId: req.query?.componentId });
  } catch (error) {
    next(error);
  }
}

/** `GET /stock/receipts/:id` — immutable receipt card. */
export async function showReceipt(req, res, next) {
  try {
    await renderDetail(res, 'receipt', req.params.id);
  } catch (error) {
    next(error);
  }
}

/** `GET /stock/issues/:id` — immutable issue card with batch consumptions. */
export async function showIssue(req, res, next) {
  try {
    await renderDetail(res, 'issue', req.params.id);
  } catch (error) {
    next(error);
  }
}

/** `GET /stock/transfers/:id` — immutable transfer card with batch consumptions. */
export async function showTransfer(req, res, next) {
  try {
    await renderDetail(res, 'transfer', req.params.id);
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// POST handlers
// ---------------------------------------------------------------------------

/**
 * A rejected posting is a form problem, so it re-renders the form with the
 * service's Russian message. A vanished entity or an unexpected failure still
 * reaches the central handler: there is no point repainting a form for a
 * supplier that no longer exists.
 * @param {import('express').Response} res
 * @param {'receipt' | 'issue' | 'transfer'} type
 * @param {ValidationError | ConflictError} error
 * @param {{ values: Record<string, unknown>, fieldErrors: Record<string, string> }} state
 */
async function renderPostingError(res, type, error, state) {
  await renderNew(res, type, {
    status: error.status,
    values: state.values,
    fieldErrors: state.fieldErrors,
    errors: [error.message],
  });
}

/** `POST /stock/receipts` — post the receipt in one transaction. */
export async function createReceipt(req, res, next) {
  const body = req.body ?? {};
  const rows = submittedRows(body.lines);
  const values = {
    supplierId: text(body.supplierId),
    warehouseId: text(body.warehouseId),
    docDate: text(body.docDate),
    comment: text(body.comment),
    rows,
  };

  const parsed = receiptSchema.safeParse(body);
  const fieldErrors = parsed.success ? {} : fieldErrorsFromZod(parsed.error);
  const errors = parsed.success ? [] : messagesFromZod(parsed.error);
  const prepared = prepareRows(rows, {
    withCost: true,
    allowDuplicates: true,
    emptyMessage: 'Добавьте хотя бы одну строку приёмки.',
  });
  errors.push(...prepared.errors);

  if (!parsed.success || prepared.errors.length > 0) {
    await renderNew(res, 'receipt', {
      status: 400,
      values,
      fieldErrors,
      lineErrors: prepared.lineErrors,
      errors,
    });
    return;
  }

  try {
    const result = await postReceipt({
      supplierId: parsed.data.supplierId,
      warehouseId: parsed.data.warehouseId,
      docDate: parsed.data.docDate,
      comment: parsed.data.comment || null,
      lines: prepared.lines,
      userId: req.user?.id ?? null,
      req,
    });

    const meta = DOCUMENT_META.receipt;
    req.flash('success', `${meta.createdMessage}: ${result.number}.`);
    res.redirect(`${meta.listPath}/${result.documentId}`);
  } catch (error) {
    if (!(error instanceof ValidationError) && !(error instanceof ConflictError)) {
      next(error);
      return;
    }
    await renderPostingError(res, 'receipt', error, { values, fieldErrors });
  }
}

/** `POST /stock/issues` — FIFO-consume the batches and post the issue. */
export async function createIssue(req, res, next) {
  const body = req.body ?? {};
  const rows = submittedRows(body.lines);
  const values = {
    warehouseId: text(body.warehouseId),
    docDate: text(body.docDate),
    reason: text(body.reason) || 'sale',
    comment: text(body.comment),
    rows,
  };

  const parsed = issueSchema.safeParse(body);
  const fieldErrors = parsed.success ? {} : fieldErrorsFromZod(parsed.error);
  const errors = parsed.success ? [] : messagesFromZod(parsed.error);
  const prepared = prepareRows(rows, {
    withCost: false,
    allowDuplicates: false,
    emptyMessage: 'Добавьте хотя бы одну строку расхода.',
  });
  errors.push(...prepared.errors);

  if (!parsed.success || prepared.errors.length > 0) {
    await renderNew(res, 'issue', {
      status: 400,
      values,
      fieldErrors,
      lineErrors: prepared.lineErrors,
      errors,
    });
    return;
  }

  try {
    const result = await postIssue({
      warehouseId: parsed.data.warehouseId,
      docDate: parsed.data.docDate,
      reason: parsed.data.reason,
      comment: parsed.data.comment || null,
      lines: prepared.lines,
      userId: req.user?.id ?? null,
      req,
    });

    const meta = DOCUMENT_META.issue;
    req.flash('success', `${meta.createdMessage}: ${result.number}.`);
    res.redirect(`${meta.listPath}/${result.documentId}`);
  } catch (error) {
    if (!(error instanceof ValidationError) && !(error instanceof ConflictError)) {
      next(error);
      return;
    }
    await renderPostingError(res, 'issue', error, { values, fieldErrors });
  }
}

/** `POST /stock/transfers` — move stock FIFO while preserving unit costs. */
export async function createTransfer(req, res, next) {
  const body = req.body ?? {};
  const rows = submittedRows(body.lines);
  const values = {
    fromWarehouseId: text(body.fromWarehouseId),
    toWarehouseId: text(body.toWarehouseId),
    docDate: text(body.docDate),
    comment: text(body.comment),
    rows,
  };

  const parsed = transferSchema.safeParse(body);
  const fieldErrors = parsed.success ? {} : fieldErrorsFromZod(parsed.error);
  const errors = parsed.success ? [] : messagesFromZod(parsed.error);
  const prepared = prepareRows(rows, {
    withCost: false,
    allowDuplicates: false,
    emptyMessage: 'Добавьте хотя бы одну строку перемещения.',
  });
  errors.push(...prepared.errors);

  // The database and the service enforce this too; checking before the service
  // lets the answer land on the destination field instead of only in the
  // summary block.
  if (
    parsed.success &&
    parsed.data.fromWarehouseId === parsed.data.toWarehouseId &&
    !fieldErrors.toWarehouseId
  ) {
    const message = 'Склад-источник и склад-назначение должны различаться.';
    fieldErrors.toWarehouseId = message;
    errors.push(message);
  }

  if (!parsed.success || prepared.errors.length > 0 || fieldErrors.toWarehouseId) {
    await renderNew(res, 'transfer', {
      status: 400,
      values,
      fieldErrors,
      lineErrors: prepared.lineErrors,
      errors,
    });
    return;
  }

  try {
    const result = await postTransfer({
      fromWarehouseId: parsed.data.fromWarehouseId,
      toWarehouseId: parsed.data.toWarehouseId,
      docDate: parsed.data.docDate,
      comment: parsed.data.comment || null,
      lines: prepared.lines,
      userId: req.user?.id ?? null,
      req,
    });

    const meta = DOCUMENT_META.transfer;
    req.flash('success', `${meta.createdMessage}: ${result.number}.`);
    res.redirect(`${meta.listPath}/${result.documentId}`);
  } catch (error) {
    if (!(error instanceof ValidationError) && !(error instanceof ConflictError)) {
      next(error);
      return;
    }
    await renderPostingError(res, 'transfer', error, { values, fieldErrors });
  }
}

// ---------------------------------------------------------------------------
// JSON API
// ---------------------------------------------------------------------------

const previewSchema = z.object({
  warehouseId: idSchema,
  lines: z
    .array(
      z.object({
        componentId: idSchema,
        qty: z.coerce.number().int().min(1).max(QTY_MAX),
      }),
    )
    .min(1),
});

/**
 * `POST /api/fifo-preview`
 *
 * Returns how the issue would consume batches and what it would cost. The
 * response mirrors `previewIssue` so the issue form can render the split without
 * duplicating FIFO logic. All money values are strings, never JSON numbers.
 *
 * Domain failures are answered here instead of by the HTML error middleware:
 * API clients need `{ error, message, available? }`, while browser errors stay
 * Russian HTML. Unexpected failures still reach the central handler and become a
 * logged 500.
 */
export async function previewFifo(req, res) {
  const parsed = previewSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Проверьте склад и строки расхода: количество должно быть целым числом больше нуля.',
    });
    return;
  }

  try {
    res.json(await previewIssue(parsed.data));
  } catch (error) {
    if (!(error instanceof AppError)) throw error;

    const body = { error: error.code, message: error.message };
    if (error.available !== undefined) body.available = error.available;
    res.status(error.status).json(body);
  }
}

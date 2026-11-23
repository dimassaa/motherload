import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { fieldErrorsFromZod, messagesFromZod } from '../middleware/validate.js';
import * as directories from '../services/directories.js';
import * as inventory from '../services/inventory.js';

const BASE_PATH = '/inventory';

// Mirrors the `integer` quantity columns. A larger number would reach
// PostgreSQL as 22003 and surface as an opaque 500 instead of a field error.
const QTY_MAX = 1_000_000_000;
const COMMENT_MAX = 500;

/** A malformed or vanished `:id` names no count, so it is a 404, not a 500. */
function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError('Инвентаризация не найдена.');
  return id;
}

const createSchema = z.object({
  warehouseId: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? null : value),
    z.coerce.number({ error: 'Выберите склад.' }).int('Выберите склад.').min(1, 'Выберите склад.'),
  ),
  comment: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : ''),
    z.string().max(COMMENT_MAX, `Комментарий — не длиннее ${COMMENT_MAX} символов.`),
  ),
});

/**
 * Result filters never fail the page. A stale bookmark with an unknown `only`
 * value falls back to the full line list instead of producing an empty table
 * the operator cannot explain.
 */
const detailQuerySchema = z.object({
  q: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : ''),
    z.string().max(120).catch(''),
  ),
  only: z.preprocess(
    (value) => (typeof value === 'string' ? value : 'all'),
    z.enum(['all', 'discrepancy', 'unfilled']).catch('all'),
  ),
});

/**
 * @param {ReturnType<typeof detailQuerySchema.parse>} filters
 * @param {{ sku: string, name: string, actualQty: number | null, difference: number | null }} line
 * @returns {boolean}
 */
function matchesFilter(filters, line) {
  if (filters.only === 'discrepancy' && (line.difference === null || line.difference === 0)) {
    return false;
  }
  if (filters.only === 'unfilled' && line.actualQty !== null) return false;

  if (filters.q !== '') {
    const needle = filters.q.toLowerCase();
    const haystack = `${line.sku} ${line.name}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  return true;
}

/**
 * Pair every line with its form index and filter visibility.
 *
 * The form index is the position in the full line list, so hidden rows keep a
 * unique field name and a save performed under a filter still submits every
 * line. Without that, filtering would silently drop lines from the document.
 * @param {Array<{ sku: string, name: string, actualQty: number | null, difference: number | null }>} lines
 * @param {ReturnType<typeof detailQuerySchema.parse>} filters
 */
function decorateLines(lines, filters) {
  return lines.map((line, formIndex) => ({
    line,
    formIndex,
    visible: matchesFilter(filters, line),
  }));
}

/** Raw form values, kept per component so a failed save repopulates the fields. */
function submittedLineValues(bodyLines) {
  const values = {};
  if (!bodyLines || typeof bodyLines !== 'object') return values;

  for (const raw of Object.values(bodyLines)) {
    if (!raw || typeof raw !== 'object') continue;
    const componentId = Number(raw.componentId);
    if (!Number.isInteger(componentId)) continue;
    values[componentId] = {
      actualQty: typeof raw.actualQty === 'string' ? raw.actualQty.trim() : '',
      comment: typeof raw.comment === 'string' ? raw.comment : '',
    };
  }

  return values;
}

/**
 * Parse the editable lines of the count form.
 *
 * An empty quantity stays `null` — "not entered" is not zero. Comments are
 * trimmed, and a cleared comment is sent as `null` so the service wipes the
 * stored note instead of leaving a stale one.
 * @param {unknown} bodyLines
 * @param {Array<{ componentId: number, sku: string }>} countLines
 * @returns {{
 *   lines: Array<{ componentId: number, actualQty: number | null, comment: string | null }>,
 *   enteredValues: Record<number, { actualQty: string, comment: string }>,
 *   lineErrors: Record<number, { actualQty?: string, comment?: string }>,
 *   errors: string[],
 * }}
 */
function parseLineInput(bodyLines, countLines) {
  const known = new Map(countLines.map((line) => [line.componentId, line]));
  const lines = [];
  const lineErrors = {};
  const errors = [];
  const enteredValues = submittedLineValues(bodyLines);

  const rawLines = bodyLines && typeof bodyLines === 'object' ? Object.values(bodyLines) : [];
  for (const raw of rawLines) {
    if (!raw || typeof raw !== 'object') continue;

    const componentId = Number(raw.componentId);
    if (!known.has(componentId)) {
      errors.push('Одна из строк относится к позиции вне этой инвентаризации.');
      continue;
    }

    const actualRaw = typeof raw.actualQty === 'string' ? raw.actualQty.trim() : '';
    let actualQty = null;
    if (actualRaw !== '') {
      if (!/^\d+$/.test(actualRaw) || Number(actualRaw) > QTY_MAX) {
        lineErrors[componentId] = {
          ...lineErrors[componentId],
          actualQty: 'Целое число от 0 до 1 000 000 000.',
        };
      } else {
        actualQty = Number(actualRaw);
      }
    }

    const commentRaw = typeof raw.comment === 'string' ? raw.comment.trim() : '';
    if (commentRaw.length > COMMENT_MAX) {
      lineErrors[componentId] = {
        ...lineErrors[componentId],
        comment: `Комментарий — не длиннее ${COMMENT_MAX} символов.`,
      };
    }

    lines.push({
      componentId,
      actualQty,
      comment: commentRaw === '' ? null : commentRaw,
    });
  }

  if (lines.length === 0) {
    errors.push('Не удалось прочитать строки. Обновите страницу и попробуйте снова.');
  }
  if (Object.keys(lineErrors).length > 0) {
    errors.push('Проверьте выделенные строки.');
  }

  return { lines, enteredValues, lineErrors, errors };
}

/**
 * @param {import('express').Response} res
 * @param {number} countId
 * @param {{
 *   status?: number,
 *   filters?: ReturnType<typeof detailQuerySchema.parse>,
 *   errors?: string[],
 *   enteredValues?: Record<number, { actualQty: string, comment: string }>,
 *   lineErrors?: Record<number, { actualQty?: string, comment?: string }>,
 *   unfilledIds?: Set<number>,
 * }} [state]
 */
async function renderDetail(res, countId, state = {}) {
  const {
    status = 200,
    filters = { q: '', only: 'all' },
    errors = [],
    enteredValues = {},
    lineErrors = {},
    unfilledIds = new Set(),
  } = state;

  const detail = await inventory.getCountDetail(countId);
  const decorated = decorateLines(detail.lines, filters);
  const count = { ...detail.count, number: inventory.displayNumber(detail.count) };
  const role = res.locals.currentUser?.role;

  res.status(status).render('pages/inventory/show', {
    title: `${count.number} — Motherload`,
    count,
    summary: detail.summary,
    rows: decorated.filter((row) => row.visible),
    hiddenRows: count.status === 'draft' ? decorated.filter((row) => !row.visible) : [],
    discrepancies: detail.discrepancies,
    filters,
    errors,
    enteredValues,
    lineErrors,
    unfilledIds,
    canEdit: count.status === 'draft',
    canApprove: count.status === 'submitted' && role === 'admin',
    canCancel: count.status === 'draft' || (count.status === 'submitted' && role === 'admin'),
    bodyClass: 'inventory-detail-page',
  });
}

async function renderNew(res, { status = 200, values, fieldErrors = {}, errors = [] }) {
  const warehouses = (await directories.list('warehouses')).filter(
    (warehouse) => warehouse.isActive,
  );

  res.status(status).render('pages/inventory/new', {
    title: 'Новая инвентаризация — Motherload',
    warehouses,
    values,
    fieldErrors,
    errors,
  });
}

/** `GET /inventory` — counts with status, actors and discrepancy totals. */
export async function showList(req, res, next) {
  try {
    const { counts, capped } = await inventory.listCounts();
    const rows = counts.map((count) => ({
      ...count,
      number: inventory.displayNumber(count),
    }));

    res.render('pages/inventory/list', {
      title: 'Инвентаризация — Motherload',
      counts: rows,
      capped,
    });
  } catch (error) {
    next(error);
  }
}

/** `GET /inventory/new` — warehouse choice and the freeze warning. */
export async function showNew(req, res, next) {
  try {
    await renderNew(res, { values: { warehouseId: '', comment: '' } });
  } catch (error) {
    next(error);
  }
}

/** `POST /inventory` — create the count and snapshot the warehouse. */
export async function createCount(req, res, next) {
  const values = {
    warehouseId: typeof req.body?.warehouseId === 'string' ? req.body.warehouseId : '',
    comment: typeof req.body?.comment === 'string' ? req.body.comment : '',
  };
  const parsed = createSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    await renderNew(res, {
      status: 400,
      values,
      fieldErrors: fieldErrorsFromZod(parsed.error),
      errors: messagesFromZod(parsed.error),
    });
    return;
  }

  try {
    const result = await inventory.createCount({
      warehouseId: parsed.data.warehouseId,
      comment: parsed.data.comment,
      user: req.user,
      req,
    });

    req.flash(
      'success',
      result.lineCount === 0
        ? 'Инвентаризация начата. На складе нет остатков, поэтому строк в снимке нет.'
        : `Инвентаризация начата. Строк в снимке: ${result.lineCount}.`,
    );
    res.redirect(`${BASE_PATH}/${result.countId}`);
  } catch (error) {
    // A frozen warehouse or an archived choice is a form-level problem: keep
    // the entered comment and explain it next to the form.
    if (error instanceof ValidationError || error instanceof ConflictError) {
      await renderNew(res, {
        status: error.status,
        values,
        fieldErrors: {},
        errors: [error.message],
      });
      return;
    }
    next(error);
  }
}

/** `GET /inventory/:id` — line entry, review and the discrepancy act. */
export async function showCount(req, res, next) {
  try {
    const filters = detailQuerySchema.parse(req.query ?? {});
    await renderDetail(res, parseId(req.params.id), { filters });
  } catch (error) {
    next(error);
  }
}

/** `POST /inventory/:id/lines` — save the draft quantities and comments. */
export async function saveLines(req, res, next) {
  const countId = parseId(req.params.id);

  try {
    const detail = await inventory.getCountDetail(countId);
    const parsed = parseLineInput(req.body?.lines, detail.lines);

    if (parsed.errors.length > 0) {
      await renderDetail(res, countId, {
        status: 400,
        errors: parsed.errors,
        enteredValues: parsed.enteredValues,
        lineErrors: parsed.lineErrors,
      });
      return;
    }

    await inventory.saveCountLines({
      countId,
      lines: parsed.lines,
      user: req.user,
      req,
    });

    req.flash('success', 'Фактические количества сохранены.');
    res.redirect(`${BASE_PATH}/${countId}`);
  } catch (error) {
    if (error instanceof ValidationError) {
      await renderDetail(res, countId, { status: 400, errors: [error.message] });
      return;
    }
    if (error instanceof ConflictError) {
      await renderDetail(res, countId, { status: 409, errors: [error.message] });
      return;
    }
    next(error);
  }
}

/** `POST /inventory/:id/submit` — hand the count to an administrator. */
export async function submitCount(req, res, next) {
  const countId = parseId(req.params.id);

  try {
    await inventory.submitCount({ countId, user: req.user, req });
    req.flash('success', 'Инвентаризация отправлена на проверку.');
    res.redirect(`${BASE_PATH}/${countId}`);
  } catch (error) {
    if (error instanceof ValidationError) {
      // The service names the first missing SKUs; marking every unfilled row
      // turns that message into something the operator can act on.
      const unfilled = error.details?.unfilled ?? [];
      await renderDetail(res, countId, {
        status: 400,
        errors: [error.message],
        unfilledIds: new Set(unfilled.map((line) => line.componentId)),
      });
      return;
    }
    if (error instanceof ConflictError) {
      req.flash('error', error.message);
      res.redirect(`${BASE_PATH}/${countId}`);
      return;
    }
    next(error);
  }
}

/** `POST /inventory/:id/approve` — admin-only approval and stock adjustment. */
export async function approveCount(req, res, next) {
  const countId = parseId(req.params.id);

  try {
    const result = await inventory.approveCount({ countId, user: req.user, req });
    req.flash(
      'success',
      `Инвентаризация утверждена. Скорректировано строк: ${result.adjustedLines}.`,
    );
    res.redirect(`${BASE_PATH}/${countId}`);
  } catch (error) {
    if (error instanceof ConflictError) {
      req.flash('error', error.message);
      res.redirect(`${BASE_PATH}/${countId}`);
      return;
    }
    next(error);
  }
}

/** `POST /inventory/:id/cancel` — release the freeze without adjustments. */
export async function cancelCount(req, res, next) {
  const countId = parseId(req.params.id);

  try {
    await inventory.cancelCount({ countId, user: req.user, req });
    req.flash('success', 'Инвентаризация отменена. Склад разморожен.');
    res.redirect(`${BASE_PATH}/${countId}`);
  } catch (error) {
    if (error instanceof ConflictError) {
      req.flash('error', error.message);
      res.redirect(`${BASE_PATH}/${countId}`);
      return;
    }
    next(error);
  }
}

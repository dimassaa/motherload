import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { fieldErrorsFromZod, messagesFromZod } from '../middleware/validate.js';
import * as componentsService from '../services/components.js';
import * as directoriesService from '../services/directories.js';
import { createComponentSchema, updateComponentSchema } from '../validation/components.js';

const BASE_PATH = '/admin/components';

/**
 * Query filters never fail the page. A stale bookmark with `categoryId=abc`
 * falls back to "no filter" instead of a 400 the administrator cannot act on.
 */
const optionalFilterId = z.preprocess(
  (value) => (value === undefined || value === null || value === '' ? null : value),
  z.union([z.null(), z.coerce.number().int().positive()]).catch(null),
);

const listQuerySchema = z.object({
  q: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : ''),
    z.string().max(120, 'Поиск — не длиннее 120 символов').catch(''),
  ),
  categoryId: optionalFilterId,
  manufacturerId: optionalFilterId,
  isActive: z.preprocess(
    (value) => (value === 'true' ? true : value === 'false' ? false : null),
    z.boolean().nullable().catch(null),
  ),
  page: z.preprocess(
    (value) => (value === undefined || value === '' || value === null ? 1 : value),
    z.coerce.number().int().min(1).catch(1),
  ),
});

const FORM_FIELDS = [
  'sku',
  'name',
  'categoryId',
  'manufacturerId',
  'defaultSupplierId',
  'unit',
  'purchasePrice',
  'retailPrice',
  'minStock',
  'maxStock',
  'leadTimeDays',
  'specs',
  'isActive',
];

/** Values of an empty creation form. An active, published position is the useful default. */
function defaultValues() {
  return {
    sku: '',
    name: '',
    categoryId: '',
    manufacturerId: '',
    defaultSupplierId: '',
    unit: 'шт',
    purchasePrice: '',
    retailPrice: '',
    minStock: '0',
    maxStock: '',
    leadTimeDays: '',
    specs: '{}',
    isActive: 'true',
  };
}

/** A malformed or vanished `:id` names no position, so it is a 404, not a 500. */
function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError('Позиция не найдена.');
  return id;
}

/** Keep what the user typed after a failed submit; unknown body keys are ignored. */
function submittedValues(body = {}) {
  const values = defaultValues();
  for (const key of FORM_FIELDS) {
    if (typeof body[key] === 'string') values[key] = body[key];
  }
  return values;
}

/**
 * Turn a stored row into form strings. `jsonb` arrives as an object, so specs
 * are pretty-printed here; the template only displays them.
 */
function storedValues(record) {
  return {
    sku: record.sku,
    name: record.name,
    categoryId: record.categoryId ?? '',
    manufacturerId: record.manufacturerId ?? '',
    defaultSupplierId: record.defaultSupplierId ?? '',
    unit: record.unit,
    purchasePrice: record.purchasePrice,
    retailPrice: record.retailPrice,
    minStock: String(record.minStock),
    maxStock: record.maxStock ?? '',
    leadTimeDays: record.leadTimeDays ?? '',
    specs: JSON.stringify(record.specs ?? {}, null, 2),
    isActive: String(record.isActive),
  };
}

/** Select options for the form and the manufacturer filter. */
async function loadOptions() {
  const [categories, manufacturers, suppliers] = await Promise.all([
    directoriesService.list('categories'),
    directoriesService.list('manufacturers'),
    directoriesService.list('suppliers'),
  ]);
  return { categories, manufacturers, suppliers };
}

/**
 * A duplicate SKU is reported against the input that caused it, so the message
 * appears next to the field instead of only in the summary block.
 */
function duplicateFieldErrors(error) {
  const field = error.details?.field;
  return typeof field === 'string' ? { [field]: error.message } : {};
}

async function renderList(res, { status = 200, filters, errors = [] }) {
  const [result, options] = await Promise.all([componentsService.list(filters), loadOptions()]);

  res.status(status).render('pages/admin/components/list', {
    title: 'Комплектующие — Motherload',
    items: result.items,
    page: result.page,
    totalPages: result.totalPages,
    total: result.total,
    pageSize: result.pageSize,
    filters,
    options,
    errors,
  });
}

async function renderForm(
  res,
  { status = 200, mode, values, editing = null, fieldErrors = {}, errors = [] },
) {
  const options = await loadOptions();
  const titleName = values.name || editing?.name || 'Позиция';

  res.status(status).render('pages/admin/components/form', {
    title: mode === 'create' ? 'Новая позиция — Motherload' : `${titleName} — Motherload`,
    mode,
    values,
    editing,
    options,
    fieldErrors,
    errors,
    formAction: mode === 'create' ? BASE_PATH : `${BASE_PATH}/${editing.id}`,
  });
}

/** `GET /admin/components` — the catalog table with search and filters. */
export async function showList(req, res, next) {
  try {
    const filters = listQuerySchema.parse(req.query ?? {});
    await renderList(res, { filters });
  } catch (error) {
    next(error);
  }
}

/** `GET /admin/components/new` — empty creation form. */
export async function showNew(req, res, next) {
  try {
    await renderForm(res, { mode: 'create', values: defaultValues() });
  } catch (error) {
    next(error);
  }
}

/** `POST /admin/components` — create one catalog position. */
export async function createComponent(req, res, next) {
  const parsed = createComponentSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    await renderForm(res, {
      status: 400,
      mode: 'create',
      values: submittedValues(req.body),
      fieldErrors: fieldErrorsFromZod(parsed.error),
      errors: messagesFromZod(parsed.error),
    });
    return;
  }

  try {
    await componentsService.create(parsed.data, { req });
    req.flash('success', 'Позиция добавлена в каталог.');
    res.redirect(BASE_PATH);
  } catch (error) {
    if (error instanceof ValidationError) {
      await renderForm(res, {
        status: 400,
        mode: 'create',
        values: submittedValues(req.body),
        fieldErrors: duplicateFieldErrors(error),
        errors: [error.message],
      });
      return;
    }
    next(error);
  }
}

/** `GET /admin/components/:id` — edit form; SKU is shown read-only. */
export async function showEdit(req, res, next) {
  try {
    const record = await componentsService.get(parseId(req.params.id));
    await renderForm(res, {
      mode: 'edit',
      editing: record,
      values: storedValues(record),
    });
  } catch (error) {
    next(error);
  }
}

/** `POST /admin/components/:id` — save the edit form. */
export async function updateComponent(req, res, next) {
  let existing;
  try {
    const id = parseId(req.params.id);
    existing = await componentsService.get(id);

    // The form renders SKU read-only and does not submit it. A hand-built
    // request that tries to change it is rejected: history rows reference the
    // immutable identifier, and the correct procedure is archive + new position.
    const submittedSku = typeof req.body?.sku === 'string' ? req.body.sku.trim().toUpperCase() : '';
    const skuError =
      submittedSku !== '' && submittedSku !== existing.sku
        ? 'SKU — неизменяемый идентификатор. Изменить нельзя: создайте новую позицию и архивируйте старую.'
        : null;
    if (skuError) {
      await renderForm(res, {
        status: 400,
        mode: 'edit',
        editing: existing,
        values: submittedValues(req.body),
        fieldErrors: { sku: skuError },
        errors: [skuError],
      });
      return;
    }

    const parsed = updateComponentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      await renderForm(res, {
        status: 400,
        mode: 'edit',
        editing: existing,
        values: submittedValues(req.body),
        fieldErrors: fieldErrorsFromZod(parsed.error),
        errors: messagesFromZod(parsed.error),
      });
      return;
    }

    await componentsService.update(id, parsed.data, { req });
    req.flash('success', 'Изменения позиции сохранены.');
    res.redirect(BASE_PATH);
  } catch (error) {
    if (existing && error instanceof ValidationError) {
      await renderForm(res, {
        status: 400,
        mode: 'edit',
        editing: existing,
        values: submittedValues(req.body),
        fieldErrors: duplicateFieldErrors(error),
        errors: [error.message],
      });
      return;
    }
    next(error);
  }
}

/** `POST /admin/components/:id/archive` — move a position to the archive. */
export async function archiveComponent(req, res, next) {
  try {
    await componentsService.archive(parseId(req.params.id), { req });
    req.flash('success', 'Позиция перенесена в архив.');
    res.redirect(BASE_PATH);
  } catch (error) {
    next(error);
  }
}

/** `POST /admin/components/:id/delete` — remove a position without history. */
export async function deleteComponent(req, res, next) {
  try {
    await componentsService.remove(parseId(req.params.id), { req });
    req.flash('success', 'Позиция удалена.');
    res.redirect(BASE_PATH);
  } catch (error) {
    // A position with history is a page-level conflict: keep the administrator
    // on the catalog with the explanation instead of a bare error page.
    if (error instanceof ConflictError) {
      await renderList(res, {
        status: 409,
        filters: listQuerySchema.parse({}),
        errors: [error.message],
      });
      return;
    }
    next(error);
  }
}

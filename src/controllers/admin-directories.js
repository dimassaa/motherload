import { NotFoundError, ValidationError } from '../domain/errors.js';
import { fieldErrorsFromZod, messagesFromZod } from '../middleware/validate.js';
import * as directoriesService from '../services/directories.js';
import { DIRECTORY_SCHEMAS } from '../validation/directories.js';

const BASE_PATH = '/admin/directories';

/**
 * Resolve the `:entity` segment. Anything outside the four known directories is
 * a missing page, not a 500: the URL simply names no section.
 * @param {string | undefined} raw
 * @throws {NotFoundError}
 */
function resolveEntity(raw) {
  const entity = raw ?? 'categories';
  if (!directoriesService.isEntity(entity)) {
    throw new NotFoundError('Раздел справочника не найден.');
  }
  return entity;
}

/** A malformed edit link selects no row; a well-formed one that no longer exists is a 404. */
function parseRecordId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError('Запись не найдена.');
  return id;
}

/** `?edit=` is optional: an empty or malformed value just shows the create form. */
function parseEditId(raw) {
  if (raw === undefined || raw === '') return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Defaults for an empty form. Active rows are the useful default for new records. */
function defaultValues(entity) {
  const values = {};
  for (const key of Object.keys(DIRECTORY_SCHEMAS[entity].shape)) values[key] = '';
  if ('sortOrder' in values) values.sortOrder = '0';
  if ('isActive' in values) values.isActive = 'true';
  return values;
}

/**
 * Turn a stored row into form values. Booleans become the `true`/`false` strings
 * the select compares against, nulls become empty inputs.
 */
function valuesFromRecord(entity, record) {
  const values = {};
  for (const key of Object.keys(DIRECTORY_SCHEMAS[entity].shape)) {
    const value = record[key];
    if (typeof value === 'boolean') values[key] = String(value);
    else values[key] = value ?? '';
  }
  return values;
}

/** Keep what the user typed after a failed submit; unknown body keys are ignored. */
function submittedValues(entity, body = {}) {
  const values = defaultValues(entity);
  for (const key of Object.keys(DIRECTORY_SCHEMAS[entity].shape)) {
    if (typeof body[key] === 'string') values[key] = body[key];
  }
  return values;
}

/**
 * A duplicate unique value is reported against the input that caused it, so the
 * message appears next to the field instead of only in the summary block.
 */
function duplicateFieldErrors(error) {
  const field = error.details?.field;
  return typeof field === 'string' ? { [field]: error.message } : {};
}

/**
 * Render the one-page directory screen. Records carry `displayName` so the
 * template can label a delete confirmation without knowing entity-specific
 * column names.
 */
async function renderDirectories(
  res,
  { entity, status = 200, editing = null, values, fieldErrors = {}, errors = [] },
) {
  const meta = directoriesService.getEntityMeta(entity);
  const records = (await directoriesService.list(entity)).map((record) => ({
    ...record,
    displayName: record.name,
  }));

  res.status(status).render('pages/admin/directories', {
    title: `${meta.label} — Справочники — Motherload`,
    meta,
    entities: directoriesService.listEntities(),
    activeEntity: entity,
    records,
    editing,
    values,
    fieldErrors,
    errors,
    formAction: editing ? `${BASE_PATH}/${entity}/${editing.id}` : `${BASE_PATH}/${entity}`,
  });
}

/** `GET /admin/directories` and `/admin/directories/:entity` — the tabbed screen. */
export async function showDirectories(req, res, next) {
  try {
    const entity = resolveEntity(req.params.entity);
    const editId = parseEditId(req.query.edit);
    const editing = editId ? await directoriesService.get(entity, editId) : null;

    await renderDirectories(res, {
      entity,
      editing,
      values: editing ? valuesFromRecord(entity, editing) : defaultValues(entity),
    });
  } catch (error) {
    next(error);
  }
}

/** `POST /admin/directories/:entity` — add a row to the active tab. */
export async function createDirectory(req, res, next) {
  let entity;
  try {
    entity = resolveEntity(req.params.entity);
    const parsed = DIRECTORY_SCHEMAS[entity].safeParse(req.body ?? {});

    if (!parsed.success) {
      await renderDirectories(res, {
        entity,
        status: 400,
        values: submittedValues(entity, req.body),
        fieldErrors: fieldErrorsFromZod(parsed.error),
        errors: messagesFromZod(parsed.error),
      });
      return;
    }

    await directoriesService.create(entity, parsed.data, { req });
    req.flash('success', directoriesService.getEntityMeta(entity).createMessage);
    res.redirect(`${BASE_PATH}/${entity}`);
  } catch (error) {
    // A duplicate unique field is a form problem: keep the input and show the
    // message above the form instead of a bare error page.
    if (entity && error instanceof ValidationError) {
      await renderDirectories(res, {
        entity,
        status: 400,
        values: submittedValues(entity, req.body),
        fieldErrors: duplicateFieldErrors(error),
        errors: [error.message],
      });
      return;
    }
    next(error);
  }
}

/** `POST /admin/directories/:entity/:id` — save the edit form. */
export async function updateDirectory(req, res, next) {
  let entity;
  let existing;
  try {
    entity = resolveEntity(req.params.entity);
    const id = parseRecordId(req.params.id);
    existing = await directoriesService.get(entity, id);
    const parsed = DIRECTORY_SCHEMAS[entity].safeParse(req.body ?? {});

    if (!parsed.success) {
      await renderDirectories(res, {
        entity,
        status: 400,
        editing: existing,
        values: submittedValues(entity, req.body),
        fieldErrors: fieldErrorsFromZod(parsed.error),
        errors: messagesFromZod(parsed.error),
      });
      return;
    }

    await directoriesService.update(entity, id, parsed.data, { req });
    req.flash('success', directoriesService.getEntityMeta(entity).updateMessage);
    res.redirect(`${BASE_PATH}/${entity}`);
  } catch (error) {
    if (entity && existing && error instanceof ValidationError) {
      await renderDirectories(res, {
        entity,
        status: 400,
        editing: existing,
        values: submittedValues(entity, req.body),
        fieldErrors: duplicateFieldErrors(error),
        errors: [error.message],
      });
      return;
    }
    next(error);
  }
}

/** `POST /admin/directories/:entity/:id/delete` — remove an unreferenced row. */
export async function deleteDirectory(req, res, next) {
  try {
    const entity = resolveEntity(req.params.entity);
    const id = parseRecordId(req.params.id);

    await directoriesService.remove(entity, id, { req });
    req.flash('success', directoriesService.getEntityMeta(entity).deleteMessage);
    res.redirect(`${BASE_PATH}/${entity}`);
  } catch (error) {
    next(error);
  }
}

import { withTransaction } from '../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import * as components from '../repositories/components.js';
import { parseSpecs } from '../validation/components.js';
import * as audit from './audit.js';

export { parseSpecs };

/** One catalog page fits the 25-row convention used by the public catalog. */
const PAGE_SIZE = 25;

const NOT_FOUND_MESSAGE = 'Позиция не найдена.';

const DELETE_CONFLICT_MESSAGE =
  'Нельзя удалить позицию: есть история — партии, движения или строки документов. ' +
  'Архивируйте позицию вместо удаления.';

// PostgreSQL error codes. A unique violation is a form problem the user can
// fix; a foreign-key failure on create/update means a reference disappeared
// between rendering and submitting; RESTRICT on delete means history exists.
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';

const UNIQUE_MESSAGES = {
  components_sku_key: {
    field: 'sku',
    message: 'Позиция с таким SKU уже есть. Укажите другой SKU.',
  },
};

const FOREIGN_KEY_MESSAGES = {
  components_category_id_fkey: {
    field: 'categoryId',
    message: 'Выбранная категория не найдена. Обновите страницу и выберите категорию заново.',
  },
  components_manufacturer_id_fkey: {
    field: 'manufacturerId',
    message: 'Выбранный производитель не найден. Обновите страницу и выберите его заново.',
  },
  components_default_supplier_id_fkey: {
    field: 'defaultSupplierId',
    message: 'Выбранный поставщик не найден. Обновите страницу и выберите его заново.',
  },
};

/** Audit rows carry the state that changed, not the primary key `entity_id` repeats. */
function auditDetails(record) {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key]) => key !== 'id' && key !== 'createdAt' && key !== 'updatedAt',
    ),
  );
}

/**
 * Translate database constraint failures into the domain errors the controller
 * renders. Anything unrecognised is rethrown and reaches the central 500 page.
 */
function translateDatabaseError(error, operation) {
  if (error?.code === UNIQUE_VIOLATION) {
    const duplicate = UNIQUE_MESSAGES[error.constraint];
    if (duplicate) {
      throw new ValidationError(duplicate.message, { details: { field: duplicate.field } });
    }
    throw new ValidationError('Позиция с такими данными уже есть. Проверьте SKU.');
  }

  if (error?.code === FOREIGN_KEY_VIOLATION) {
    const reference = FOREIGN_KEY_MESSAGES[error.constraint];
    if (reference) {
      throw new ValidationError(reference.message, { details: { field: reference.field } });
    }
    if (operation === 'delete') throw new ConflictError(DELETE_CONFLICT_MESSAGE);
  }

  if (operation === 'delete' && error?.code === RESTRICT_VIOLATION) {
    throw new ConflictError(DELETE_CONFLICT_MESSAGE);
  }

  throw error;
}

/**
 * One page of the admin catalog.
 * @param {{
 *   q?: string,
 *   categoryId?: number | null,
 *   manufacturerId?: number | null,
 *   isActive?: boolean | null,
 *   page?: number,
 * }} [filters]
 * @returns {Promise<{
 *   items: Array<Record<string, unknown>>,
 *   page: number,
 *   totalPages: number,
 *   total: number,
 *   pageSize: number,
 * }>}
 */
export async function list(filters = {}) {
  const query = {
    q: filters.q ?? '',
    categoryId: filters.categoryId ?? null,
    manufacturerId: filters.manufacturerId ?? null,
    isActive: filters.isActive ?? null,
  };

  // The count comes first because a stale `?page=999` must be clamped before
  // its offset is safe to compute.
  const total = await components.count(query);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const requestedPage = Number.isInteger(filters.page) && filters.page > 0 ? filters.page : 1;
  const page = Math.min(requestedPage, totalPages);

  const items =
    total === 0
      ? []
      : await components.list({
          ...query,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        });

  return { items, page, totalPages, total, pageSize: PAGE_SIZE };
}

/**
 * @param {number} id
 * @throws {NotFoundError}
 */
export async function get(id) {
  const record = await components.findById(id);
  if (!record) throw new NotFoundError(NOT_FOUND_MESSAGE);
  return record;
}

/**
 * Create a catalog row and its audit entry in one transaction.
 * @param {Record<string, unknown>} data validated form data
 * @param {{ req: import('express').Request }} context
 * @throws {ValidationError} on a duplicate SKU or a vanished reference
 */
export async function create(data, { req }) {
  try {
    return await withTransaction(async (client) => {
      const created = await components.insert(data, client);

      await audit.record(
        {
          action: 'component.create',
          entityType: 'component',
          entityId: created.id,
          details: auditDetails(created),
          req,
        },
        { client },
      );

      return created;
    });
  } catch (error) {
    translateDatabaseError(error, 'create');
  }
}

/**
 * Replace every editable field of one row. The row is locked first, so a
 * concurrent archive cannot be overwritten by a stale edit form.
 * @param {number} id
 * @param {Record<string, unknown>} data validated form data without SKU
 * @param {{ req: import('express').Request }} context
 * @throws {NotFoundError | ValidationError}
 */
export async function update(id, data, { req }) {
  try {
    return await withTransaction(async (client) => {
      const existing = await components.findById(id, { forUpdate: true, client });
      if (!existing) throw new NotFoundError(NOT_FOUND_MESSAGE);

      const updated = await components.update(id, data, client);
      if (!updated) throw new NotFoundError(NOT_FOUND_MESSAGE);

      await audit.record(
        {
          action: 'component.update',
          entityType: 'component',
          entityId: id,
          details: auditDetails(updated),
          req,
        },
        { client },
      );

      return updated;
    });
  } catch (error) {
    translateDatabaseError(error, 'update');
  }
}

/**
 * Move a position to the archive. History rows keep pointing at it, which is
 * exactly why this is the default instead of deletion.
 * @param {number} id
 * @param {{ req: import('express').Request }} context
 * @throws {NotFoundError}
 */
export async function archive(id, { req }) {
  try {
    return await withTransaction(async (client) => {
      const existing = await components.findById(id, { forUpdate: true, client });
      if (!existing) throw new NotFoundError(NOT_FOUND_MESSAGE);

      const archived = await components.archive(id, client);
      if (!archived) throw new NotFoundError(NOT_FOUND_MESSAGE);

      await audit.record(
        {
          action: 'component.archive',
          entityType: 'component',
          entityId: id,
          details: { sku: archived.sku, name: archived.name, isActive: false },
          req,
        },
        { client },
      );

      return archived;
    });
  } catch (error) {
    translateDatabaseError(error, 'archive');
  }
}

/**
 * Delete a position only when nothing references it. The reference counts are
 * read under the same lock as the delete, so a concurrently posted document
 * cannot turn a "no history" decision into a half-applied deletion.
 * @param {number} id
 * @param {{ req: import('express').Request }} context
 * @throws {NotFoundError | ConflictError}
 */
export async function remove(id, { req }) {
  try {
    return await withTransaction(async (client) => {
      const existing = await components.findById(id, { forUpdate: true, client });
      if (!existing) throw new NotFoundError(NOT_FOUND_MESSAGE);

      const history = await components.historyCounts(id, client);
      const hasHistory = Object.values(history).some((count) => count > 0);
      if (hasHistory) throw new ConflictError(DELETE_CONFLICT_MESSAGE);

      const removed = await components.remove(id, client);
      if (!removed) throw new NotFoundError(NOT_FOUND_MESSAGE);

      await audit.record(
        {
          action: 'component.delete',
          entityType: 'component',
          entityId: id,
          details: auditDetails(removed),
          req,
        },
        { client },
      );

      return removed;
    });
  } catch (error) {
    translateDatabaseError(error, 'delete');
  }
}

import { withTransaction } from '../db/pool.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import * as directories from '../repositories/directories.js';
import * as audit from './audit.js';

/**
 * Display metadata for the four reference directories. The keys match
 * `DIRECTORY_DEFINITIONS` in the repository and `DIRECTORY_SCHEMAS` in the
 * validation module; `isEntity` is the single membership check the controller
 * uses before any SQL runs.
 */
export const DIRECTORY_ENTITIES = Object.freeze({
  categories: {
    label: 'Категории',
    singular: 'category',
    recordsLabel: 'категорий',
    createMessage: 'Категория добавлена.',
    updateMessage: 'Изменения категории сохранены.',
    deleteMessage: 'Категория удалена.',
    notFoundMessage: 'Категория не найдена.',
  },
  manufacturers: {
    label: 'Производители',
    singular: 'manufacturer',
    recordsLabel: 'производителей',
    createMessage: 'Производитель добавлен.',
    updateMessage: 'Изменения производителя сохранены.',
    deleteMessage: 'Производитель удалён.',
    notFoundMessage: 'Производитель не найден.',
  },
  suppliers: {
    label: 'Поставщики',
    singular: 'supplier',
    recordsLabel: 'поставщиков',
    createMessage: 'Поставщик добавлен.',
    updateMessage: 'Изменения поставщика сохранены.',
    deleteMessage: 'Поставщик удалён.',
    notFoundMessage: 'Поставщик не найден.',
  },
  warehouses: {
    label: 'Склады',
    singular: 'warehouse',
    recordsLabel: 'складов',
    createMessage: 'Склад добавлен.',
    updateMessage: 'Изменения склада сохранены.',
    deleteMessage: 'Склад удалён.',
    notFoundMessage: 'Склад не найден.',
  },
});

// PostgreSQL error codes. A unique violation means the user typed a value that
// already exists; a foreign-key or RESTRICT violation means documents or
// components still point at the row being deleted. PostgreSQL raises 23001 for
// `ON DELETE RESTRICT` and 23503 for a NO ACTION check, so both are handled.
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';

// Constraint names are stable migration output. Mapping them gives a message
// that names the exact field and lets the controller mark that input invalid.
const UNIQUE_MESSAGES = {
  categories: {
    categories_name_key: {
      field: 'name',
      message: 'Категория с таким названием уже есть. Укажите другое название.',
    },
    categories_slug_key: {
      field: 'slug',
      message: 'Такой slug уже занят. Укажите другой, например cpu-coolers.',
    },
  },
  manufacturers: {
    manufacturers_name_key: {
      field: 'name',
      message: 'Производитель с таким названием уже есть. Укажите другое название.',
    },
  },
  suppliers: {
    suppliers_unp_key: {
      field: 'unp',
      message: 'Поставщик с таким УНП уже есть. Проверьте номер: УНП должен быть уникальным.',
    },
  },
  warehouses: {
    warehouses_code_key: {
      field: 'code',
      message: 'Склад с таким кодом уже есть. Укажите другой код, например WH-MSK.',
    },
  },
};

const DELETE_CONFLICT_MESSAGES = {
  categories:
    'Нельзя удалить категорию: она используется в комплектующих. Сначала назначьте этим позициям другую категорию.',
  manufacturers:
    'Нельзя удалить производителя: он используется в комплектующих. Сначала назначьте этим позициям другого производителя.',
  suppliers:
    'Нельзя удалить поставщика: на него ссылаются документы или комплектующие. Деактивируйте поставщика вместо удаления.',
  warehouses:
    'Нельзя удалить склад: на него ссылаются документы, остатки или инвентаризация. Деактивируйте склад вместо удаления.',
};

const GENERIC_UNIQUE_MESSAGE = 'Запись с такими данными уже есть. Проверьте уникальные поля.';

/** @param {string} entity */
export function isEntity(entity) {
  return Object.hasOwn(DIRECTORY_ENTITIES, entity);
}

/**
 * Metadata for the page title, tabs and messages.
 * @param {string} entity
 * @throws {TypeError} on an entity the service does not own
 */
export function getEntityMeta(entity) {
  if (!isEntity(entity)) throw new TypeError(`Unknown directory entity: ${entity}`);
  return DIRECTORY_ENTITIES[entity];
}

/** Tab descriptors in the order the specification lists them. */
export function listEntities() {
  return Object.entries(DIRECTORY_ENTITIES).map(([key, meta]) => ({ key, label: meta.label }));
}

// An aborted unique insert leaves the transaction dead; translating after the
// rollback keeps the original constraint name available on the error object.
// The RESTRICT message is delete-specific, so it is only emitted for `remove`;
// a foreign-key failure on create/update is unexpected and reaches the central
// 500 handler instead of claiming something could not be deleted.
function translateDatabaseError(error, entity, operation) {
  if (error?.code === UNIQUE_VIOLATION) {
    const duplicate = UNIQUE_MESSAGES[entity]?.[error.constraint];
    if (duplicate) {
      throw new ValidationError(duplicate.message, { details: { field: duplicate.field } });
    }
    throw new ValidationError(GENERIC_UNIQUE_MESSAGE);
  }

  if (
    operation === 'delete' &&
    (error?.code === FOREIGN_KEY_VIOLATION || error?.code === RESTRICT_VIOLATION)
  ) {
    throw new ConflictError(DELETE_CONFLICT_MESSAGES[entity]);
  }

  throw error;
}

// The audit row mirrors what changed but does not repeat the primary key that
// `entity_id` already carries.
function auditDetails(record) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'id'));
}

/**
 * @param {string} entity
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export function list(entity) {
  return directories.list(entity);
}

/**
 * @param {string} entity
 * @param {number} id
 * @throws {NotFoundError}
 */
export async function get(entity, id) {
  const record = await directories.findById(entity, id);
  if (!record) throw new NotFoundError(getEntityMeta(entity).notFoundMessage);
  return record;
}

/**
 * Create one reference row and its audit entry in a single transaction.
 * @param {string} entity
 * @param {Record<string, unknown>} data validated form data
 * @param {{ req: import('express').Request }} context
 * @throws {ValidationError} on a duplicate unique field
 */
export async function create(entity, data, { req }) {
  const meta = getEntityMeta(entity);

  try {
    return await withTransaction(async (client) => {
      const created = await directories.insert(entity, data, client);

      await audit.record(
        {
          action: 'directory.create',
          entityType: meta.singular,
          entityId: created.id,
          details: auditDetails(created),
          req,
        },
        { client },
      );

      return created;
    });
  } catch (error) {
    translateDatabaseError(error, entity, 'create');
  }
}

/**
 * Replace one reference row. The row is locked first so a concurrent delete
 * cannot make the update report success on a row that no longer exists.
 * @param {string} entity
 * @param {number} id
 * @param {Record<string, unknown>} data validated form data
 * @param {{ req: import('express').Request }} context
 * @throws {NotFoundError | ValidationError}
 */
export async function update(entity, id, data, { req }) {
  const meta = getEntityMeta(entity);

  try {
    return await withTransaction(async (client) => {
      const existing = await directories.findById(entity, id, { forUpdate: true, client });
      if (!existing) throw new NotFoundError(meta.notFoundMessage);

      const updated = await directories.update(entity, id, data, client);
      if (!updated) throw new NotFoundError(meta.notFoundMessage);

      await audit.record(
        {
          action: 'directory.update',
          entityType: meta.singular,
          entityId: id,
          details: auditDetails(updated),
          req,
        },
        { client },
      );

      return updated;
    });
  } catch (error) {
    translateDatabaseError(error, entity, 'update');
  }
}

/**
 * Delete one reference row. A row referenced by documents, components or stock
 * is protected by `ON DELETE RESTRICT`; that failure becomes a 409 with an
 * explanation instead of a database error page.
 * @param {string} entity
 * @param {number} id
 * @param {{ req: import('express').Request }} context
 * @throws {NotFoundError | ConflictError}
 */
export async function remove(entity, id, { req }) {
  const meta = getEntityMeta(entity);

  try {
    return await withTransaction(async (client) => {
      const existing = await directories.findById(entity, id, { forUpdate: true, client });
      if (!existing) throw new NotFoundError(meta.notFoundMessage);

      const removed = await directories.remove(entity, id, client);
      if (!removed) throw new NotFoundError(meta.notFoundMessage);

      await audit.record(
        {
          action: 'directory.delete',
          entityType: meta.singular,
          entityId: id,
          details: auditDetails(removed),
          req,
        },
        { client },
      );

      return removed;
    });
  } catch (error) {
    translateDatabaseError(error, entity, 'delete');
  }
}

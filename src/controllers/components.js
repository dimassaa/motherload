import { z } from 'zod';
import { NotFoundError } from '../domain/errors.js';
import * as catalog from '../services/catalog.js';
import * as directoriesService from '../services/directories.js';

/**
 * Query parsing for the catalog pages.
 *
 * A stale bookmark with `page=abc` or `status=whatever` falls back to a safe
 * default instead of returning 400: the user cannot fix a URL they only
 * followed. Values are still validated before they reach the repository.
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
  warehouseId: optionalFilterId,
  status: z.preprocess(
    (value) => (typeof value === 'string' ? value : 'all'),
    z.enum(['all', 'zero', 'overstock', 'below_min']).catch('all'),
  ),
  sort: z.preprocess(
    (value) => (typeof value === 'string' ? value : 'name'),
    z.enum(['name', 'sku', 'qty', 'value']).catch('name'),
  ),
  dir: z.preprocess(
    (value) => (typeof value === 'string' ? value : 'asc'),
    z.enum(['asc', 'desc']).catch('asc'),
  ),
  page: z.preprocess(
    (value) => (value === undefined || value === '' || value === null ? 1 : value),
    z.coerce.number().int().min(1).catch(1),
  ),
});

const cardQuerySchema = z.object({
  showAll: z.preprocess((value) => value === '1' || value === 'true', z.boolean().catch(false)),
  movementsPage: z.preprocess(
    (value) => (value === undefined || value === '' || value === null ? 1 : value),
    z.coerce.number().int().min(1).catch(1),
  ),
  warehouseId: optionalFilterId,
});

/** A malformed or vanished `:id` names no position, so it is a 404, not a 500. */
function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError('Позиция не найдена.');
  return id;
}

/** Select options shared by the filter bar. */
async function loadOptions() {
  const [categories, manufacturers, warehouses] = await Promise.all([
    directoriesService.list('categories'),
    directoriesService.list('manufacturers'),
    directoriesService.list('warehouses'),
  ]);
  return { categories, manufacturers, warehouses };
}

/** `GET /components` — the stock catalog with search, filters and sorting. */
export async function showList(req, res, next) {
  try {
    const filters = listQuerySchema.parse(req.query ?? {});
    const [result, options] = await Promise.all([catalog.list(filters), loadOptions()]);
    const selectedWarehouse =
      options.warehouses.find((warehouse) => warehouse.id === filters.warehouseId) ?? null;

    res.render('pages/components/list', {
      title: 'Комплектующие — Motherload',
      rows: result.rows,
      total: result.total,
      page: result.page,
      pages: result.pages,
      filters,
      options,
      selectedWarehouse,
      canManageCatalog: req.user?.role === 'admin',
    });
  } catch (error) {
    next(error);
  }
}

/** `GET /components/:id` — balances, batches, movements and replenishment. */
export async function showCard(req, res, next) {
  try {
    const options = cardQuerySchema.parse(req.query ?? {});
    const card = await catalog.getById(parseId(req.params.id), options);

    res.render('pages/components/show', {
      title: `${card.component.name} — Motherload`,
      ...card,
      canManageStock: req.user?.role === 'admin' || req.user?.role === 'storekeeper',
    });
  } catch (error) {
    next(error);
  }
}

/** `GET /api/components/search` — active positions for stock form type-ahead. */
export async function search(req, res, next) {
  try {
    res.json(await catalog.search(req.query?.q));
  } catch (error) {
    next(error);
  }
}

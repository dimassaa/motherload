import { env } from '../config/env.js';
import { NotFoundError } from '../domain/errors.js';
import * as repository from '../repositories/components-read.js';

/** Catalog page size fixed by the specification. */
const PAGE_SIZE = 25;

/** The card shows the last 50 movements per page. */
const MOVEMENTS_PAGE_SIZE = 50;

/** Stock forms need a short type-ahead list, never the whole catalog. */
const SEARCH_LIMIT = 20;

/** The card chart always covers six calendar months. */
const CONSUMPTION_MONTHS = 6;

const NOT_FOUND_MESSAGE = 'Позиция не найдена.';

const MONTH_LABELS = Object.freeze([
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
]);

/**
 * "Today" for every window in this module.
 *
 * Demo and test runs pin `ANALYTICS_REFERENCE_DATE` so the same data always
 * produces the same months and statuses. Production leaves it empty and the
 * current Europe/Minsk calendar day is used.
 */
function referenceDate() {
  if (env.analyticsReferenceDate) return env.analyticsReferenceDate;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Minsk',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function isoDate(year, monthIndex, day) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Six calendar buckets ending with the reference month. `end` is exclusive so
 * the SQL range needs no "last day of month" arithmetic.
 */
function monthBuckets(reference, count = CONSUMPTION_MONTHS) {
  const [year, month] = reference.split('-').map(Number);
  const buckets = [];

  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const start = new Date(Date.UTC(year, month - 1 - offset, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const startYear = start.getUTCFullYear();
    const startMonth = start.getUTCMonth();

    buckets.push({
      key: `${startYear}-${String(startMonth + 1).padStart(2, '0')}`,
      label: `${MONTH_LABELS[startMonth]} ${startYear}`,
      qty: 0,
      start: isoDate(startYear, startMonth, 1),
      end: isoDate(end.getUTCFullYear(), end.getUTCMonth(), 1),
    });
  }

  return buckets;
}

function buildConsumption(monthlyRows, reference) {
  const buckets = monthBuckets(reference);
  const byMonth = new Map(monthlyRows.map((row) => [row.month, row.qty]));

  for (const bucket of buckets) {
    bucket.qty = byMonth.get(bucket.key) ?? 0;
  }

  return {
    months: buckets.map(({ key, label, qty }) => ({ key, label, qty })),
    total: buckets.reduce((sum, bucket) => sum + bucket.qty, 0),
    max: Math.max(0, ...buckets.map((bucket) => bucket.qty)),
  };
}

/**
 * Replenishment calculations belong to Task 19 (reorder point and EOQ). Until
 * then the card renders explicit placeholders instead of guessed numbers.
 */
function replenishmentPlaceholder() {
  return {
    available: false,
    averageDailyUsage: null,
    safetyStock: null,
    reorderPoint: null,
    eoq: null,
    recommendedOrder: null,
  };
}

/**
 * One catalog page.
 * @param {{
 *   q?: string,
 *   categoryId?: number | null,
 *   manufacturerId?: number | null,
 *   warehouseId?: number | null,
 *   status?: 'all' | 'zero' | 'overstock' | 'below_min',
 *   sort?: 'name' | 'sku' | 'qty' | 'value',
 *   dir?: 'asc' | 'desc',
 *   page?: number,
 * }} [filters]
 * @returns {Promise<{ rows: Array<Record<string, unknown>>, total: number, page: number, pages: number }>}
 */
export async function list(filters = {}) {
  const query = {
    q: filters.q ?? '',
    categoryId: filters.categoryId ?? null,
    manufacturerId: filters.manufacturerId ?? null,
    warehouseId: filters.warehouseId ?? null,
    status: filters.status ?? 'all',
    sort: filters.sort ?? 'name',
    dir: filters.dir ?? 'asc',
    referenceDate: referenceDate(),
  };

  // Counting first clamps a stale `?page=999` before its offset is computed,
  // exactly like the admin list does.
  const total = await repository.countCatalog(query);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const requested = Number.isInteger(filters.page) && filters.page > 0 ? filters.page : 1;
  const page = Math.min(requested, pages);

  const rows =
    total === 0
      ? []
      : await repository.listCatalog({
          ...query,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        });

  return { rows, total, page, pages };
}

/**
 * Full component card.
 * @param {number} id
 * @param {{ showAll?: boolean, movementsPage?: number }} [options]
 * @throws {NotFoundError}
 */
export async function getById(id, { showAll = false, movementsPage = 1 } = {}) {
  const reference = referenceDate();
  const component = await repository.findCardComponent(id);
  if (!component) throw new NotFoundError(NOT_FOUND_MESSAGE);

  const movementTotal = await repository.countMovements(id);
  const movementPages = Math.max(1, Math.ceil(movementTotal / MOVEMENTS_PAGE_SIZE));
  const requested = Number.isInteger(movementsPage) && movementsPage > 0 ? movementsPage : 1;
  const movementPage = Math.min(requested, movementPages);
  const months = monthBuckets(reference);

  const [warehouseRows, batches, movements, monthlyRows] = await Promise.all([
    repository.listWarehouseBalances(id, { referenceDate: reference }),
    repository.listBatches(id),
    repository.listMovements(id, {
      limit: MOVEMENTS_PAGE_SIZE,
      offset: (movementPage - 1) * MOVEMENTS_PAGE_SIZE,
    }),
    repository.listMonthlyConsumption(id, {
      start: months[0].start,
      end: months[months.length - 1].end,
    }),
  ]);

  const visibleWarehouses = showAll
    ? warehouseRows
    : warehouseRows.filter((row) => row.hasActivity);
  const hiddenWarehouses = warehouseRows.length - visibleWarehouses.length;

  return {
    component,
    warehouses: {
      items: visibleWarehouses,
      showAll,
      hiddenCount: hiddenWarehouses,
    },
    batches,
    movements: {
      items: movements,
      page: movementPage,
      pages: movementPages,
      total: movementTotal,
    },
    consumption: buildConsumption(monthlyRows, reference),
    replenishment: replenishmentPlaceholder(),
  };
}

/**
 * Active components matching a type-ahead query.
 * @param {string} q
 * @returns {Promise<Array<{ id: number, sku: string, name: string }>>}
 */
export function search(q) {
  const term = typeof q === 'string' ? q.trim().slice(0, 120) : '';
  return repository.searchActive(term, SEARCH_LIMIT);
}

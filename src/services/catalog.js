import { env } from '../config/env.js';
import { NotFoundError } from '../domain/errors.js';
import { d } from '../domain/money.js';
import { aggregateStockStatus, stockStatus } from '../domain/stock-status.js';
import * as repository from '../repositories/components-read.js';
import { getReorder } from './analytics.js';

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
 * The card has no planning row when a position has neither stock nor movement
 * on the selected warehouse during the activity window. Returning explicit
 * nulls lets the template say "no data" rather than render a fake zero.
 */
function unavailableReplenishment() {
  return {
    available: false,
    averageDailyUsage: null,
    safetyStock: null,
    reorderPoint: null,
    eoq: null,
    recommendedOrder: null,
    lowData: false,
    warehouseCount: 0,
    warehousesBelowRop: 0,
    warehouses: [],
  };
}

/**
 * Replenishment block for one component (§5.4, §6.6).
 *
 * Reusing `getReorder` keeps the card, the reorder page and the dashboard in
 * agreement about the same pair; recomputing the statistics here would create
 * a second source of truth for ROP. With a warehouse selected the row is that
 * pair alone. Without one, `getReorder` returns the §6.6 aggregate: balances,
 * ROP and recommended order summed across participating warehouses, EOQ as the
 * maximum. Its `warehouses` detail is preserved for the disclosure list.
 *
 * @param {number} componentId
 * @param {{ warehouseId?: number | null }} [selection]
 */
async function buildReplenishment(componentId, { warehouseId = null } = {}) {
  const { rows } = await getReorder({ warehouseId });
  const row = rows.find((item) => item.componentId === componentId);
  if (!row) return unavailableReplenishment();

  return {
    available: true,
    averageDailyUsage: row.avgDaily,
    safetyStock: row.safetyStock,
    reorderPoint: row.rop,
    eoq: row.eoq,
    recommendedOrder: row.suggested,
    lowData: row.lowData,
    warehouseCount: warehouseId ? 1 : row.warehouseCount,
    warehousesBelowRop: warehouseId ? (row.belowRop ? 1 : 0) : row.warehousesBelowRop,
    // A single selected warehouse still travels as a one-element list so the
    // balance table can publish its ROP without a second lookup.
    warehouses: warehouseId ? [row] : row.warehouses,
  };
}

/**
 * Classify one catalog candidate with the shared stock rule.
 *
 * The repository returns either the participating warehouses (all-warehouse
 * mode) or the selected warehouse alone. `aggregateStockStatus` compares the
 * row's total balance with the summed thresholds, so an empty Minsk warehouse
 * does not hide the four units held in Gomel. Under a warehouse filter the
 * state set has one element and the aggregate reduces to the local status.
 */
function classifyCatalogRow(row) {
  const warehouses = Array.isArray(row.warehouseStates) ? row.warehouseStates : [];
  return { ...row, status: aggregateStockStatus({ qty: row.qty, warehouses }) };
}

function compareCatalogRows(a, b, sort, direction) {
  // ROP is optional: a component without stock or movements has no planning
  // row. Those stay at the end in both directions instead of jumping to the top
  // on a descending sort.
  if (sort === 'rop') {
    if (a.rop === null || b.rop === null) {
      if (a.rop === null && b.rop === null) return a.id - b.id;
      return a.rop === null ? 1 : -1;
    }
    const ropResult = a.rop - b.rop || a.id - b.id;
    return direction === 'desc' ? -ropResult : ropResult;
  }

  let result;

  if (sort === 'value') {
    // Values are PostgreSQL numeric strings; comparing them as Decimal keeps
    // money off the float path even on the sort path.
    result = d(a.value).comparedTo(d(b.value));
  } else if (sort === 'qty') {
    result = a.qty - b.qty;
  } else {
    result = String(a[sort]).localeCompare(String(b[sort]), 'ru');
  }

  if (result === 0) result = a.id - b.id;
  return direction === 'desc' ? -result : result;
}

/**
 * Attach the reorder point to catalog rows.
 *
 * The catalog shows ROP in its own column and filters by `below_rop`, so it
 * must use exactly the same pair calculation as the reorder page. The `rop`
 * column shows the §6.6 aggregate (summed across participating warehouses)
 * when no warehouse is selected, while `belowRop` is true as soon as one pair
 * is below its own point — the same "at least one warehouse" condition the
 * dashboard KPI counts. A component with no participating warehouse has no ROP
 * and is never classified as below it.
 */
async function attachReorderPoints(rows, { warehouseId, categoryId }) {
  if (rows.length === 0) return rows;

  const reorder = await getReorder({ warehouseId, categoryId });
  const byComponent = new Map(reorder.rows.map((row) => [row.componentId, row]));

  return rows.map((row) => {
    const planning = byComponent.get(row.id);
    return {
      ...row,
      rop: planning?.rop ?? null,
      belowRop: planning?.belowRop ?? false,
    };
  });
}

/**
 * Normalise the catalog filter contract shared by the page and the CSV export.
 * The repository already expects null for "all", so the defaults live here once.
 */
function normalizeQuery(filters) {
  return {
    q: filters.q ?? '',
    categoryId: filters.categoryId ?? null,
    manufacturerId: filters.manufacturerId ?? null,
    warehouseId: filters.warehouseId ?? null,
    status: filters.status ?? 'all',
    sort: filters.sort ?? 'name',
    dir: filters.dir ?? 'asc',
    referenceDate: referenceDate(),
  };
}

/**
 * Apply every catalog filter, including the derived stock status and ROP.
 *
 * Status needs per-warehouse inputs, so the whole filtered candidate set is
 * classified here. Pagination happens after the status filter so its count is
 * exact; the export reuses the same unordered step without pagination.
 */
async function selectRows(query) {
  const candidates = await repository.listCatalogCandidates(query);
  const classified = candidates.map(classifyCatalogRow);
  const withPlanning = await attachReorderPoints(classified, {
    warehouseId: query.warehouseId,
    categoryId: query.categoryId,
  });

  // `below_rop` is a planning filter, not a stock-status chip: the row keeps
  // its zero/below_min/overstock classification and is matched separately.
  let filtered = withPlanning;
  if (query.status === 'below_rop') {
    filtered = withPlanning.filter((row) => row.belowRop);
  } else if (query.status !== 'all') {
    filtered = withPlanning.filter((row) => row.status === query.status);
  }

  filtered.sort((a, b) => compareCatalogRows(a, b, query.sort, query.dir));

  return filtered.map((row) => {
    const visible = { ...row };
    delete visible.warehouseStates;
    return visible;
  });
}

/**
 * One catalog page.
 * @param {{
 *   q?: string,
 *   categoryId?: number | null,
 *   manufacturerId?: number | null,
 *   warehouseId?: number | null,
 *   status?: 'all' | 'zero' | 'overstock' | 'below_min' | 'below_rop',
 *   sort?: 'name' | 'sku' | 'qty' | 'value' | 'rop',
 *   dir?: 'asc' | 'desc',
 *   page?: number,
 * }} [filters]
 * @returns {Promise<{ rows: Array<Record<string, unknown>>, total: number, page: number, pages: number }>}
 */
export async function list(filters = {}) {
  const query = normalizeQuery(filters);
  const filtered = await selectRows(query);

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const requested = Number.isInteger(filters.page) && filters.page > 0 ? filters.page : 1;
  const page = Math.min(requested, pages);
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return { rows, total, page, pages };
}

/**
 * Every row matching the catalog filters, without pagination.
 *
 * Used by the CSV export so the file can never disagree with the screen about
 * search, manufacturer, warehouse, status or sort order. Zero-balance rows are
 * included exactly when the status filter keeps them (`all` and `zero`).
 *
 * @param {Parameters<typeof list>[0]} [filters]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function listAll(filters = {}) {
  return selectRows(normalizeQuery(filters));
}

/**
 * Full component card.
 * @param {number} id
 * @param {{ showAll?: boolean, movementsPage?: number, warehouseId?: number | null }} [options]
 * @throws {NotFoundError}
 */
export async function getById(id, { showAll = false, movementsPage = 1, warehouseId = null } = {}) {
  const reference = referenceDate();
  const component = await repository.findCardComponent(id);
  if (!component) throw new NotFoundError(NOT_FOUND_MESSAGE);

  const [warehouseRows, batches, movementTotal] = await Promise.all([
    repository.listWarehouseBalances(id, { referenceDate: reference }),
    repository.listBatches(id),
    repository.countMovements(id),
  ]);

  // The card rows use the same rule as the catalog summary. A warehouse id
  // that no longer exists falls back to all warehouses instead of rendering an
  // empty chart with no explanation.
  const warehousesWithStatus = warehouseRows.map((row) => ({
    ...row,
    status: stockStatus(row),
  }));
  const selectedWarehouse =
    warehousesWithStatus.find((row) => row.warehouseId === warehouseId) ?? null;

  const movementPages = Math.max(1, Math.ceil(movementTotal / MOVEMENTS_PAGE_SIZE));
  const requested = Number.isInteger(movementsPage) && movementsPage > 0 ? movementsPage : 1;
  const movementPage = Math.min(requested, movementPages);
  const months = monthBuckets(reference);

  const [movements, monthlyRows, replenishment] = await Promise.all([
    repository.listMovements(id, {
      limit: MOVEMENTS_PAGE_SIZE,
      offset: (movementPage - 1) * MOVEMENTS_PAGE_SIZE,
    }),
    repository.listMonthlyConsumption(id, {
      start: months[0].start,
      end: months[months.length - 1].end,
      warehouseId: selectedWarehouse?.warehouseId ?? null,
    }),
    buildReplenishment(id, {
      warehouseId: selectedWarehouse?.warehouseId ?? null,
    }),
  ]);

  // The balance table has its own ROP column. Publish the planning value on
  // every row that participates in the reorder calculation; a warehouse with
  // stock but no planning pair keeps the dash instead of a misleading zero.
  const ropByWarehouse = new Map(
    replenishment.warehouses.map((pair) => [pair.warehouse.warehouseId, pair.rop]),
  );
  const warehousesWithRop = warehousesWithStatus.map((row) => ({
    ...row,
    rop: ropByWarehouse.get(row.warehouseId) ?? null,
  }));

  const visibleWarehouses = showAll
    ? warehousesWithRop
    : warehousesWithRop.filter((row) => row.hasActivity);
  const hiddenWarehouses = warehousesWithRop.length - visibleWarehouses.length;

  return {
    component,
    warehouses: {
      items: visibleWarehouses,
      all: warehousesWithRop,
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
    consumption: {
      ...buildConsumption(monthlyRows, reference),
      warehouseId: selectedWarehouse?.warehouseId ?? null,
      warehouseName: selectedWarehouse?.name ?? null,
    },
    replenishment,
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

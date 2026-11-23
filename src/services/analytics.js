import { env } from '../config/env.js';
import { ACTIVITY_WINDOW_DAYS, DEMAND_WINDOW_DAYS, XYZ_MONTHS } from '../config/inventory.js';
import { classifyAbc } from '../domain/abc.js';
import { calculateKpi } from '../domain/kpi.js';
import { d } from '../domain/money.js';
import { calculateReorder } from '../domain/reorder.js';
import { classifyXyz } from '../domain/xyz.js';
import * as repository from '../repositories/analytics.js';

/**
 * ABC, XYZ, reorder planning and the KPI dashboard.
 *
 * The screens deliberately share one filter contract `{ warehouseId,
 * categoryId }` so the XYZ matrix can reuse the ABC classification and the
 * catalog/dashboard can reuse one reorder interpretation. All money arithmetic
 * goes through decimal.js; quantities are integers and are converted to Number
 * only for the domain classifiers and chart labels.
 */

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

const ABC_CLASSES = Object.freeze(['A', 'B', 'C']);
const XYZ_CLASSES = Object.freeze(['X', 'Y', 'Z']);

/** Statistics are display values; three decimals are enough to compare classes. */
const STAT_DECIMALS = 3;

/**
 * "Today" for every analytics window.
 *
 * Demo and test runs pin `ANALYTICS_REFERENCE_DATE`, so the same data always
 * produces the same months. Production leaves it empty and the current
 * Europe/Minsk calendar day is used.
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

function isoDate(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`;
}

/**
 * Six full calendar months ending before the reference month.
 *
 * A full month is closed only once the next month starts. On 22.11.2026 the
 * window is therefore May–October 2026; November is still in progress and would
 * understate the last bucket.
 *
 * @param {string} reference `YYYY-MM-DD`
 * @returns {{
 *   start: string, end: string, referenceDate: string,
 *   months: Array<{ key: string, label: string }>
 * }}
 */
function monthWindow(reference) {
  const [year, month] = reference.split('-').map(Number);
  const end = new Date(Date.UTC(year, month - 1, 1));
  const start = new Date(Date.UTC(year, month - 1 - XYZ_MONTHS, 1));
  const months = [];

  for (let offset = 0; offset < XYZ_MONTHS; offset += 1) {
    const bucket = new Date(Date.UTC(year, month - 1 - XYZ_MONTHS + offset, 1));
    const bucketYear = bucket.getUTCFullYear();
    const bucketMonth = bucket.getUTCMonth();
    months.push({
      key: `${bucketYear}-${String(bucketMonth + 1).padStart(2, '0')}`,
      label: `${MONTH_LABELS[bucketMonth]} ${bucketYear}`,
    });
  }

  return {
    start: isoDate(start.getUTCFullYear(), start.getUTCMonth()),
    end: isoDate(end.getUTCFullYear(), end.getUTCMonth()),
    referenceDate: reference,
    months,
  };
}

/**
 * Counts and values per ABC class.
 *
 * The values stay decimal strings so the template formats them through the same
 * money helper as every other screen.
 */
function summarizeAbc(rows) {
  const summary = {
    A: { count: 0, value: d(0) },
    B: { count: 0, value: d(0) },
    C: { count: 0, value: d(0) },
    total: { count: rows.length, value: d(0) },
  };

  for (const row of rows) {
    const amount = d(row.value);
    summary[row.class].count += 1;
    summary[row.class].value = summary[row.class].value.plus(amount);
    summary.total.value = summary.total.value.plus(amount);
  }

  return {
    A: { count: summary.A.count, value: summary.A.value.toFixed(4) },
    B: { count: summary.B.count, value: summary.B.value.toFixed(4) },
    C: { count: summary.C.count, value: summary.C.value.toFixed(4) },
    total: { count: summary.total.count, value: summary.total.value.toFixed(4) },
  };
}

/**
 * Chart.js accepts only numbers, so the Pareto series is the one place where a
 * money value is converted for display. The table and the summary keep strings.
 */
function buildAbcChart(rows) {
  return {
    type: 'pareto',
    labels: rows.map((row) => row.sku),
    values: rows.map((row) => Number(d(row.value).toFixed(2))),
    cumulative: rows.map((row) => Number((row.cumulativeShare * 100).toFixed(2))),
  };
}

/**
 * ABC ranking of current stock value.
 *
 * @param {{ warehouseId?: number|null, categoryId?: number|null }} [filters]
 * @returns {Promise<{
 *   rows: Array<Record<string, unknown>>,
 *   summary: {
 *     A: { count: number, value: string }, B: { count: number, value: string },
 *     C: { count: number, value: string }, total: { count: number, value: string }
 *   },
 *   chart: { type: 'pareto', labels: string[], values: number[], cumulative: number[] }
 * }>}
 */
export async function getAbc(filters = {}) {
  const warehouseId = filters.warehouseId ?? null;
  const categoryId = filters.categoryId ?? null;
  const candidates = await repository.listAbcCandidates({ warehouseId, categoryId });
  const byId = new Map(candidates.map((row) => [row.id, row]));

  const classified = classifyAbc(candidates.map((row) => ({ id: row.id, value: row.value })));

  const rows = classified.map((item, index) => ({
    ...byId.get(item.id),
    value: item.value,
    share: item.share,
    cumulativeShare: item.cumulativeShare,
    class: item.class,
    rank: index + 1,
  }));

  return {
    rows,
    summary: summarizeAbc(rows),
    chart: buildAbcChart(rows),
  };
}

/**
 * Mean and population standard deviation of the monthly window.
 *
 * The domain classifier owns the CV rule; these numbers are only what the table
 * shows next to it, so they are computed with Decimal and rounded once.
 */
function demandStats(monthly) {
  const quantities = monthly.map((qty) => d(qty));
  const total = quantities.reduce((sum, qty) => sum.plus(qty), d(0));
  const mean = total.div(XYZ_MONTHS);
  const variance = quantities
    .reduce((sum, qty) => sum.plus(qty.minus(mean).pow(2)), d(0))
    .div(XYZ_MONTHS);

  return {
    total: Number(total.toFixed(0)),
    mean: Number(mean.toFixed(STAT_DECIMALS)),
    stddev: Number(variance.sqrt().toFixed(STAT_DECIMALS)),
  };
}

function compareXyzRows(left, right) {
  const leftCv = left.cv === null ? Number.POSITIVE_INFINITY : left.cv;
  const rightCv = right.cv === null ? Number.POSITIVE_INFINITY : right.cv;

  if (leftCv !== rightCv) return leftCv - rightCv;
  if (left.total !== right.total) return right.total - left.total;
  return left.id - right.id;
}

function buildMatrix(rows, abcClassById) {
  const matrixRows = ABC_CLASSES.map((abc) => ({
    abc,
    cells: XYZ_CLASSES.map((xyz) => ({ xyz, count: 0 })),
  }));
  const rowByClass = new Map(matrixRows.map((row) => [row.abc, row]));

  for (const row of rows) {
    // A position that consumes but holds no stock has no ABC value; ABC treats
    // zero value as class C, and the matrix follows the same rule.
    const abcClass = abcClassById.get(row.id) ?? 'C';
    const cell = rowByClass.get(abcClass).cells.find((item) => item.xyz === row.class);
    cell.count += 1;
  }

  return {
    xyzClasses: [...XYZ_CLASSES],
    rows: matrixRows,
    total: rows.length,
  };
}

/**
 * XYZ classification over six full months plus the ABC×XYZ matrix.
 *
 * @param {{ warehouseId?: number|null, categoryId?: number|null }} [filters]
 * @returns {Promise<{
 *   rows: Array<Record<string, unknown>>,
 *   matrix: {
 *     xyzClasses: string[],
 *     rows: Array<{ abc: string, cells: Array<{ xyz: string, count: number }> }>,
 *     total: number
 *   },
 *   window: { start: string, end: string, referenceDate: string, months: Array<{ key: string, label: string }> }
 * }>}
 */
export async function getXyz(filters = {}) {
  const warehouseId = filters.warehouseId ?? null;
  const categoryId = filters.categoryId ?? null;
  const window = monthWindow(referenceDate());

  // ABC is classified from the full filtered range, not from the XYZ subset:
  // moving a position out of the stock ranking would move the class boundaries
  // for every other row on the same screen.
  const [components, issueRows, abcCandidates] = await Promise.all([
    repository.listXyzComponents({ warehouseId, categoryId, ...window }),
    repository.listMonthlyIssues({ warehouseId, categoryId, ...window }),
    repository.listAbcCandidates({ warehouseId, categoryId }),
  ]);

  const quantitiesByComponent = new Map();
  for (const issue of issueRows) {
    const monthly = quantitiesByComponent.get(issue.componentId) ?? new Map();
    monthly.set(issue.month, issue.qty);
    quantitiesByComponent.set(issue.componentId, monthly);
  }

  const rows = components.map((component) => {
    const byMonth = quantitiesByComponent.get(component.id);
    const monthly = window.months.map((month) => Number(byMonth?.get(month.key) ?? 0));
    const { cv, class: className } = classifyXyz(monthly);
    const stats = demandStats(monthly);

    return {
      ...component,
      monthly,
      total: stats.total,
      mean: stats.mean,
      stddev: stats.stddev,
      cv,
      class: className,
    };
  });

  rows.sort(compareXyzRows);

  const abcClassById = new Map(
    classifyAbc(abcCandidates.map((row) => ({ id: row.id, value: row.value }))).map((item) => [
      item.id,
      item.class,
    ]),
  );

  return { rows, matrix: buildMatrix(rows, abcClassById), window };
}

/* ------------------------------------------------------------- Reorder plan */

const DAY_MS = 24 * 60 * 60 * 1000;
const ATTENTION_LIMIT = 8;
const RECENT_MOVEMENTS_LIMIT = 8;

const MOVEMENT_TYPE_LABELS = Object.freeze({
  receipt: 'Приёмка',
  issue: 'Расход',
  transfer: 'Перемещение',
  adjustment: 'Корректировка',
});

/** Calendar arithmetic stays on ISO strings so no local timezone leaks in. */
function addDays(iso, days) {
  const [year, month, day] = iso.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS,
  );
}

/**
 * The rolling 90-day demand window ending on the reference date.
 *
 * `end` is the last covered calendar day for display; `endExclusive` is the
 * half-open bound handed to SQL. The array indices are 0..89, with index 89
 * representing the reference day.
 */
function demandWindow(reference) {
  return {
    start: addDays(reference, -(DEMAND_WINDOW_DAYS - 1)),
    end: reference,
    endExclusive: addDays(reference, 1),
    days: DEMAND_WINDOW_DAYS,
    referenceDate: reference,
  };
}

/**
 * Calendar days since the first consumption, capped at the window length.
 *
 * The first demand day counts as day one: a position first issued 14 days ago
 * has exactly 14 days of history and clears the domain's trust floor. No
 * consumption at all is zero days, which always triggers the low-data fallback.
 */
function historyDays(firstIssueDate, reference) {
  if (!firstIssueDate) return 0;
  const elapsed = daysBetween(firstIssueDate, reference) + 1;
  return Math.min(Math.max(elapsed, 0), DEMAND_WINDOW_DAYS);
}

/**
 * One pair below its reorder point is a shortage; zero stock is the sharper
 * label because the user must act before anything else.
 */
function pairStatus(balance, rop) {
  if (balance <= 0) return 'zero';
  if (balance < rop) return 'below_rop';
  return 'ok';
}

function emptyDailyWindow() {
  return Array(DEMAND_WINDOW_DAYS).fill(0);
}

/**
 * Run the domain calculation for every participating pair.
 *
 * The daily map is sparse from SQL; the domain requires exactly 90 entries, so
 * every quiet day is filled with a zero before the call. `historyDays` comes
 * from the first issue rather than from the zero-filled array length, which is
 * the whole point of the low-data badge.
 */
function buildReorderPairs(pairs, dailyRows, window) {
  const dailyByPair = new Map();

  for (const row of dailyRows) {
    const index = daysBetween(window.start, row.day);
    if (index < 0 || index >= DEMAND_WINDOW_DAYS) continue;

    const key = `${row.componentId}:${row.warehouseId}`;
    const bucket = dailyByPair.get(key) ?? emptyDailyWindow();
    bucket[index] = row.qty;
    dailyByPair.set(key, bucket);
  }

  return pairs.map((pair) => {
    const dailyQuantities =
      dailyByPair.get(`${pair.componentId}:${pair.warehouseId}`) ?? emptyDailyWindow();
    const unitCost = pair.avgCost ?? pair.purchasePrice;
    // A document service never lets the ledger go below zero, but read-only
    // analytics can meet legacy or fixture data where issues exceed receipts.
    // Treat that impossible balance as empty stock instead of failing the whole
    // dashboard with a validation error; the rest of the page stays usable.
    const balance = Math.max(0, pair.qty);
    const computed = calculateReorder({
      dailyQuantities,
      historyDays: historyDays(pair.firstIssueDate, window.referenceDate),
      leadTimeDays: pair.leadTimeDays,
      minStock: pair.minStock,
      balance,
      unitCost,
    });

    return {
      componentId: pair.componentId,
      sku: pair.sku,
      name: pair.name,
      unit: pair.unit,
      categoryName: pair.categoryName,
      warehouse: {
        warehouseId: pair.warehouseId,
        code: pair.warehouseCode,
        name: pair.warehouseName,
        city: pair.warehouseCity,
      },
      warehouseName: pair.warehouseName,
      balance,
      unitCost,
      leadTimeDays: pair.leadTimeDays,
      avgDaily: computed.avgDaily,
      stddev: computed.stddev,
      safetyStock: computed.safetyStock,
      rop: computed.rop,
      eoq: computed.eoq,
      suggested: computed.suggested,
      lowData: computed.lowData,
      status: pairStatus(balance, computed.rop),
      belowRop: balance < computed.rop,
    };
  });
}

/**
 * Worst planning state across the warehouses of one component.
 *
 * The aggregate row must not say "в норме" while it also recommends an order:
 * a single pair below its own ROP is enough to put the whole position into the
 * below-ROP bucket, exactly like the dashboard KPI counts it.
 */
const REORDER_STATUS_RANK = Object.freeze({ zero: 2, below_rop: 1, ok: 0 });

function worstReorderStatus(pairs) {
  return pairs.reduce(
    (worst, pair) =>
      REORDER_STATUS_RANK[pair.status] > REORDER_STATUS_RANK[worst] ? pair.status : worst,
    'ok',
  );
}

/**
 * Roll the per-warehouse pairs up into one row per component.
 *
 * §6.6 fixes the aggregation: balances, ROP, safety stock and suggested are
 * summed; EOQ is a single order size and is therefore the maximum, never a sum.
 * The row keeps every pair under `warehouses` so the page can reveal the
 * detail the summary hides.
 */
function aggregateReorderRows(pairs) {
  const byComponent = new Map();

  for (const pair of pairs) {
    const group = byComponent.get(pair.componentId) ?? {
      componentId: pair.componentId,
      sku: pair.sku,
      name: pair.name,
      unit: pair.unit,
      categoryName: pair.categoryName,
      balance: 0,
      avgDaily: d(0),
      safetyStock: d(0),
      rop: d(0),
      eoq: 0,
      suggested: 0,
      warehouses: [],
    };

    group.balance += pair.balance;
    group.avgDaily = group.avgDaily.plus(d(pair.avgDaily));
    group.safetyStock = group.safetyStock.plus(d(pair.safetyStock));
    group.rop = group.rop.plus(d(pair.rop));
    group.eoq = Math.max(group.eoq, pair.eoq);
    group.suggested += pair.suggested;
    group.warehouses.push(pair);

    byComponent.set(pair.componentId, group);
  }

  const rows = [...byComponent.values()].map((group) => {
    const rop = Number(group.rop.toFixed(2));
    const warehouses = [...group.warehouses].sort((left, right) =>
      left.warehouseName.localeCompare(right.warehouseName, 'ru'),
    );

    return {
      componentId: group.componentId,
      sku: group.sku,
      name: group.name,
      unit: group.unit,
      categoryName: group.categoryName,
      balance: group.balance,
      avgDaily: Number(group.avgDaily.toFixed(4)),
      safetyStock: Number(group.safetyStock.toFixed(2)),
      rop,
      eoq: group.eoq,
      suggested: group.suggested,
      // Any untrustworthy pair taints the sum: part of the ROP may be the
      // min_stock fallback, so the badge must still warn the reader.
      lowData: warehouses.some((pair) => pair.lowData),
      status: worstReorderStatus(warehouses),
      belowRop: warehouses.some((pair) => pair.belowRop),
      anyWarehouseBelowRop: warehouses.some((pair) => pair.belowRop),
      warehouses,
      warehouseCount: warehouses.length,
    };
  });

  return rows.sort(compareReorderRows);
}

function reorderSeverity(row) {
  if (row.status === 'zero') return 0;
  if (row.status === 'below_rop') return 1;
  return 2;
}

function compareReorderRows(left, right) {
  const severity = reorderSeverity(left) - reorderSeverity(right);
  if (severity !== 0) return severity;
  if (left.suggested !== right.suggested) return right.suggested - left.suggested;
  return left.name.localeCompare(right.name, 'ru') || left.componentId - right.componentId;
}

/**
 * Reorder planning for one filter selection.
 *
 * With a warehouse selected the rows are component/warehouse pairs. Without
 * one they are components aggregated exactly as §6.6 describes, while each row
 * still carries the per-warehouse detail for the expandable table note.
 *
 * @param {{ warehouseId?: number|null, categoryId?: number|null }} [filters]
 * @returns {Promise<{
 *   rows: Array<Record<string, unknown>>,
 *   window: {
 *     start: string, end: string, endExclusive: string,
 *     days: number, referenceDate: string
 *   },
 *   pairCount: number
 * }>}
 */
export async function getReorder(filters = {}) {
  const warehouseId = filters.warehouseId ?? null;
  const categoryId = filters.categoryId ?? null;
  const window = demandWindow(referenceDate());
  const activityStart = addDays(window.referenceDate, -ACTIVITY_WINDOW_DAYS);

  const [pairs, dailyRows] = await Promise.all([
    repository.listReorderPairs({ warehouseId, categoryId, activityStart }),
    repository.listDailyIssues({
      warehouseId,
      categoryId,
      start: window.start,
      end: window.endExclusive,
    }),
  ]);

  const pairRows = buildReorderPairs(pairs, dailyRows, window);

  if (warehouseId) {
    pairRows.sort(compareReorderRows);
    return { rows: pairRows, window, pairCount: pairRows.length };
  }

  return { rows: aggregateReorderRows(pairRows), window, pairCount: pairRows.length };
}

/* ----------------------------------------------------------------- Dashboard */

function compareAttentionRows(left, right) {
  if (left.suggested !== right.suggested) return right.suggested - left.suggested;
  const leftDeficit = left.rop - left.balance;
  const rightDeficit = right.rop - right.balance;
  if (leftDeficit !== rightDeficit) return rightDeficit - leftDeficit;
  return left.name.localeCompare(right.name, 'ru') || left.componentId - right.componentId;
}

/**
 * Everything the dashboard needs in one call.
 *
 * The below-ROP count is per distinct component with at least one warehouse
 * pair below its own ROP, while the attention table stays at pair level because
 * that is where the order is actually placed. The matrix and demand windows are
 * reused from XYZ so the dashboard cannot disagree with the analytics pages.
 *
 * @returns {Promise<{
 *   kpis: {
 *     stockValue: string, cogs90: string, deadValue: string,
 *     belowRopCount: number, turnoverYear: number|null, coverageDays: number|null
 *   },
 *   categoryValues: Array<{ name: string, value: string }>,
 *   categoryChart: { type: 'category-bar', labels: string[], values: number[] },
 *   attention: Array<Record<string, unknown>>,
 *   matrix: Record<string, unknown>,
 *   recentMovements: Array<Record<string, unknown>>,
 *   window: Record<string, unknown>
 * }>}
 */
export async function getDashboard() {
  const window = demandWindow(referenceDate());
  const [totals, categoryValues, recentMovements, reorder, xyz] = await Promise.all([
    repository.getKpiTotals({ start: window.start, end: window.endExclusive }),
    repository.listCategoryValues(),
    repository.listRecentMovements(RECENT_MOVEMENTS_LIMIT),
    getReorder({}),
    getXyz({}),
  ]);

  const kpi = calculateKpi({ stockValue: totals.stockValue, cogs90: totals.cogs90 });

  const pairsBelowRop = reorder.rows.flatMap((row) =>
    row.warehouses.filter((pair) => pair.belowRop),
  );
  const attention = [...pairsBelowRop]
    .sort(compareAttentionRows)
    .slice(0, ATTENTION_LIMIT)
    .map((pair) => ({
      componentId: pair.componentId,
      sku: pair.sku,
      name: pair.name,
      unit: pair.unit,
      warehouseId: pair.warehouse.warehouseId,
      warehouseName: pair.warehouseName,
      balance: pair.balance,
      rop: pair.rop,
      suggested: pair.suggested,
      lowData: pair.lowData,
    }));

  return {
    kpis: {
      stockValue: totals.stockValue,
      cogs90: totals.cogs90,
      deadValue: totals.deadValue,
      belowRopCount: reorder.rows.filter((row) => row.anyWarehouseBelowRop).length,
      turnoverYear: kpi.turnoverYear,
      coverageDays: kpi.coverageDays,
    },
    categoryValues,
    // Chart.js accepts numbers only; this conversion is display-only and the
    // table/cards keep the exact numeric strings.
    categoryChart: {
      type: 'category-bar',
      labels: categoryValues.map((item) => item.name),
      values: categoryValues.map((item) => Number(d(item.value).toFixed(2))),
    },
    attention,
    matrix: xyz.matrix,
    recentMovements: recentMovements.map((movement) => ({
      ...movement,
      typeLabel: MOVEMENT_TYPE_LABELS[movement.documentType] ?? MOVEMENT_TYPE_LABELS.adjustment,
    })),
    window,
  };
}

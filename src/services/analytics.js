import { env } from '../config/env.js';
import { XYZ_MONTHS } from '../config/inventory.js';
import { classifyAbc } from '../domain/abc.js';
import { classifyXyz } from '../domain/xyz.js';
import { d } from '../domain/money.js';
import * as repository from '../repositories/analytics.js';

/**
 * ABC and XYZ analytics.
 *
 * The two analyses deliberately share one filter contract `{ warehouseId,
 * categoryId }` so the XYZ matrix can reuse the ABC classification without a
 * second interpretation of the same screen. All money arithmetic goes through
 * decimal.js; quantities are integers and are converted to Number only for the
 * domain classifier and for chart labels.
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

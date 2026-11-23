/**
 * Deterministic demo seeding for the Motherload warehouse terminal.
 *
 * The seeder writes reference data, a full six-month demand history plus the
 * three demo accounts from AGENTS §3. History goes through the real
 * `postReceipt`/`postIssue` services, so batches, FIFO consumptions, ledger
 * movements and audit rows follow exactly the same rules as an operator
 * posting a document. A hand-written INSERT set would drift from those rules
 * the first time a service changed.
 *
 * Demand is not a flat random walk: every component belongs to one of three
 * deterministic profiles. A third issue the same quantity every month (XYZ X),
 * a third follow a mild seasonal pattern (Y), and the rest are spiky or dead
 * (Z). The opening receipt predates the first XYZ month, so May–October is a
 * complete six-month observation window and the ABC×XYZ matrix has all three
 * columns populated.
 *
 * Analytics and alert windows read `stock_movements.created_at`, not the
 * document date. Posting through the services stamps "now", so the seeder
 * backdates movements after posting; otherwise every document would land in
 * one week and dead-stock/XYZ/COGS would be meaningless. `stock_batches
 * .received_at` already carries the document date and needs no correction.
 *
 * Idempotency: a second run without `force` does nothing when `components`
 * already holds rows. `force` truncates every application table (including
 * sessions, audit and sequences) and reseeds from scratch.
 */

import { pathToFileURL } from 'node:url';
import {
  categories,
  components,
  manufacturers,
  suppliers,
  users,
  warehouses,
} from '../../db/seed/data.js';
import { env } from '../config/env.js';
import { d } from '../domain/money.js';
import { logger } from '../lib/logger.js';
import { recalculate } from '../services/alerts.js';
import { hashPassword } from '../services/auth.js';
import { postIssue, postReceipt } from '../services/stock.js';
import { APPLICATION_TABLES } from './application-tables.js';
import { closePool, query, withTransaction } from './pool.js';

// Fixed so the same reference date produces identical demo history on every
// machine. Changing it rewrites every generated quantity and date.
const HISTORY_SEED = 20261122;
const DAY_MS = 24 * 60 * 60 * 1000;

// The first XYZ month is six full months before the reference month. The
// opening receipt is placed a few days before that boundary so May–October is
// a complete observation window, whatever the reference date is.
const OPENING_LEAD_DAYS_MIN = 3;
const OPENING_LEAD_DAYS_MAX = 12;

const XYZ_MONTHS = 6;
const EVENTS_MIN = 12;
const EVENTS_MAX = 20;

// Mild seasonality: mean 1.1, coefficient of variation ~0.17, which lands
// comfortably inside the Y band (0.10 < CV <= 0.25).
const SEASONAL_FACTORS = [1.2, 1.0, 1.4, 1.0, 0.8, 1.2];

// Zero months plus large issues elsewhere. The sets are fixed per component so
// both warehouses of a two-warehouse position spike in the same months; mixing
// them would smooth the aggregate back into an X/Y pattern.
const SPIKY_MONTH_SETS = [
  [0, 3],
  [1, 4],
  [0, 4],
  [2, 5],
  [1, 3],
  [0, 3, 5],
];

// Dead positions issue only in the first two XYZ months. That keeps the last
// issue more than 120 days before the reference on every calendar, including
// references late in a month where the third window month starts only ~120
// days earlier.
const DEAD_MONTHS = [0, 1];

const ISSUE_REASONS = ['sale', 'sale', 'sale', 'sale', 'internal', 'defect'];

const PRIMARY_WAREHOUSE_BY_INDEX = ['WH-MSK', 'WH-MSK', 'WH-GOM', 'WH-MSK', 'WH-BRE'];
const WAREHOUSE_CODES = ['WH-MSK', 'WH-GOM', 'WH-BRE'];

// Audit fields accept an optional request; services and scripts have no HTTP
// session, so the synthetic request keeps the audit API contract unchanged.
const SYSTEM_REQUEST = { ip: null, get: () => null };

/**
 * Small, fast, deterministic PRNG (mulberry32). The generator is seeded with a
 * constant, so an unchanged data module always produces the same history.
 * @param {number} seed
 * @returns {() => number} values in [0, 1)
 */
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inclusive integer in [min, max]. @returns {number} */
function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Calendar arithmetic on ISO strings, never through a local-time Date. */
function addDays(iso, days) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** @returns {string} today's calendar date in the business timezone */
function todayInMinsk() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Minsk',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

/**
 * @param {unknown} value
 * @throws {Error} when the value is not a real `YYYY-MM-DD` calendar date
 */
function assertIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('seed: referenceDate must be a YYYY-MM-DD string');
  }

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`seed: referenceDate "${value}" is not a calendar date`);
  }
}

/**
 * Receipt lot size derived from the purchase price: expensive hardware arrives
 * in pairs, cheap accessories in dozens. Decimal keeps money out of floats even
 * though only the resulting whole-unit lot is used.
 * @param {{ purchasePrice: string }} component
 * @returns {number} 2..40 units
 */
function lotSize(component) {
  const raw = d('80').dividedBy(d(component.purchasePrice).sqrt()).toDecimalPlaces(0).toNumber();
  return Math.min(40, Math.max(2, raw));
}

/**
 * Every component normally lives in Minsk, with Gomel and Brest taking a share
 * so all three warehouses have history. Every third component gets a second
 * warehouse, which keeps transfers out of the seed but makes the regional
 * balances non-trivial.
 * @param {number} index
 * @returns {string[]} one or two warehouse codes
 */
function warehousesForComponent(index) {
  const primary = PRIMARY_WAREHOUSE_BY_INDEX[index % PRIMARY_WAREHOUSE_BY_INDEX.length];
  if (index % 3 !== 1) return [primary];

  const alternatives = WAREHOUSE_CODES.filter((code) => code !== primary);
  return [primary, alternatives[index % alternatives.length]];
}

/**
 * Final balance the history is steered towards. `dead` pairs are excluded from
 * steering because their value comes from the age of untouched stock, not from
 * a quantity target.
 * @param {{ stockCase: string, minStock: number, maxStock: number | null }} component
 * @returns {number}
 */
function targetBalance(component) {
  if (component.stockCase === 'low') {
    return Math.max(1, component.minStock - 1 - Math.floor(component.minStock / 3));
  }
  if (component.stockCase === 'overstock') {
    return component.maxStock + 2 + Math.floor(component.maxStock / 2);
  }
  return component.minStock + Math.floor((component.maxStock - component.minStock) / 2);
}

function receiptDocument({ component, warehouseCode, docDate, qty }) {
  return {
    type: 'receipt',
    docDate,
    warehouseCode,
    sku: component.sku,
    supplierName: component.supplierName,
    qty,
    unitCost: component.purchasePrice,
  };
}

function issueDocument({ component, warehouseCode, docDate, qty, rng }) {
  return {
    type: 'issue',
    docDate,
    warehouseCode,
    sku: component.sku,
    qty,
    reason: ISSUE_REASONS[randInt(rng, 0, ISSUE_REASONS.length - 1)],
  };
}

/**
 * The six full XYZ months, oldest first. The reference month itself is
 * excluded because it is still in progress; for 22.11.2026 this is May–October.
 * @param {string} referenceDate
 * @returns {Array<{ year: number, month: number }>}
 */
function xyzMonths(referenceDate) {
  const [year, month] = referenceDate.split('-').map(Number);
  const months = [];

  for (let offset = XYZ_MONTHS; offset >= 1; offset -= 1) {
    const date = new Date(Date.UTC(year, month - 1 - offset, 1));
    months.push({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 });
  }

  return months;
}

/** @returns {string} ISO date for a day inside one window month */
function monthDate(month, day) {
  return `${month.year}-${String(month.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Demand profile for one component.
 *
 * Dead positions are treated as spiky by construction: their issues stop in
 * early summer, so August–October is zero and the XYZ classifier sees a high
 * coefficient of variation regardless of the profile it would otherwise have.
 *
 * @param {{ stockCase: string }} component
 * @param {number} index catalogue position, used for a deterministic profile
 * @returns {{ kind: 'steady'|'seasonal'|'spiky'|'dead', months: number[] }}
 */
function profileForComponent(component, index) {
  if (component.stockCase === 'dead') {
    return { kind: 'dead', months: DEAD_MONTHS };
  }

  const kind = ['steady', 'seasonal', 'spiky'][index % 3];
  if (kind === 'spiky') {
    return { kind, months: SPIKY_MONTH_SETS[index % SPIKY_MONTH_SETS.length] };
  }

  return { kind, months: [0, 1, 2, 3, 4, 5] };
}

/**
 * Day of month for one issue. Live profiles spread days across 5–24; dead
 * profiles stay on 5–16 so the last issue in July is safely more than 120 days
 * before the reference date.
 */
function issueDay(componentIndex, pairIndex, monthIndex, dead) {
  if (dead) return 5 + ((componentIndex + pairIndex * 3 + monthIndex * 2) % 12);
  return 5 + ((componentIndex * 3 + pairIndex * 5 + monthIndex * 7) % 20);
}

/**
 * Monthly issue quantities for one warehouse of one component.
 *
 * Steady: the same quantity in all six months (CV 0, class X).
 * Seasonal: a fixed mild pattern (CV ~0.17, class Y for every lot size).
 * Spiky/dead: zero months and large issues elsewhere (class Z).
 *
 * @returns {Array<{ monthIndex: number, day: number, qty: number }>}
 */
function buildIssueSchedule({ component, componentIndex, pairIndex, profile }) {
  const lot = lotSize(component);
  const schedule = [];

  if (profile.kind === 'steady') {
    const qty = Math.max(1, Math.round(lot * 0.5));
    for (let monthIndex = 0; monthIndex < XYZ_MONTHS; monthIndex += 1) {
      schedule.push({
        monthIndex,
        day: issueDay(componentIndex, pairIndex, monthIndex, false),
        qty,
      });
    }
    return schedule;
  }

  if (profile.kind === 'seasonal') {
    // Starting at two units keeps the pattern visible after integer rounding;
    // with a base of one every month would round back to the same value.
    const base = Math.max(2, Math.round(lot * 0.6));
    for (let monthIndex = 0; monthIndex < XYZ_MONTHS; monthIndex += 1) {
      schedule.push({
        monthIndex,
        day: issueDay(componentIndex, pairIndex, monthIndex, false),
        qty: Math.max(1, Math.round(base * SEASONAL_FACTORS[monthIndex])),
      });
    }
    return schedule;
  }

  const dead = profile.kind === 'dead';
  const qty = dead ? Math.max(1, Math.round(lot * 0.5)) : Math.max(2, Math.round(lot * 1.8));

  for (const monthIndex of profile.months) {
    schedule.push({
      monthIndex,
      day: issueDay(componentIndex, pairIndex, monthIndex, dead),
      qty,
    });
  }

  return schedule;
}

/**
 * Spread the receipt budget across warehouses round-robin. The issue schedule
 * of each warehouse is fixed by the profile, so only receipts need sharing.
 * @returns {number[]}
 */
function distributeReceipts(count, pairCount) {
  const allocation = Array(pairCount).fill(0);
  for (let index = 0; index < count; index += 1) {
    allocation[index % pairCount] += 1;
  }
  return allocation;
}

/**
 * A live pair: an opening receipt in April (before the first XYZ month), the
 * profile's monthly issues from May to October, and receipts spread through the
 * window. The opening quantity already covers every planned issue plus the
 * final target, so no issue can overdraw. Excess received stock is consumed by
 * one steering issue on the reference date, which is outside the XYZ window and
 * therefore cannot distort the demand profile.
 */
function planLivePair({
  component,
  warehouseCode,
  schedule,
  receiptCount,
  months,
  openingDate,
  referenceDate,
  rng,
}) {
  const lot = lotSize(component);
  const documents = [];
  const totalIssues = schedule.reduce((sum, issue) => sum + issue.qty, 0);
  const target = targetBalance(component);

  let balance = totalIssues + target;
  documents.push(
    receiptDocument({
      component,
      warehouseCode,
      docDate: openingDate,
      qty: balance,
    }),
  );

  for (const issue of schedule) {
    documents.push(
      issueDocument({
        component,
        warehouseCode,
        docDate: monthDate(months[issue.monthIndex], issue.day),
        qty: issue.qty,
        rng,
      }),
    );
    balance -= issue.qty;
  }

  let received = 0;
  for (let index = 0; index < receiptCount; index += 1) {
    const qty = lot * randInt(rng, 1, 2);
    documents.push(
      receiptDocument({
        component,
        warehouseCode,
        docDate: addDays(referenceDate, -randInt(rng, 1, 200)),
        qty,
      }),
    );
    balance += qty;
    received += qty;
  }

  // One steering issue returns the balance to the case target. It is dated on
  // the reference day, so XYZ (May–October) never sees it.
  if (received > 0) {
    documents.push(
      issueDocument({
        component,
        warehouseCode,
        docDate: referenceDate,
        qty: received,
        rng,
      }),
    );
    balance -= received;
  }

  return documents;
}

/**
 * A dead pair: the profile issues everything in May–July, then only receipts
 * arrive. The opening quantity leaves at least five units untouched, so the
 * oldest remaining batch keeps the April `received_at` and the dead-stock alert
 * sees genuinely frozen capital. The receipt count is clamped so it can never
 * become negative even if a caller passes a tiny event budget.
 */
function planDeadPair({
  component,
  warehouseCode,
  schedule,
  eventCount,
  months,
  openingDate,
  referenceDate,
  rng,
}) {
  const lot = lotSize(component);
  const documents = [];
  const issueSchedule = schedule.slice(0, Math.max(1, eventCount - 1));
  const receiptCount = Math.max(0, eventCount - issueSchedule.length);

  let balance = issueSchedule.reduce((sum, issue) => sum + issue.qty, 0) + randInt(rng, 5, 12);
  documents.push(
    receiptDocument({
      component,
      warehouseCode,
      docDate: openingDate,
      qty: balance,
    }),
  );

  for (const issue of issueSchedule) {
    documents.push(
      issueDocument({
        component,
        warehouseCode,
        docDate: monthDate(months[issue.monthIndex], issue.day),
        qty: issue.qty,
        rng,
      }),
    );
    balance -= issue.qty;
  }

  // Receipts stay after the last dead issue and spread through July–November,
  // so the old opening batch remains the oldest positive batch.
  for (let index = 0; index < receiptCount; index += 1) {
    const qty = lot * randInt(rng, 1, 2);
    documents.push(
      receiptDocument({
        component,
        warehouseCode,
        docDate: addDays(referenceDate, -randInt(rng, 1, 118)),
        qty,
      }),
    );
    balance += qty;
  }

  return documents;
}

/**
 * Build the whole document plan before touching the database. A bug in the
 * generator then fails without leaving half a demo behind.
 * @param {string} referenceDate
 * @returns {Array<Record<string, unknown>>} chronological documents
 */
function buildHistoryPlan(referenceDate) {
  const rng = mulberry32(HISTORY_SEED);
  const documents = [];
  const months = xyzMonths(referenceDate);

  for (const [index, component] of components.entries()) {
    const warehouseCodes = warehousesForComponent(index);
    const profile = profileForComponent(component, index);
    const schedules = warehouseCodes.map((_warehouseCode, pairIndex) =>
      buildIssueSchedule({ component, componentIndex: index, pairIndex, profile }),
    );

    const requiredIssues = schedules.reduce((sum, schedule) => sum + schedule.length, 0);
    const eventCount = randInt(rng, Math.max(EVENTS_MIN, requiredIssues), EVENTS_MAX);
    const receiptAllocation = distributeReceipts(
      eventCount - requiredIssues,
      warehouseCodes.length,
    );
    const openingDate = addDays(
      monthDate(months[0], 1),
      -randInt(rng, OPENING_LEAD_DAYS_MIN, OPENING_LEAD_DAYS_MAX),
    );

    for (const [pairIndex, warehouseCode] of warehouseCodes.entries()) {
      const schedule = schedules[pairIndex];
      const shared = {
        component,
        warehouseCode,
        schedule,
        months,
        openingDate,
        referenceDate,
        rng,
      };

      if (profile.kind === 'dead') {
        // The dead planner owns the clamp: its event budget includes the
        // receipts allocated above and it always leaves room for at least one.
        documents.push(
          ...planDeadPair({
            ...shared,
            eventCount: schedule.length + receiptAllocation[pairIndex],
          }),
        );
      } else {
        documents.push(...planLivePair({ ...shared, receiptCount: receiptAllocation[pairIndex] }));
      }
    }
  }

  // Posting in calendar order keeps the document numbers increasing with time
  // and preserves each pair's internal order (Array#sort is stable).
  documents.sort((left, right) => left.docDate.localeCompare(right.docDate));
  return documents;
}

/**
 * Insert every demo row that is not a stock document and return id maps used by
 * the posting step. Runs in one transaction so reference data is all-or-nothing.
 * @param {import('pg').PoolClient} client
 * @param {string[]} passwordHashes one hash per `users` entry, same order
 */
async function insertReferenceData(client, passwordHashes) {
  const warehouseIds = new Map();
  for (const warehouse of warehouses) {
    const { rows } = await client.query(
      `insert into warehouses (code, name, city, address)
       values ($1, $2, $3, $4)
       returning id`,
      [warehouse.code, warehouse.name, warehouse.city, warehouse.address],
    );
    warehouseIds.set(warehouse.code, rows[0].id);
  }

  const categoryIds = new Map();
  for (const category of categories) {
    const { rows } = await client.query(
      `insert into categories (name, slug, description, sort_order)
       values ($1, $2, $3, $4)
       returning id`,
      [category.name, category.slug, category.description, category.sortOrder],
    );
    categoryIds.set(category.slug, rows[0].id);
  }

  const manufacturerIds = new Map();
  for (const manufacturer of manufacturers) {
    const { rows } = await client.query(
      'insert into manufacturers (name, country) values ($1, $2) returning id',
      [manufacturer.name, manufacturer.country],
    );
    manufacturerIds.set(manufacturer.name, rows[0].id);
  }

  const supplierIds = new Map();
  for (const supplier of suppliers) {
    const { rows } = await client.query(
      `insert into suppliers (name, unp, address, phone, email, lead_time_days)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [
        supplier.name,
        supplier.unp,
        supplier.address,
        supplier.phone,
        supplier.email,
        supplier.leadTimeDays,
      ],
    );
    supplierIds.set(supplier.name, rows[0].id);
  }

  const userIds = new Map();
  for (const [index, user] of users.entries()) {
    const { rows } = await client.query(
      `insert into users (email, password_hash, full_name, role, phone)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [user.email, passwordHashes[index], user.fullName, user.role, user.phone],
    );
    userIds.set(user.email, rows[0].id);
  }

  const componentIds = new Map();
  for (const component of components) {
    const { rows } = await client.query(
      `insert into components
         (sku, name, category_id, manufacturer_id, default_supplier_id, unit, specs,
          purchase_price, retail_price, min_stock, max_stock, lead_time_days)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
       returning id`,
      [
        component.sku,
        component.name,
        categoryIds.get(component.categorySlug),
        manufacturerIds.get(component.manufacturerName),
        supplierIds.get(component.supplierName),
        component.unit,
        JSON.stringify(component.specs),
        component.purchasePrice,
        component.retailPrice,
        component.minStock,
        component.maxStock,
        component.leadTimeDays,
      ],
    );
    componentIds.set(component.sku, rows[0].id);
  }

  return { warehouseIds, supplierIds, componentIds, userIds };
}

/**
 * Post the planned history through the stock services.
 * @param {Array<Record<string, unknown>>} documents
 * @param {{
 *   warehouseIds: Map<string, number>,
 *   supplierIds: Map<string, number>,
 *   componentIds: Map<string, number>,
 *   userId: number,
 * }} ids
 * @returns {Promise<{ receipts: number, issues: number, total: number }>}
 */
async function postHistory(documents, ids) {
  const documentDates = new Map();
  let receipts = 0;
  let issues = 0;

  for (const document of documents) {
    const warehouseId = ids.warehouseIds.get(document.warehouseCode);
    const componentId = ids.componentIds.get(document.sku);

    if (document.type === 'receipt') {
      const result = await postReceipt({
        supplierId: ids.supplierIds.get(document.supplierName),
        warehouseId,
        docDate: document.docDate,
        comment: 'Пополнение склада',
        lines: [{ componentId, qty: document.qty, unitCost: document.unitCost }],
        userId: ids.userId,
        req: SYSTEM_REQUEST,
      });
      documentDates.set(result.documentId, document.docDate);
      receipts += 1;
    } else {
      const result = await postIssue({
        warehouseId,
        docDate: document.docDate,
        reason: document.reason,
        lines: [{ componentId, qty: document.qty }],
        userId: ids.userId,
        req: SYSTEM_REQUEST,
      });
      documentDates.set(result.documentId, document.docDate);
      issues += 1;
    }
  }

  // The services intentionally do not expose the movement timestamps: an
  // operator's posting happened now. The demo needs the ledger to look like it
  // accumulated over six months, and every analytics/alert query windows on
  // `created_at`, so the timestamps are corrected in one bulk statement.
  const documentIds = [...documentDates.keys()];
  const documentDay = documentIds.map((id) => documentDates.get(id));
  await query(
    `update stock_movements m
     set created_at = (v.doc_date::date + time '12:00') at time zone 'Europe/Minsk'
     from (
       select unnest($1::int[]) as id, unnest($2::date[]) as doc_date
     ) v
     where m.document_id = v.id`,
    [documentIds, documentDay],
  );

  return { receipts, issues, total: receipts + issues };
}

/** @returns {Promise<Record<string, number>>} */
async function readCounts() {
  const { rows } = await query(
    `select
       (select count(*)::int from warehouses) as warehouses,
       (select count(*)::int from categories) as categories,
       (select count(*)::int from manufacturers) as manufacturers,
       (select count(*)::int from suppliers) as suppliers,
       (select count(*)::int from components) as components,
       (select count(*)::int from users) as users,
       (select count(*)::int from stock_documents) as stock_documents,
       (select count(*)::int from stock_movements) as stock_movements`,
  );
  return rows[0];
}

/** Remove every application row while keeping the schema and its migrations. */
async function truncateApplicationTables() {
  await query(`truncate ${APPLICATION_TABLES.join(', ')} restart identity cascade`);
}

/**
 * Seed the demo database.
 *
 * @param {{
 *   referenceDate?: string,
 *   force?: boolean,
 * }} [options]
 *   `referenceDate` is the last allowed document day and the analytics "today";
 *   defaults to `ANALYTICS_REFERENCE_DATE`, then to the current Minsk date.
 *   `force` truncates all application data before seeding.
 * @returns {Promise<{
 *   skipped: boolean,
 *   referenceDate: string,
 *   counts: Record<string, number>,
 *   documents?: { receipts: number, issues: number, total: number },
 *   alerts?: { created: number, resolved: number },
 * }>}
 */
export async function seed({ referenceDate, force = false } = {}) {
  const resolvedDate = referenceDate ?? env.analyticsReferenceDate ?? todayInMinsk();
  assertIsoDate(resolvedDate);

  if (force) {
    logger.info('force seed: truncating application tables');
    await truncateApplicationTables();
  } else {
    const { rows } = await query('select count(*)::int as count from components');
    if (rows[0].count > 0) {
      logger.info({ components: rows[0].count }, 'demo data already present, seed skipped');
      return { skipped: true, referenceDate: resolvedDate, counts: await readCounts() };
    }
  }

  // Hash before the insert transaction: Argon2 is deliberately slow and holding
  // a transaction open while hashing would block every other writer.
  const passwordHashes = await Promise.all(users.map((user) => hashPassword(user.password)));
  const plan = buildHistoryPlan(resolvedDate);

  const ids = await withTransaction((client) => insertReferenceData(client, passwordHashes));
  const adminId = ids.userIds.get(users.find((user) => user.role === 'admin').email);

  const documents = await postHistory(plan, { ...ids, userId: adminId });
  const alerts = await recalculate({ req: SYSTEM_REQUEST });
  const counts = await readCounts();

  logger.info({ referenceDate: resolvedDate, counts, documents, alerts }, 'demo data seeded');

  return { skipped: false, referenceDate: resolvedDate, counts, documents, alerts };
}

const isDirectRun =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  const force = process.argv.includes('--force');

  try {
    const result = await seed({ force });
    // A one-line human summary next to the structured log helps manual runs of
    // `npm run db:seed`; the logger remains the machine-readable channel.
    process.stdout.write(
      `seed: ${result.skipped ? 'skipped' : 'done'} — components ${result.counts.components}, users ${result.counts.users}\n`,
    );
  } catch (error) {
    logger.error({ err: error }, 'demo seed failed');
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

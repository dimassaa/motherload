import { pool } from '../db/pool.js';

/**
 * Alert persistence.
 *
 * Alerts are derived from the stock ledger and the catalogue: nothing here
 * stores a condition flag. The partial unique index `alerts_open_unique`
 * (`type, component_id, warehouse_id WHERE status <> 'resolved'`) is the
 * idempotency boundary, so recalculation can run as often as needed without
 * turning one shortage into a stream of duplicates.
 */

// Wall-clock comparisons use the same fixed business zone as analytics. The
// database session timezone is not trusted for calendar-day boundaries.
const DISPLAY_ZONE = 'Europe/Minsk';

const ALERT_COLUMNS = `
  a.id,
  a.type,
  a.severity,
  a.status,
  a.message,
  a.created_at,
  a.acknowledged_at,
  a.resolved_at,
  a.component_id,
  a.warehouse_id,
  c.sku,
  c.name as component_name,
  c.unit,
  w.name as warehouse_name,
  u.full_name as acknowledged_by_name
`;

/**
 * Active component/warehouse pairs that take part in alerting.
 *
 * A pair participates when it holds stock or moved on or after `activityStart`.
 * The warehouse cross join in `v_component_warehouse_stock` means a position
 * that was never stored in Gomel would otherwise look like a permanent
 * stockout; this filter is what keeps empty regional warehouses quiet.
 *
 * `last_issue_date` is the newest consumption day, not the newest movement: a
 * transfer or an inventory correction is not demand and must not hide a dead
 * position.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ activityStart: string }} filters inclusive lower bound (`YYYY-MM-DD`)
 * @returns {Promise<Array<{
 *   componentId: number, sku: string, name: string, unit: string,
 *   balance: number, minStock: number, maxStock: number | null,
 *   warehouseId: number, warehouseName: string,
 *   lastIssueDate: string | null
 * }>>}
 */
export async function listCandidatePairs(client, { activityStart }) {
  const { rows } = await client.query(
    `select
       vw.component_id,
       c.sku,
       c.name,
       c.unit,
       vw.qty as balance,
       vw.min_stock,
       vw.max_stock,
       vw.warehouse_id,
       w.name as warehouse_name,
       last_issue.last_issue_date
     from v_component_warehouse_stock vw
     join components c on c.id = vw.component_id
     join warehouses w on w.id = vw.warehouse_id
     left join lateral (
       select (max(m.created_at) at time zone '${DISPLAY_ZONE}')::date as last_issue_date
       from stock_movements m
       join stock_documents d on d.id = m.document_id
       where m.component_id = vw.component_id
         and m.warehouse_id = vw.warehouse_id
         and d.type = 'issue'
         and m.qty_delta < 0
     ) last_issue on true
     where c.is_active
       and (
         vw.qty > 0
         or exists (
           select 1
           from stock_movements m
           where m.component_id = vw.component_id
             and m.warehouse_id = vw.warehouse_id
             and m.created_at >= ($1::date::timestamp at time zone '${DISPLAY_ZONE}')
         )
       )
     order by c.name, c.id, w.name, w.id`,
    [activityStart],
  );

  return rows.map((row) => ({
    componentId: row.component_id,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    balance: row.balance,
    minStock: row.min_stock,
    maxStock: row.max_stock,
    warehouseId: row.warehouse_id,
    warehouseName: row.warehouse_name,
    lastIssueDate: row.last_issue_date ?? null,
  }));
}

function mapAlert(row) {
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    status: row.status,
    message: row.message,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
    componentId: row.component_id,
    warehouseId: row.warehouse_id,
    sku: row.sku,
    componentName: row.component_name,
    unit: row.unit,
    warehouseName: row.warehouse_name,
    acknowledgedByName: row.acknowledged_by_name ?? null,
  };
}

/**
 * Build the WHERE clause for the list filters.
 *
 * `status = 'active'` is the actionable default: it hides resolved history but
 * keeps acknowledged alerts visible, because acknowledging does not fix stock.
 * Only fixed fragments are concatenated; every value stays a parameter.
 */
function buildFilterClause({ type, status, warehouseId }) {
  const conditions = [];
  const values = [];

  if (type) {
    values.push(type);
    conditions.push(`a.type = $${values.length}`);
  }
  if (status && status !== 'all') {
    if (status === 'active') {
      conditions.push(`a.status <> 'resolved'`);
    } else {
      values.push(status);
      conditions.push(`a.status = $${values.length}`);
    }
  }
  if (warehouseId) {
    values.push(warehouseId);
    conditions.push(`a.warehouse_id = $${values.length}`);
  }

  return {
    where: conditions.length > 0 ? `where ${conditions.join(' and ')}` : '',
    values,
  };
}

/**
 * Alerts for the `/alerts` page, most urgent first.
 *
 * Severity ordering is explicit so a critical stockout cannot disappear below
 * an informational overstock merely because it is older. Within a severity the
 * newest alert comes first: a condition that just appeared is the one the
 * operator has not seen.
 *
 * @param {{ type?: string | null, status?: string, warehouseId?: number | null }} filters
 * @returns {Promise<Array<ReturnType<typeof mapAlert>>>}
 */
export async function listAlerts({ type = null, status = 'active', warehouseId = null } = {}) {
  const { where, values } = buildFilterClause({ type, status, warehouseId });
  const { rows } = await pool.query(
    `select ${ALERT_COLUMNS}
     from alerts a
     join components c on c.id = a.component_id
     join warehouses w on w.id = a.warehouse_id
     left join users u on u.id = a.acknowledged_by
     ${where}
     order by
       case a.severity
         when 'critical' then 0
         when 'warning' then 1
         else 2
       end,
       a.created_at desc,
       a.id desc`,
    values,
  );

  return rows.map(mapAlert);
}

/**
 * Count every unresolved alert. Acknowledged alerts still need action, so they
 * are included in the badge and in the `active` list.
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @returns {Promise<number>}
 */
export async function countOpenAlerts(client = pool) {
  const { rows } = await client.query(
    `select count(*)::integer as count from alerts where status <> 'resolved'`,
  );
  return rows[0].count;
}

/**
 * Unresolved alerts locked for the recalculation transaction.
 *
 * Locking the existing set serialises two concurrent recalculations: the second
 * one sees the first one's inserts and resolves only genuinely stale rows.
 * @param {import('pg').PoolClient} client
 * @returns {Promise<Array<{
 *   id: number, type: string, severity: string, status: string,
 *   componentId: number, warehouseId: number, message: string
 * }>>}
 */
export async function listActiveAlerts(client) {
  const { rows } = await client.query(
    `select id, type, severity, status, component_id, warehouse_id, message
     from alerts
     where status <> 'resolved'
     order by id
     for update`,
  );

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    severity: row.severity,
    status: row.status,
    componentId: row.component_id,
    warehouseId: row.warehouse_id,
    message: row.message,
  }));
}

/**
 * Insert one open alert unless an unresolved alert with the same condition
 * already exists. `ON CONFLICT DO NOTHING` makes the insert idempotent even if
 * another process inserted the same row after this transaction took its
 * snapshot.
 *
 * @param {import('pg').PoolClient} client
 * @param {{
 *   type: string, severity: string, componentId: number,
 *   warehouseId: number, message: string
 * }} alert
 * @returns {Promise<number | null>} new id, or null when the alert already exists
 */
export async function insertOpenAlert(
  client,
  { type, severity, componentId, warehouseId, message },
) {
  const { rows } = await client.query(
    `insert into alerts (type, severity, component_id, warehouse_id, message)
     values ($1, $2, $3, $4, $5)
     on conflict (type, component_id, warehouse_id) where status <> 'resolved' do nothing
     returning id`,
    [type, severity, componentId, warehouseId, message],
  );

  return rows[0]?.id ?? null;
}

/**
 * Refresh the explanation and severity of an existing unresolved alert.
 *
 * Balance and thresholds change while the condition stays true, so the stored
 * message must follow the numbers. Status is deliberately untouched: a manual
 * acknowledgement survives recalculation.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ id: number, severity: string, message: string }} alert
 */
export async function updateAlertContent(client, { id, severity, message }) {
  await client.query(
    `update alerts
     set severity = $2, message = $3
     where id = $1 and status <> 'resolved'`,
    [id, severity, message],
  );
}

/** @param {import('pg').PoolClient} client @param {number} alertId */
export async function resolveAlert(client, alertId) {
  const { rowCount } = await client.query(
    `update alerts
     set status = 'resolved', resolved_at = now()
     where id = $1 and status <> 'resolved'`,
    [alertId],
  );

  return rowCount === 1;
}

/**
 * Load one alert for a state change. Pass `forUpdate` before deciding what the
 * new status may be, so two operators cannot acknowledge and resolve the same
 * row out of order.
 * @param {import('pg').PoolClient} client
 * @param {number} alertId
 * @param {{ forUpdate?: boolean }} [options]
 * @returns {Promise<{
 *   id: number, type: string, severity: string, status: string,
 *   componentId: number, warehouseId: number, message: string
 * } | null>}
 */
export async function findAlertById(client, alertId, { forUpdate = false } = {}) {
  const { rows } = await client.query(
    `select id, type, severity, status, component_id, warehouse_id, message
     from alerts
     where id = $1
     ${forUpdate ? 'for update' : ''}`,
    [alertId],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    status: row.status,
    componentId: row.component_id,
    warehouseId: row.warehouse_id,
    message: row.message,
  };
}

/**
 * Move an open alert to `acknowledged`.
 * @param {import('pg').PoolClient} client
 * @param {{ alertId: number, userId: number }} input
 * @returns {Promise<boolean>}
 */
export async function acknowledgeAlert(client, { alertId, userId }) {
  const { rowCount } = await client.query(
    `update alerts
     set status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now()
     where id = $1 and status = 'open'`,
    [alertId, userId],
  );

  return rowCount === 1;
}

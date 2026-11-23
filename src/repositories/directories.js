import { pool } from '../db/pool.js';

/**
 * SQL for the four reference directories.
 *
 * The table and column names are fixed strings from `DIRECTORY_DEFINITIONS`,
 * never request data, so building the statement text is safe: every value is
 * still passed as a parameter. Keeping one definition per entity prevents the
 * four CRUD paths from drifting apart.
 */
const DIRECTORY_DEFINITIONS = {
  categories: {
    table: 'categories',
    orderBy: 'sort_order, name, id',
    columns: {
      name: 'name',
      slug: 'slug',
      description: 'description',
      sortOrder: 'sort_order',
    },
  },
  manufacturers: {
    table: 'manufacturers',
    orderBy: 'name, id',
    columns: {
      name: 'name',
      country: 'country',
    },
  },
  suppliers: {
    table: 'suppliers',
    orderBy: 'name, id',
    columns: {
      name: 'name',
      unp: 'unp',
      contactPerson: 'contact_person',
      phone: 'phone',
      email: 'email',
      address: 'address',
      leadTimeDays: 'lead_time_days',
      isActive: 'is_active',
    },
  },
  warehouses: {
    table: 'warehouses',
    orderBy: 'name, id',
    columns: {
      code: 'code',
      name: 'name',
      city: 'city',
      address: 'address',
      isActive: 'is_active',
    },
  },
};

function db(client) {
  return client ?? pool;
}

function definition(entity) {
  const found = DIRECTORY_DEFINITIONS[entity];
  if (!found) throw new TypeError(`Unknown directory entity: ${entity}`);
  return found;
}

function selectColumns(def) {
  return ['id', ...Object.values(def.columns)].join(', ');
}

function mapRow(def, row) {
  if (!row) return null;

  const record = { id: row.id };
  for (const [property, column] of Object.entries(def.columns)) {
    record[property] = row[column];
  }
  return record;
}

/**
 * Every row of one directory in display order.
 * @param {string} entity one of `categories | manufacturers | suppliers | warehouses`
 * @param {import('pg').PoolClient | null} [client]
 */
export async function list(entity, client = null) {
  const def = definition(entity);
  const { rows } = await db(client).query(
    `select ${selectColumns(def)} from ${def.table} order by ${def.orderBy}`,
  );
  return rows.map((row) => mapRow(def, row));
}

/**
 * Find one row, optionally locking it for the surrounding transaction.
 * @param {string} entity
 * @param {number} id
 * @param {{ forUpdate?: boolean, client?: import('pg').PoolClient | null }} [options]
 */
export async function findById(entity, id, { forUpdate = false, client = null } = {}) {
  const def = definition(entity);
  const { rows } = await db(client).query(
    `select ${selectColumns(def)} from ${def.table} where id = $1${forUpdate ? ' for update' : ''}`,
    [id],
  );
  return mapRow(def, rows[0]);
}

/**
 * Insert a directory row. Every schema field is always present after Zod has
 * parsed the form, so the column list is fixed and the parameter order cannot
 * drift from the values.
 * @param {string} entity
 * @param {Record<string, unknown>} values
 * @param {import('pg').PoolClient | null} [client]
 */
export async function insert(entity, values, client = null) {
  const def = definition(entity);
  const properties = Object.keys(def.columns);
  const columns = properties.map((property) => def.columns[property]);
  const placeholders = columns.map((_, index) => `$${index + 1}`);

  const { rows } = await db(client).query(
    `insert into ${def.table} (${columns.join(', ')})
     values (${placeholders.join(', ')})
     returning ${selectColumns(def)}`,
    properties.map((property) => values[property] ?? null),
  );
  return mapRow(def, rows[0]);
}

/**
 * Replace every editable field of one row.
 * @param {string} entity
 * @param {number} id
 * @param {Record<string, unknown>} values
 * @param {import('pg').PoolClient | null} [client]
 */
export async function update(entity, id, values, client = null) {
  const def = definition(entity);
  const properties = Object.keys(def.columns);
  const assignments = properties.map(
    (property, index) => `${def.columns[property]} = $${index + 1}`,
  );

  const { rows } = await db(client).query(
    `update ${def.table}
     set ${assignments.join(', ')}
     where id = $${properties.length + 1}
     returning ${selectColumns(def)}`,
    [...properties.map((property) => values[property] ?? null), id],
  );
  return mapRow(def, rows[0]);
}

/**
 * Delete one row and return it so the service can audit what was removed.
 * A foreign-key reference raises PostgreSQL error 23503; the service turns it
 * into a readable conflict instead of letting it reach the error page raw.
 * @param {string} entity
 * @param {number} id
 * @param {import('pg').PoolClient | null} [client]
 */
export async function remove(entity, id, client = null) {
  const def = definition(entity);
  const { rows } = await db(client).query(
    `delete from ${def.table} where id = $1 returning ${selectColumns(def)}`,
    [id],
  );
  return mapRow(def, rows[0]);
}

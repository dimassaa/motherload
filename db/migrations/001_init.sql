-- Initial schema for the Motherload warehouse terminal.
--
-- Balances are never stored as a column: stock_movements is the ledger and
-- stock_batches is the FIFO/cost source. The views at the end of the file are
-- the read models every repository queries.
--
-- schema_migrations is intentionally absent here: src/db/migrate.js creates and
-- owns it before running any migration file (it uses a `name` column today).

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE user_role AS ENUM ('admin', 'storekeeper', 'analyst');
CREATE TYPE stock_doc_type AS ENUM ('receipt', 'issue', 'transfer');
CREATE TYPE issue_reason AS ENUM ('sale', 'defect', 'supplier_return', 'internal', 'other');
CREATE TYPE inventory_status AS ENUM ('draft', 'submitted', 'approved', 'cancelled');
CREATE TYPE alert_type AS ENUM ('stockout', 'low_stock', 'overstock', 'dead_stock');
CREATE TYPE alert_status AS ENUM ('open', 'acknowledged', 'resolved');
CREATE TYPE alert_severity AS ENUM ('critical', 'warning', 'info');

-- connect-pg-simple expects exactly these three columns.
CREATE TABLE sessions (
  sid text PRIMARY KEY,
  sess json NOT NULL,
  expire timestamptz NOT NULL
);

CREATE INDEX sessions_expire_idx ON sessions (expire);

CREATE TABLE users (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  role user_role NOT NULL,
  phone text,
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE warehouses (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  city text NOT NULL,
  address text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE categories (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  slug text NOT NULL UNIQUE,
  description text,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE manufacturers (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  country text
);

CREATE TABLE suppliers (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  -- char(9) pads shorter values with spaces, so the regex also keeps the value
  -- compact and rejects letters instead of relying on length alone.
  unp char(9) NOT NULL UNIQUE CHECK (unp ~ '^[0-9]{9}$'),
  contact_person text,
  phone text,
  email citext,
  address text,
  lead_time_days integer NOT NULL CHECK (lead_time_days > 0),
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE components (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  category_id integer REFERENCES categories (id) ON DELETE RESTRICT,
  manufacturer_id integer REFERENCES manufacturers (id) ON DELETE RESTRICT,
  default_supplier_id integer REFERENCES suppliers (id) ON DELETE RESTRICT,
  unit text NOT NULL DEFAULT 'шт',
  specs jsonb NOT NULL DEFAULT '{}',
  purchase_price numeric(12,2) NOT NULL CHECK (purchase_price >= 0),
  retail_price numeric(12,2) NOT NULL CHECK (retail_price >= 0),
  min_stock integer NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  max_stock integer CHECK (max_stock IS NULL OR max_stock >= min_stock),
  lead_time_days integer CHECK (lead_time_days IS NULL OR lead_time_days > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stock_documents (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type stock_doc_type NOT NULL,
  number text NOT NULL,
  doc_date date NOT NULL,
  supplier_id integer REFERENCES suppliers (id) ON DELETE RESTRICT,
  warehouse_id integer REFERENCES warehouses (id) ON DELETE RESTRICT,
  from_warehouse_id integer REFERENCES warehouses (id) ON DELETE RESTRICT,
  to_warehouse_id integer REFERENCES warehouses (id) ON DELETE RESTRICT,
  reason issue_reason,
  comment text,
  total_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  created_by integer REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type, number),
  CONSTRAINT stock_documents_receipt_fields CHECK (
    type <> 'receipt' OR (warehouse_id IS NOT NULL AND supplier_id IS NOT NULL)
  ),
  CONSTRAINT stock_documents_issue_fields CHECK (
    type <> 'issue' OR (warehouse_id IS NOT NULL AND reason IS NOT NULL)
  ),
  CONSTRAINT stock_documents_transfer_fields CHECK (
    type <> 'transfer'
      OR (
        from_warehouse_id IS NOT NULL
        AND to_warehouse_id IS NOT NULL
        AND from_warehouse_id <> to_warehouse_id
      )
  )
);

CREATE TABLE stock_document_lines (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id integer NOT NULL REFERENCES stock_documents (id) ON DELETE CASCADE,
  component_id integer NOT NULL REFERENCES components (id) ON DELETE RESTRICT,
  qty integer NOT NULL CHECK (qty > 0),
  unit_cost numeric(14,4) CHECK (unit_cost >= 0),
  total_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  comment text
);

CREATE TABLE stock_batches (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  component_id integer NOT NULL REFERENCES components (id) ON DELETE RESTRICT,
  warehouse_id integer NOT NULL REFERENCES warehouses (id) ON DELETE RESTRICT,
  supplier_id integer REFERENCES suppliers (id) ON DELETE RESTRICT,
  unit_cost numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  qty_received integer NOT NULL CHECK (qty_received > 0),
  qty_remaining integer NOT NULL CHECK (qty_remaining >= 0 AND qty_remaining <= qty_received),
  received_at date NOT NULL,
  document_no text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE batch_consumptions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  line_id integer NOT NULL REFERENCES stock_document_lines (id) ON DELETE CASCADE,
  batch_id integer NOT NULL REFERENCES stock_batches (id) ON DELETE RESTRICT,
  qty integer NOT NULL CHECK (qty > 0),
  unit_cost numeric(14,4) NOT NULL CHECK (unit_cost >= 0)
);

CREATE TABLE stock_movements (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  component_id integer NOT NULL REFERENCES components (id) ON DELETE RESTRICT,
  warehouse_id integer NOT NULL REFERENCES warehouses (id) ON DELETE RESTRICT,
  qty_delta integer NOT NULL CHECK (qty_delta <> 0),
  unit_cost numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  document_id integer REFERENCES stock_documents (id) ON DELETE RESTRICT,
  line_id integer REFERENCES stock_document_lines (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_counts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  warehouse_id integer NOT NULL REFERENCES warehouses (id) ON DELETE RESTRICT,
  status inventory_status NOT NULL DEFAULT 'draft',
  started_by integer REFERENCES users (id) ON DELETE RESTRICT,
  submitted_at timestamptz,
  approved_by integer REFERENCES users (id) ON DELETE RESTRICT,
  approved_at timestamptz,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_lines (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  count_id integer NOT NULL REFERENCES inventory_counts (id) ON DELETE CASCADE,
  component_id integer NOT NULL REFERENCES components (id) ON DELETE RESTRICT,
  expected_qty integer NOT NULL CHECK (expected_qty >= 0),
  actual_qty integer CHECK (actual_qty >= 0),
  difference integer,
  unit_cost numeric(14,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  comment text,
  UNIQUE (count_id, component_id),
  -- An empty actual_qty means "not entered" and must stay NULL, never 0.
  -- A recorded difference is always derived, but may be left NULL while the
  -- count is still being filled in.
  CONSTRAINT inventory_lines_difference_matches CHECK (
    (actual_qty IS NULL AND difference IS NULL)
      OR (
        actual_qty IS NOT NULL
        AND (difference IS NULL OR difference = actual_qty - expected_qty)
      )
  )
);

CREATE TABLE alerts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type alert_type NOT NULL,
  severity alert_severity NOT NULL,
  component_id integer NOT NULL REFERENCES components (id) ON DELETE RESTRICT,
  warehouse_id integer NOT NULL REFERENCES warehouses (id) ON DELETE RESTRICT,
  message text NOT NULL,
  status alert_status NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by integer REFERENCES users (id) ON DELETE RESTRICT,
  acknowledged_at timestamptz,
  resolved_at timestamptz
);

CREATE TABLE audit_log (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer REFERENCES users (id) ON DELETE RESTRICT,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}',
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_sequences (
  type stock_doc_type NOT NULL,
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 2999),
  last_value integer NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  PRIMARY KEY (type, year)
);

-- Query-path indexes: balances, FIFO, alerts, audit, inventory.
CREATE INDEX components_category_id_idx ON components (category_id);
CREATE INDEX components_is_active_idx ON components (is_active);
CREATE INDEX components_name_idx ON components (name);

CREATE INDEX stock_batches_fifo_idx
  ON stock_batches (component_id, warehouse_id, received_at, id)
  WHERE qty_remaining > 0;

CREATE INDEX stock_document_lines_document_id_idx ON stock_document_lines (document_id);
CREATE INDEX batch_consumptions_batch_id_idx ON batch_consumptions (batch_id);

CREATE INDEX stock_movements_balance_idx
  ON stock_movements (component_id, warehouse_id, created_at DESC);
CREATE INDEX stock_movements_warehouse_created_idx ON stock_movements (warehouse_id, created_at DESC);
CREATE INDEX stock_movements_document_id_idx ON stock_movements (document_id);
CREATE INDEX stock_movements_line_id_idx ON stock_movements (line_id);

CREATE INDEX inventory_counts_warehouse_status_idx ON inventory_counts (warehouse_id, status);
-- A warehouse can be frozen by at most one live inventory count at a time.
CREATE UNIQUE INDEX inventory_counts_active_warehouse
  ON inventory_counts (warehouse_id)
  WHERE status IN ('draft', 'submitted');

CREATE INDEX alerts_status_type_idx ON alerts (status, type);
CREATE INDEX alerts_component_id_idx ON alerts (component_id);
-- Alert recalculation is idempotent: one unresolved alert per condition.
CREATE UNIQUE INDEX alerts_open_unique
  ON alerts (type, component_id, warehouse_id)
  WHERE status <> 'resolved';

CREATE INDEX audit_log_created_at_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_user_id_idx ON audit_log (user_id);

-- Read models.
--
-- v_stock_balances: the authoritative quantity per component and warehouse from
-- the movement ledger.
CREATE VIEW v_stock_balances AS
SELECT
  component_id,
  warehouse_id,
  sum(qty_delta)::integer AS qty
FROM stock_movements
GROUP BY component_id, warehouse_id;

-- v_stock_values: remaining batch quantity, FIFO stock value and the weighted
-- average cost. When nothing remains, the last received batch price is used so
-- the caller still has a cost for replenishment calculations.
CREATE VIEW v_stock_values AS
SELECT
  component_id,
  warehouse_id,
  sum(qty_remaining)::integer AS qty,
  coalesce(round(sum(qty_remaining * unit_cost), 4), 0)::numeric(16,4) AS value,
  CASE
    WHEN sum(qty_remaining) > 0
      THEN round(sum(qty_remaining * unit_cost) / sum(qty_remaining), 4)::numeric(14,4)
    ELSE (array_agg(unit_cost ORDER BY received_at DESC, id DESC))[1]
  END AS avg_cost
FROM stock_batches
GROUP BY component_id, warehouse_id;

-- v_component_warehouse_stock: every component/warehouse pair with its balance
-- and value, plus the per-warehouse thresholds used for status and alerts.
-- The cross join keeps pairs with no history visible so callers can filter them
-- out explicitly instead of silently losing rows through an inner join.
CREATE VIEW v_component_warehouse_stock AS
SELECT
  c.id AS component_id,
  w.id AS warehouse_id,
  coalesce(b.qty, 0)::integer AS qty,
  coalesce(v.value, 0)::numeric(16,4) AS value,
  v.avg_cost,
  c.min_stock,
  c.max_stock
FROM components c
CROSS JOIN warehouses w
LEFT JOIN v_stock_balances b ON b.component_id = c.id AND b.warehouse_id = w.id
LEFT JOIN v_stock_values v ON v.component_id = c.id AND v.warehouse_id = w.id;

-- v_component_stock: catalog totals across warehouses. Derived from the
-- per-warehouse view so both read models always agree.
CREATE VIEW v_component_stock AS
SELECT
  component_id,
  sum(qty)::integer AS qty,
  sum(value)::numeric(16,4) AS value
FROM v_component_warehouse_stock
GROUP BY component_id;

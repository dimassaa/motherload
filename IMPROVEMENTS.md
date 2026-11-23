# Improvements backlog — Motherload

Open, verified items only. Resolved findings are removed; version control and the
task reports keep their history. Each item states the impact and why it was not
fixed in the stage that found it.

## Spec gap

### 2026-11-23, Task 24 — public SEO metadata is missing

Spec §11 and acceptance criterion 13 require `description`, `canonical`, Open
Graph and Twitter tags and JSON-LD `SoftwareApplication` on the public landing,
plus `robots.txt` and `sitemap.xml` served by the application and a committed
`public/img/og-cover.png` (1200×630). The current `head.ejs` emits only the
title, favicon and `noindex` for private pages; `scripts/build-og.js` waits for
an `og-cover.svg` that was never committed. This is not cosmetic: it is an unmet
acceptance criterion and must be scheduled before submission.

## Interface

### 2026-11-23, Task 24 — 400/403/404/500 pages do not use the app layout

`src/middleware/errors.js` still answers browsers with a minimal bootstrap HTML
page (title, `h1`, one paragraph) instead of the shared header, footer and error
styling from §5.19. Status codes and Russian messages are correct, and API
callers get JSON, so the functional contract holds; only the presentation is
unfinished. Replacing the bootstrap response with a rendered view is a small,
self-contained change.

### 2026-11-23, Task 24 — `GET /login` returns 404

Only `POST /login` is routed. A user who types the address or follows an old
bookmark sees «Страница не найдена» even though the same form is on `/`. Adding
a redirect to `/` (or rendering the landing) removes a confusing dead end.

### 2026-11-23, Task 20 — the alert list has no pagination

`/alerts` renders every row matching the filters. At most one open row exists per
condition, so the open view stays small, but `status=all` grows with every
resolved history row. Add pagination or a date window when browsing resolved
history becomes a real task.

### 2026-11-23, Task 18 — catalog and XYZ use different six-month windows

The component card chart includes the reference month (June–November for
22.11.2026), while XYZ deliberately uses only full months (May–October). Both
windows are defensible, but the screens do not explain the difference. Align the
labels or reuse one window helper before the two figures are shown side by side.

### 2026-11-23, Task 19 — a catalog row below ROP can look healthy by totals

The catalog row shows the summed balance and summed ROP, while `below_rop`
matches as soon as one warehouse pair is below its own point. A component with a
large central stock and one weak regional warehouse is therefore listed with a
healthy-looking total. The reorder page is the authoritative per-warehouse view;
a later catalog pass could add a «N складов ниже ROP» hint to the status cell.

### 2026-11-23, Task 24 — a local shortage can read «В норме» in the catalog

The aggregate `below_min` rule compares the total balance with the sum of the
participating warehouses' `min_stock`. That deliberately stops an empty Minsk
warehouse from hiding four units in Gomel, but it also means a component with an
empty active warehouse and enough stock elsewhere shows «В норме» in the
all-warehouse list. The per-warehouse row and the reorder page still expose the
local shortage. A later catalog pass could show a «N складов ниже минимума» hint
next to the aggregate status, as with the ROP note above.

### 2026-11-23, Task 16 — the inventory list caps at 200 rows

`/inventory` loads the 200 newest counts and has no pagination. That is enough
for the demo dataset, but a long-lived database would hide older counts; direct
links by id and the audit log still reach them. Add pagination or a year/status
filter when inventory history becomes a working screen.

### 2026-11-23, Task 16 — the inventory number is derived, not persisted

`inventory_counts` has no document-number column, so the UI and the CSV export
derive `ИНВ-<year>-<id>` from `created_at` and the primary key. The label is
stable for a given row, but it is not reserved through `document_sequences`, does
not appear in audit details, and would have to be recomputed by any other export.
If the number ever needs to be immutable or quoted externally, persist it in a
new migration.

### 2026-11-23, Task 14 — the type-ahead lacks `aria-activedescendant`

The component combobox supports `role="combobox"`/`listbox` and keyboard
navigation but does not announce the active option to screen readers while the
arrow keys move through suggestions. The native `<select>` remains as the
no-JavaScript fallback before the module runs. The refinement costs a small JS
change and a keyboard test.

## Accounting and data

### 2026-11-23, Task 20 — `dead_stock` uses stock age, KPI `deadValue` does not

`dead_stock` fires only when the pair has stock, no issue in 90 days, and the
oldest relevant receipt is at least 90 days old. The dashboard KPI `deadValue`
follows the literal §6.7 formula and counts every component with no issue in 90
days, including stock received yesterday. The two surfaces therefore disagree
for brand-new stock. Aligning them changes a KPI definition fixed by the spec,
so it is a product decision rather than a local fix.

### 2026-11-23, Task 12 — document totals are 2dp, consumption valuations are 4dp

`stock_documents.total_cost` and `stock_document_lines.total_cost` are
`numeric(14,2)`, while `batch_consumptions.unit_cost`, `stock_movements.unit_cost`
and FIFO allocation totals keep four decimals. A cost report can differ by up to
a kopeck depending on whether it sums documents or consumption rows. Any future
cost report must pick one source deliberately and state it; never mix both in one
reconciliation.

### 2026-11-23, Task 19 — negative ledger balances are clamped in analytics

`calculateReorder` rejects negative balances, but read-only analytics can meet
one from a legacy fixture or a manually edited ledger, so the service clamps it
to zero instead of failing the page. The alert pass does report a negative
balance as a stockout, which is the operational signal; the catalog still hides
the integrity problem. The issue document remains the only writer that must
prevent negative balances.

### 2026-11-23, Task 23 — a failed demo seed leaves partial data behind

Reference rows are inserted in one transaction and each stock document posts in
its own transaction, so the whole seed is not atomic. If a document posting fails
midway, `components` is already populated and the next `npm run db:seed` skips
the database as "already seeded"; the operator must run `npm run db:reset`. A
marker table or a single service-level transaction would make the seed
resumable. Docker startup is protected in practice by `set -e`: a failed seed
stops the container rather than serving a half-empty demo.

## Architecture and performance

### 2026-11-23, Task 21 — the reference-date helper is copied in four services

`analytics.js`, `catalog.js`, `alerts.js` and `reports.js` each repeat the
`ANALYTICS_REFERENCE_DATE` / Europe/Minsk "today" logic. They must agree or
different screens can describe different months. Extract one shared clock module
(`referenceDate()` and `todayInMinsk()`) in a dedicated refactor before the final
analytics pass.

### 2026-11-23, Task 18 — monthly issue aggregation SQL is duplicated

`components-read.js:listMonthlyConsumption` and
`analytics.js:listMonthlyIssues` select issue quantity per month with the same
document join and Europe/Minsk month bucket. Their filters and consumers differ,
so both remain. Extract one query when a third caller needs the same aggregation.

### 2026-11-23, Task 19 — the catalog recomputes ROP on every page load

`catalog.list` runs the full pair calculation (two analytics queries plus the
domain pass) even for the default name-sorted list. With the demo catalogue this
is milliseconds; a much larger catalogue should compute ROP once per request,
cache it briefly, or move the below-ROP filter into SQL with a materialised
planning view. Deferred until a real dataset shows the cost.

### 2026-11-23, Task 19 — the aggregate low-data flag is conservative

In all-warehouse mode a component is flagged «мало данных» as soon as one
participating pair has fewer than 14 days of consumption, because that pair's ROP
comes from the `min_stock` fallback and is still summed into the row. The
per-warehouse disclosure explains which pair is short, but a future iteration
could expose a distinct "частично" state or exclude the fallback pair from the
aggregate ROP while keeping its suggested quantity.

### 2026-11-23, Task 21 — CSV exports are built fully in memory

Every report loads all matching rows and materialises one string before sending
it. That is fine for the demo dataset and keeps `toCsv` a pure function, but a
multi-year audit export has no date filter and grows linearly. If production
volumes appear, add a date window to the audit card and stream rows into the
response.

## Operations and security

### 2026-11-23, Task 24 — Docker backups need host-side tooling

The runtime image intentionally has no PostgreSQL client tools, so `npm run
backup` inside the app container cannot run, and `backups/` is not a volume, so
`/admin/backups` lists nothing in a Compose deployment. The documented Docker
path uses `docker compose exec -T db pg_dump` on the host; mounting `./backups`
into the app container would make the page useful again. Decide whether to add
the client tools (larger image) or keep backups host-owned.

### 2026-11-23, Task 24 — the Compose v2 one-command path is unverified

Owner: pre-submission verification on a machine with the Docker Compose v2
plugin. This environment had the Docker daemon but no plugin, so `docker compose
up --build` was never executed; the YAML was parsed, and the image, entrypoint,
migrations, seed and healthcheck passed an equivalent manual two-container run.
Impact: the documented primary deployment command is still unproven as written
until that run is repeated and recorded.

### 2026-11-23, Task 22 — the connection string is a `pg_dump` argv element

`scripts/backup.js` and `scripts/restore.js` pass `--dbname=<DATABASE_URL>`, so a
local user who can list processes sees the database password while the tool runs.
The scripts never print the URL themselves. For a multi-user production host,
split the URL into host/port/user/db arguments and supply the password through
`PGPASSWORD` or a `.pgpass` file.

### 2026-11-23, Task 22 — audit redaction happens on read, not on write

The audit screen replaces values under password/hash/token/secret keys before
rendering, so an accidental secret cannot leak through the UI, but the value
still lands in `audit_log.details` and has no retention job. Move the same
redaction into `auditService.record` when audit retention is implemented; doing
it now would silently rewrite the contract every mutation relies on.

### 2026-11-23, Task 24 — the `sharp` dev advisory remains open

`npm audit` reports one high-severity advisory in the `sharp` devDependency
(`<=0.35.5-rc.1`); `npm audit --omit=dev` is clean. `sharp` is used only by
`scripts/build-og.js` and is pruned from the runtime image. The fix is a breaking
upgrade to `sharp@0.35.5`, which needs a dependency decision and a re-run of the
OG build; the approved range is still `^0.34`.

### 2026-11-22, Task 4 — rate-limit counters live in process memory

The spec deploys one application container, so this is correct today; a
multi-instance deployment would need a shared store. No action until the
deployment shape changes.

### 2026-11-23, Task 22 — the backups page has no directory injection point

`showBackups` reads a module-level `backups/` path, so the integration test writes
a uniquely named fixture into the real (gitignored) directory and deletes it
afterwards. A `BACKUP_DIR` override would be cheap to read but would then have to
be honoured by the backup/restore scripts too; that is a config contract, not a
test cleanup.

## Deliberate behaviours

### 2026-11-23, Task 14 — receipt rows with the same component are accepted

`postReceipt` accepts the same `componentId` twice in one document and creates a
separate batch per line. The ledger and FIFO stay consistent, but an accidental
duplicate row splits cost history. The form does not merge rows. If this becomes
a real accounting problem, merge repeated lines client-side or reject duplicates
in the service; both change the approved contract.

### 2026-11-23, Task 12 — the FIFO preview skips the inventory-freeze check

`previewIssue` does not check for a live inventory count, while `postIssue`
rejects it with 409. Showing the cost split on a frozen warehouse is still
useful, and the posting path remains authoritative. The issue form may disable
the preview during a count if operators find the later rejection confusing.

### 2026-11-23, Task 11 — the freeze check runs before supplier/component validation

On a frozen warehouse an archived component returns 409 «На складе идёт
инвентаризация» instead of the 400 that names the real input problem. The 409 is
still true and actionable; reordering only decides which error wins.

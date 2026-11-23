# Improvements backlog — Motherload

Пока пусто. Некритичные находки добавляются сюда по мере работы.

## 2026-11-23, Task 16 — inventory number is derived, not persisted

`inventory_counts` has no document-number column, so the UI labels a count as
`ИНВ-<year>-<id>` computed from `created_at` and the primary key. The label is
stable for a given row, but it is not reserved through `document_sequences`, does
not appear in the audit details, and would have to be recomputed by every export.
The inventory act CSV (spec §5.8/§5.13) belongs to the reports task; if it needs
the same number, either persist it in a new migration or export the derived label
with the same formula. Until then, a manual report must not assume the number is
stored.

## 2026-11-23, Task 16 — inventory list caps at 200 rows

`/inventory` loads the 200 newest counts and has no pagination. That is enough for
the demo dataset and keeps the page a single query, but a long-lived production
database would hide older counts from the list. Direct links by id still work,
and every count remains reachable through the audit log. Add pagination or a
year/status filter when the reports task revisits inventory history.

## 2026-11-23, Task 16 — act CSV export is not wired

The discrepancy act is available on screen and prints cleanly, but the CSV button
from spec §5.8/§5.13 is not implemented here. CSV generation is shared with the
reports screen, so the export belongs to that task; this stage deliberately did
not add a second CSV encoder in the inventory controller.

## 2026-11-23, Task 12 — document totals are 2dp while consumption valuations are 4dp

`stock_documents.total_cost` and `stock_document_lines.total_cost` are
`numeric(14,2)`, while `batch_consumptions.unit_cost`, `stock_movements.unit_cost`
and FIFO allocation totals keep four decimals. Rounding at the line boundary means
a cost report can differ by up to a kopeck depending on whether it sums documents
or consumption rows. Future cost reports must pick one source deliberately and
state it; never mix both sources in one reconciliation.

## 2026-11-23, Task 12 — FIFO preview skips the inventory-freeze check

`previewIssue` does not check whether an inventory count is freezing the warehouse,
while `postIssue` rejects that case with 409. Showing the cost split is still
useful on a frozen warehouse, and the posting path remains authoritative, so this
is deliberate for an advisory preview. Task 14 (issue form) decides whether to
disable preview during a count. Repeated `componentId` lines are rejected at the
service boundary (400) for both preview and posting, so the optimistic-allocation
case no longer exists.

## 2026-11-23, Task 11 — freeze check runs before supplier/component validation

`postReceipt` checks the inventory freeze before it checks that the supplier and
components are active. On a frozen warehouse an archived component therefore
returns 409 «На складе идёт инвентаризация» instead of the 400 that names the
real input problem. Deferred minor: the 409 is still true and actionable, and
reordering only decides which error wins. Revisit when the receipt form (Task 14)
defines the precedence it wants to show.

## 2026-11-23, Task 14 — stock operation screens

- The navigation audit found `/analytics`, `/alerts` and `/reports` had no routes
  yet. They are hidden from `nav-links.ejs` until their tasks land; a visible
  link must never advertise a 404.
- Receipt rows with the same component are deliberately accepted, matching
  `postReceipt`. The form does not merge them. The Task 11 note asked for a
  decision here: changing the service contract is out of Task 14's scope, and
  rejecting duplicates would contradict the approved brief. If duplicate batches
  per receipt become a real accounting problem, merge rows client-side in a
  dedicated change.
- The component type-ahead exposes `role="combobox"`/`listbox` and keyboard
  navigation but does not set `aria-activedescendant` while moving through the
  options. A screen reader still has the native `<select>` fallback before the
  module runs; the active-descendant refinement is deferred as a non-critical
  accessibility improvement.

## 2026-11-23, Task 11 — duplicate component lines produce duplicate batches

`postReceipt` accepts the same `componentId` twice in one document and creates a
separate `stock_batches` row per line. Nothing breaks — the ledger and FIFO stay
consistent — but the receipt form can produce two batches for one purchase when
the operator adds a repeated row by accident, which splits the cost history and
makes the batch list harder to read. Owner: Task 14 (receipt form). Options:
merge repeated lines in the form, reject duplicates with a 400, or document the
behaviour deliberately. Decide when the form is built, since that is where the
user-facing contract becomes visible.

## 2026-11-23, Task 5 — RBAC, users, profile, audit

- `GET /login` returns 404: only `POST /login` is routed. A user who types the
  address or follows an old bookmark sees the not-found page. Task 4 owns the
  auth routes; a redirect to `/` would be the natural fix.
- 400/403/404 responses still use the Task 4 bootstrap HTML without the app
  layout. Task 6 replaces it with the shared error views; the status codes and
  Russian messages from this task already flow through that middleware.
- The navigation bar wraps to a second row for administrators at 1280–1439 px,
  because ten links plus the identity block no longer fit. All links stay
  visible instead of being clipped by the previous horizontal scroll, but the
  header is taller on those widths. A compact admin menu can be considered once
  the remaining sections add their own navigation entries.

## 2026-11-23, Task 7 — remaining §5.19 error pages for directories

A refused directory delete now re-renders the active tab at 409 with the
explanation in the page's form-errors area. Two directory responses still use the
Task 4 bootstrap HTML without the app layout: a 403 for a non-admin on
`/admin/directories*` and a 404 for an unknown entity or a malformed/missing
`?edit=` id. That gap is the same one already listed under Task 5 and belongs to
Task 6, which replaces `src/middleware/errors.js` with the shared error views.
Listed here so the directory surface is explicitly covered by that task.

## 2026-11-22, Task 4 — auth session and rate-limit notes

- Rate-limit counters live in process memory. The spec deploys one application
  container, so this is correct today; a multi-instance deployment would need a
  shared store.
- CSRF protection is mounted by the web router so `/healthz` does not create a
  session row on every probe. Any future API router must mount
  `csrfProtection` itself; this is called out in the middleware comment.

## 2026-11-22, Task 1 — `sharp` high-severity advisory

`npm audit` reports one high-severity advisory in the `sharp` devDependency
(`<=0.35.5-rc.1`). It is used only by `scripts/build-og.js` (Task 3) to render
the static OG cover locally and is never loaded by the server, so it does not
affect the runtime image (`npm prune --omit=dev` in the Dockerfile). Deferred:
the approved dependency range is `sharp@^0.34`, and the fix requires an upgrade
decision that belongs to Task 24 (docs, CI, final polish).

## 2026-11-23, Task 18 — analytics and catalog duplicate the reference-date helper

`src/services/analytics.js` repeats the small `ANALYTICS_REFERENCE_DATE` /
Europe/Minsk "today" helper that `src/services/catalog.js` keeps private. Both
must agree or the six-month card chart and the XYZ window could describe
different months. Extract one shared helper when a third caller (reorder or
alerts) needs it; moving the catalog one now would be an unrelated refactor.

## 2026-11-23, Task 18 — catalog and XYZ use different six-month windows

The component card chart includes the reference month (June–November for
22.11.2026), while XYZ deliberately uses only full months (May–October). Both
windows are defensible, but the screens do not explain the difference. Align
the labels or reuse one window helper before the reports task exposes both
figures side by side.

## 2026-11-23, Task 18 — monthly issue aggregation SQL is duplicated

`src/repositories/components-read.js:listMonthlyConsumption` and
`src/repositories/analytics.js:listMonthlyIssues` select issue quantity per
month with the same document join and Europe/Minsk month bucket. The filters
and consumers differ, so this stage left both in place. Extract one query when
a third caller (reports or the dashboard feed) needs the same aggregation.



## 2026-11-23, Task 19 — catalog recomputes ROP on every page load

The catalog now attaches the reorder point and supports `status=below_rop`, so
`catalog.list` runs the full pair calculation (two analytics queries plus the
domain pass) even when the user only asked for the default name-sorted list.
With the demo catalogue this is measured in milliseconds; a much larger
catalogue should compute ROP once per request, cache it for a short TTL, or
move the below-ROP filter into SQL with a materialised planning view. Deferred
until a real dataset shows the cost.

## 2026-11-23, Task 19 — aggregate low-data flag is conservative

In "all warehouses" mode a component is flagged «мало данных» as soon as one
participating pair has fewer than 14 days of consumption, because that pair's
ROP comes from the `min_stock` fallback and is still summed into the row. The
per-warehouse disclosure shows which pair is short, so the number is explained,
but a future iteration could expose a distinct "частично" state or exclude the
fallback pair from the aggregate ROP while keeping its suggested quantity.

## 2026-11-23, Task 19 — negative ledger balances are clamped in analytics

`calculateReorder` correctly rejects negative balances. Read-only analytics can
still meet a negative per-warehouse balance from legacy fixtures or a manually
edited ledger, so the service clamps it to zero before planning instead of
failing the whole dashboard. This keeps the page available but hides a real
data-integrity problem; a dedicated consistency check or alert (Task 20) should
surface negative balances, and the issue document remains the only writer that
must prevent them.

## 2026-11-23, Task 19 — catalog below-ROP row can look healthy by totals

The catalog row shows the summed balance and summed ROP, while `below_rop`
matches as soon as one warehouse pair is below its own point. A component with
a large central stock and one weak regional warehouse is therefore listed with a
healthy-looking total. The reorder page is the authoritative per-warehouse view;
a later catalog pass could add a "N складов ниже ROP" hint to the status cell.

## 2026-11-23, Task 20 — dead_stock uses stock age, KPI deadValue does not

`dead_stock` fires when the pair has stock, no issue inside the 90-day window
(never issued counts), and the oldest still-relevant positive receipt is at least
90 days old. That flags the actual frozen-inventory case while leaving a fresh
receipt after an old issue alone.

The dashboard KPI `deadValue` still follows the literal §6.7 formula and counts
stock of every component with no issue in 90 days, including stock received
yesterday. Aligning it would change a KPI definition fixed by the spec and
accepted in Task 19, and would rewrite the Task 19 dashboard expectations; that
is a product decision, not a local Task 20 fix. The two surfaces therefore
disagree for brand-new stock. Decide whether §6.7 should gain the stock-age
condition before the final analytics pass.

## 2026-11-23, Task 20 — manual resolve is intentionally transient

An admin can close an alert manually, but recalculation has no suppression list:
if the condition is still true, the next pass opens a fresh alert beside the
resolved history. That is deliberate — a still-true shortage must not stay hidden
because someone clicked "Закрыть" — and is covered by an integration test. The
cost is that manual resolution alone does not silence an alert permanently; only
fixing the stock or resolving the condition does. A per-condition suppression
window (with an owner and an expiry) would be a separate product feature.

## 2026-11-23, Task 20 — the reference-date helper now has a third copy

`src/services/alerts.js` repeats the `ANALYTICS_REFERENCE_DATE` / Europe/Minsk
"today" helper already present in `analytics.js` and `catalog.js`. Task 18
deferred extraction until the third caller appeared; that caller is now here, but
moving the helper would touch two files outside Task 20's scope. Extract one
shared clock module when the reports task adds its own windows.

## 2026-11-23, Task 20 — the alert list has no pagination

`/alerts` renders every row matching the filters. A recalculation creates at most
one open row per condition, so the open view stays small, but a long-lived
`status=all` selection will grow with every resolved history row. Add pagination
or a date window when the resolved history becomes useful to browse.

## 2026-11-23, Task 20 — the admin navigation wraps at 1440 px

Adding the eleventh navigation link made the admin header wrap to a second row
even at 1440 px; the discomfort previously noted for 1280–1439 px now covers the
reference desktop width. All links remain visible, but a compact admin menu
(or moving reference data under one "Администрирование" entry) is worth doing
before the final layout pass.

## 2026-11-23, Task 21 — catalog export button is still missing

§5.3 asks for an «Экспорт CSV» button on `/components` that keeps the current
filters. `/reports/export/stock` accepts `warehouseId` and `categoryId`, so the
data path exists, but the catalog view and controller are outside Task 21's file
scope. A short follow-up should compose that URL with `queryString()` and add the
button beside the filter form; the report itself needs no new code.

## 2026-11-23, Task 21 — the reference-date helper now has a fourth copy

`src/services/reports.js` repeats the `ANALYTICS_REFERENCE_DATE` / Europe/Minsk
"today" helper already present in `analytics.js`, `catalog.js` and `alerts.js`.
Task 20 explicitly deferred extraction to the reports task, but doing it here
would change three services outside this task's scope. Extract one shared clock
module (`referenceDate()` and `todayInMinsk()`) in a dedicated refactor before
the final analytics pass.

## 2026-11-23, Task 21 — CSV exports are built fully in memory

Every report loads all matching rows and materialises one string before sending
it. That is fine for the demo dataset and keeps `toCsv` a pure function, but a
multi-year audit export or a large movement range will grow memory linearly.
The audit export has no date filter at all. If production volumes appear, add a
date window to the audit card and stream rows into the response instead of
joining them in memory.

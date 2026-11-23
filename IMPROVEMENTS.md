# Improvements backlog — Motherload

Пока пусто. Некритичные находки добавляются сюда по мере работы.

## 2026-11-23, Task 11 — audit cannot join the stock transaction yet

A posted receipt is audited **after** its transaction commits: `insertAuditEntry`
queries the shared pool and accepts no transaction client. Impact: if the
process dies between COMMIT and the audit insert, a conducted receipt has no
`stock.receipt` row (stock data stays correct; the audit trail has a hole). Owner:
Task 11 fix round 2, after Task 5 merges, so that the audit UI work is not
touched twice. Fix: optional client parameter on `insertAuditEntry` and the
audit call moved inside `withTransaction`.

## 2026-11-23, Task 11 — freeze check runs before supplier/component validation

`postReceipt` checks the inventory freeze before it checks that the supplier and
components are active. On a frozen warehouse an archived component therefore
returns 409 «На складе идёт инвентаризация» instead of the 400 that names the
real input problem. Deferred minor: the 409 is still true and actionable, and
reordering only decides which error wins. Revisit when the receipt form (Task 14)
defines the precedence it wants to show.

## 2026-11-23, Task 11 — document year outside 2000–2999 (resolved)

`postReceipt` used to accept a document date outside the `document_sequences`
year range and let PostgreSQL reject the sequence insert. Resolved in the
2026-11-23 fix round: `docDate` is now bounded to 2000–2999 with a Russian 400,
together with bounds for `qty`, `componentId`, `unitCost` and line totals.

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

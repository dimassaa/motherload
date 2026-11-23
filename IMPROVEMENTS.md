# Improvements backlog — Motherload

Пока пусто. Некритичные находки добавляются сюда по мере работы.

## 2026-11-23, Task 11 — freeze check runs before supplier/component validation

`postReceipt` checks the inventory freeze before it checks that the supplier and
components are active. On a frozen warehouse an archived component therefore
returns 409 «На складе идёт инвентаризация» instead of the 400 that names the
real input problem. Deferred minor: the 409 is still true and actionable, and
reordering only decides which error wins. Revisit when the receipt form (Task 14)
defines the precedence it wants to show.

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

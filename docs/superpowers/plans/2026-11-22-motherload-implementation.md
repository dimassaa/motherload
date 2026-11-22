# Motherload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Построить Motherload — SSR-терминал учёта и аналитики складских запасов комплектующих на Node.js 24, Express 5, EJS и PostgreSQL 18, с FIFO, ABC/XYZ, ROP, алертами, отчётами, аудитом и Docker-развёртыванием.

**Architecture:** Классический MVC: routes → controllers → services → repositories → PostgreSQL; чистые доменные функции для FIFO/ABC/XYZ/ROP/CSV; EJS-страницы с прогрессивным улучшением на нативных ES-модулях. Все мутации остатков — транзакции с блокировкой партий. Одна CSS-таблица, дизайн из `DESIGN (4).md`.

**Tech Stack:** Node.js 24 LTS, Express 5, EJS 3, PostgreSQL 18, `pg`, `decimal.js`, Zod, Pino, `express-session` + `connect-pg-simple`, Argon2id, Helmet, Chart.js 4, `node:test` + Supertest, Docker Compose, ESLint 9 + Prettier.

**Spec:** `docs/superpowers/specs/2026-11-22-motherload-design.md`

## Global Constraints

- Только чистый JavaScript, `"type": "module"`, без TypeScript, bundler, ORM, React/Vue.
- Node.js 24+, Express 5, PostgreSQL 18, EJS 3.
- Один CSS-файл: `public/css/app.css`. Без Tailwind, `<style>`, `style="..."`.
- Без inline-скриптов; CSP `script-src 'self'`.
- Русский UI, английские имена/комментарии/коммиты.
- Деньги: `decimal.js`; `numeric` из `pg` — строка, не `Number`.
- BYN, знак через `nbrb-icon`; ВСЕ демо-данные белорусские и вымышленные.
- Все мутации остатков — в транзакции с `FOR UPDATE`.
- Все мутации — в аудит; секреты не логируются.
- `min_stock`/`max_stock` — порог на каждом складе.
- Складские документы создаются сразу проведёнными; номера из `document_sequences`.
- Инвентаризация замораживает склад с `draft` до `approved`/`cancelled`.
- `ANALYTICS_REFERENCE_DATE=2026-11-22` в демо/тестах; в production пусто.
- Каждый task заканчивается зелёными `npm run lint`, `npm run format:check` и релевантными тестами; коммит — один на task.
- Перед коммитом проверить `git diff` на случайные файлы, секреты, `console.log`, закомментированный код.

## Review Focus

1. **Двойное списание одной партии при параллельных расходах.** Два одновременных issue на одну позицию не должны увести `qty_remaining` в минус; второй ждёт блокировку и получает корректный остаток. Тест — Task 12.
2. **Движение на складе во время инвентаризации.** Приёмка/расход/перемещение с замороженным складом возвращают 409, а утверждение при изменившемся остатке откатывается. Тест — Task 15.
3. **Потеря копеек на `numeric`-строках.** Себестоимость и итоги считаются через `Decimal`, а не `Number`; CSV и БД сходятся до 4 знаков. Тест — Tasks 10, 12, 21.
4. **Обход RBAC прямым POST.** Analyst не может провести приёмку, storekeeper — утвердить инвентаризацию, даже если кнопки скрыты. Тест — Tasks 5, 11, 15.
5. **Аналитика на пустой истории и плавающей дате.** Нет делений на ноль, `NaN`, ложных X/Y; окна считаются от `ANALYTICS_REFERENCE_DATE`. Тест — Task 17.

---

## Shared Interfaces

Эти имена и формы обязательны для всех задач. Не переименовывать без обновления плана и спеки.

### Env (`src/config/env.js`)

```js
export const env = {
  nodeEnv, port, databaseUrl, testDatabaseUrl, sessionSecret, sessionTtlHours,
  appUrl, https, tlsCertPath, tlsKeyPath, seedDemo, logLevel, timezone,
  analyticsReferenceDate // Date | null
};
export const isProduction = env.nodeEnv === 'production';
export const isTest = env.nodeEnv === 'test';
```

В `NODE_ENV=test` `databaseUrl` берётся из `TEST_DATABASE_URL`; без него — fail fast.

### DB (`src/db/pool.js`)

```js
export const pool;
export async function query(text, params);
export async function withTransaction(fn); // fn(client), COMMIT/ROLLBACK автоматически
export async function closePool();
```

`pg.types.setTypeParser(1082, (v) => v)` — даты документов остаются строками `YYYY-MM-DD`.

### Errors (`src/domain/errors.js`)

```js
export class AppError extends Error { status; code; }
export class ValidationError extends AppError {}      // 400
export class UnauthorizedError extends AppError {}    // 401
export class ForbiddenError extends AppError {}       // 403
export class NotFoundError extends AppError {}        // 404
export class ConflictError extends AppError {}        // 409
export class InsufficientStockError extends ValidationError { available; }
```

### Domain

```js
// src/domain/fifo.js
export function allocateFifo(batches, quantity);
// batches: [{ id:number, unitCost:string, qtyRemaining:number, receivedAt:string }]
// -> { allocations:[{ batchId, qty, unitCost, totalCost }], totalCost }

// src/domain/abc.js
export function classifyAbc(items, { a = 0.8, b = 0.95 } = {});
// items: [{ id, value:string }] -> [{ id, value, share, cumulativeShare, class:'A'|'B'|'C' }]

// src/domain/xyz.js
export function classifyXyz(monthlyQuantities);
// number[6] -> { cv:number|null, class:'X'|'Y'|'Z' }

// src/domain/reorder.js
export function calculateReorder({ dailyQuantities, historyDays = dailyQuantities.length, leadTimeDays, minStock, balance, unitCost });
// -> { avgDaily, stddev, safetyStock, rop, eoq, suggested, lowData }
// lowData = historyDays < MIN_HISTORY_DAYS (14); dailyQuantities may be 90 values with zeros

// src/domain/kpi.js
export function calculateKpi({ stockValue, cogs90, deadValue });
// -> { turnoverYear:number|null, coverageDays:number|null }

// src/domain/csv.js
export function toCsv(rows, columns); // BOM + ';' + CRLF
export function csvFilename(prefix, date); // motherload-stock-2026-11-22.csv
```

### Services

```js
postReceipt({ supplierId, warehouseId, docDate, comment, lines, userId, req }) // -> { documentId, number }
postIssue({ warehouseId, docDate, reason, comment, lines, userId, req })       // -> { documentId, number, totalCost }
postTransfer({ fromWarehouseId, toWarehouseId, docDate, comment, lines, userId, req }) // -> { documentId, number, totalCost }
previewIssue({ warehouseId, lines }) // -> { lines:[{ componentId, allocations, totalCost }], totalCost }

createCount({ warehouseId, comment, userId, req }) // -> { countId }
saveCountLines({ countId, lines, userId, req })    // lines: [{ componentId, actualQty:number|null, comment }]
submitCount({ countId, userId, req })
approveCount({ countId, userId, req })
cancelCount({ countId, userId, req })
```

### Views

`express-ejs-layouts`; layout выбирается в `res.render(..., { layout: 'layouts/app' })`.
Helpers в `res.locals`: `formatMoney`, `formatQty`, `formatDate`, `formatDateTime`, `formatPct`, `money`, `csrfField`, `statusChip`, `queryString`.

---

## File Structure

```
package.json, .nvmrc, .env.example, eslint.config.js, .prettierrc.json, Dockerfile, docker-compose.yml
src/app.js, src/server.js
src/config/{env,inventory}.js
src/db/{pool,migrate,seed}.js
src/domain/{errors,money,fifo,abc,xyz,reorder,kpi,csv}.js
src/middleware/{auth,csrf,flash,errors,rate-limit,locals,validate}.js
src/repositories/{users,audit,directories,components,stock,inventory,analytics,alerts}.js
src/services/{auth,audit,users,directories,components,stock,inventory,analytics,alerts,reports}.js
src/controllers/{auth,dashboard,components,stock,inventory,analytics,alerts,reports,admin,profile}.js
src/routes/{web,api}.js
src/views/layouts/base.ejs
src/views/partials/*.ejs
src/views/pages/**/*.ejs
src/views/helpers.js
db/migrations/001_init.sql
db/seed/data.js
public/css/app.css
public/js/*.js
public/fonts/*, public/img/*, public/vendor/*
scripts/{wait-for-db,docker-entrypoint,backup,restore,gen-cert,smoke,copy-vendor,recalc-alerts,reset-db}.js|sh
test/helpers/{db,app,factories,http}.js
test/unit/*.test.js
test/integration/*.test.js
docs/{superpowers/specs,superpowers/plans}
README.md, DEPLOYMENT.md, AGENTS.md, IMPROVEMENTS.md
```

---

## Task 1: Tooling, env, DB connection, app skeleton

**Files:**
- Create: `package.json`, `.nvmrc`, `.env.example`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `IMPROVEMENTS.md`
- Create: `scripts/copy-vendor.js` (stub in this task, filled in Task 3)
- Create: `src/config/env.js`, `src/config/inventory.js`, `src/db/pool.js`, `src/db/migrate.js`
- Create: `src/app.js`, `src/server.js`, `src/routes/web.js`, `src/middleware/errors.js`
- Create: `Dockerfile`, `docker-compose.yml`, `scripts/wait-for-db.js`, `scripts/docker-entrypoint.sh`
- Test: `test/integration/health.test.js`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `env`, `isProduction`, `isTest`, `pool`, `query`, `withTransaction`, `migrate(pool)`, `createApp()`.
- Produces npm scripts: `dev`, `start`, `db:migrate`, `db:seed`, `db:reset`, `alerts`, `lint`, `format`, `format:check`, `test`, `test:unit`, `test:integration`, `backup`, `restore`, `cert`, `smoke`.

- [ ] **Step 1: Create package manifests and configuration**

`package.json` dependencies: `express@^5`, `ejs@^3`, `express-ejs-layouts@^2`, `pg@^8`, `decimal.js@^10`, `zod@^4`, `dotenv@^17`, `express-session@^1`, `connect-pg-simple@^10`, `argon2@^0.44`, `helmet@^8`, `express-rate-limit@^8`, `pino@^9`, `pino-http@^10`, `chart.js@^4`, `@fontsource-variable/inter@^5`, `@fontsource-variable/jetbrains-mono@^5`, `selfsigned@^3`. Dev: `eslint@^9`, `@eslint/js@^9`, `globals@^16`, `prettier@^3`, `supertest@^7`, `cross-env@^10`, `sharp@^0.34`.

Scripts: `test` = `npm run test:unit && npm run test:integration`; `test:integration` = `cross-env NODE_ENV=test node --test --test-concurrency=1 test/integration`; `test:unit` = `node --test --test-concurrency=4 test/unit`; `postinstall` = `node scripts/copy-vendor.js` (create stub in this task, fill in Task 3).

`.env.example` exactly:

```
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://motherload:motherload@localhost:5432/motherload
TEST_DATABASE_URL=postgres://motherload:motherload@localhost:5432/motherload_test
SESSION_SECRET=replace-with-at-least-32-random-characters
SESSION_TTL_HOURS=8
APP_URL=http://localhost:3000
HTTPS=0
TLS_CERT_PATH=
TLS_KEY_PATH=
SEED_DEMO=true
LOG_LEVEL=info
TZ=Europe/Minsk
ANALYTICS_REFERENCE_DATE=2026-11-22
```

Add `.env`, `certs/`, `public/vendor/`, `tmp/` to `.gitignore`; ignore generated `public/fonts/*.woff2` but re-include the committed NBRB file with `!public/fonts/nbrb.woff2`.

Create `IMPROVEMENTS.md` with a title and «Пока пусто. Некритичные находки добавляются сюда по мере работы.». Create `scripts/copy-vendor.js` as a no-op stub so `postinstall` does not fail before Task 3.

- [ ] **Step 2: Implement env and inventory config**

`src/config/env.js`: load `dotenv/config`; Zod schema validates all vars; `SESSION_SECRET` min 32; `ANALYTICS_REFERENCE_DATE` optional ISO date; `isTest` selects `TEST_DATABASE_URL`; fail fast with a readable Russian error listing missing keys (not values). Export `env`, `isProduction`, `isTest`.

`src/config/inventory.js`: export `ORDER_COST_BYN = '50'`, `HOLDING_RATE = '0.20'`, `SERVICE_LEVEL_Z = 1.645`, `DEMAND_WINDOW_DAYS = 90`, `XYZ_MONTHS = 6`, `DEAD_STOCK_DAYS = 90`, `ACTIVITY_WINDOW_DAYS = 180`, `ABC_A = 0.8`, `ABC_B = 0.95`, `XYZ_X = 0.10`, `XYZ_Y = 0.25`, `MIN_HISTORY_DAYS = 14`.

- [ ] **Step 3: Implement pool, transaction wrapper, migration runner**

`src/db/pool.js`: singleton `Pool`; date parser; `query`, `withTransaction`, `closePool`. `withTransaction` always releases the client and rolls back on throw.

`src/db/migrate.js`: read `db/migrations/*.sql` sorted; create `schema_migrations` if absent; apply each unapplied file in a transaction; export `migrate(poolOverride = pool)`; CLI entry via `pathToFileURL(process.argv[1]).href === import.meta.url`.

- [ ] **Step 4: Implement app/server/health**

`src/app.js`: `createApp()` builds Express app, disables `x-powered-by`, sets EJS views, `trust proxy`, Helmet with CSP from spec and HSTS when `env.https`, `express.urlencoded({ extended: true })` (nested line arrays), `express.json()` for `/api`, Pino HTTP with redaction of `req.headers.authorization`, `req.headers.cookie` and `res.headers['set-cookie']`, static `/public` and `/vendor`, mounts `web` routes, 404 and error middleware. `GET /healthz` runs `SELECT 1`, returns `{status:'ok', db:'up'}` or 503 `{status:'degraded', db:'down'}`.

`src/server.js`: starts HTTP or HTTPS based on `env.https`, graceful shutdown on SIGINT/SIGTERM, logs listening URL.

`src/middleware/errors.js`: `notFoundHandler`, `errorHandler`; known `AppError` → status + Russian message; Zod → 400; unknown → 500 and Pino error with request id.

- [ ] **Step 5: Docker skeleton**

`Dockerfile`: multi-stage `node:24-bookworm-slim`; `npm ci`; production stage copies `node_modules`, source, public; `USER node`; entrypoint. `docker-compose.yml`: `db` `postgres:18-alpine` with healthcheck and named volume; `app` builds, depends on healthy db, passes env from `.env`, port 3000. `scripts/wait-for-db.js` retries `SELECT 1` 30 times. `scripts/docker-entrypoint.sh` waits, migrates, then `exec node src/server.js`; the seed step is added in Task 23 when `src/db/seed.js` exists.

- [ ] **Step 6: Test health and boot**

`test/integration/health.test.js`:

```js
test('GET /healthz returns ok when database is reachable', async () => {
  const res = await request(createApp()).get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.body.db, 'up');
});
```

Run: `cp .env.example .env`, create databases, `npm run db:migrate`, `npm run test:integration`.
Expected: PASS. `npm run lint` and `npm run format:check` PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .nvmrc .env.example eslint.config.js .prettierrc.json .prettierignore src test Dockerfile docker-compose.yml scripts .gitignore
git commit -m "feat: bootstrap application foundation"
```

---

## Task 2: Database schema, views, constraints

**Files:**
- Create: `db/migrations/001_init.sql`
- Create: `test/helpers/db.js`
- Test: `test/integration/migrations.test.js`

**Interfaces:**
- Produces tables/enums/views exactly as spec §7.
- Produces `v_stock_balances`, `v_stock_values`, `v_component_stock`, `v_component_warehouse_stock`.
- Produces `test/helpers/db.js`: `setupTestDb()`, `truncateAll()`, `teardownTestDb()`.

- [ ] **Step 1: Write the failing migration test**

```js
test('migrations are idempotent and create core tables', async () => {
  await migrate(pool);
  await migrate(pool); // second run must not throw
  const tables = await query("select tablename from pg_tables where schemaname='public'");
  const names = tables.rows.map((r) => r.tablename);
  for (const name of ['users','warehouses','components','stock_batches','stock_documents','stock_document_lines','stock_movements','inventory_counts','alerts','audit_log','document_sequences','sessions']) {
    assert.ok(names.includes(name), name);
  }
});

test('foreign keys and checks reject bad data', async () => {
  await truncateAll();
  await assert.rejects(() => query("insert into stock_batches (component_id, warehouse_id, unit_cost, qty_received, qty_remaining, received_at) values (999999, 999999, 1, 1, 1, '2026-01-01')"), /foreign key/i);
  await query("insert into warehouses (code, name, city, address) values ('X','X','X','X')");
  await assert.rejects(() => query("insert into warehouses (code, name, city, address) values ('X','X','X','X')"), /duplicate key/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:integration -- --test-name-pattern migrations`
Expected: FAIL — relation `schema_migrations` / tables missing.

- [ ] **Step 3: Write `001_init.sql`**

Create `citext`, enums, `schema_migrations`, `sessions`, `users`, `warehouses`, `categories`, `manufacturers`, `suppliers`, `components`, `stock_batches`, `stock_documents`, `stock_document_lines`, `batch_consumptions`, `stock_movements`, `inventory_counts`, `inventory_lines`, `alerts`, `audit_log`, `document_sequences` exactly per spec §7.2. Add all checks, FKs (`RESTRICT` by default, `CASCADE` only for document lines, consumption, inventory lines), indexes and the four views. Add the partial unique index for open alerts and `CREATE UNIQUE INDEX inventory_counts_active_warehouse ON inventory_counts(warehouse_id) WHERE status IN ('draft','submitted')` so two active counts per warehouse are impossible. `document_sequences` PK `(type, year)`.

- [ ] **Step 4: Implement test DB helpers**

`setupTestDb`: `await migrate(pool)`. `truncateAll`: `TRUNCATE users, warehouses, categories, manufacturers, suppliers, components, stock_batches, stock_documents, stock_document_lines, batch_consumptions, stock_movements, inventory_counts, inventory_lines, alerts, audit_log, document_sequences RESTART IDENTITY CASCADE`. `teardownTestDb`: `closePool()`.

- [ ] **Step 5: Run tests and verify**

Run: `npm run test:integration -- --test-name-pattern migrations`
Expected: PASS. Run migration twice on dev DB: PASS. `npm run lint` PASS.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/001_init.sql test/helpers/db.js test/integration/migrations.test.js
git commit -m "feat: add PostgreSQL schema and integrity constraints"
```

---

## Task 3: Design system, layouts, static assets

**Files:**
- Create: `public/css/app.css`
- Create: `scripts/copy-vendor.js`, `scripts/build-og.js`
- Create: `src/views/layouts/base.ejs`, `src/views/pages/landing.ejs` (minimal, enhanced in Task 4/6)
- Create: `src/views/partials/{head,public-header,app-header,nav,footer,flash,status-chip,pagination,empty-state,form-errors}.ejs`
- Create: `src/views/helpers.js`, `src/middleware/locals.js`, `src/middleware/flash.js`
- Create: `public/fonts/nbrb.woff2`, `nbrb.woff`, `nbrb.ttf` (official NBRB files, commit)
- Modify: `src/app.js`, `src/routes/web.js`
- Test: `test/unit/helpers.test.js`, `test/integration/render.test.js`

**Interfaces:**
- Produces `formatMoney(value)` → `"1 234,56"`, `formatQty`, `formatDate`, `formatDateTime`, `formatPct`, `money(value)` → trusted HTML with BYN, `csrfField()`, `statusChip(status)` → `{label, className}`, `queryString(base, params)`.
- Produces `res.locals.currentUser`, `res.locals.flash`, helpers.

- [ ] **Step 1: Write failing helper tests**

```js
test('formatMoney uses ru-BY grouping and comma', () => {
  assert.equal(formatMoney('1234.5'), '1 234,50');
});
test('formatDate keeps document date without timezone shift', () => {
  assert.equal(formatDate('2026-11-22'), '22.11.2026');
});
test('queryString preserves existing params and overrides page', () => {
  assert.equal(queryString('/components', { q: 'ssd', page: 2 }), '/components?q=ssd&page=2');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- --test-name-pattern "formatMoney"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement helpers, flash, locals**

Use `Intl.NumberFormat('ru-BY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })` for display only, then replace NBSP (`\u00A0`) with a regular space so tests and CSV stay predictable. `formatQty` groups integers the same way. `money` returns `<span class="money">… <i class="nbrb-icon" aria-hidden="true">BYN</i></span>`. `csrfField` reads `req.session.csrfToken`. `statusChip` maps statuses to Russian labels and classes (`chip--success`, `chip--warning`, `chip--danger`, `chip--info`, `chip--muted`). Flash stores one message in `req.session.flash` and clears on read.

- [ ] **Step 4: Build the single CSS and layouts**

`public/css/app.css`: `@font-face` for Inter variable (Latin + Cyrillic), JetBrains Mono (Latin + Cyrillic), NBRB; tokens from spec; reset; typography; canvas/card/tag/button/link/table/form/chip/toast/pagination/empty-state/layout/nav/footer/auth/dashboard styles. BEM classes. Responsive 1280/1024/768. `prefers-reduced-motion`. Print styles for acts. No `style=` attributes anywhere.

Layout: `base.ejs` holds `<html lang="ru">`, head, skip-link, conditional `public-header` (guest) or `app-header` + `nav` (authenticated), `<%- body %>`, footer. All pages render with `layout: 'layouts/base'`; no nested layouts, because `express-ejs-layouts` does not chain them reliably. Nav shows links by role and open-alert badge placeholder (`0` until Task 20). Minimal `landing.ejs` renders wordmark, one-sentence pitch and a disabled «Войти» placeholder; Task 4 adds the real form.

- [ ] **Step 5: Vendor fonts and Chart.js**

`scripts/copy-vendor.js`: copy `@fontsource-variable/inter/files/inter-cyrillic-wght-normal.woff2`, `inter-latin-wght-normal.woff2`, `@fontsource-variable/jetbrains-mono/files/jetbrains-mono-cyrillic-wght-normal.woff2`, `jetbrains-mono-latin-wght-normal.woff2` into `public/fonts/`; copy `node_modules/chart.js/dist/chart.umd.js` to `public/vendor/chart.umd.js`; create dirs. Fail with a clear message if a file is missing. `scripts/build-og.js` uses `sharp` (add devDependency) to render `public/img/og-cover.svg` to `og-cover.png` 1200×630.

- [ ] **Step 6: Test rendering and assets**

`test/integration/render.test.js`: `GET /` returns 200 HTML, contains `MOTHERLOAD`, `<html lang="ru">`, no `style=` and no `<style`. `npm run postinstall` creates all vendor files. Run `npm run test:unit`, `npm run test:integration -- --test-name-pattern render`, `npm run lint`, `npm run format:check`.

- [ ] **Step 7: Commit**

```bash
git add public src/views src/middleware/locals.js src/middleware/flash.js scripts/copy-vendor.js scripts/build-og.js package.json package-lock.json test
git commit -m "feat: add design system and server-rendered layouts"
```

---

## Task 4: Authentication, sessions, CSRF, rate limit

**Files:**
- Create: `src/repositories/users.js`, `src/repositories/audit.js`
- Create: `src/services/auth.js`, `src/services/audit.js`
- Create: `src/middleware/auth.js`, `src/middleware/csrf.js`, `src/middleware/rate-limit.js`
- Create: `src/controllers/auth.js`
- Create: `src/views/pages/dashboard.ejs`
- Modify: `src/views/pages/landing.ejs`, `src/app.js`, `src/routes/web.js`
- Test: `test/helpers/{app,http,factories}.js`, `test/integration/auth.test.js`

**Interfaces:**
- Produces `hashPassword(password)`, `verifyPassword(hash, password)`, `login({ email, password, req })` → user.
- Produces `requireAuth`, `requireRole(...roles)`, `csrfProtection`, `csrfToken` in `res.locals`, `audit.record(...)`.
- Produces test helpers `createTestApp()`, `getCsrf(agent, path)`, `loginAs(agent, email, password)`, `createUserFactory(overrides)`.

- [ ] **Step 1: Write failing auth tests**

```js
test('login succeeds with correct password and redirects to dashboard', async () => {
  await createUserFactory({ email: 'admin@test.by', password: 'Admin!23456', role: 'admin' });
  const { agent } = await createTestApp();
  const token = await getCsrf(agent, '/');
  const res = await agent.post('/login').type('form').send({ email: 'admin@test.by', password: 'Admin!23456', _csrf: token });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard');
});
test('login without CSRF is rejected', async () => {
  const { agent } = await createTestApp();
  const res = await agent.post('/login').type('form').send({ email: 'x@y.by', password: 'x' });
  assert.equal(res.status, 403);
});
test('login rate limit returns 429 after 5 attempts', async () => { /* 6 wrong POSTs, last = 429 */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- --test-name-pattern "login"`
Expected: FAIL — 404 / missing helpers.

- [ ] **Step 3: Implement users repo and auth service**

`findByEmail`, `findById`, `touchLastLogin`, `createUser`, `updatePassword`, `setActive`, `countActiveAdmins`. Argon2id defaults. Password policy: ≥10 chars, lower, upper, digit; Russian validation message. `login` compares hash, checks `is_active`, throws `UnauthorizedError('Неверный email или пароль')`. Audit actions: `auth.login`, `auth.login_failed`, `auth.logout`.

- [ ] **Step 4: Implement session, CSRF, rate limit, routes**

Session: `connect-pg-simple` with `createTableIfMissing: false`, `tableName: 'sessions'`; cookie `httpOnly`, `sameSite:'lax'`, `secure: env.https`, `maxAge: hours*3600*1000`; `rolling: true`; regenerate on login and store `req.session.userId`. `attachUser` loads the active user into `req.user`/`res.locals.currentUser` on every request; `requireAuth` redirects guests. CSRF: session-bound random token, timing-safe compare for `_csrf` body or `x-csrf-token` header; skip safe methods; 403 with Russian message. Global rate limit 300/min per IP, plus `/login` 5/min per IP; `standardHeaders: true`, Russian 429 messages. Routes: `GET /` (landing), `POST /login`, `POST /logout`, `GET /dashboard` (auth placeholder).

- [ ] **Step 5: Implement landing and dashboard placeholders**

Landing: wordmark, short pitch, login form with email/password, error display, demo credentials block (collapsible `<details>`), no inline styles. Dashboard: placeholder heading «Обзор склада» and logout button; full dashboard in Task 19.

- [ ] **Step 6: Run tests, lint, format**

Run: `npm run test:integration -- --test-name-pattern "login|csrf|rate"`; `npm run lint`; `npm run format:check`.
Expected: PASS. Verify cookie has `HttpOnly` and `SameSite=Lax` in test.

- [ ] **Step 7: Commit**

```bash
git add src test
git commit -m "feat: add authentication sessions and CSRF protection"
```

---

## Task 5: RBAC, users, profile, audit

**Files:**
- Create: `src/services/users.js`, `src/controllers/admin.js`, `src/controllers/profile.js`
- Create: `src/views/pages/admin/users/{list,form}.ejs`, `src/views/pages/admin/audit.ejs`, `src/views/pages/profile.ejs`
- Create: `src/middleware/validate.js`
- Modify: `src/routes/web.js`, `src/views/partials/nav.ejs`
- Test: `test/integration/users.test.js`, `test/integration/rbac.test.js`

**Interfaces:**
- Produces `usersService.create/update/adminResetPassword/changeOwnPassword/list`.
- Produces `validateBody(schema)` middleware and `parseOrThrow(schema, input)`.
- Produces audit list `auditService.list({ userId, action, from, to, page })`.

- [ ] **Step 1: Write failing RBAC and user tests**

```js
test('analyst cannot POST to an admin route', async () => {
  const { agent } = await loginAsRole('analyst');
  const res = await agent.post('/admin/users').type('form').send({ _csrf: await getCsrf(agent, '/dashboard') });
  assert.equal(res.status, 403);
});
test('admin cannot deactivate the last active admin', async () => {
  const { agent, user } = await loginAsRole('admin');
  const res = await agent.post(`/admin/users/${user.id}/toggle`).type('form').send({ _csrf: await getCsrf(agent, '/admin/users') });
  assert.equal(res.status, 400);
  assert.match(res.text, /последнего администратора/i);
});
test('user creation writes an audit row', async () => { /* create, then select audit_log where action='user.create' */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- --test-name-pattern "analyst|last active|audit"`
Expected: FAIL — routes missing.

- [ ] **Step 3: Implement RBAC and validation middleware**

`requireAuth` redirects guests to `/` with flash; `requireRole('admin','storekeeper')` returns 403 page for wrong role. Zod schemas for user forms and profile. `validateBody` returns 400 re-render with errors (controllers pass `res.locals.formErrors`).

- [ ] **Step 4: Implement user management and audit UI**

Routes: `GET/POST /admin/users`, `GET/POST /admin/users/new`, `GET/POST /admin/users/:id`, `POST /admin/users/:id/password`, `POST /admin/users/:id/toggle`, `GET /admin/audit`, `GET/POST /profile`, `POST /profile/password`. Admin cannot deactivate self or last active admin. Email immutable. Password reset invalidates target sessions (delete `sessions` rows matching `sess->>'userId'`). Audit list filters/pagination.

- [ ] **Step 5: Run tests, lint, format**

Run: `npm run test:integration -- --test-name-pattern "user|rbac|profile|audit"`; `npm run lint`; `npm run format:check`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat: add role-based access and user administration"
```

---

## Task 6: Public landing, SEO, errors

**Files:**
- Create: `public/img/og-cover.svg`, `public/img/og-cover.png`
- Create: `src/controllers/public.js` (or extend auth controller)
- Modify: `src/views/pages/landing.ejs`, `src/views/partials/public-header.ejs`, `src/app.js`, `src/routes/web.js`
- Test: `test/integration/seo.test.js`

**Interfaces:**
- Produces `GET /robots.txt`, `GET /sitemap.xml`, canonical/OG/JSON-LD on `/`.
- Private layouts set `noindex, nofollow`.

- [ ] **Step 1: Write failing SEO tests**

```js
test('landing exposes title, description, canonical and JSON-LD', async () => {
  const res = await request(createApp()).get('/');
  assert.match(res.text, /<title>Motherload/);
  assert.match(res.text, /name="description"/);
  assert.match(res.text, /rel="canonical" href="http:\/\/localhost:3000\/"/);
  assert.match(res.text, /"@type":"SoftwareApplication"/);
});
test('robots disallows private areas and points to sitemap', async () => {
  const res = await request(createApp()).get('/robots.txt');
  assert.match(res.text, /Disallow: \/dashboard/);
  assert.match(res.text, /Sitemap: http:\/\/localhost:3000\/sitemap.xml/);
});
test('dashboard is noindex', async () => { /* login, then /dashboard contains noindex */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- --test-name-pattern "seo|robots|noindex"`
Expected: FAIL.

- [ ] **Step 3: Build the real landing**

Hero with decorative SVG scatter (inline SVG allowed), bracket labels `[ ЗАПАСЫ ]` / `[ КОНТРОЛЬ ]`, three value points, login card, demo credentials, version stamp. Use Moss only on «Войти». Add meta/OG/Twitter/JSON-LD from spec. OG image generated by `scripts/build-og.js`.

- [ ] **Step 4: Add robots, sitemap, private noindex**

`robots.txt` and `sitemap.xml` generated from `env.appUrl`; private layout adds noindex. 403/404/500 pages in app layout with human Russian text and links.

- [ ] **Step 5: Verify in browser and tests**

Run tests; then start `npm run dev` and `agent-browser`:
`session id --scope worktree --prefix motherload`; open `/`; snapshot; screenshot at 1440 and 390; confirm login form, CTA, no horizontal scroll. Save to `tmp/smoke/landing-1440.png`, `landing-390.png`.

- [ ] **Step 6: Commit**

```bash
git add public src test
git commit -m "feat: add public landing page and SEO metadata"
```

---

## Task 7: Directories CRUD

**Files:**
- Create: `src/repositories/directories.js`, `src/services/directories.js`, `src/controllers/admin-directories.js`
- Create: `src/views/pages/admin/directories.ejs`
- Modify: `src/routes/web.js`
- Test: `test/integration/directories.test.js`

**Interfaces:**
- Produces `directoriesService.list(entity)`, `create(entity, data, ctx)`, `update(entity, id, data, ctx)`, `remove(entity, id, ctx)`.
- Entities: `categories`, `manufacturers`, `suppliers`, `warehouses`.

- [ ] **Step 1: Write failing tests**

```js
test('admin creates a supplier and sees it in the list', async () => { /* POST /admin/directories/suppliers, expect 302, DB row */ });
test('duplicate UNP is rejected with a human message', async () => { /* second POST, expect 400 and /УНП/ */ });
test('warehouse referenced by documents cannot be deleted', async () => { /* create doc, delete, expect 409 */ });
test('storekeeper cannot open directories', async () => { /* expect 403 */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- --test-name-pattern "directories|UNP"`
Expected: FAIL.

- [ ] **Step 3: Implement repository/service/controller**

CRUD with Zod; unique conflicts → 409/400; FK restrict → 409 with explanation. Supplier fields: name, UNP (9 digits), contact, phone, email, address, lead time. Warehouse: code, name, city, address, active. Audit `directory.create/update/delete`.

- [ ] **Step 4: Build the tabbed UI**

One page with tabs, tables, inline create/edit forms, delete buttons with confirm dialog (native `confirm()` is allowed). Russian labels and human errors.

- [ ] **Step 5: Run tests, lint, format; browser check**

Run tests; open `/admin/directories`, create a supplier, verify row. Screenshot `tmp/smoke/directories.png`.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat: add reference data management"
```

---

## Task 8: Component CRUD

**Files:**
- Create: `src/repositories/components.js`, `src/services/components.js`, `src/controllers/admin-components.js`
- Create: `src/views/pages/admin/components/{list,form}.ejs`
- Modify: `src/routes/web.js`, `src/views/partials/nav.ejs`
- Test: `test/integration/components-admin.test.js`

**Interfaces:**
- Produces `componentsService.list/get/create/update/archive/remove`.
- Produces `parseSpecs(text)` → object or `ValidationError`.

- [ ] **Step 1: Write failing tests**

```js
test('admin creates a component with specs and thresholds', async () => { /* POST, expect 302, specs jsonb */ });
test('SKU is immutable on edit', async () => { /* POST changed sku, expect 400 */ });
test('component with stock history is archived, not deleted', async () => { /* create batch, POST archive, expect is_active=false */ });
test('storekeeper gets 403 on component create', async () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- --test-name-pattern "component.*create|SKU|archived"`
Expected: FAIL.

- [ ] **Step 3: Implement component repository/service**

Filters: q, categoryId, manufacturerId, isActive. Validate SKU `^[A-Z0-9][A-Z0-9-]{2,31}$`, prices ≥ 0, max ≥ min, lead time > 0. `specs` textarea parsed as JSON object; error «Проверьте JSON: …». Delete only if no batches/movements/lines; otherwise 409 «Есть история — архивируйте». Audit `component.create/update/archive/delete`.

- [ ] **Step 4: Build admin UI**

List with search/filter; form with sections «Основное», «Цены и запасы», «Характеристики», «Публикация». Show SKU read-only on edit. Russian validation errors.

- [ ] **Step 5: Run tests, lint, format; browser check**

Run tests; create a component via browser; screenshot `tmp/smoke/components-admin.png`.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat: add component catalog administration"
```

---

## Task 9: Catalog, component card, stock read models

**Files:**
- Create: `src/repositories/components-read.js` (or extend components repo), `src/services/catalog.js`, `src/controllers/components.js`
- Create: `src/views/pages/components/{list,show}.ejs`
- Create: `src/routes/api.js` (search endpoint; extend later in Task 12)
- Modify: `src/routes/web.js`, `src/app.js`
- Test: `test/integration/catalog.test.js`

**Interfaces:**
- Produces `catalog.list(filters)` → `{ rows, total, page, pages }`; `catalog.getById(id)` → `{ component, warehouses, batches, movements, replenishment }`.
- Produces `GET /api/components/search?q=` → `[{ id, sku, name }]`, auth required, max 20.
- Consumes views `v_component_stock`, `v_component_warehouse_stock`.
- Status filter in this task: `all`, `zero`, `overstock`, `below_min`. `below_rop` добавляется в Task 19, когда появляется ROP.

- [ ] **Step 1: Write failing catalog tests**

```js
test('catalog filters by SKU and category', async () => { /* two components, q=SSD, expect one */ });
test('component card shows balances per warehouse from views', async () => { /* insert batch/movement, expect qty and value */ });
test('unknown component returns 404 page', async () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- --test-name-pattern "catalog|component card"`
Expected: FAIL.

- [ ] **Step 3: Implement read repository/service**

List query joins categories/manufacturers, aggregates `qty`/`value`, computes status per warehouse using `min_stock`; pagination 25. Search endpoint returns active components matching `q` by SKU/name, limit 20, used by stock forms. Card loads batches ordered by `received_at, id`, movements paginated 50, warehouse rows filtered to activity (stock or movement in 180 days) with a `showAll` option. Replenishment block returns placeholders until Task 19 (show `—`).

- [ ] **Step 4: Build catalog and card UI**

Table with filters (search, category, warehouse, status), sortable headers, pagination, status chips. Card with header, prices, warehouse table, batches, movement history, placeholder chart area, replenishment panel, quick action buttons for admin/storekeeper (links to prefilled forms; forms in Task 14).

- [ ] **Step 5: Run tests, lint, format; browser check**

Run tests; open `/components`, filter, open a card; screenshot `tmp/smoke/catalog.png`.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat: add component catalog and stock read models"
```

---

## Task 10: Money, FIFO domain, error types

**Files:**
- Create: `src/domain/errors.js`, `src/domain/money.js`, `src/domain/fifo.js`
- Test: `test/unit/fifo.test.js`, `test/unit/money.test.js`

**Interfaces:**
- Produces errors, `Decimal`, `d(value)`, `formatMoney`, `formatQty`, `allocateFifo(batches, quantity)`.

- [ ] **Step 1: Write failing FIFO tests**

```js
test('allocates across batches in received_at then id order', () => {
  const r = allocateFifo([
    { id: 2, unitCost: '12.5000', qtyRemaining: 5, receivedAt: '2026-01-02' },
    { id: 1, unitCost: '10.0000', qtyRemaining: 3, receivedAt: '2026-01-01' },
  ], 6);
  assert.deepEqual(r.allocations.map((a) => [a.batchId, a.qty]), [[1, 3], [2, 3]]);
  assert.equal(r.totalCost, '67.5000');
});
test('throws InsufficientStockError with available quantity', () => {
  assert.throws(() => allocateFifo([{ id: 1, unitCost: '1', qtyRemaining: 2, receivedAt: '2026-01-01' }], 3), (e) => e.code === 'INSUFFICIENT_STOCK' && e.available === 2);
});
test('rejects non-positive and fractional quantities', () => {
  assert.throws(() => allocateFifo([], 0), ValidationError);
  assert.throws(() => allocateFifo([], 1.5), ValidationError);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- --test-name-pattern fifo`
Expected: FAIL.

- [ ] **Step 3: Implement errors, money, FIFO**

`Decimal.set({ rounding: Decimal.ROUND_HALF_UP })`. FIFO sorts a copy; validates integer positive quantity; uses `Decimal`; returns 4-decimal strings. `InsufficientStockError` message: `На складе недостаточно: доступно N шт.`

- [ ] **Step 4: Add money tests**

```js
test('formats BYN with space grouping and comma', () => assert.equal(formatMoney('1234.5'), '1 234,50'));
test('adds without float drift', () => assert.equal(d('0.1').plus('0.2').toFixed(2), '0.30'));
```

- [ ] **Step 5: Run tests, lint, format; commit**

Run: `npm run test:unit`; `npm run lint`; `npm run format:check`.
```bash
git add src/domain test/unit
git commit -m "feat: add decimal money and FIFO allocation domain"
```

---

## Task 11: Receipts service

**Files:**
- Create: `src/repositories/stock.js`, `src/services/stock.js`
- Test: `test/integration/receipts.test.js`
- Modify: `test/helpers/factories.js`

**Interfaces:**
- Produces `postReceipt({ supplierId, warehouseId, docDate, comment, lines, userId, req })` → `{ documentId, number }`.
- Produces `assertWarehouseNotFrozen(client, warehouseId)`.
- Produces `nextDocumentNumber(client, type, year)`.

- [ ] **Step 1: Write failing receipt tests**

```js
test('receipt creates document, batch and positive movement', async () => {
  const ctx = await seedBase();
  const r = await postReceipt({ ...ctx.receiptInput, lines: [{ componentId: ctx.componentId, qty: 5, unitCost: '100.0000' }] });
  assert.match(r.number, /^ПР-\d{4}-0001$/);
  assert.equal((await balance(ctx.componentId, ctx.warehouseId)), 5);
  const batch = await query('select * from stock_batches where component_id=$1', [ctx.componentId]);
  assert.equal(batch.rows[0].qty_remaining, 5);
});
test('receipt is rejected when warehouse has an active inventory count', async () => {
  await query("insert into inventory_counts (warehouse_id,status,started_by) values ($1,'draft',$2)", [wh, user]);
  await assert.rejects(() => postReceipt(...), (e) => e.status === 409);
});
test('receipt number increments without duplicates', async () => { /* two receipts -> 0001, 0002 */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- --test-name-pattern "receipt"`
Expected: FAIL.

- [ ] **Step 3: Implement repository primitives**

`nextDocumentNumber` uses `INSERT INTO document_sequences ... ON CONFLICT ... RETURNING last_value`, formats with prefix (`ПР`, `РС`, `ПМ`) and year. `assertWarehouseNotFrozen` first locks the warehouse row (`SELECT id FROM warehouses WHERE id=$1 FOR UPDATE`) and then checks `inventory_counts` status in (`draft`,`submitted`); if active, throws `ConflictError('На складе идёт инвентаризация')`. The lock serializes stock operations with count creation, so a receipt cannot slip in between the snapshot and the freeze. Insert document, lines, batches, movements.

- [ ] **Step 4: Implement receipt transaction**

Validate supplier/warehouse/component active and belong together; compute line totals with Decimal; insert document with `total_cost`; for each line create batch (`received_at = docDate`) and movement `+qty`; audit `stock.receipt` with number and total. All or nothing.

- [ ] **Step 5: Run tests, lint, format; commit**

Run: `npm run test:integration -- --test-name-pattern "receipt"`; `npm run lint`; `npm run format:check`.
```bash
git add src test
git commit -m "feat: add stock receipt posting"
```

---

## Task 12: Issues, FIFO posting, preview API

**Files:**
- Modify: `src/repositories/stock.js`, `src/services/stock.js`, `src/routes/api.js`, `src/controllers/stock.js` (create minimal)
- Test: `test/integration/issues.test.js`, `test/integration/concurrency.test.js`

**Interfaces:**
- Produces `postIssue(...)`, `previewIssue({ warehouseId, lines })`.
- Produces `POST /api/fifo-preview` (auth, CSRF) → `{ lines, totalCost }`.

- [ ] **Step 1: Write failing issue tests**

```js
test('issue consumes oldest batches first and records total cost', async () => {
  await receive(3, '10.0000', '2026-01-01');
  await receive(3, '20.0000', '2026-01-02');
  const r = await postIssue({ ...ctx.issueInput, lines: [{ componentId, qty: 4 }] });
  assert.equal(r.totalCost, '50.00');
  assert.equal((await balance(componentId, warehouseId)), 2);
});
test('insufficient stock rolls back the whole document', async () => {
  await assert.rejects(() => postIssue(... qty 999), (e) => e.code === 'INSUFFICIENT_STOCK');
  assert.equal(await documentsCount(), 0);
  assert.equal(await balance(...), 3);
});
test('two concurrent issues cannot oversell the same batch', async () => {
  await receive(5, '10.0000');
  const results = await Promise.allSettled([postIssue(... qty 4), postIssue(... qty 4)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await balance(...), 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- --test-name-pattern "issue|oversell"`
Expected: FAIL.

- [ ] **Step 3: Implement FIFO posting**

Inside `withTransaction`: freeze check; select batches `FOR UPDATE` ordered by `(received_at, id)`; call `allocateFifo`; insert `batch_consumptions`; update `qty_remaining`; insert negative movements; compute total cost; update document `total_cost`; audit. `previewIssue` runs the same selection without lock and without writes, returns allocations.

- [ ] **Step 4: Implement preview API**

`POST /api/fifo-preview`: `requireAuth`, CSRF, Zod body `{warehouseId, lines:[{componentId, qty}]}`; returns JSON with strings for money. Errors as JSON `{error, message, available?}`.

- [ ] **Step 5: Run tests, lint, format; commit**

Run: `npm run test:integration -- --test-name-pattern "issue|oversell"`; `npm run lint`; `npm run format:check`.
```bash
git add src test
git commit -m "feat: add FIFO issue posting and preview API"
```

---

## Task 13: Transfers

**Files:**
- Modify: `src/repositories/stock.js`, `src/services/stock.js`
- Test: `test/integration/transfers.test.js`

**Interfaces:**
- Produces `postTransfer(...)` → `{ documentId, number, totalCost }`.

- [ ] **Step 1: Write failing transfer tests**

```js
test('transfer preserves unit costs and moves stock between warehouses', async () => {
  await receive(whA, 4, '10.0000');
  const r = await postTransfer({ fromWarehouseId: whA, toWarehouseId: whB, lines: [{ componentId, qty: 3 }], ... });
  assert.equal(await balance(componentId, whA), 1);
  assert.equal(await balance(componentId, whB), 3);
  assert.equal((await batchCost(componentId, whB)), '10.0000');
});
test('source and destination must differ', async () => { /* expect ValidationError */ });
test('transfer is rejected when either warehouse is frozen', async () => { /* expect 409 */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- --test-name-pattern transfer`
Expected: FAIL.

- [ ] **Step 3: Implement transfer transaction**

Freeze check on both warehouses; lock them in ascending id order to avoid deadlocks; FIFO consume on source; create destination batches with each allocation's `unit_cost` and `received_at = docDate`; insert `-qty` and `+qty` movements sharing `document_id`/`line_id`; total cost; audit.

- [ ] **Step 4: Run tests, lint, format; commit**

Run tests; lint; format check.
```bash
git add src test
git commit -m "feat: add inter-warehouse stock transfers"
```

---

## Task 14: Stock operation UI

**Files:**
- Create: `src/controllers/stock.js` (full), `src/views/pages/stock/{receipts,issues,transfers}.ejs`, `{receipt,issue,transfer}-new.ejs`, `document.ejs`
- Create: `public/js/{app,receipt-form,issue-form,transfer-form,toasts,confirm,money}.js`
- Modify: `src/routes/web.js`, `public/css/app.css`
- Test: `test/integration/stock-ui.test.js`

**Interfaces:**
- Consumes `postReceipt/postIssue/postTransfer/previewIssue`.
- Produces routes `/stock/receipts`, `/stock/issues`, `/stock/transfers` and `/:id`; prefilled `/new?componentId=`.
- Produces CSRF meta tag in app layout for fetch (`<meta name="csrf-token" content="...">`).

- [ ] **Step 1: Write failing UI tests**

```js
test('receipt form is available to storekeeper and hidden from analyst', async () => { /* 200 for storekeeper, 403 for analyst */ });
test('POST receipt redirects to document card and shows the number', async () => { /* 302 -> /stock/receipts/:id, page contains ПР- */ });
test('issue form renders and FIFO preview endpoint returns allocations', async () => { /* seed batches, POST api, expect JSON */ });
test('document list paginates and filters', async () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- --test-name-pattern "stock ui|receipt form|document card"`
Expected: FAIL.

- [ ] **Step 3: Build forms and dynamic rows**

`app.js` is the global entry: it imports `toasts.js` and `confirm.js` on every page. Page-specific modules (`receipt-form.js`, `issue-form.js`, `transfer-form.js`, `inventory-form.js`, `charts.js`) are included only by their pages. Receipt: supplier, warehouse, date, comment, rows with component search, qty, unit cost; client totals; server recalculates. Issue: warehouse, date, reason, rows; on component/qty change fetch preview with `X-CSRF-Token`; skeleton while loading; show batch allocations and total. Transfer: from/to, rows; reject same warehouse client-side and server-side. Dynamic row add/remove; at least one row; no inline handlers.

- [ ] **Step 4: Build lists and document cards**

Lists with filters and pagination. Card shows header, lines, batch allocations, total, author, date; no edit buttons. Toasts for success/error. RBAC hides buttons but server enforces.

- [ ] **Step 5: Run tests, lint, format; browser check**

Run tests; start server; use agent-browser to create a receipt `ПР`, verify balance on component card, create an issue, verify FIFO total, create a transfer, verify both warehouses. Screenshots `tmp/smoke/receipt.png`, `issue.png`, `transfer.png`.

- [ ] **Step 6: Commit**

```bash
git add src public test
git commit -m "feat: add stock operation screens"
```

---

## Task 15: Inventory counting service

**Files:**
- Create: `src/repositories/inventory.js`, `src/services/inventory.js`
- Test: `test/integration/inventory.test.js`

**Interfaces:**
- Produces `createCount`, `saveCountLines`, `submitCount`, `approveCount`, `cancelCount`.
- Produces `getActiveCount(client, warehouseId)`.

- [ ] **Step 1: Write failing inventory tests**

```js
test('count snapshots expected quantities and freezes the warehouse', async () => {
  await receive(5);
  const { countId } = await createCount({ warehouseId, ... });
  await assert.rejects(() => postReceipt(...), (e) => e.status === 409);
  const lines = await query('select * from inventory_lines where count_id=$1', [countId]);
  assert.equal(lines.rows[0].expected_qty, 5);
});
test('submit rejects unfilled lines', async () => {
  await assert.rejects(() => submitCount({ countId, ... }), (e) => e.status === 400);
});
test('approval applies positive and negative differences', async () => {
  await saveCountLines({ countId, lines: [{ componentId, actualQty: 8 }] });
  await submitCount({ countId });
  await approveCount({ countId, user: admin });
  assert.equal(await balance(componentId, warehouseId), 8);
  assert.equal(await countStatus(countId), 'approved');
});
test('approval aborts if balance changed since snapshot', async () => {
  await saveCountLines(... actual 8); await submitCount(...);
  await query('update stock_movements set qty_delta = qty_delta + 1 where ...'); // simulate drift
  await assert.rejects(() => approveCount(...), (e) => e.status === 409);
});
test('approved count cannot be approved again', async () => { /* expect 409 */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- --test-name-pattern "inventory|snapshot|approval"`
Expected: FAIL.

- [ ] **Step 3: Implement snapshot and freeze**

`createCount` transaction: lock the warehouse row `FOR UPDATE` (same lock as stock operations), verify no active count, insert count; insert lines for components with balance or movement in 180 days, `expected_qty` from ledger, `unit_cost` weighted average. Translate the partial-unique-index violation (`23505`) into `ConflictError('На складе уже идёт инвентаризация')`. `saveCountLines` only in `draft`; upsert actual/comment. `submitCount`: all actual not null; status `submitted`, `submitted_at`.

- [ ] **Step 4: Implement approval adjustments**

`approveCount` admin-only: lock count; require `submitted`; re-check current balance equals expected for every line; for each difference, positive → create batch at weighted average cost (or last purchase price) and `+` movement; negative → FIFO consume and `-` movement; status `approved`; audit with counts and total adjustment. All in one transaction. `cancelCount` releases freeze.

- [ ] **Step 5: Run tests, lint, format; commit**

Run tests; lint; format check.
```bash
git add src test
git commit -m "feat: add inventory counting workflow"
```

---

## Task 16: Inventory UI

**Files:**
- Create: `src/controllers/inventory.js`, `src/views/pages/inventory/{list,new,show}.ejs`
- Create: `public/js/inventory-form.js`
- Modify: `src/routes/web.js`, `public/css/app.css`
- Test: `test/integration/inventory-ui.test.js`

**Interfaces:**
- Consumes inventory service.
- Produces routes `/inventory`, `/inventory/new`, `/inventory/:id`, actions `lines`, `submit`, `approve`, `cancel`.

- [ ] **Step 1: Write failing UI tests**

```js
test('storekeeper creates a count and sees snapshot lines', async () => { /* 302, page contains expected qty */ });
test('storekeeper sees submit but not approve; admin sees approve', async () => { /* role-specific HTML */ });
test('approve action changes status and redirects with toast', async () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- --test-name-pattern "inventory ui|snapshot lines"`
Expected: FAIL.

- [ ] **Step 3: Build list/create/detail screens**

List with status chips and discrepancies count. Create form: warehouse, comment, warning that warehouse freezes. Detail: search/filter rows, expected/actual/difference, comments, «Заполнить по учёту», «Очистить», save draft, submit, approve (admin), cancel. Print-friendly act.

- [ ] **Step 4: Run tests, lint, format; browser check**

Create a count, fill all lines, submit, approve as admin, verify balance changed and audit row. Screenshots `tmp/smoke/inventory.png`, `inventory-act.png`.

- [ ] **Step 5: Commit**

```bash
git add src public test
git commit -m "feat: add inventory counting screens"
```

---

## Task 17: ABC, XYZ, ROP, KPI domain

**Files:**
- Create: `src/domain/abc.js`, `src/domain/xyz.js`, `src/domain/reorder.js`, `src/domain/kpi.js`
- Test: `test/unit/{abc,xyz,reorder,kpi}.test.js`

**Interfaces:**
- Produces functions from Shared Interfaces.

- [ ] **Step 1: Write failing ABC tests**

```js
test('ABC boundaries are inclusive and stable for ties', () => {
  const r = classifyAbc([{ id: 1, value: '80' }, { id: 2, value: '15' }, { id: 3, value: '5' }]);
  assert.deepEqual(r.map((x) => x.class), ['A', 'B', 'C']);
});
test('zero total marks everything C without NaN', () => {
  const r = classifyAbc([{ id: 1, value: '0' }]);
  assert.equal(r[0].class, 'C');
  assert.equal(r[0].share, 0);
});
```

- [ ] **Step 2: Write failing XYZ tests**

```js
test('stable monthly demand is X', () => assert.equal(classifyXyz([10,10,10,10,10,10]).class, 'X'));
test('high variation is Z', () => assert.equal(classifyXyz([0,0,0,100,0,0]).class, 'Z'));
test('zero mean is Z with null cv', () => { const r = classifyXyz([0,0,0,0,0,0]); assert.equal(r.cv, null); assert.equal(r.class, 'Z'); });
```

- [ ] **Step 3: Write failing ROP/KPI tests**

```js
test('ROP uses z=1.645 and 90-day demand', () => {
  const r = calculateReorder({ dailyQuantities: Array(90).fill(2), leadTimeDays: 5, minStock: 10, balance: 30, unitCost: '100.0000' });
  assert.equal(r.avgDaily, 2);
  assert.equal(r.safetyStock, 0);
  assert.equal(r.rop, 10);
  assert.ok(r.eoq > 0);
});
test('low history falls back to min_stock', () => {
  const r = calculateReorder({ dailyQuantities: Array(90).fill(0), historyDays: 3, leadTimeDays: 5, minStock: 12, balance: 4, unitCost: '10.0000' });
  assert.equal(r.lowData, true);
  assert.equal(r.rop, 12);
  assert.equal(r.suggested, 8);
});
test('KPI returns null instead of dividing by zero', () => {
  assert.deepEqual(calculateKpi({ stockValue: '0', cogs90: '0', deadValue: '0' }), { turnoverYear: null, coverageDays: null });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm run test:unit -- --test-name-pattern "ABC|XYZ|ROP|KPI"`
Expected: FAIL.

- [ ] **Step 5: Implement domain functions**

Implement exactly per spec §6.4–6.7. Use population stddev. `EOQ` via Decimal `sqrt`; if `unitCost <= 0`, `eoq = 0` instead of dividing by zero. Round `rop`/`safetyStock` to 2 decimals, `suggested` up. `lowData` when `historyDays < 14`. `turnoverYear = cogs90 / stockValue * 4`; `coverageDays = stockValue / (cogs90 / 90)`; null when denominator 0.

- [ ] **Step 6: Run tests, lint, format; commit**

Run: `npm run test:unit`; `npm run lint`; `npm run format:check`.
```bash
git add src/domain test/unit
git commit -m "feat: add ABC XYZ reorder and KPI calculations"
```

---

## Task 18: Analytics queries and ABC/XYZ pages

**Files:**
- Create: `src/repositories/analytics.js`, `src/services/analytics.js`, `src/controllers/analytics.js`
- Create: `src/views/pages/analytics/{abc,xyz}.ejs`, `public/js/charts.js`
- Modify: `src/routes/web.js`, `src/views/layouts/base.ejs`
- Test: `test/integration/analytics-abc-xyz.test.js`

**Interfaces:**
- Produces `analyticsService.getAbc(filters)` → `{ rows, summary }`; `getXyz(filters)` → `{ rows, matrix }`.
- Filters: `{ warehouseId?: number, categoryId?: number }`.
- Uses `env.analyticsReferenceDate ?? new Date()`.

- [ ] **Step 1: Write failing analytics tests with fixed fixtures**

```js
test('ABC ranks by stock value from batches and respects warehouse filter', async () => {
  // comp A: 10 * 100 = 1000; comp B: 10 * 10 = 100; comp C: 1 * 1 = 1
  const { rows } = await getAbc({});
  assert.deepEqual(rows.map((r) => r.class), ['A', 'B', 'C']);
});
test('XYZ uses six full months ending at the reference date', async () => {
  // set ANALYTICS_REFERENCE_DATE=2026-11-22; issues only in May..Oct
  const { rows } = await getXyz({});
  assert.equal(rows[0].class, 'X');
});
test('empty warehouse returns empty rows without NaN', async () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- --test-name-pattern "ABC ranks|XYZ uses"`
Expected: FAIL.

- [ ] **Step 3: Implement analytics repository**

ABC: SQL sum `qty_remaining * unit_cost` by component with filters; classify in JS. XYZ: SQL issues grouped by month between reference date minus 6 months and reference date; build 6-length arrays with zeros; classify in JS; matrix crosses ABC and XYZ from the same filters. `pg` returns `SUM(qty)` numeric as strings: cast quantities to `Number` before calling `classifyXyz`/`calculateReorder`, and keep money strings for Decimal. `calculateReorder` requires exactly 90 zero-filled entries; `classifyXyz` requires exactly 6.

- [ ] **Step 4: Build ABC/XYZ pages**

ABC: summary chips, Pareto chart (`data-chart`), table with cumulative share. XYZ: matrix 3×3, table with CV, explanation of formulas. Filters by warehouse/category. Empty state.

- [ ] **Step 5: Run tests, lint, format; browser check**

Run tests; open `/analytics/abc` and `/analytics/xyz`; verify charts render, no console errors; screenshots.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat: add ABC and XYZ analytics"
```

---

## Task 19: Reorder page, dashboard, charts

**Files:**
- Create: `src/controllers/dashboard.js`
- Create: `src/views/pages/analytics/reorder.ejs`
- Modify: `src/views/pages/dashboard.ejs`, `public/js/charts.js`, `src/services/analytics.js`, `src/routes/web.js`, `public/css/app.css`
- Test: `test/integration/analytics-reorder-dashboard.test.js`

**Interfaces:**
- Produces `analyticsService.getReorder(filters)` → `{ rows }`; `getDashboard()` → `{ kpis, categoryValues, attention, matrix, recentMovements }`.

- [ ] **Step 1: Write failing tests**

```js
test('reorder row shows ROP, safety stock and suggested quantity', async () => { /* fixture, expect numbers */ });
test('dashboard KPI cards and attention table render', async () => { /* login, GET /dashboard, expect values */ });
test('dashboard is empty-safe on a fresh database', async () => { /* no movements, no NaN */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- --test-name-pattern "reorder|dashboard"`
Expected: FAIL.

- [ ] **Step 3: Implement queries**

Reorder: daily issue totals per component+warehouse for 90 days, fill zeros, compute `historyDays` from the first movement date (capped at 90) and pass it to `calculateReorder`, calculate per pair, aggregate per component when `warehouseId` absent (sum ROP/suggested, max EOQ). Dashboard: stock value, count of **distinct components** with at least one warehouse below ROP, dead value, turnover; category values; top 8 component+warehouse pairs below ROP; ABC×XYZ matrix; recent 8 movements. Also add the `below_rop` filter to the catalog in this task.

- [ ] **Step 4: Build pages and charts**

Reorder table with filters, low-data badge, formulas in a collapsible note. Dashboard KPI cards, category bar chart, attention table, 3×3 matrix, movement timeline. `charts.js` reads `data-chart`, uses `window.Chart` with forest/moss palette, no shadows, responsive. Chart.js UMD loaded in app layout.

- [ ] **Step 5: Run tests, lint, format; browser check**

Run tests; check dashboard at 1440 and 390; verify charts and no overflow; screenshots `tmp/smoke/dashboard.png`, `reorder.png`.

- [ ] **Step 6: Commit**

```bash
git add src public test
git commit -m "feat: add reorder planning and KPI dashboard"
```

---

## Task 20: Alerts

**Files:**
- Create: `src/repositories/alerts.js`, `src/services/alerts.js`, `src/controllers/alerts.js`
- Create: `src/views/pages/alerts.ejs`, `scripts/recalc-alerts.js`
- Modify: `src/routes/web.js`, `src/views/partials/nav.ejs`, `src/middleware/locals.js`
- Test: `test/integration/alerts.test.js`

**Interfaces:**
- Produces `alertsService.recalculate({ userId, req })`, `list(filters)`, `acknowledge`, `resolve`.
- Produces `npm run alerts`.
- Produces `res.locals.openAlertsCount`.

- [ ] **Step 1: Write failing alert tests**

```js
test('recalculate creates low_stock and stockout alerts idempotently', async () => {
  await receive(2); await setMinStock(10);
  const first = await recalculate();
  const second = await recalculate();
  assert.equal(first.created, 1);
  assert.equal(second.created, 0);
  assert.equal(await openAlertCount(), 1);
});
test('a warehouse with no history gets no alert', async () => { /* component only in WH-MSK; WH-GOM no alert */ });
test('condition gone auto-resolves the alert', async () => { /* receive to above min, recalc, status resolved */ });
test('analyst cannot acknowledge', async () => { /* 403 */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- --test-name-pattern "alert"`
Expected: FAIL.

- [ ] **Step 3: Implement recalculation**

Query active components × warehouses with stock or movement in 180 days. Compute balance, min/max, last issue date. Build candidate alerts (`stockout`, `low_stock`, `overstock`, `dead_stock`) with Russian messages. Upsert open alerts (partial unique index); resolve open alerts whose condition disappeared. Audit `alerts.recalculate` with counts. Run in a transaction.

- [ ] **Step 4: Build alerts page and badge**

List filters type/status/warehouse; acknowledge (admin/storekeeper), resolve (admin); recalc button (admin). Nav badge count from `res.locals.openAlertsCount` only for authenticated users. CLI `scripts/recalc-alerts.js` uses service with system user.

- [ ] **Step 5: Run tests, lint, format; browser check**

Run tests; open `/alerts`; acknowledge an alert; screenshot.

- [ ] **Step 6: Commit**

```bash
git add src scripts test
git commit -m "feat: add stock alerts and recalculation"
```

---

## Task 21: CSV reports

**Files:**
- Create: `src/services/reports.js`, `src/controllers/reports.js`, `src/views/pages/reports.ejs`
- Create: `src/domain/csv.js`
- Modify: `src/routes/web.js`
- Test: `test/unit/csv.test.js`, `test/integration/reports.test.js`

**Interfaces:**
- Produces `toCsv(rows, columns)`, `csvFilename(prefix, date)`.
- Produces `reportsService.export(type, filters, ctx)` → `{ filename, content }`.
- Types: `stock`, `movements`, `abc`, `xyz`, `reorder`, `inventory`, `audit`.

- [ ] **Step 1: Write failing CSV tests**

```js
test('CSV starts with BOM, uses semicolons and CRLF', () => {
  const csv = toCsv([{ name: 'SSD; 1TB', qty: 2 }], [{ key: 'name', label: 'Название' }, { key: 'qty', label: 'Кол-во' }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /Название;Кол-во\r\n/);
  assert.match(csv, /"SSD; 1TB";2/);
});
test('money formatter uses comma decimals', () => { /* format column */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- --test-name-pattern CSV`
Expected: FAIL.

- [ ] **Step 3: Implement CSV and report service**

Escape quotes, semicolons, CR/LF; prefix dangerous spreadsheet formulas (`=`, `+`, `-`, `@`) with `'` to prevent CSV injection. Dates `дд.мм.гггг`; money with comma; qty with spaces. Report queries reuse repositories. Audit `report.export` with type and filters.

- [ ] **Step 4: Build reports page and routes**

`GET /reports` with cards for each report, date range for movements, export buttons. `GET /reports/export/:type` sets `Content-Type: text/csv; charset=utf-8`, `Content-Disposition` with filename, sends content. Admin-only audit report.

- [ ] **Step 5: Run tests, lint, format; verify in Excel-compatible parser**

Run tests; download a CSV with curl after login; check BOM and semicolons. Optionally open in LibreOffice headless if installed.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat: add CSV reports with Excel-safe encoding"
```

---

## Task 22: Audit screen, backups

**Files:**
- Create: `src/views/pages/admin/backups.ejs`
- Modify: `src/controllers/admin.js` (audit filtering + backups), `src/views/pages/admin/audit.ejs`, `src/routes/web.js`
- Create: `scripts/backup.js`, `scripts/restore.js` (Node, cross-platform; `pg_dump`/`pg_restore` from PATH)
- Test: `test/integration/admin-audit-backups.test.js`

**Interfaces:**
- Produces `GET /admin/audit` filters/pagination; `GET /admin/backups` listing `backups/*.dump`.
- Produces `npm run backup`, `npm run restore -- <file>`.

- [ ] **Step 1: Write failing tests**

```js
test('audit page filters by action and hides secrets', async () => { /* insert audit rows, GET, expect one, no password hash */ });
test('backups page lists dump files without exposing contents', async () => { /* create tmp backups/a.dump, expect name/size */ });
test('non-admin gets 403', async () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- --test-name-pattern "audit page|backups"`
Expected: FAIL.

- [ ] **Step 3: Implement audit UI and backup scripts**

Audit filters: user, action, entity type, date range; JSON details in `<details>`. Backups page scans `backups/` (read-only, no download); shows last backup age and instructions. `scripts/backup.js`: spawn `pg_dump --format=custom --file=backups/motherload-YYYYMMDD-HHmmss.dump $DATABASE_URL`, create `backups/` if absent, delete dumps older than 7 days. `scripts/restore.js`: require an explicit `--yes`, then spawn `pg_restore --clean --if-exists --dbname=$DATABASE_URL <file>`. Both work on Windows if PostgreSQL `bin` is in `PATH`; errors are human-readable.

- [ ] **Step 4: Run tests, lint, format; smoke backup**

Run `npm run backup` against dev DB; verify file exists; run `pg_restore --list` on it. Do not run restore on dev without confirmation.

- [ ] **Step 5: Commit**

```bash
git add src scripts test
git commit -m "feat: add audit log and backup tooling"
```

---

## Task 23: Demo seed and Docker reproducibility

**Files:**
- Create: `db/seed/data.js`, `scripts/reset-db.js`
- Modify: `src/db/seed.js`, `scripts/docker-entrypoint.sh`, `docker-compose.yml`, `.env.example`
- Test: `test/integration/seed.test.js`

**Interfaces:**
- Produces `seed({ referenceDate, force })`; idempotent unless `force`.
- Produces demo data exactly per AGENTS §3: 3 warehouses, 10 categories, 6 suppliers, 60 components, 3 users, 6 months of history.
- Produces `npm run db:reset`.

- [ ] **Step 1: Write failing seed tests**

```js
test('seed is idempotent and creates demo users', async () => {
  await seed({ referenceDate: '2026-11-22' });
  await seed({ referenceDate: '2026-11-22' });
  assert.equal((await query('select count(*)::int from components')).rows[0].count, 60);
  assert.equal((await query('select count(*)::int from users')).rows[0].count, 3);
});
test('demo analytics are stable across reseeds', async () => {
  const before = await getAbc({});
  await seed({ referenceDate: '2026-11-22', force: true });
  const after = await getAbc({});
  assert.deepEqual(after.rows.map((r) => [r.sku, r.class]), before.rows.map((r) => [r.sku, r.class]));
});
test('demo data contains low stock, dead stock and overstock cases', async () => { /* counts > 0 */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:integration -- --test-name-pattern seed`
Expected: FAIL.

- [ ] **Step 3: Build demo data**

`data.js`: warehouses (WH-MSK/WH-GOM/WH-BRE), 10 categories, 15 manufacturers, 6 suppliers with Belarusian fictional data, 60 components across CPU/motherboard/RAM/storage/GPU/PSU/case/cooling/peripherals/network with realistic models, BYN prices, specs JSON, min/max and lead times. 3 demo users from AGENTS. Mark fictional in comments.

History generator: deterministic mulberry32 seed `20261122`; for each component, pick 1–2 warehouses, initial receipt 150–170 days before reference, then 12–20 receipt/issue events over 26 weeks, capping every document date at the reference date (not every component every week — keep the seed under ~2000 documents); ensure non-negative; deliberately leave some components low, some overstocked, some with no issues for 120 days. Use `postReceipt/postIssue` services so batches/ledger stay consistent; pass a synthetic `req` context (`{ ip: null, get: () => null }`) because audit accepts `req` optionally. Run `alertsService.recalculate` at the end. Use reference date for all document dates.

- [ ] **Step 4: Make Docker one-command**

`docker-entrypoint.sh`: wait for DB, migrate, if `SEED_DEMO=true` run seed (idempotent), start server. `docker-compose.yml` passes `ANALYTICS_REFERENCE_DATE=2026-11-22`, `SEED_DEMO=true`, `SESSION_SECRET` from `.env` required. Add healthcheck for app. `scripts/reset-db.js` truncates and reseeds with `force`.

- [ ] **Step 5: Verify fresh Docker run**

Run `docker compose down -v && docker compose up --build -d`; wait for healthy; `curl /healthz`; login with demo credentials; check dashboard. Run tests; lint; format.

- [ ] **Step 6: Commit**

```bash
git add db src scripts docker-compose.yml .env.example test
git commit -m "chore: add reproducible demo data and container startup"
```

---

## Task 24: Docs, CI, smoke, final polish

**Files:**
- Create: `README.md`, `DEPLOYMENT.md`, `IMPROVEMENTS.md`, `.github/workflows/ci.yml`, `scripts/smoke.sh`, `scripts/gen-cert.js`
- Modify: `public/css/app.css`, views for responsive/a11y fixes
- Test: manual + `npm run smoke`

**Interfaces:**
- Produces complete quick start for Docker and Windows/local; demo accounts; commands; security/backup notes; CI.

- [ ] **Step 1: Write README and DEPLOYMENT**

README: what Motherload is, screenshots (if available), stack, quick start Docker, local setup, demo accounts, commands, architecture, security notes, project structure, license note. Add a troubleshooting note: a pre-`version` `schema_migrations` table from an early build must be dropped or the database recreated before `db:migrate` (`42703`), because migration history is intentionally not auto-renamed. DEPLOYMENT: Windows 10+ manual steps (Node 24, PostgreSQL 18, role/db creation, `.env`, migrations, seed, start), HTTPS with `npm run cert`, backup/restore and Task Scheduler example, Docker production notes. `scripts/gen-cert.js` uses the `selfsigned` package to write `certs/key.pem` and `certs/cert.pem` for `localhost` (works on Windows without OpenSSL). `IMPROVEMENTS.md` with known non-critical items (if any).

- [ ] **Step 2: Add CI**

`.github/workflows/ci.yml`: on push/PR; Ubuntu; Node 24; PostgreSQL 18 service with healthcheck; env `DATABASE_URL`, `TEST_DATABASE_URL`, `SESSION_SECRET`, `ANALYTICS_REFERENCE_DATE`; step `psql "$DATABASE_URL" -c 'CREATE DATABASE motherload_test'` (or create both DBs via service env); `npm ci`; `npm run lint`; `npm run format:check`; `npm test`. Cache npm. No deploy.

- [ ] **Step 3: Add smoke script**

`scripts/smoke.sh`: requires server at `$APP_URL`; `agent-browser` session; open `/`; snapshot; login admin; assert dashboard heading; open components; open first component; open receipt form; create a receipt of 1 unit on a seeded component; assert success toast; logout; close. Screenshots to `tmp/smoke/`. Fail with non-zero exit on assertion failure.

- [ ] **Step 4: Accessibility and responsive pass**

Check keyboard navigation, focus-visible, labels, contrast, `aria-current`, table headers; 390/768/1440 layouts; no horizontal scroll except tables; `prefers-reduced-motion`; print act. Fix issues in `public/css/app.css` and views.

- [ ] **Step 5: Full verification**

Run `npm run lint`, `npm run format:check`, `npm test`, `docker compose down -v && docker compose up --build -d`, `curl /healthz`, `npm run smoke`. Record results.

- [ ] **Step 6: Screenshots for defense**

Use agent-browser to capture `/`, `/dashboard`, `/components`, component card, receipt form, ABC, XYZ, reorder, alerts, inventory act at 1440. Save to `docs/screenshots/` only if the owner wants them committed; otherwise `tmp/smoke/`.

- [ ] **Step 7: Commit**

```bash
git add README.md DEPLOYMENT.md IMPROVEMENTS.md .github scripts public src test
git commit -m "docs: add deployment guide CI and smoke checks"
```

---

## Builder-Check Resolutions

Закрыты на этапе спеки, чтобы исполнители не гадали:

- Комплектующие: CRUD у admin, архив вместо удаления при истории (Task 8).
- Пороги: `min_stock`/`max_stock` на каждом складе; ROP по паре «позиция + склад» (Tasks 9, 19).
- Документы: создаются сразу проведёнными, номера автоматические (Tasks 11–13).
- Инвентаризация: заморозка склада, обязательный факт во всех строках, повторная сверка при утверждении (Task 15).
- Дата аналитики: `ANALYTICS_REFERENCE_DATE` в демо/тестах (Tasks 17–19, 23).
- Ложные алерты на складах без истории: фильтр активности 180 дней (Task 20).

## Self-Review Notes

- **Spec coverage:** продукт, роли, 13 операций, модель данных, FIFO, ABC/XYZ/ROP, алерты, KPI, CSV, аудит, бэкапы, безопасность, SEO, дизайн, Docker, Windows, тесты — покрыты Tasks 1–24.
- **Type consistency:** `postReceipt/postIssue/postTransfer`, `allocateFifo`, `classifyAbc/classifyXyz`, `calculateReorder`, `toCsv`, `createCount/approveCount` используются одинаково во всех задачах.
- **Review Focus tests:** concurrency — Task 12; freeze — Task 15; Decimal — Tasks 10/21; RBAC — Tasks 5/11/15; empty analytics — Task 17.
- **Known gap:** полноценный визуальный regression и нагрузочное тестирование не входят в курс; отмечено в `IMPROVEMENTS.md` при выполнении.

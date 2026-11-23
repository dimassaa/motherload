# Motherload

**Motherload** — складской терминал для анализа и мониторинга запасов комплектующих компьютерной техники. Внутренняя система вымышленной белорусской компании: приёмка, расход по FIFO, перемещения, инвентаризация, ABC/XYZ, точка заказа, алерты, KPI, отчёты и аудит.

Интерфейс полностью на русском языке, суммы — в BYN со знаком НБРБ, даты и часовой пояс — `Europe/Minsk`. Все компании, сотрудники, телефоны и адреса в демо-данных вымышлены.

> Учебный проект по дисциплине «Проектирование и разработка web-приложений». Это не готовый коммерческий продукт: перед реальной эксплуатацией прочитайте раздел [«Production»](#production) и `DEPLOYMENT.md`.

## Возможности

- Каталог из 60 демо-позиций с остатками по складам, стоимостью, min/max и ROP.
- Приёмка, расход по FIFO и перемещения между складами; документы создаются сразу проведёнными и не редактируются.
- Инвентаризация со снимком учётных остатков, обязательным фактом и утверждением администратором; склад заморожен на время пересчёта.
- ABC по стоимости запаса, XYZ по регулярности, точка заказа, страховой запас, EOQ и рекомендуемый заказ на пару «позиция + склад».
- Дашборд с KPI, графиком стоимости по категориям и матрицей ABC × XYZ.
- Идемпотентные алерты: нет остатка, ниже минимума, избыток, без движения 90+ дней.
- CSV-отчёты для Excel: остатки, движения, ABC, XYZ, точка заказа, акт инвентаризации, аудит.
- Роли `admin` / `storekeeper` / `analyst`, сессии в PostgreSQL, CSRF, CSP, rate limit, аудит каждой мутации.
- Резервные копии `pg_dump` с хранением 7 дней; веб-доступа к дампам нет.

## Стек

| Слой | Технология |
|---|---|
| Runtime | Node.js 24 LTS |
| Сервер | Express 5 |
| Шаблоны | EJS 3, SSR |
| База данных | PostgreSQL 18 |
| Доступ к БД | `pg` + параметризованный SQL, без ORM |
| Деньги | `decimal.js` |
| Валидация | Zod |
| Логи | Pino + `pino-http` |
| Сессии | `express-session` + `connect-pg-simple` |
| Пароли | Argon2id |
| Графики | Chart.js 4 + собственный SVG |
| Стили | один `public/css/app.css` |
| Клиент | нативные ES-модули без сборщика |
| Тесты | `node:test` + Supertest |
| Деплой | Docker Compose и ручная установка (Windows/Linux) |

## Быстрый старт в Docker

Нужны Docker Engine 24+ и **плагин Compose v2** (команда `docker compose`, не устаревшая `docker-compose`).

```bash
cp .env.example .env
```

В `.env` замените `SESSION_SECRET` на случайную строку не короче 32 символов (и `POSTGRES_PASSWORD`, если база будет доступна кому-то кроме вас):

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Затем:

```bash
docker compose up --build
```

Приложение доступно на [http://localhost:3000](http://localhost:3000). Контейнер сам ждёт готовности PostgreSQL, применяет миграции и при `SEED_DEMO=true` засевает демо-данные, если база пуста. Данные лежат в named volume `motherload-db`.

Полный сброс демо-базы:

```bash
docker compose down -v
docker compose up --build
```

В PowerShell те же команды работают без изменений, только копирование файла выглядит иначе: `Copy-Item .env.example .env`.

### Демо-доступы

| Роль | Email | Пароль | Имя |
|---|---|---|---|
| admin | `admin@motherload.by` | `Admin!23456` | Алексей Ковалёв |
| storekeeper | `sklad@motherload.by` | `Sklad!23456` | Марина Сидорова |
| analyst | `analyst@motherload.by` | `Analyst!2345` | Дмитрий Лебедев |

**Пароли существуют только для локального демо. В production смените их до первого рабочего дня** — через «Профиль» или раздел «Пользователи»; подробности в `DEPLOYMENT.md`.

## Локальный запуск без Docker

Понадобятся Node.js 24 LTS и PostgreSQL 18.

1. Создайте роль и базы (от суперпользователя `postgres`):

   ```sql
   CREATE ROLE motherload LOGIN PASSWORD 'motherload';
   CREATE DATABASE motherload OWNER motherload;
   CREATE DATABASE motherload_test OWNER motherload;
   ```

2. Создайте `.env` и проверьте `DATABASE_URL` / `TEST_DATABASE_URL`:

   ```bash
   cp .env.example .env
   ```

3. Установите зависимости, примените миграции и загрузите демо-данные:

   ```bash
   npm ci
   npm run db:migrate
   npm run db:seed
   ```

4. Запустите dev-сервер:

   ```bash
   npm run dev
   ```

5. Откройте [http://localhost:3000](http://localhost:3000) и войдите одним из демо-аккаунтов.

`npm run db:seed` идемпотентен: повторный запуск ничего не дублирует. `npm run db:reset` полностью пересоздаёт демо-данные и запрещён при `NODE_ENV=production`.

## Команды

| Команда | Назначение |
|---|---|
| `npm ci` | установка зависимостей по lock-файлу |
| `npm run dev` | разработка с `node --watch` |
| `npm start` | запуск сервера |
| `npm run db:migrate` | применить неприменённые миграции |
| `npm run db:seed` | демо-данные (идемпотентно) |
| `npm run db:reset` | сброс и повторный сидинг dev-базы |
| `npm run alerts` | пересчитать алерты |
| `npm run lint` | ESLint |
| `npm run format` / `npm run format:check` | Prettier: записать / проверить |
| `npm test` | unit + integration |
| `npm run test:unit` | только unit-тесты |
| `npm run test:integration` | интеграционные тесты с реальным PostgreSQL |
| `npm run backup` | `pg_dump` в `backups/`, удаление копий старше 7 дней |
| `npm run restore -- <файл> --yes` | восстановление базы из дампа |
| `npm run cert` | self-signed сертификат в `certs/` для локального HTTPS |
| `npm run smoke` | браузерный сценарий; нужен запущенный сервер и `agent-browser`; адрес — `APP_URL` (по умолчанию `http://localhost:3000`) |
| `docker compose up --build` | полный запуск в Docker |

На Windows для `npm run smoke` нужен Git Bash или WSL: скрипт написан на `bash` и использует `curl` и `agent-browser`.

## Архитектура

```
routes → middleware → controller → service → repository → PostgreSQL
                                   ↓
                                 view (EJS)
```

- **controller** — HTTP, Zod-валидация, вызов сервиса, redirect/render. SQL здесь нет.
- **service** — бизнес-правила, транзакции, вызов чистых доменных функций.
- **repository** — параметризованный SQL и маппинг строк. HTTP-объектов здесь нет.
- **domain** — чистые функции (`fifo`, `abc`, `xyz`, `reorder`, `kpi`, `csv`, `money`), которые тестируются без базы.
- **view** — только подготовленные данные; никакой бизнес-логики и SQL.

Остаток не хранится отдельным полем: источник истины — движения (`stock_movements`) и партии (`stock_batches`). Деньги всегда идут через `decimal.js`; `numeric` из PostgreSQL остаётся строкой до форматирования.

### Структура проекта

```
src/
  app.js, server.js
  config/            проверка окружения, константы склада
  db/                пул, миграции, сидинг
  middleware/        auth, CSRF, rate limit, ошибки, locals
  domain/            FIFO, ABC, XYZ, ROP, KPI, CSV, деньги
  repositories/      SQL
  services/          бизнес-логика и транзакции
  controllers/       HTTP-слой
  routes/            web и api
  views/             layouts, partials, pages (EJS)
db/
  migrations/        SQL-миграции, только вперёд
  seed/              демо-данные и детерминированная история
public/
  css/app.css        единственная таблица стилей
  js/                прогрессивное улучшение форм и графиков
  fonts/, vendor/    self-hosted ресурсы
scripts/             бэкапы, сертификат, smoke, вспомогательные команды
test/unit/           чистые функции
test/integration/    Supertest + PostgreSQL
```

## Безопасность

- Пароли — Argon2id; пароль не короче 10 символов со строчной, заглавной буквой и цифрой.
- Сессии хранятся в PostgreSQL, cookie `HttpOnly`, `SameSite=Lax`, `Secure` при HTTPS или за доверенным прокси с `X-Forwarded-Proto: https`, TTL 8 часов с продлением.
- CSRF — double-submit: hidden `_csrf` в формах и `X-CSRF-Token` в fetch.
- Helmet и строгий CSP без `unsafe-inline`; inline-скрипты и `onclick` запрещены.
- Rate limit: `/login` — 5 попыток в минуту на IP, остальные маршруты — 300 в минуту.
- RBAC проверяется на сервере для каждого защищённого маршрута; скрытая ссылка не является защитой.
- SQL только параметризованный; EJS экранирует пользовательские данные.
- Каждая мутация пишется в аудит. Пароли, хеши, CSRF-токены и cookie в логи не попадают.
- Дампы лежат только в `backups/` на сервере; веб-доступа и кнопки скачивания нет.

## Production

Короткий чек-лист; полная инструкция — в [`DEPLOYMENT.md`](DEPLOYMENT.md).

- Задайте собственный `SESSION_SECRET` (≥32 символов) и не коммитьте `.env`.
- Смените пароли всех демо-аккаунтов; при необходимости создайте новых пользователей и отключите лишние.
- `SEED_DEMO=false` после первого наполнения базы. На совершенно пустой базе демо-сид нужен один раз, чтобы появились первый администратор и справочники, — затем пароли меняются.
- `ANALYTICS_REFERENCE_DATE=` оставьте пустым: аналитика будет считать «сегодня» по реальному календарю Europe/Minsk. Значение `2026-11-22` — только для демо и тестов.
- `TRUST_PROXY=false`, если приложение опубликовано напрямую. За reverse proxy укажите число переходов (например `1`) или `loopback`, иначе rate limit увидит адрес прокси.
- Включите HTTPS: `npm run cert` для локальной проверки либо сертификат доверенного центра для реального домена.
- Настройте ежедневный `npm run backup` и проверьте восстановление на отдельной базе.
- Не запускайте `npm run db:reset` в production: скрипт удаляет все складские данные.

## Диагностика

**`docker: unknown command: docker compose`.** Установлен только Docker Engine без плагина Compose v2. Поставьте `docker-compose-plugin` (Linux) или используйте Docker Desktop; устаревшая команда `docker-compose` в инструкции не используется.

**Compose пишет `SESSION_SECRET must be set in .env`.** Файл `.env` не создан или переменная пуста. Скопируйте `.env.example` и задайте значение. Compose проверяет только наличие непустой переменной; минимум 32 символа проверяет уже Node при старте, иначе сервер остановится с сообщением «SESSION_SECRET — минимум 32 символа».

**`schema_migrations` от старой версии.** Мигратор хранит в таблице полные имена файлов. Если база осталась от раннего прототипа с другим форматом версий, текущие миграции попытаются примениться поверх существующих объектов и упадут. Проверьте историю:

```bash
psql "$DATABASE_URL" -c "select version, applied_at from schema_migrations order by version"
```

Для демо-базы проще `npm run db:reset`. Для базы с реальными данными сделайте резервную копию и согласуйте ручную сверку схемы; применённые миграции не редактируются.

**Порт 3000 занят.** Остановите другой процесс или задайте `PORT` в `.env` (в Docker меняется только опубликованный порт, контейнер всё равно слушает 3000).

**`pg_dump`/`pg_restore` не найдены (Windows).** Добавьте `C:\Program Files\PostgreSQL\18\bin` в `PATH` и перезапустите терминал. Проверка: `pg_dump --version`.

**Smoke не запускается.** `npm run smoke` не стартует сервер. Сначала поднимите приложение и убедитесь, что `curl http://localhost:3000/healthz` отвечает, затем установите `agent-browser` (`npm i -g agent-browser && agent-browser install`).

**Нет доступа к `/admin/*`.** Это ожидаемо для ролей `storekeeper` и `analyst`: разделы администратора доступны только `admin`.

## Лицензия и данные

Проект создан в учебных целях. Сторонние библиотеки распространяются по своим лицензиям. Все организации, люди, телефоны, адреса и складские операции в демо-данных вымышлены; совпадения случайны. Не заменяйте демо-данные реальными персональными данными.

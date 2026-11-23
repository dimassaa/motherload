# Развёртывание Motherload

Инструкция для ручной установки на Windows 10+ и Linux, а также замечания для production-запуска в Docker. Для локального демо быстрее воспользоваться разделом «Быстрый старт» в [`README.md`](README.md).

## 1. Требования

| Компонент | Версия | Зачем |
|---|---|---|
| Node.js | 24 LTS | сервер и скрипты |
| PostgreSQL | 18 | база данных и клиентские утилиты `psql`, `pg_dump`, `pg_restore` |
| Git | любая актуальная | получение исходников (необязательно при копировании папки) |
| Браузер | Chrome/Edge/Firefox | интерфейс |
| `agent-browser` + Chrome | для `npm run smoke` | только проверка, не нужен для работы |

`pg_dump` и `pg_restore` должны быть в `PATH`: без них не работают `npm run backup` и `npm run restore`. Проверка:

```bash
node --version
psql --version
pg_dump --version
pg_restore --version
```

## 2. Установка на Windows 10+

### 2.1. Node.js

1. Скачайте **Node.js 24 LTS** (MSI x64) с <https://nodejs.org/> и установите с параметрами по умолчанию.
2. Откройте новый PowerShell и проверьте: `node --version` — должно быть `v24.x`.

### 2.2. PostgreSQL 18

1. Установите PostgreSQL 18 с <https://www.postgresql.org/download/windows/> (EDB installer). Запомните пароль пользователя `postgres`.
2. Добавьте папку клиентских утилит в `PATH`, если установщик этого не сделал:
   `C:\Program Files\PostgreSQL\18\bin`.
3. Перезапустите PowerShell и проверьте `psql --version`, `pg_dump --version`, `pg_restore --version`.
4. Убедитесь, что служба `postgresql-x64-18` запущена (Services → PostgreSQL Server).

### 2.3. Роль и базы

```powershell
psql -U postgres -c "CREATE ROLE motherload LOGIN PASSWORD 'замените-этот-пароль';"
psql -U postgres -c "CREATE DATABASE motherload OWNER motherload;"
psql -U postgres -c "CREATE DATABASE motherload_test OWNER motherload;"
```

Для работы приложения достаточно первой базы. Вторая нужна только для `npm test`; её можно создать позже.

### 2.4. Проект и зависимости

```powershell
cd C:\motherload
npm ci
```

`npm ci` выполняет `postinstall`, который копирует шрифты и локальный ESM-билд Chart.js из `node_modules` в `public/`. Папка `node_modules` в репозиторий не входит.

### 2.5. Файл `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

Минимальный production-набор:

```dotenv
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://motherload:URL-ENCODED-PASSWORD@localhost:5432/motherload
TEST_DATABASE_URL=postgres://motherload:URL-ENCODED-PASSWORD@localhost:5432/motherload_test
SESSION_SECRET=случайная-строка-не-короче-32-символов
SESSION_TTL_HOURS=8
APP_URL=http://localhost:3000
HTTPS=0
TRUST_PROXY=false
TLS_CERT_PATH=
TLS_KEY_PATH=
SEED_DEMO=false
LOG_LEVEL=info
TZ=Europe/Minsk
ANALYTICS_REFERENCE_DATE=
```

- Пароль в `DATABASE_URL` должен быть URL-кодирован (`@`, `:`, `/`, `#` и пробелы заменяются процентами).
- `SESSION_SECRET` сгенерируйте командой:
  `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
- `TRUST_PROXY=false` — приложение доступно напрямую. За IIS/nginx поставьте число переходов (`1`) или `loopback`.
- `ANALYTICS_REFERENCE_DATE=` пустой — «сегодня» берётся из реального календаря Europe/Minsk. Не оставляйте демо-дату `2026-11-22` в production.
- `HTTPS=0` в примере — первый запуск без сертификата. Включите HTTPS по разделу 3 после того, как создадите или получите сертификат; с `HTTPS=1` и пустыми путями приложение не стартует.

### 2.6. Схема и первый администратор

```powershell
npm run db:migrate
```

Дальше выберите один из вариантов.

**Вариант A — быстрый ввод в эксплуатацию (рекомендуется для курсового демо).** Загрузите демо-данные один раз, чтобы появились администратор, склады, справочники и каталог:

```powershell
npm run db:seed
```

Затем войдите как `admin@motherload.by` / `Admin!23456`, сразу смените пароль в «Профиле», создайте реальных пользователей и отключите демо-аккаунты. `SEED_DEMO` на ручной запуск не влияет — он нужен только Docker-entrypoint; всё равно оставьте `false`, чтобы случайный контейнер не подсыпал демо-данные.

**Вариант B — чистая база без демо-каталога.** После миграций создайте первого администратора вручную. Хеш пароля (Argon2id, параметры библиотеки по умолчанию) удобно получить в папке проекта:

```powershell
node --input-type=module -e "import argon2 from 'argon2'; process.stdout.write(await argon2.hash(process.argv[1]))" 'ВашПароль!1'
```

Скопируйте строку `$argon2id$...` и вставьте её в SQL (одинарные кавычки обязательны). Чтобы PowerShell не принял `$argon2id` за переменную, выполняйте вставку в интерактивной сессии `psql`, а не в кавычках командной строки:

```powershell
psql $env:DATABASE_URL
```

```sql
insert into users (email, password_hash, full_name, role)
values ('admin@example.by', '<вставьте-хеш>', 'Администратор', 'admin');
\q
```

Пароль должен содержать не меньше 10 символов, строчную и заглавную буквы и цифру. Склады, категории, производителей и поставщиков администратор добавит через «Справочники»; без них нельзя создать приёмку.

### 2.7. Запуск

```powershell
npm start
```

Откройте `APP_URL`. Для фонового режима используйте службу Windows (например, NSSM) или Task Scheduler с триггером «При запуске системы»; в обоих случаях рабочая папка — `C:\motherload`, команда — `C:\Program Files\nodejs\node.exe src\server.js`.

Приложение пишет структурные логи Pino в stdout; перенаправьте их в файл или журнал службы. Секреты и cookie в логах не печатаются.

## 3. HTTPS

### 3.1. Локальный самоподписанный сертификат

```bash
npm run cert
```

Скрипт использует пакет `selfsigned` и создаёт `certs/key.pem` и `certs/cert.pem` для `localhost` и `127.0.0.1`. OpenSSL не требуется, поэтому команда работает и на Windows. Затем в `.env`:

```dotenv
HTTPS=1
TLS_CERT_PATH=certs/cert.pem
TLS_KEY_PATH=certs/key.pem
APP_URL=https://localhost:3000
```

Перезапустите приложение. Браузер предупредит о самоподписанном сертификате — для локальной проверки это нормально; в production используйте сертификат доверенного центра.

### 3.2. Реальный домен

Положите сертификат и ключ в недоступную для чтения посторонними папку, укажите пути в `TLS_CERT_PATH` / `TLS_KEY_PATH`, включите `HTTPS=1`. Приложение само отдаёт HSTS при secure-соединении.

Если HTTPS терминируется на nginx/IIS, приложение можно оставить на HTTP, но тогда:

- `APP_URL` указывает на внешний HTTPS-адрес;
- `TRUST_PROXY` описывает реальную цепочку прокси (например, `1`), иначе rate limit будет видеть IP прокси;
- заголовок `X-Forwarded-Proto` должен передаваться приложению.

## 4. Резервное копирование и восстановление

### 4.1. Создание копии

```bash
npm run backup
```

Скрипт вызывает `pg_dump` в custom-формате и сохраняет файл `backups/motherload-ГГГГММДД-ЧЧММСС.dump`. При следующем успешном запуске удаляются только файлы этого шаблона старше 7 дней; чужие файлы и ручные копии не трогаются. Браузерного доступа к дампам нет, страница `/admin/backups` показывает только список файлов на сервере.

Требования:

- `pg_dump` в `PATH`;
- корректный `DATABASE_URL`;
- папка `backups/` не должна быть доступна по HTTP (она уже в `.gitignore` и не входит в `public/`).

Проверяйте копию восстановлением на отдельной базе, а не только по размеру файла.

### 4.2. Восстановление

1. Остановите приложение.
2. Убедитесь, что восстанавливаете в нужную базу: команда заменяет объекты в целевой БД.
3. Выполните:

   ```bash
   npm run restore -- backups/motherload-20261123-020000.dump --yes
   ```

4. Запустите приложение и проверьте вход и остатки.

Без флага `--yes` команда отказывается работать. `pg_restore --list` сначала проверяет, что файл действительно является дампом PostgreSQL; текстовый файл с расширением `.dump` будет отклонён, база не изменится. Для восстановления нужен `pg_restore` в `PATH`.

### 4.3. Windows Task Scheduler

1. Откройте **Task Scheduler → Create Task** (не «Basic Task»).
2. **General:** имя `Motherload backup`; «Run whether user is logged on or not»; учётная запись с доступом к папке проекта и базе.
3. **Triggers → New:** Daily, 02:00, включено.
4. **Actions → New → Start a program:**
   - Program: `C:\Program Files\nodejs\node.exe`
   - Arguments: `scripts\backup.js`
   - Start in: `C:\motherload`
5. **Conditions:** снимите «Start the task only if the computer is on AC power», если это сервер.
6. Сохраните и запустите задачу вручную. В колонке **Last Run Result** должно быть `0x0`; файл появится в `C:\motherload\backups`.

Почему `node.exe`, а не `npm`: так задача не зависит от того, найден ли `npm.cmd` в PATH планировщика. Рабочая папка обязательна — скрипт читает `.env` из неё.

Эквивалент через PowerShell (запуск от администратора):

```powershell
$action = New-ScheduledTaskAction -Execute 'C:\Program Files\nodejs\node.exe' `
  -Argument 'scripts\backup.js' -WorkingDirectory 'C:\motherload'
$trigger = New-ScheduledTaskTrigger -Daily -At 02:00
Register-ScheduledTask -TaskName 'Motherload backup' -Action $action -Trigger $trigger `
  -RunLevel Highest
```

### 4.4. Cron (Linux)

```cron
# Daily 02:00, PostgreSQL client tools in PATH, logs next to the app.
PATH=/usr/lib/postgresql/18/bin:/usr/local/bin:/usr/bin:/bin
0 2 * * * cd /opt/motherload && npm run backup >> /var/log/motherload-backup.log 2>&1
```

Если PostgreSQL установлен из пакетов Debian/Ubuntu, путь может быть `/usr/lib/postgresql/18/bin`; проверьте `command -v pg_dump`. Ретенция 7 дней выполняется самим `npm run backup`, отдельный `find` не нужен.

## 5. Production в Docker

```bash
cp .env.example .env
# отредактируйте SESSION_SECRET, POSTGRES_PASSWORD, PORT, APP_URL, SEED_DEMO
docker compose up --build -d
```

Что важно знать:

- `docker-compose.yml` передаёт приложению `DATABASE_URL` вида `postgres://...@db:5432/...`; значение `localhost` из `.env` внутри контейнера не используется.
- Compose подставляет `POSTGRES_PASSWORD` в URL без кодирования: выбирайте для пароля базы буквы и цифры либо кодируйте спецсимволы вручную, иначе приложение не подключится.
- Данные PostgreSQL лежат в named volume `motherload-db`. Удаление `docker compose down -v` уничтожает базу.
- Entrypoint ждёт PostgreSQL, применяет миграции и при `SEED_DEMO=true` засевает демо-данные только в пустую базу. После первого наполнения поставьте `SEED_DEMO=false`.
- `SESSION_SECRET` обязателен; compose не подставляет секрет по умолчанию.
- За reverse proxy задайте `TRUST_PROXY=1` (или фактическое число переходов). Публикация порта напрямую через `ports:` не требует прокси, поэтому по умолчанию `false`.
- Для HTTPS либо терминируйте TLS на прокси, либо смонтируйте `certs/` в контейнер и задайте `HTTPS=1`, `TLS_CERT_PATH`, `TLS_KEY_PATH`.

### 5.1. Бэкапы в Docker

В runtime-образ намеренно не устанавливаются клиентские утилиты PostgreSQL, поэтому `npm run backup` **внутри контейнера приложения** не сработает. Рабочие варианты:

```bash
# Дамп из контейнера базы в папку на хосте:
mkdir -p backups
docker compose exec -T db pg_dump -U motherload -Fc motherload \
  > "backups/motherload-$(date +%Y%m%d-%H%M%S).dump"

# Ретенция для таких файлов (7 дней):
find backups -name 'motherload-*.dump' -mtime +7 -delete
```

Либо установите PostgreSQL client tools на хост, опубликуйте порт базы и запускайте `npm run backup` с `DATABASE_URL`, указывающим на хост. Страница `/admin/backups` читает `backups/` внутри контейнера приложения; чтобы она видела дампы, эту папку нужно смонтировать в контейнер (например, `./backups:/app/backups`). Без монтирования страница останется пустой — это известное ограничение, а не ошибка копирования.

Проверка восстановления в Docker:

```bash
docker compose stop app
docker compose exec -T db pg_restore -U motherload -d motherload --clean --if-exists < backups/<файл>.dump
docker compose start app
```

`pg_restore` читает custom-формат из stdin; для больших дампов удобнее скопировать файл в контейнер через `docker compose cp` и передать путь.

## 6. Обновление версии

1. Сделайте `npm run backup`.
2. Остановите приложение.
3. Получите новую версию (`git pull` или распакуйте архив).
4. `npm ci` (зависимости могли измениться).
5. `npm run db:migrate` — применятся только новые миграции.
6. `npm start`.

В Docker: `docker compose up --build -d`; entrypoint применит миграции сам. Применённые миграции не редактируются: исправление схемы оформляется новой миграцией.

## 7. Чек-лист приёмки

- [ ] `curl http://localhost:3000/healthz` отвечает `{"status":"ok","db":"up"}`.
- [ ] Вход администратором, смена демо-пароля, создание рабочего пользователя.
- [ ] Создана приёмка, остаток и партия видны в каталоге и на карточке.
- [ ] Расход списывает FIFO, перемещение меняет остатки двух складов.
- [ ] Инвентаризация утверждается администратором; повторное утверждение отклоняется.
- [ ] `/admin/backups` показывает свежий дамп; восстановление проверено на отдельной базе.
- [ ] `ANALYTICS_REFERENCE_DATE` пуст, ABC/XYZ считаются на реальную дату.
- [ ] HTTPS работает, `TRUST_PROXY` соответствует схеме публикации.
- [ ] Планировщик бэкапов запускается и завершается с кодом 0.

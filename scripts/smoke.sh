#!/usr/bin/env bash
#
# Browser smoke test for Motherload (`npm run smoke`).
#
# PREREQUISITES — the script does not start anything:
#   * a running application at $APP_URL (default http://localhost:3000);
#   * a database with the demo seed, so the demo admin and the seeded supplier,
#     warehouse and component exist;
#   * `agent-browser` installed with a Chrome/Chromium build.
#
# The scenario signs in as the demo admin, checks the dashboard KPIs, opens the
# catalog and a component card, posts a one-unit receipt, and signs out. It
# writes a receipt to the target database, so point it at a demo instance, never
# at production. Screenshots land in tmp/smoke/ (gitignored). Any failed
# assertion exits non-zero so CI and an operator can trust the result.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

APP_URL="${APP_URL:-http://localhost:3000}"
APP_URL="${APP_URL%/}"
SCREENSHOT_DIR="$PROJECT_ROOT/tmp/smoke"
ADMIN_EMAIL="admin@motherload.by"
ADMIN_PASSWORD="Admin!23456"
SESSION=""

fail() {
  printf 'SMOKE FAILED: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  local status=$?
  if [[ -n "$SESSION" ]]; then
    # A screenshot of the failure state is more useful than a stack trace.
    if [[ $status -ne 0 ]]; then
      agent-browser --session "$SESSION" screenshot "$SCREENSHOT_DIR/failure.png" >/dev/null 2>&1 || true
    fi
    agent-browser --session "$SESSION" close >/dev/null 2>&1 || true
  fi
  return $status
}
trap cleanup EXIT

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  # CSS renders many labels in uppercase. The assertion is about the words, not
  # the presentation, so the comparison ignores case (grep -i is UTF-8 aware).
  if ! printf '%s' "$haystack" | grep -Fqi -- "$needle"; then
    fail "$label: ожидалось «$needle», получено «$haystack»"
  fi
}

assert_equals() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  [[ "$actual" == "$expected" ]] ||
    fail "$label: ожидалось «$expected», получено «$actual»"
}

ab() {
  agent-browser --session "$SESSION" "$@"
}

command -v agent-browser >/dev/null 2>&1 ||
  fail "не найден agent-browser. Установите его: npm i -g agent-browser && agent-browser install"

curl -fsS "$APP_URL/healthz" >/dev/null 2>&1 ||
  fail "приложение не отвечает на $APP_URL/healthz. Запустите сервер (npm run dev или docker compose up) и повторите."

mkdir -p "$SCREENSHOT_DIR"
SESSION="$(agent-browser session id --scope worktree --prefix motherload-smoke)"
printf 'Сессия agent-browser: %s\n' "$SESSION"

printf '\n[1/7] Публичная страница и вход\n'
ab open "$APP_URL/"
ab wait --text "Рабочее место"
ab screenshot "$SCREENSHOT_DIR/01-landing.png" >/dev/null
ab find label "Email" fill "$ADMIN_EMAIL"
ab find label "Пароль" fill "$ADMIN_PASSWORD"
ab find role button click --name "Войти"
ab wait --url "**/dashboard"

printf '\n[2/7] Дашборд и KPI\n'
ab wait --text "Обзор склада"
assert_equals "$(ab get text '#dashboard-title')" "Обзор склада" "заголовок дашборда"
kpi_text="$(ab get text '.kpi-grid')"
assert_contains "$kpi_text" "Стоимость запасов" "KPI стоимости запасов"
assert_contains "$kpi_text" "Позиций ниже ROP" "KPI позиций ниже ROP"
assert_contains "$kpi_text" "Стоимость неликвидов" "KPI неликвидов"
ab screenshot "$SCREENSHOT_DIR/02-dashboard.png" >/dev/null

printf '\n[3/7] Каталог комплектующих\n'
ab open "$APP_URL/components"
ab wait --text "Комплектующие"
assert_equals "$(ab get text '#catalog-title')" "Комплектующие" "заголовок каталога"
ab screenshot "$SCREENSHOT_DIR/03-catalog.png" >/dev/null

printf '\n[4/7] Карточка позиции\n'
ab find first "table tbody a[href^='/components/']" click
ab wait "#component-title"
component_title="$(ab get text '#component-title')"
[[ -n "$component_title" ]] || fail "карточка позиции: пустой заголовок"
printf 'Позиция: %s\n' "$component_title"
ab screenshot "$SCREENSHOT_DIR/04-component.png" >/dev/null

printf '\n[5/7] Форма приёмки\n'
ab find role link click --name "Принять"
ab wait --text "Новая приёмка"
assert_equals "$(ab get text '#receipt-new-title')" "Новая приёмка" "заголовок формы приёмки"
ab select "#receipt-supplier" "ООО «БелКомпьютерТрейд»"
ab select "#receipt-warehouse" "Центральный склад · Минск"
ab fill "#stock-line-0-qty" "1"
ab fill "#stock-line-0-unit-cost" "1,00"
ab screenshot "$SCREENSHOT_DIR/05-receipt-form.png" >/dev/null

printf '\n[6/7] Проведение приёмки на 1 единицу\n'
ab find role button click --name "Провести приёмку"
ab wait --text "Приёмка проведена"
flash_text="$(ab get text '.flash__text')"
assert_contains "$flash_text" "Приёмка проведена: ПР-" "сообщение о проведённой приёмке"
printf '%s\n' "$flash_text"
assert_contains "$(ab get text 'body')" "Проведён" "статус проведённого документа"
ab screenshot "$SCREENSHOT_DIR/06-receipt-document.png" >/dev/null

printf '\n[7/7] Выход\n'
ab click ".app-header__logout button"
ab wait --url "$APP_URL/"
ab wait --text "Рабочее место"
assert_equals "$(ab get url)" "$APP_URL/" "URL после выхода"
assert_contains "$(ab get text 'body')" "Войти" "страница входа после выхода"
ab screenshot "$SCREENSHOT_DIR/07-logged-out.png" >/dev/null

printf '\nSMOKE OK: сценарий пройден. Скриншоты: tmp/smoke/\n'

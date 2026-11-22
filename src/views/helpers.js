/**
 * View helpers shared by every EJS template.
 *
 * Display formatting only: values arrive from PostgreSQL as strings and are
 * converted with `Number` solely for `Intl` output. Money arithmetic must use
 * `decimal.js` in the domain layer, never these helpers.
 */

// The spec fixes wall-clock display to Europe/Minsk regardless of the process
// timezone, so a server in another region cannot shift document dates.
const DISPLAY_TIME_ZONE = 'Europe/Minsk';

// Intl renders ru-BY group separators as NBSP; plain spaces keep tests, copied
// text and CSV predictable.
const GROUP_SEPARATOR = '\u00A0';
const PLAIN_SPACE = ' ';

const moneyFormatter = new Intl.NumberFormat('ru-BY', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const qtyFormatter = new Intl.NumberFormat('ru-BY', {
  minimumFractionDigits: 0,
  // Quantities are integers in the schema; three decimals leave room for
  // future fractional units without pretending precision that is not there.
  maximumFractionDigits: 3,
});

const dateFormatter = new Intl.DateTimeFormat('ru-BY', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const dateTimeFormatter = new Intl.DateTimeFormat('ru-BY', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const STATUS_CHIPS = Object.freeze({
  draft: { label: 'Черновик', className: 'chip--muted' },
  submitted: { label: 'На проверке', className: 'chip--warning' },
  approved: { label: 'Утверждена', className: 'chip--success' },
  cancelled: { label: 'Отменена', className: 'chip--muted' },
  posted: { label: 'Проведён', className: 'chip--success' },
  active: { label: 'Активна', className: 'chip--success' },
  inactive: { label: 'Неактивна', className: 'chip--muted' },
  archived: { label: 'В архиве', className: 'chip--muted' },
  open: { label: 'Открыт', className: 'chip--warning' },
  resolved: { label: 'Закрыт', className: 'chip--success' },
  success: { label: 'В норме', className: 'chip--success' },
  ok: { label: 'В норме', className: 'chip--success' },
  info: { label: 'Информация', className: 'chip--info' },
  warning: { label: 'Предупреждение', className: 'chip--warning' },
  low: { label: 'Низкий остаток', className: 'chip--warning' },
  danger: { label: 'Критично', className: 'chip--danger' },
  critical: { label: 'Критично', className: 'chip--danger' },
  error: { label: 'Ошибка', className: 'chip--danger' },
});

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Convert a database numeric string to a finite number for display.
 * Nullish and empty values mean "nothing to show" and render as zero.
 * @throws {TypeError} when the value is not a finite number.
 */
function toDisplayNumber(value, name) {
  if (value === null || value === undefined || value === '') return 0;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${name}: expected a finite number, got ${String(value)}`);
  }
  return number;
}

function withPlainSpaces(formatted) {
  return formatted.replaceAll(GROUP_SEPARATOR, PLAIN_SPACE);
}

/**
 * Format a monetary amount for display: `1 234,56`.
 * The BYN sign is added by {@link money}; this returns text only.
 */
export function formatMoney(value) {
  return withPlainSpaces(moneyFormatter.format(toDisplayNumber(value, 'formatMoney')));
}

/** Format a quantity: `1 234`, `1 234,5`. */
export function formatQty(value) {
  return withPlainSpaces(qtyFormatter.format(toDisplayNumber(value, 'formatQty')));
}

/**
 * Format a calendar date as `дд.мм.гггг`.
 * A `YYYY-MM-DD` string is read as written, never through `Date`, so the
 * calendar day cannot shift between timezones.
 * @throws {TypeError} for anything that is not a real date or Date instance.
 */
export function formatDate(value) {
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
      throw new TypeError(`formatDate: expected YYYY-MM-DD, got ${value}`);
    }
    const [, year, month, day] = match;
    const probe = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    const isRealDate =
      probe.getUTCFullYear() === Number(year) &&
      probe.getUTCMonth() === Number(month) - 1 &&
      probe.getUTCDate() === Number(day);
    if (!isRealDate) {
      throw new TypeError(`formatDate: ${value} is not a real calendar date`);
    }
    return `${day}.${month}.${year}`;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return dateFormatter.format(value);
  }
  throw new TypeError('formatDate: expected a YYYY-MM-DD string or a valid Date');
}

/**
 * Format a timestamp as `дд.мм.гггг ЧЧ:ММ` in Europe/Minsk.
 * @throws {TypeError} for unparseable values.
 */
export function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`formatDateTime: expected a valid date, got ${String(value)}`);
  }
  // The ru-BY pattern inserts a comma between date and time.
  return dateTimeFormatter.format(date).replace(', ', ' ');
}

/** Format an already-percentage value: `12,3%`. */
export function formatPct(value, fractionDigits = 1) {
  const formatter = new Intl.NumberFormat('ru-BY', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  return `${withPlainSpaces(formatter.format(toDisplayNumber(value, 'formatPct')))}%`;
}

/**
 * Render an amount together with the official BYN sign glyph.
 * The output is trusted HTML; the numeric part is validated, so no user text
 * can reach the template unescaped.
 */
export function money(value) {
  return `<span class="money">${formatMoney(value)} <i class="nbrb-icon" aria-hidden="true">BYN</i></span>`;
}

/**
 * Map a stored status to a Russian label and chip modifier.
 * Unknown statuses keep their raw value instead of inventing a colour.
 */
export function statusChip(status) {
  const key = String(status ?? '').toLowerCase();
  const known = STATUS_CHIPS[key];
  if (known) return { ...known };
  return { label: String(status ?? ''), className: 'chip--muted' };
}

/**
 * Build a URL from `base` while preserving its query parameters.
 * Empty, null and undefined values delete the parameter, which is what filter
 * forms expect when a field is cleared.
 */
export function queryString(base, params = {}) {
  const [path, search = ''] = String(base).split('?');
  const query = new URLSearchParams(search);

  for (const [key, rawValue] of Object.entries(params)) {
    if (Array.isArray(rawValue)) {
      query.delete(key);
      for (const item of rawValue) {
        if (item !== null && item !== undefined && item !== '') query.append(key, String(item));
      }
      continue;
    }
    if (rawValue === null || rawValue === undefined || rawValue === '') {
      query.delete(key);
      continue;
    }
    query.set(key, String(rawValue));
  }

  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

/**
 * Hidden CSRF input for classic form posts.
 * Task 4 stores the token on the session; before sessions exist this renders
 * nothing rather than an empty field the server would reject.
 */
export function csrfField(req) {
  const token = req?.session?.csrfToken;
  if (typeof token !== 'string' || token === '') return '';
  return `<input type="hidden" name="_csrf" value="${escapeHtml(token)}">`;
}

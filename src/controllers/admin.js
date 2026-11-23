import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BACKUP_RETENTION_DAYS, formatFileSize, isBackupExpired } from '../domain/backup.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import { fieldErrorsFromZod, messagesFromZod, parseOrThrow } from '../middleware/validate.js';
import * as auditService from '../services/audit.js';
import * as usersService from '../services/users.js';
import { createUserSchema, resetPasswordSchema, updateUserSchema } from '../validation/users.js';

const USERS_PATH = '/admin/users';
const BACKUPS_DIR = fileURLToPath(new URL('../../backups', import.meta.url));

function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

const optionalText = (max) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().max(max).optional().catch(undefined),
  );

const optionalUserId = z.preprocess(
  (value) => (value === undefined || value === '' ? undefined : value),
  z.coerce.number().int().positive().optional().catch(undefined),
);

const optionalDate = z.preprocess(
  (value) => (value === undefined || value === '' ? undefined : value),
  z.string().refine(isRealDate, 'Дата должна существовать').optional().catch(undefined),
);

// Filters never fail the page: a stale bookmark with a malformed value falls
// back to "no filter" instead of a 400 the user cannot act on.
const auditQuerySchema = z.object({
  userId: optionalUserId,
  action: optionalText(120),
  entityType: optionalText(60),
  from: optionalDate,
  to: optionalDate,
  page: z.preprocess(
    (value) => (value === undefined || value === '' ? 1 : value),
    z.coerce.number().int().min(1).max(100000).catch(1),
  ),
});

/** A malformed :id names no user; a 404 is the honest response. */
function parseUserId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError('Пользователь не найден.');
  return id;
}

/** Submitted strings survive a failed render so the form does not go blank. */
function submittedValues(body = {}) {
  return {
    fullName: typeof body.fullName === 'string' ? body.fullName : '',
    email: typeof body.email === 'string' ? body.email : '',
    role: typeof body.role === 'string' ? body.role : 'storekeeper',
    phone: typeof body.phone === 'string' ? body.phone : '',
  };
}

function storedValues(user) {
  return {
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    phone: user.phone ?? '',
  };
}

function renderUserForm(
  res,
  {
    status = 200,
    mode,
    values,
    user = null,
    fieldErrors = {},
    errors = [],
    passwordErrors = {},
    passwordMessages = [],
  },
) {
  res.status(status).render('pages/admin/users/form', {
    title: mode === 'create' ? 'Новый пользователь — Motherload' : `${user.fullName} — Motherload`,
    mode,
    formAction: mode === 'create' ? USERS_PATH : `${USERS_PATH}/${user.id}`,
    values,
    user,
    fieldErrors,
    errors,
    passwordErrors,
    passwordMessages,
    isSelf: user !== null && user.id === res.locals.currentUser?.id,
  });
}

/** `GET /admin/users` — the account table. */
export async function showUsers(req, res, next) {
  try {
    const users = await usersService.list();
    res.render('pages/admin/users/list', {
      title: 'Пользователи — Motherload',
      users,
    });
  } catch (error) {
    next(error);
  }
}

/** `GET /admin/users/new` — empty creation form. */
export function showNewUser(req, res) {
  renderUserForm(res, { mode: 'create', values: submittedValues() });
}

/** `POST /admin/users` (and `/admin/users/new`) — create an account. */
export async function createUser(req, res, next) {
  const parsed = createUserSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    renderUserForm(res, {
      status: 400,
      mode: 'create',
      values: submittedValues(req.body),
      fieldErrors: fieldErrorsFromZod(parsed.error),
      errors: messagesFromZod(parsed.error),
    });
    return;
  }

  try {
    const user = await usersService.create(parsed.data, { req });
    req.flash('success', `Пользователь ${user.fullName} создан.`);
    res.redirect(USERS_PATH);
  } catch (error) {
    // A duplicate email is a form-level problem; keep the entered values and
    // show the message above the form instead of an unstyled error page.
    if (error instanceof ValidationError) {
      renderUserForm(res, {
        status: 400,
        mode: 'create',
        values: submittedValues(req.body),
        errors: [error.message],
      });
      return;
    }
    next(error);
  }
}

/** `GET /admin/users/:id` — edit form, password reset and access control. */
export async function showEditUser(req, res, next) {
  try {
    const user = await usersService.getById(parseUserId(req.params.id));
    renderUserForm(res, { mode: 'edit', user, values: storedValues(user) });
  } catch (error) {
    next(error);
  }
}

/** `POST /admin/users/:id` — change name, role and phone. */
export async function updateUser(req, res, next) {
  try {
    const id = parseUserId(req.params.id);
    const user = await usersService.getById(id);
    const parsed = updateUserSchema.safeParse(req.body ?? {});

    if (!parsed.success) {
      renderUserForm(res, {
        status: 400,
        mode: 'edit',
        user,
        values: { ...submittedValues(req.body), email: user.email },
        fieldErrors: fieldErrorsFromZod(parsed.error),
        errors: messagesFromZod(parsed.error),
      });
      return;
    }

    await usersService.update(id, parsed.data, { req });
    req.flash('success', 'Изменения сохранены.');
    res.redirect(USERS_PATH);
  } catch (error) {
    if (error instanceof ValidationError) {
      // The service refuses changes that would remove the last administrator;
      // show that on the form rather than on the generic error page.
      const user = await usersService.getById(parseUserId(req.params.id)).catch(() => null);
      if (user) {
        renderUserForm(res, {
          status: 400,
          mode: 'edit',
          user,
          values: storedValues(user),
          errors: [error.message],
        });
        return;
      }
    }
    next(error);
  }
}

/** `POST /admin/users/:id/password` — administrator password reset. */
export async function resetPassword(req, res, next) {
  try {
    const id = parseUserId(req.params.id);
    const user = await usersService.getById(id);
    const parsed = resetPasswordSchema.safeParse(req.body ?? {});

    if (!parsed.success) {
      renderUserForm(res, {
        status: 400,
        mode: 'edit',
        user,
        values: storedValues(user),
        errors: [],
        passwordErrors: fieldErrorsFromZod(parsed.error),
        passwordMessages: messagesFromZod(parsed.error),
      });
      return;
    }

    const { keepsCurrentSession } = await usersService.adminResetPassword(
      id,
      parsed.data.password,
      { req, sessionId: req.sessionID ?? null },
    );
    req.flash(
      'success',
      keepsCurrentSession
        ? 'Пароль изменён. Текущий сеанс сохранён, остальные завершены.'
        : 'Пароль обновлён. Все сеансы пользователя завершены.',
    );
    res.redirect(`${USERS_PATH}/${id}`);
  } catch (error) {
    next(error);
  }
}

/** `POST /admin/users/:id/toggle` — open or close access for an account. */
export async function toggleUser(req, res, next) {
  try {
    const user = await usersService.toggleActive(parseUserId(req.params.id), { req });
    req.flash(
      'success',
      user.isActive
        ? `Доступ для ${user.fullName} восстановлен.`
        : `Доступ для ${user.fullName} закрыт.`,
    );
    res.redirect(USERS_PATH);
  } catch (error) {
    next(error);
  }
}

// Secrets must never reach the audit screen. Writers already keep them out of
// `details` (the service contract says so), but the page applies the same rule
// on read: a missed call site must not leak a hash to administrators.
const SECRET_DETAIL_KEY = /pass(?:word|wd)?|hash|token|secret|authorization|cookie|session/i;

/**
 * Replace values under secret-looking keys, walking nested objects and arrays.
 * The key names stay visible so an operator sees that something was recorded,
 * while the value is replaced with a fixed placeholder.
 * @param {unknown} value
 * @param {number} [depth] guards against pathological nesting in old rows
 * @returns {unknown}
 */
function redactSecretDetails(value, depth = 0) {
  if (depth > 5) return '[вложенность скрыта]';
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretDetails(item, depth + 1));
  }
  if (value === null || typeof value !== 'object') return value;

  const redacted = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = SECRET_DETAIL_KEY.test(key) ? '[скрыто]' : redactSecretDetails(item, depth + 1);
  }
  return redacted;
}

/** A details block that renders as an em dash instead of `{}` when empty. */
function detailsJsonOrNull(details) {
  const redacted = redactSecretDetails(details ?? {});
  if (redacted && typeof redacted === 'object' && Object.keys(redacted).length === 0) return null;
  return JSON.stringify(redacted, null, 2);
}

/** `GET /admin/audit` — filtered, paginated security log. */
export async function showAudit(req, res, next) {
  try {
    const filters = parseOrThrow(auditQuerySchema, req.query ?? {});
    const [result, options] = await Promise.all([
      auditService.list(filters),
      auditService.filterOptions(),
    ]);

    const entries = result.entries.map((entry) => ({
      ...entry,
      // Pretty JSON is prepared here so the template stays a renderer; `<%= %>`
      // escapes the result, which also neutralises HTML inside details.
      detailsJson: detailsJsonOrNull(entry.details),
    }));

    // An inverted range is a typo, not "no records": the page says so instead of
    // showing an empty table that looks like a clean log.
    const dateRangeMessage =
      filters.from && filters.to && filters.from > filters.to
        ? 'Дата «с» позже даты «по» — записей в таком диапазоне быть не может.'
        : null;

    res.render('pages/admin/audit', {
      title: 'Аудит — Motherload',
      entries,
      filters,
      options,
      page: result.page,
      totalPages: result.totalPages,
      total: result.total,
      dateRangeMessage,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Age of a backup in words: `только что`, `2 часа назад`, `3 дня назад`.
 * Abbreviations would be shorter but read as machine output on a screen that is
 * meant to be understood by an administrator.
 */
function formatAge(modifiedAt, now = new Date()) {
  const minutes = Math.floor((now.getTime() - modifiedAt.getTime()) / 60000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) {
    return `${minutes} ${plural(minutes, ['минуту', 'минуты', 'минут'])} назад`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ${plural(hours, ['час', 'часа', 'часов'])} назад`;
  }

  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, ['день', 'дня', 'дней'])} назад`;
}

/** Russian plural form for a count: `1 минуту`, `2 минуты`, `5 минут`. */
function plural(count, [one, few, many]) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** Every `*.dump` in the backups directory, newest first. */
async function listBackupFiles(directory) {
  const names = await readdir(directory);
  const files = [];

  for (const name of names) {
    if (!name.endsWith('.dump')) continue;
    const info = await stat(path.join(directory, name));
    if (!info.isFile()) continue;
    files.push({ name, sizeBytes: info.size, modifiedAt: info.mtime });
  }

  files.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return files;
}

/**
 * `GET /admin/backups` — read-only view of the server-side dump directory.
 *
 * The directory is created when missing so the page is not an error on a fresh
 * install; dumps are never served over HTTP, so there is deliberately no
 * download link.
 */
export async function showBackups(req, res, next) {
  try {
    await mkdir(BACKUPS_DIR, { recursive: true });
    const files = await listBackupFiles(BACKUPS_DIR);
    const now = new Date();

    const rows = files.map((file) => ({
      name: file.name,
      sizeLabel: formatFileSize(file.sizeBytes),
      modifiedAt: file.modifiedAt,
      ageLabel: formatAge(file.modifiedAt, now),
    }));

    const newest = files[0] ?? null;
    const lastBackup = newest
      ? {
          name: newest.name,
          modifiedAt: newest.modifiedAt,
          ageLabel: formatAge(newest.modifiedAt, now),
          expired: isBackupExpired(newest.modifiedAt, now),
        }
      : null;

    res.render('pages/admin/backups', {
      title: 'Резервные копии — Motherload',
      files: rows,
      lastBackup,
      retentionDays: BACKUP_RETENTION_DAYS,
    });
  } catch (error) {
    next(error);
  }
}

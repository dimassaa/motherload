import { z } from 'zod';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import { fieldErrorsFromZod, messagesFromZod } from '../middleware/validate.js';
import * as auditService from '../services/audit.js';
import * as usersService from '../services/users.js';
import { createUserSchema, resetPasswordSchema, updateUserSchema } from '../validation/users.js';

const USERS_PATH = '/admin/users';

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

    await usersService.adminResetPassword(id, parsed.data.password, { req });
    req.flash('success', 'Пароль обновлён. Все сеансы пользователя завершены.');
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

/** `GET /admin/audit` — filtered, paginated security log. */
export async function showAudit(req, res, next) {
  try {
    const filters = auditQuerySchema.parse(req.query ?? {});
    const [result, options] = await Promise.all([
      auditService.list(filters),
      auditService.filterOptions(),
    ]);

    const entries = result.entries.map((entry) => ({
      ...entry,
      // Pretty JSON is prepared here so the template stays a renderer; `<%= %>`
      // escapes the result, which also neutralises HTML inside details.
      detailsJson: JSON.stringify(entry.details ?? {}, null, 2),
    }));

    res.render('pages/admin/audit', {
      title: 'Аудит — Motherload',
      entries,
      filters,
      options,
      page: result.page,
      totalPages: result.totalPages,
      total: result.total,
    });
  } catch (error) {
    next(error);
  }
}

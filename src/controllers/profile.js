import { ValidationError } from '../domain/errors.js';
import { fieldErrorsFromZod, messagesFromZod } from '../middleware/validate.js';
import * as usersService from '../services/users.js';
import { passwordChangeSchema, profileSchema } from '../validation/users.js';

const PROFILE_PATH = '/profile';

function profileValues(source) {
  return {
    fullName: typeof source.fullName === 'string' ? source.fullName : '',
    phone: typeof source.phone === 'string' ? source.phone : '',
  };
}

function renderProfile(
  res,
  {
    status = 200,
    values,
    fieldErrors = {},
    errors = [],
    passwordErrors = {},
    passwordMessages = [],
  },
) {
  res.status(status).render('pages/profile', {
    title: 'Профиль — Motherload',
    values,
    fieldErrors,
    errors,
    passwordErrors,
    passwordMessages,
  });
}

/** `GET /profile` — personal data and password forms. */
export function showProfile(req, res) {
  renderProfile(res, { values: profileValues(req.user) });
}

/** `POST /profile` — change the user's own name and phone. */
export async function updateProfile(req, res, next) {
  const parsed = profileSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    renderProfile(res, {
      status: 400,
      values: profileValues(req.body),
      fieldErrors: fieldErrorsFromZod(parsed.error),
      errors: messagesFromZod(parsed.error),
    });
    return;
  }

  try {
    await usersService.updateOwnProfile(req.user, parsed.data, { req });
    req.flash('success', 'Профиль обновлён.');
    res.redirect(PROFILE_PATH);
  } catch (error) {
    next(error);
  }
}

/**
 * `POST /profile/password` — rotate the password after verifying the current
 * one. The session that submits the form survives; every other session of the
 * same user is invalidated by the service.
 */
export async function changePassword(req, res, next) {
  const parsed = passwordChangeSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    renderProfile(res, {
      status: 400,
      values: profileValues(req.user),
      errors: [],
      passwordErrors: fieldErrorsFromZod(parsed.error),
      passwordMessages: messagesFromZod(parsed.error),
    });
    return;
  }

  try {
    await usersService.changeOwnPassword(req.user, {
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
      sessionId: req.sessionID ?? null,
      req,
    });
    req.flash('success', 'Пароль изменён. Остальные сеансы завершены.');
    res.redirect(PROFILE_PATH);
  } catch (error) {
    // A wrong current password is a field error, not a server failure: keep the
    // profile page and point at the field the user needs to fix.
    if (error instanceof ValidationError) {
      renderProfile(res, {
        status: 400,
        values: profileValues(req.user),
        errors: [],
        passwordErrors: { currentPassword: error.message },
        passwordMessages: [error.message],
      });
      return;
    }
    next(error);
  }
}

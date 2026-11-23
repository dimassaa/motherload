import { z } from 'zod';
import { assertPasswordPolicy, PASSWORD_POLICY_MESSAGE } from '../services/auth.js';

/**
 * Zod schemas for the administration and profile forms.
 *
 * Rules live in one module so the admin creation form, the admin reset form and
 * the profile password form cannot drift apart. Every schema supplies a Russian
 * type-error message: Zod's defaults are English and would leak into the UI when
 * a request is tampered with.
 */

export const ROLE_VALUES = ['admin', 'storekeeper', 'analyst'];

export const PHONE_PATTERN = /^\+375 \(\d{2}\) \d{3}-\d{2}-\d{2}$/;
const PHONE_HINT = 'Телефон в формате +375 (29) 123-45-67';

export const fullNameSchema = z.preprocess(
  (value) => (value === undefined || value === null ? '' : value),
  z
    .string({ error: 'Укажите имя и фамилию' })
    .trim()
    .min(2, 'Имя должно быть не короче 2 символов')
    .max(120, 'Имя слишком длинное'),
);

export const emailSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z
    .string({ error: 'Укажите email' })
    .max(254, 'Email слишком длинный')
    .refine((value) => value !== '', 'Укажите email')
    .refine(
      (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
      'Укажите корректный email, например sklad@motherload.by',
    )
    // Demo data and the Belarusian context use .by addresses only; refusing the
    // rest at the boundary keeps the login directory consistent.
    .refine((value) => value.endsWith('.by'), 'Укажите email в домене .by'),
);

export const phoneSchema = z.preprocess(
  (value) => (value === undefined || value === null ? '' : value),
  z
    .string({ error: PHONE_HINT })
    .trim()
    .max(32, 'Телефон слишком длинный')
    .refine((value) => value === '' || PHONE_PATTERN.test(value), PHONE_HINT)
    .transform((value) => (value === '' ? null : value)),
);

export const roleSchema = z.enum(ROLE_VALUES, {
  error: 'Выберите роль: администратор, кладовщик или аналитик.',
});

export const passwordSchema = z.string({ error: PASSWORD_POLICY_MESSAGE }).refine((value) => {
  try {
    assertPasswordPolicy(value);
    return true;
  } catch {
    return false;
  }
}, PASSWORD_POLICY_MESSAGE);

export const createUserSchema = z.object({
  fullName: fullNameSchema,
  email: emailSchema,
  role: roleSchema,
  phone: phoneSchema,
  password: passwordSchema,
});

// Email is deliberately absent: it is the login and cannot be changed.
export const updateUserSchema = z.object({
  fullName: fullNameSchema,
  role: roleSchema,
  phone: phoneSchema,
});

export const resetPasswordSchema = z.object({ password: passwordSchema });

export const profileSchema = z.object({
  fullName: fullNameSchema,
  phone: phoneSchema,
});

export const passwordChangeSchema = z
  .object({
    currentPassword: z
      .string({ error: 'Введите текущий пароль' })
      .min(1, 'Введите текущий пароль')
      .max(200, 'Слишком длинный пароль'),
    newPassword: passwordSchema,
    repeatPassword: z.string({ error: 'Повторите новый пароль' }).min(1, 'Повторите новый пароль'),
  })
  .superRefine((data, context) => {
    if (data.newPassword !== data.repeatPassword) {
      context.addIssue({
        code: 'custom',
        message: 'Пароли не совпадают.',
        path: ['repeatPassword'],
      });
    }
  });

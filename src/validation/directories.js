import { z } from 'zod';
import { phoneSchema } from './users.js';

/**
 * Zod schemas for the reference-data forms.
 *
 * Every schema normalises its input (trim, uppercase codes, lowercase email)
 * so the repository receives values in the shape the columns expect. Optional
 * fields become `null` instead of an empty string: the database stores an
 * absent value, not a blank one, and the template renders `—`.
 */

const EMAIL_HINT = 'Укажите корректный email, например sales@postavka.by';
const EMAIL_DOMAIN_HINT = 'Укажите email в домене .by';

function requiredText(max, label) {
  return z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    z
      .string({ error: `Укажите ${label}` })
      .min(1, `Укажите ${label}`)
      .max(max, `Слишком длинное значение: не более ${max} символов`),
  );
}

function optionalText(max) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z
      .string({ error: 'Значение должно быть текстом' })
      .trim()
      .max(max, `Слишком длинное значение: не более ${max} символов`)
      .nullable()
      .optional(),
  );
}

const optionalEmailSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
  z
    .string({ error: EMAIL_HINT })
    .trim()
    .toLowerCase()
    .max(254, 'Email слишком длинный')
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, EMAIL_HINT)
    // The project is a Belarusian company directory; a non-.by supplier mailbox
    // would contradict the demo data policy in AGENTS.md.
    .refine((value) => value.endsWith('.by'), EMAIL_DOMAIN_HINT)
    .nullable()
    .optional(),
);

const activeSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === '') return true;
    return value === true || value === 'true' || value === 'on' || value === '1';
  },
  z.boolean({ error: 'Выберите статус записи' }),
);

const sortOrderSchema = z.preprocess(
  (value) => (value === undefined || value === null || value === '' ? 0 : value),
  z.coerce
    .number({ error: 'Порядок сортировки — целое число' })
    .int('Порядок сортировки — целое число')
    .min(0, 'Порядок сортировки не может быть отрицательным')
    .max(10000, 'Порядок сортировки слишком большой'),
);

const leadTimeDaysSchema = z.preprocess(
  (value) => (value === undefined || value === null || value === '' ? undefined : value),
  z.coerce
    .number({ error: 'Укажите срок поставки целым числом дней' })
    .int('Срок поставки — целое число дней')
    .positive('Срок поставки должен быть больше нуля'),
);

const supplierUnpSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : value),
  z
    .string({ error: 'Укажите УНП из 9 цифр' })
    .regex(/^\d{9}$/, 'УНП должен состоять из 9 цифр, например 193456789'),
);

const warehouseCodeSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
  z
    .string({ error: 'Укажите код склада, например WH-MSK' })
    .min(2, 'Код склада должен быть не короче 2 символов')
    .max(16, 'Код склада должен быть не длиннее 16 символов')
    .regex(/^[A-Z0-9][A-Z0-9-]*$/, 'Код склада: латинские буквы, цифры и дефис, например WH-MSK'),
);

const categorySlugSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z
    .string({ error: 'Укажите slug, например комплектующие' })
    .min(2, 'Slug должен быть не короче 2 символов')
    .max(60, 'Slug должен быть не длиннее 60 символов')
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'Slug: строчные латинские буквы, цифры и дефис, например cpu-coolers',
    ),
);

export const categorySchema = z.object({
  name: requiredText(120, 'название категории'),
  slug: categorySlugSchema,
  description: optionalText(500),
  sortOrder: sortOrderSchema,
});

export const manufacturerSchema = z.object({
  name: requiredText(120, 'название производителя'),
  country: optionalText(80),
});

export const supplierSchema = z.object({
  name: requiredText(200, 'название поставщика'),
  unp: supplierUnpSchema,
  contactPerson: optionalText(120),
  phone: phoneSchema,
  email: optionalEmailSchema,
  address: optionalText(250),
  leadTimeDays: leadTimeDaysSchema,
  isActive: activeSchema,
});

export const warehouseSchema = z.object({
  code: warehouseCodeSchema,
  name: requiredText(120, 'название склада'),
  city: requiredText(80, 'город'),
  address: requiredText(250, 'адрес'),
  isActive: activeSchema,
});

/** Entity key → form schema. The controller and service share these keys. */
export const DIRECTORY_SCHEMAS = Object.freeze({
  categories: categorySchema,
  manufacturers: manufacturerSchema,
  suppliers: supplierSchema,
  warehouses: warehouseSchema,
});

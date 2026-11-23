import Decimal from 'decimal.js';
import { z } from 'zod';
import { ValidationError } from '../domain/errors.js';

/**
 * Zod schemas for the component administration forms.
 *
 * The form is the only boundary where a human types money, thresholds and
 * specs. Everything is normalised here — SKU to uppercase, comma decimal
 * separator to a dot, empty selects to null — so the repository always receives
 * the shape the columns expect and no controller re-implements these rules.
 */

/** Spec §5.15.1: 3–32 characters, first uppercase alphanumeric, then digits, letters, hyphen. */
const SKU_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

// The column is `numeric(12,2)`: ten integer digits and two decimals. Rejecting
// longer input at the form keeps PostgreSQL from rounding or overflowing it.
const PRICE_PATTERN = /^\d{1,10}(?:\.\d{1,2})?$/;

/** A specs blob is a small set of key–value pairs, not a document store. */
const SPECS_MAX_LENGTH = 10000;

const ACTIVE_VALUES = new Set(['true', 'on', '1']);
const INACTIVE_VALUES = new Set(['false', 'off', '0']);

/**
 * Parse the specs textarea into the object stored in the `jsonb` column.
 *
 * `null`/`undefined`/blank mean "no characteristics" and become `{}`. Anything
 * that is not a JSON object — an array, a scalar or malformed text — is a form
 * error: the column is an object by contract, and silently wrapping another
 * JSON type would hide the user's mistake.
 * @param {string | null | undefined} text
 * @returns {Record<string, unknown>}
 * @throws {ValidationError} when the text is not a JSON object
 */
export function parseSpecs(text) {
  if (text === null || text === undefined) return {};
  if (typeof text !== 'string') {
    throw new ValidationError('Проверьте JSON: характеристики задаются текстом объекта.');
  }

  const raw = text.trim();
  if (raw === '') return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError(
      'Проверьте JSON: не удалось разобрать текст. Нужен объект вида {"socket": "LGA1700"}.',
    );
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new ValidationError('Проверьте JSON: нужен объект с парами «ключ — значение».');
  }

  return parsed;
}

function requiredText(max, label) {
  return z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    z
      .string({ error: `Укажите ${label}` })
      .min(1, `Укажите ${label}`)
      .max(max, `Слишком длинное значение: не более ${max} символов`),
  );
}

const skuSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
  z
    .string({ error: 'Укажите SKU, например CPU-I7-12700' })
    .regex(
      SKU_PATTERN,
      'SKU: от 3 до 32 символов — заглавные латинские буквы, цифры и дефис, например CPU-I7-12700',
    ),
);

const unitSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? 'шт' : value),
  z
    .string({ error: 'Укажите единицу измерения' })
    .trim()
    .min(1, 'Укажите единицу измерения')
    .max(20, 'Единица измерения — не длиннее 20 символов'),
);

/**
 * Price input: a positive decimal string with at most two decimals.
 * The comma is accepted because the Russian locale writes `1099,90`, then the
 * value is quantised to the column scale and kept as a string for `numeric`.
 */
function priceSchema(label) {
  return z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().replace(',', '.') : value),
    z
      .string({ error: `Укажите ${label}, например 850.00` })
      .min(1, `Укажите ${label}, например 850.00`)
      .regex(PRICE_PATTERN, `${label}: сумма в BYN, например 850.00`)
      .transform((value) => new Decimal(value).toFixed(2)),
  );
}

/**
 * Optional whole number. A blank select or input means "not set" and becomes
 * null; the union checks null before coercion so `null` is not turned into 0.
 * The union carries its own message because the branch errors are English.
 */
function optionalInteger({ label, min = 0, max = 1000000, minMessage, errorMessage }) {
  return z.preprocess(
    (value) => (value === undefined || value === null || value === '' ? null : value),
    z.union(
      [
        z.null(),
        z.coerce
          .number({ error: `${label} — целое число` })
          .int(`${label} — целое число`)
          .min(min, minMessage ?? `${label}: не меньше ${min}`)
          .max(max, `${label}: не больше ${max}`),
      ],
      { error: errorMessage ?? `${label} — целое число` },
    ),
  );
}

const minStockSchema = z.preprocess(
  (value) => (value === undefined || value === null || value === '' ? 0 : value),
  z.coerce
    .number({ error: 'Минимальный запас — целое число' })
    .int('Минимальный запас — целое число')
    .min(0, 'Минимальный запас не может быть отрицательным')
    .max(1000000, 'Минимальный запас слишком большой'),
);

const maxStockSchema = optionalInteger({
  label: 'Максимальный запас',
  min: 0,
  minMessage: 'Максимальный запас не может быть отрицательным',
});

const leadTimeDaysSchema = optionalInteger({
  label: 'Срок поставки',
  min: 1,
  minMessage: 'Срок поставки должен быть больше нуля',
});

const categoryIdSchema = optionalInteger({
  label: 'Категория',
  min: 1,
  max: 2147483647,
  errorMessage: 'Выберите категорию из списка.',
});
const manufacturerIdSchema = optionalInteger({
  label: 'Производитель',
  min: 1,
  max: 2147483647,
  errorMessage: 'Выберите производителя из списка.',
});
const supplierIdSchema = optionalInteger({
  label: 'Поставщик',
  min: 1,
  max: 2147483647,
  errorMessage: 'Выберите поставщика из списка.',
});

/**
 * The select sends `true`/`false`; a hand-built request may send any spelling.
 * Unrecognised values reach `z.boolean` unchanged and fail with a 400 instead
 * of silently archiving the position on a typo.
 */
const activeSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === '') return true;
    if (value === true || ACTIVE_VALUES.has(value)) return true;
    if (value === false || INACTIVE_VALUES.has(value)) return false;
    return value;
  },
  z.boolean({ error: 'Выберите статус: «Опубликована» или «В архиве».' }),
);

const specsSchema = z.preprocess(
  (value) => (value === undefined || value === null ? '' : value),
  z
    .string({ error: 'Характеристики задаются JSON-объектом' })
    .max(SPECS_MAX_LENGTH, `Слишком длинный JSON: не более ${SPECS_MAX_LENGTH} символов`)
    .superRefine((text, ctx) => {
      try {
        parseSpecs(text);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: error.message });
      }
    })
    // Validation has already recorded the issue; the fallback keeps the
    // transform from throwing so the user sees a field error, not a 500.
    .transform((text) => {
      try {
        return parseSpecs(text);
      } catch {
        return {};
      }
    }),
);

/**
 * The database has the same CHECK, but only the form can point at the field
 * the administrator has to correct.
 */
function validateThresholds(data, ctx) {
  if (data.maxStock !== null && data.maxStock < data.minStock) {
    ctx.addIssue({
      code: 'custom',
      path: ['maxStock'],
      message: 'Максимальный запас не может быть меньше минимального.',
    });
  }
}

const editableFields = {
  name: requiredText(200, 'название позиции'),
  categoryId: categoryIdSchema,
  manufacturerId: manufacturerIdSchema,
  defaultSupplierId: supplierIdSchema,
  unit: unitSchema,
  purchasePrice: priceSchema('закупочную цену'),
  retailPrice: priceSchema('розничную цену'),
  minStock: minStockSchema,
  maxStock: maxStockSchema,
  leadTimeDays: leadTimeDaysSchema,
  specs: specsSchema,
  isActive: activeSchema,
};

export const createComponentSchema = z
  .object({ sku: skuSchema, ...editableFields })
  .superRefine(validateThresholds);

/**
 * SKU is an immutable identifier (spec §5.15.1). It is deliberately absent here;
 * the controller rejects a submitted SKU that differs from the stored one.
 */
export const updateComponentSchema = z.object(editableFields).superRefine(validateThresholds);

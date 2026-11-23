/**
 * Validation helpers shared by the SSR controllers.
 *
 * Zod is the single source of truth for field rules; `parseOrThrow` is the
 * throwing variant used when the route has no submitted form to repopulate.
 */

/**
 * Collapse a ZodError into one Russian message per field. The first issue wins:
 * a field shows a single correction, not a paragraph.
 * @param {import('zod').ZodError} error
 * @returns {Record<string, string>}
 */
export function fieldErrorsFromZod(error) {
  const errors = {};
  for (const issue of error.issues) {
    const field = issue.path.join('.') || 'form';
    if (!(field in errors)) errors[field] = issue.message;
  }
  return errors;
}

/**
 * Unique messages in issue order, for the summary block above a form.
 * @param {import('zod').ZodError} error
 * @returns {string[]}
 */
export function messagesFromZod(error) {
  return [...new Set(error.issues.map((issue) => issue.message))];
}

/**
 * Parse input and let the ZodError bubble to the central error middleware.
 * Controllers use the throwing variant when the route has no form to repopulate.
 * @template T
 * @param {import('zod').ZodType<T>} schema
 * @param {unknown} input
 * @returns {T}
 */
export function parseOrThrow(schema, input) {
  return schema.parse(input);
}

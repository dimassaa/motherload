/**
 * Validation helpers shared by the SSR controllers.
 *
 * Zod is the single source of truth for field rules, but the two callers need
 * different outcomes: a form has to re-render with the values the user typed,
 * while a JSON endpoint only needs the standard 400 response. `parseOrThrow`
 * serves the first case and `validateBody` the second.
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

/**
 * Validate `req.body` against a Zod schema. Replacement of `req.body` with the
 * parsed value applies the schema's trimming and normalisation once, so the
 * handler never re-implements it.
 *
 * NOTE: no route uses this middleware yet. The SSR controllers must re-render
 * the submitted form with per-field errors, so they parse explicitly and render
 * themselves. This is the generic variant reserved for the Task 12 JSON API,
 * where a failed body maps to the shared 400 response instead of a form.
 * @param {import('zod').ZodType} schema
 * @returns {import('express').RequestHandler}
 */
export function validateBody(schema) {
  return function bodyValidator(req, res, next) {
    const result = schema.safeParse(req.body ?? {});

    if (!result.success) {
      res.locals.formErrors = messagesFromZod(result.error);
      next(result.error);
      return;
    }

    req.body = result.data;
    next();
  };
}

import { ZodError } from 'zod';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';

const UNEXPECTED_MESSAGE = 'Что-то пошло не так. Попробуйте ещё раз.';

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Reply in the shape the caller expects: API clients want JSON, browsers want a
 * readable page. The HTML is intentionally minimal and does not use the app
 * layout; switching it to the shared error views is an open item in
 * IMPROVEMENTS.md.
 */
function respond(req, res, status, message, details) {
  if (req.path.startsWith('/api')) {
    const body = { error: message };
    if (details !== undefined) body.details = details;
    return res.status(status).json(body);
  }
  return res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html lang="ru"><head><meta charset="utf-8">` +
        `<meta name="robots" content="noindex, nofollow">` +
        `<title>Motherload</title></head><body>` +
        `<h1>Motherload</h1><p>${escapeHtml(message)}</p></body></html>`,
    );
}

export function notFoundHandler(req, res) {
  respond(req, res, 404, 'Страница не найдена. Проверьте адрес.');
}

/**
 * Central error boundary. Known errors keep their status and Russian message;
 * unexpected failures are logged with the request id and never leak internals.
 */
export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    respond(req, res, 400, 'Данные заполнены неверно. Проверьте поля формы.', details);
    return;
  }

  if (error instanceof AppError) {
    respond(req, res, error.status, error.message, error.details);
    return;
  }

  const log = req.log ?? logger;
  log.error({ err: error, requestId: req.id }, 'unhandled request error');
  respond(req, res, 500, UNEXPECTED_MESSAGE);
}

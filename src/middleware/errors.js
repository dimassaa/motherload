import { ZodError } from 'zod';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';

const UNEXPECTED_MESSAGE = 'Что-то пошло не так. Попробуйте ещё раз.';

const ERROR_403 = Object.freeze({
  view: 'pages/errors/403',
  title: 'Доступ запрещён — Motherload',
});
const ERROR_404 = Object.freeze({
  view: 'pages/errors/404',
  title: 'Страница не найдена — Motherload',
});
const ERROR_500 = Object.freeze({
  view: 'pages/errors/500',
  title: 'Ошибка сервера — Motherload',
});

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Keep the old minimal shell for the rare statuses without a dedicated view. */
function minimalHtml(message) {
  return (
    `<!doctype html><html lang="ru"><head><meta charset="utf-8">` +
    `<meta name="robots" content="noindex, nofollow">` +
    `<title>Motherload</title></head><body>` +
    `<h1>Motherload</h1><p>${escapeHtml(message)}</p></body></html>`
  );
}

/**
 * Only the statuses the spec asks to present in the application chrome get a
 * view. Everything else keeps the compact shell: inventing a 409 page would
 * claim more than the product offers.
 */
function resolvePage(status) {
  if (status === 403) return ERROR_403;
  if (status === 404) return ERROR_404;
  if (status >= 500) return ERROR_500;
  return null;
}

function plainFallback(res, status, title, message) {
  res.status(status).type('text/plain').send(`${title}\n\n${message}`);
}

/**
 * Render an error page through the shared layout. The render callback is the
 * recursion guard: if the layout itself fails (missing locals, broken view,
 * lost database connection), the response degrades to plain text instead of
 * entering the error middleware again.
 */
function respondHtml(req, res, status, message) {
  const page = resolvePage(status);
  if (!page) {
    res.status(status).type('html').send(minimalHtml(message));
    return;
  }

  // A server failure must not echo its internal message; the view owns the
  // human wording. Client errors keep their specific explanation (for example
  // the CSRF "refresh the page" guidance).
  const details = status >= 500 ? '' : message;
  res.status(status);

  try {
    res.render(page.view, { title: page.title, errorMessage: details }, (renderError, html) => {
      if (renderError) {
        if (!res.headersSent) {
          (req.log ?? logger).error(
            { err: renderError, requestId: req.id },
            'error page render failed',
          );
          plainFallback(res, status, page.title, message);
        }
        return;
      }

      res.type('html').send(html);
    });
  } catch (renderError) {
    (req.log ?? logger).error({ err: renderError, requestId: req.id }, 'error page render failed');
    plainFallback(res, status, page.title, message);
  }
}

/**
 * Reply in the shape the caller expects: API clients want JSON, browsers want a
 * readable page. HTML errors use the shared layout so header, footer and the
 * Russian explanation match the rest of the application.
 */
function respond(req, res, status, message, details) {
  if (req.path.startsWith('/api')) {
    const body = { error: message };
    if (details !== undefined) body.details = details;
    return res.status(status).json(body);
  }
  return respondHtml(req, res, status, message);
}

export function notFoundHandler(req, res) {
  // The view already carries the heading «Страница не найдена»; this sentence
  // adds guidance without repeating it.
  respond(req, res, 404, 'Проверьте адрес — возможно, ссылка устарела.');
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

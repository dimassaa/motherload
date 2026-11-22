import { AppError } from '../lib/app-error.js';

export { AppError };

/**
 * Domain error hierarchy on top of the shared `AppError` base, so the central
 * error middleware keeps a single `instanceof AppError` branch. Defaults carry
 * the HTTP status; callers may override `code`/`details` through options.
 */
export class ValidationError extends AppError {
  /** @param {string} message @param {{ code?: string, details?: unknown }} [options] */
  constructor(message, options = {}) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', ...options });
  }
}

export class UnauthorizedError extends AppError {
  /** @param {string} message @param {{ code?: string, details?: unknown }} [options] */
  constructor(message, options = {}) {
    super(message, { status: 401, code: 'UNAUTHORIZED', ...options });
  }
}

export class ForbiddenError extends AppError {
  /** @param {string} message @param {{ code?: string, details?: unknown }} [options] */
  constructor(message, options = {}) {
    super(message, { status: 403, code: 'FORBIDDEN', ...options });
  }
}

export class NotFoundError extends AppError {
  /** @param {string} message @param {{ code?: string, details?: unknown }} [options] */
  constructor(message, options = {}) {
    super(message, { status: 404, code: 'NOT_FOUND', ...options });
  }
}

export class ConflictError extends AppError {
  /** @param {string} message @param {{ code?: string, details?: unknown }} [options] */
  constructor(message, options = {}) {
    super(message, { status: 409, code: 'CONFLICT', ...options });
  }
}

/**
 * Raised when an issue or transfer asks for more units than the warehouse holds.
 * Extends `ValidationError` because the request itself is unprocessable; the
 * machine-readable `code` and `available` let services and the FIFO preview
 * distinguish it without parsing the Russian message.
 */
export class InsufficientStockError extends ValidationError {
  /** @param {number} available quantity physically present on the warehouse */
  constructor(available) {
    super(`На складе недостаточно: доступно ${available} шт.`, {
      code: 'INSUFFICIENT_STOCK',
      details: { available },
    });
    this.available = available;
  }
}

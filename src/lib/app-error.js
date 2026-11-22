/**
 * Base class for failures that are safe to show to the user: the message is
 * already human-readable Russian, the status maps to the HTTP response.
 * Domain-specific errors in Task 10 extend this class, so the error middleware
 * can keep a single check.
 */
export class AppError extends Error {
  /**
   * @param {string} message user-facing Russian message
   * @param {{ status?: number, code?: string, details?: unknown }} [options]
   */
  constructor(message, { status = 500, code = 'app_error', details } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

import { pino } from 'pino';
import { env } from '../config/env.js';

/**
 * Process-wide logger. Request-scoped logging goes through `req.log` (pino-http);
 * this instance covers background jobs, CLI scripts and boot-time failures.
 */
export const logger = pino({
  level: env.logLevel,
  // Sessions, credentials and CSRF tokens must never reach the log files, no
  // matter which middleware serialises the request.
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    censor: '[Redacted]',
  },
});

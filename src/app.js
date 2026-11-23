import { fileURLToPath } from 'node:url';
import connectPgSimple from 'connect-pg-simple';
import express from 'express';
import expressLayouts from 'express-ejs-layouts';
import session from 'express-session';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import {
  SESSION_COOKIE_MAX_AGE_MS,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from './config/session.js';
import { pool } from './db/pool.js';
import { logger } from './lib/logger.js';
import { attachUser } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { attachFlash } from './middleware/flash.js';
import { attachLocals } from './middleware/locals.js';
import { createRateLimiters } from './middleware/rate-limit.js';
import { createApiRouter } from './routes/api.js';
import { createWebRouter } from './routes/web.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const viewsDir = fileURLToPath(new URL('./views', import.meta.url));

const CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'self'"],
};

const staticOptions = { index: false };

// connect-pg-simple expects the `sessions` table created by migration 001.
// `createTableIfMissing` stays off so a missing migration fails at boot instead
// of letting the store invent a different schema.
const PgSessionStore = connectPgSimple(session);

/** Build the Express application. Tests call this directly; server.js wraps it in HTTP(S). */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Rate limiting keys off the client IP. Forwarding headers are trusted only
  // when TRUST_PROXY explicitly says a proxy is in front: the shipped Docker
  // setup publishes the app port directly, so the default `false` is required.
  app.set('trust proxy', env.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', viewsDir);
  app.use(expressLayouts);
  app.set('layout', 'layouts/base');
  // Pages own their <script> and <link> placement; automatic extraction would
  // hide ordering and break the "no inline scripts" review checklist.
  app.set('layout extractScripts', false);
  app.set('layout extractStyles', false);

  app.use(
    helmet({
      contentSecurityPolicy: {
        // Explicit list instead of helmet defaults: the defaults inject
        // upgrade-insecure-requests, which breaks plain-HTTP local development.
        useDefaults: false,
        directives: CSP_DIRECTIVES,
      },
      // HSTS is meaningless (and ignored) over plain HTTP; enable it only when
      // this process actually terminates TLS itself.
      hsts: env.https ? { maxAge: 15552000, includeSubDomains: true } : false,
      frameguard: { action: 'deny' },
    }),
  );

  app.use(pinoHttp({ logger }));

  // extended: true parses nested document line arrays (lines[0][componentId]).
  app.use(express.urlencoded({ extended: true }));

  app.use(express.static(publicDir, staticOptions));
  app.use('/vendor', express.static(`${publicDir}/vendor`, staticOptions));

  const { globalLimiter, loginLimiter } = createRateLimiters();
  // Applied after static assets so a page load does not spend the request budget
  // on CSS and fonts, but before sessions so a flood cannot exhaust the pool
  // with session lookups.
  app.use(globalLimiter);

  const sessionStore = new PgSessionStore({
    pool,
    tableName: 'sessions',
    createTableIfMissing: false,
    ttl: env.sessionTtlHours * 3600,
  });

  // This order is required: session → attachUser → attachFlash → attachLocals.
  // Flash reads the session, attachUser resolves req.user from it and
  // attachLocals publishes the authenticated user to every template.
  app.use(
    session({
      name: SESSION_COOKIE_NAME,
      secret: env.sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      // Rolling extends the 8-hour window for active users while the absolute
      // cookie lifetime still bounds a forgotten browser session.
      rolling: true,
      cookie: { ...sessionCookieOptions(), maxAge: SESSION_COOKIE_MAX_AGE_MS },
    }),
  );
  app.use(attachUser);
  app.use(attachFlash);
  app.use(attachLocals);

  app.use('/api', createApiRouter());
  app.use(createWebRouter({ loginLimiter }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

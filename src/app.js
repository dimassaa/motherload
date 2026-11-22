import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { webRouter } from './routes/web.js';

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

/** Build the Express application. Tests call this directly; server.js wraps it in HTTP(S). */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Rate limiting keys off the client IP, so behind one reverse proxy the
  // forwarded address is the trustworthy one.
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', viewsDir);

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
  app.use('/api', express.json());

  app.use(express.static(publicDir, staticOptions));
  app.use('/vendor', express.static(`${publicDir}/vendor`, staticOptions));

  app.use(webRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

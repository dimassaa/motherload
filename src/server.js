import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool } from './db/pool.js';
import { logger } from './lib/logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function createServer(app) {
  if (!env.https) return http.createServer(app);

  const [cert, key] = await Promise.all([readFile(env.tlsCertPath), readFile(env.tlsKeyPath)]);
  return https.createServer({ cert, key }, app);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.port, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * Stop accepting connections, finish in-flight requests, then close the pool.
 * A hard timeout keeps a stuck connection from blocking deploys forever.
 */
function installShutdownHandlers(server) {
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const forceExit = setTimeout(() => {
      logger.error({ signal }, 'graceful shutdown timed out');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      server.closeIdleConnections();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await closePool();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error, signal }, 'graceful shutdown failed');
      process.exit(1);
    }
  }

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

async function start() {
  const server = await createServer(createApp());
  await listen(server);
  logger.info(
    { url: `${env.https ? 'https' : 'http'}://localhost:${env.port}`, env: env.nodeEnv },
    'server listening',
  );
  installShutdownHandlers(server);
}

start().catch((error) => {
  logger.error({ err: error }, 'failed to start server');
  process.exit(1);
});

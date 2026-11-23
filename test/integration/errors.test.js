import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import expressLayouts from 'express-ejs-layouts';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { errorHandler } from '../../src/middleware/errors.js';
import { createTestApp } from '../helpers/app.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';
import { createUserFactory, DEFAULT_TEST_PASSWORD } from '../helpers/factories.js';
import { loginAs } from '../helpers/http.js';

const viewsDir = fileURLToPath(new URL('../../src/views', import.meta.url));

test.before(async () => {
  await setupTestDb();
});

test.beforeEach(async () => {
  await truncateAll();
});

test.after(async () => {
  await teardownTestDb();
});

/**
 * A minimal app that mounts the real error boundary behind a route which always
 * throws. Building the whole app is unnecessary: the point is the 500 page and
 * its fallback, not authentication or stock data.
 * @param {{ views?: string }} [options]
 */
function createFailingApp(options = {}) {
  const app = express();
  const captured = { log: null };

  app.set('view engine', 'ejs');
  app.set('views', options.views ?? viewsDir);
  app.use(expressLayouts);
  app.set('layout', 'layouts/base');
  app.use((req, res, next) => {
    req.id = 'test-request-id';
    req.log = {
      error: (payload) => {
        captured.log = payload;
      },
      warn: () => {},
    };
    res.locals.currentUser = null;
    res.locals.currentPath = req.path;
    res.locals.flash = null;
    res.locals.csrfField = () => '';
    next();
  });
  app.get('/boom', () => {
    throw new Error('sensitive internal failure');
  });
  app.use(errorHandler);

  return { app, captured };
}

test('unknown pages render the 404 page inside the shared app layout', async () => {
  const res = await request(createApp()).get('/there-is-no-such-page');

  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /<a class="skip-link" href="#main">/);
  assert.match(res.text, /<header class="public-header">/);
  assert.match(res.text, /<footer class="site-footer">/);
  assert.match(res.text, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(res.text, /Страница не найдена/);
  assert.match(res.text, /href="\/"/);
  assert.doesNotMatch(res.text, /Error:|at .*\.js:\d+/);
});

test('a missing API route keeps the JSON error shape', async () => {
  await createUserFactory({
    email: 'errors-api@test.by',
    password: DEFAULT_TEST_PASSWORD,
    role: 'admin',
  });
  const { agent } = createTestApp();
  await loginAs(agent, 'errors-api@test.by', DEFAULT_TEST_PASSWORD);

  const res = await agent.get('/api/no-such-endpoint');

  assert.equal(res.status, 404);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.body.error, 'Проверьте адрес — возможно, ссылка устарела.');
});

test('a rejected CSRF token renders the 403 page and keeps the explanation', async () => {
  const res = await request(createApp())
    .post('/login')
    .type('form')
    .send({ email: 'x@y.by', password: 'x' });

  assert.equal(res.status, 403);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /<header class="public-header">/);
  assert.match(res.text, /Доступ запрещён/);
  assert.match(res.text, /Обновите страницу/);
  assert.match(res.text, /href="\/"/);
});

test('unexpected failures render the 500 page, log the request id and leak nothing', async () => {
  const { app, captured } = createFailingApp();

  const res = await request(app).get('/boom');

  assert.equal(res.status, 500);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /<footer class="site-footer">/);
  assert.match(res.text, /Что-то пошло не так/);
  assert.match(res.text, /<meta name="robots" content="noindex, nofollow">/);
  assert.doesNotMatch(res.text, /sensitive internal failure/);
  assert.doesNotMatch(res.text, /at .*\.js:\d+/);
  assert.equal(captured.log.requestId, 'test-request-id');
  assert.equal(captured.log.err.message, 'sensitive internal failure');
});

test('a failing error view falls back to plain text instead of recursing', async () => {
  const { app } = createFailingApp({ views: `${viewsDir}/missing` });

  const res = await request(app).get('/boom');

  assert.equal(res.status, 500);
  assert.match(res.headers['content-type'], /text\/plain/);
  assert.match(res.text, /Что-то пошло не так/);
  assert.doesNotMatch(res.text, /sensitive internal failure/);
});

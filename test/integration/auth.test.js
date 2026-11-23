import assert from 'node:assert/strict';
import test from 'node:test';
import argon2 from 'argon2';
import { query } from '../../src/db/pool.js';
import { createTestApp } from '../helpers/app.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';
import { createUserFactory } from '../helpers/factories.js';
import { getCsrf, loginAs } from '../helpers/http.js';

const PASSWORD = 'Admin!23456';
const WRONG_PASSWORD = 'Wrong!23456';

test.before(async () => {
  await setupTestDb();
});

test.beforeEach(async () => {
  await truncateAll();
});

test.after(async () => {
  await teardownTestDb();
});

async function findAudit(action) {
  const { rows } = await query(
    'select user_id, action, details, ip, user_agent from audit_log where action = $1 order by id',
    [action],
  );
  return rows;
}

test('login succeeds with correct password and redirects to dashboard', async () => {
  const user = await createUserFactory({
    email: 'admin@test.by',
    password: PASSWORD,
    role: 'admin',
  });
  const { agent } = createTestApp();
  const token = await getCsrf(agent, '/');

  const res = await agent
    .post('/login')
    .set('User-Agent', 'motherload-test')
    .type('form')
    .send({ email: 'admin@test.by', password: PASSWORD, _csrf: token });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard');

  const dashboard = await agent.get('/dashboard');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /Обзор склада/);
  assert.match(dashboard.text, /Выйти/);
  assert.match(dashboard.text, /Администратор/);
  assert.doesNotMatch(dashboard.text, />admin</);

  const entries = await findAudit('auth.login');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].user_id, user.id);
  assert.ok(entries[0].ip, 'audit must record the client IP');
  assert.equal(entries[0].user_agent, 'motherload-test');
});

test('session cookie is HttpOnly and SameSite=Lax, not Secure without HTTPS', async () => {
  const { agent } = createTestApp();

  const res = await agent.get('/');
  const cookies = res.headers['set-cookie'] ?? [];
  const sessionCookie = cookies.find((cookie) => cookie.startsWith('motherload.sid='));

  assert.ok(sessionCookie, 'landing must start a session for the CSRF token');
  assert.match(sessionCookie, /HttpOnly/);
  assert.match(sessionCookie, /SameSite=Lax/);
  assert.doesNotMatch(sessionCookie, /Secure/);
});

test('login rotates the session id to prevent fixation', async () => {
  await createUserFactory({ email: 'rotate@test.by', password: PASSWORD });
  const { agent } = createTestApp();

  const landing = await agent.get('/');
  const token = /name="_csrf" value="([^"]+)"/.exec(landing.text)[1];
  const beforeSid = landing.headers['set-cookie'][0].split(';')[0];

  const login = await agent
    .post('/login')
    .type('form')
    .send({ email: 'rotate@test.by', password: PASSWORD, _csrf: token });
  const afterSid = login.headers['set-cookie'][0].split(';')[0];

  assert.equal(login.status, 302);
  assert.notEqual(afterSid, beforeSid);
});

test('login failure returns the same generic message and records a failed audit', async () => {
  const user = await createUserFactory({ email: 'sklad@test.by', password: PASSWORD });
  const { agent } = createTestApp();
  const token = await getCsrf(agent, '/');

  const res = await agent
    .post('/login')
    .type('form')
    .send({ email: 'sklad@test.by', password: WRONG_PASSWORD, _csrf: token });

  assert.equal(res.status, 401);
  assert.match(res.text, /Неверный email или пароль/);
  assert.doesNotMatch(res.text, /Argon|argon|hash/i);

  const entries = await findAudit('auth.login_failed');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].user_id, user.id);
  assert.doesNotMatch(JSON.stringify(entries[0].details), new RegExp(WRONG_PASSWORD));

  const dashboard = await agent.get('/dashboard');
  assert.equal(dashboard.status, 302);
  assert.equal(dashboard.headers.location, '/');
});

test('unknown email gets the same generic message as a wrong password', async () => {
  const { agent } = createTestApp();
  const token = await getCsrf(agent, '/');

  const res = await agent
    .post('/login')
    .type('form')
    .send({ email: 'ghost@test.by', password: PASSWORD, _csrf: token });

  assert.equal(res.status, 401);
  assert.match(res.text, /Неверный email или пароль/);

  const entries = await findAudit('auth.login_failed');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].user_id, null);
});

test('unknown email still pays one Argon2 verification', async () => {
  const originalVerify = argon2.verify;
  let verifyCalls = 0;

  // Patching the library object is the least invasive way to prove the dummy
  // hash path runs; the service and the test share the same CJS module instance.
  argon2.verify = async (...args) => {
    verifyCalls += 1;
    return originalVerify.apply(argon2, args);
  };

  try {
    const { agent } = createTestApp();
    const token = await getCsrf(agent, '/');

    const res = await agent
      .post('/login')
      .type('form')
      .send({ email: 'ghost@test.by', password: PASSWORD, _csrf: token });

    assert.equal(res.status, 401);
    assert.equal(verifyCalls, 1, 'unknown email must verify against the dummy hash exactly once');
  } finally {
    argon2.verify = originalVerify;
  }
});

test('inactive user cannot sign in even with the right password', async () => {
  await createUserFactory({ email: 'inactive@test.by', password: PASSWORD, isActive: false });
  const { agent } = createTestApp();
  const token = await getCsrf(agent, '/');

  const res = await agent
    .post('/login')
    .type('form')
    .send({ email: 'inactive@test.by', password: PASSWORD, _csrf: token });

  assert.equal(res.status, 401);
  assert.match(res.text, /Неверный email или пароль/);

  const entries = await findAudit('auth.login_failed');
  assert.equal(entries.length, 1);

  const dashboard = await agent.get('/dashboard');
  assert.equal(dashboard.status, 302);
  assert.equal(dashboard.headers.location, '/');
});

test('deactivated user loses an existing session on the next request', async () => {
  const user = await createUserFactory({ email: 'revoked@test.by', password: PASSWORD });
  const { agent } = createTestApp();

  await loginAs(agent, 'revoked@test.by', PASSWORD);
  assert.equal((await agent.get('/dashboard')).status, 200);

  await query('update users set is_active = false where id = $1', [user.id]);

  const res = await agent.get('/dashboard');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');

  const landing = await agent.get('/');
  assert.equal(landing.status, 200);
});

test('login without CSRF is rejected', async () => {
  const { agent } = createTestApp();

  const res = await agent.post('/login').type('form').send({ email: 'x@y.by', password: 'x' });

  assert.equal(res.status, 403);
  assert.match(res.text, /Обновите страницу/);
});

test('login accepts the X-CSRF-Token header used by fetch clients', async () => {
  await createUserFactory({ email: 'header@test.by', password: PASSWORD });
  const { agent } = createTestApp();
  const token = await getCsrf(agent, '/');

  const res = await agent
    .post('/login')
    .set('X-CSRF-Token', token)
    .type('form')
    .send({ email: 'header@test.by', password: PASSWORD });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard');
});

test('authenticated landing redirects to the dashboard', async () => {
  await createUserFactory({ email: 'analyst@test.by', password: PASSWORD, role: 'analyst' });
  const { agent } = createTestApp();

  await loginAs(agent, 'analyst@test.by', PASSWORD);
  const res = await agent.get('/');

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/dashboard');
});

test('logout destroys the session, records an audit row and returns to the landing', async () => {
  const user = await createUserFactory({ email: 'storekeeper@test.by', password: PASSWORD });
  const { agent } = createTestApp();

  await loginAs(agent, 'storekeeper@test.by', PASSWORD);
  const token = await getCsrf(agent, '/dashboard');

  const res = await agent.post('/logout').type('form').send({ _csrf: token });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');

  const clearedCookie = (res.headers['set-cookie'] ?? []).find((cookie) =>
    cookie.startsWith('motherload.sid='),
  );
  assert.ok(clearedCookie, 'logout must clear the session cookie');
  assert.match(clearedCookie, /Expires=Thu, 01 Jan 1970/);

  const dashboard = await agent.get('/dashboard');
  assert.equal(dashboard.status, 302);
  assert.equal(dashboard.headers.location, '/');

  const entries = await findAudit('auth.logout');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].user_id, user.id);
});

test('logout without CSRF is rejected and keeps the session', async () => {
  await createUserFactory({ email: 'logout@test.by', password: PASSWORD });
  const { agent } = createTestApp();

  await loginAs(agent, 'logout@test.by', PASSWORD);

  const res = await agent.post('/logout').type('form').send({});
  assert.equal(res.status, 403);
  assert.match(res.text, /Обновите страницу/);

  const dashboard = await agent.get('/dashboard');
  assert.equal(dashboard.status, 200);
});

test('landing renders a working login form, demo credentials and the version stamp', async () => {
  const { agent } = createTestApp();
  const res = await agent.get('/');

  assert.equal(res.status, 200);
  assert.match(res.text, /<form[^>]+method="post"[^>]+action="\/login"/);
  assert.match(res.text, /name="_csrf"/);
  assert.match(res.text, /name="email"/);
  assert.match(res.text, /name="password"/);
  assert.match(res.text, /<details/);
  assert.match(res.text, /admin@motherload\.by/);
  assert.match(res.text, /MOTHERLOAD \/ v1\.0 \/ 2026/);
  assert.doesNotMatch(res.text, /\sstyle="/);
  // JSON-LD is an inert data block, not an executable inline script.
  assert.doesNotMatch(res.text, /<script(?![^>]*(?:\bsrc=|application\/ld\+json))/);
});

test('password policy rejects weak passwords with a Russian message', async () => {
  await assert.rejects(
    () => createUserFactory({ email: 'weak@test.by', password: 'weakpass' }),
    /не короче 10 символов/,
  );
});

// Keep the two limiter tests last: they deliberately exhaust the login limiter.
test('login rate limit returns 429 after 5 attempts', async () => {
  await createUserFactory({ email: 'limit@test.by', password: PASSWORD });
  const { agent } = createTestApp();
  const token = await getCsrf(agent, '/');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await agent
      .post('/login')
      .type('form')
      .send({ email: 'limit@test.by', password: WRONG_PASSWORD, _csrf: token });
    assert.equal(res.status, 401, `attempt ${attempt + 1} should be rejected as bad credentials`);
  }

  const blocked = await agent
    .post('/login')
    .type('form')
    .send({ email: 'limit@test.by', password: WRONG_PASSWORD, _csrf: token });

  assert.equal(blocked.status, 429);
  assert.match(blocked.text, /Слишком много попыток входа/);
});

test('client-supplied X-Forwarded-For cannot bypass the login limiter', async () => {
  await createUserFactory({ email: 'spoof@test.by', password: PASSWORD });
  const { agent } = createTestApp();
  const token = await getCsrf(agent, '/');

  // With the default TRUST_PROXY=false the socket address, not the forged
  // header, is the limiter key. If trust proxy regresses, every attempt gets a
  // fresh key and the sixth request would render 401 instead of 429.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await agent
      .post('/login')
      .set('X-Forwarded-For', `203.0.113.${attempt + 1}`)
      .type('form')
      .send({ email: 'spoof@test.by', password: WRONG_PASSWORD, _csrf: token });
    assert.equal(res.status, 401, `attempt ${attempt + 1} should be rejected as bad credentials`);
  }

  const blocked = await agent
    .post('/login')
    .set('X-Forwarded-For', '203.0.113.99')
    .type('form')
    .send({ email: 'spoof@test.by', password: WRONG_PASSWORD, _csrf: token });

  assert.equal(blocked.status, 429);
  assert.match(blocked.text, /Слишком много попыток входа/);
});

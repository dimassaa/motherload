import assert from 'node:assert/strict';
import test from 'node:test';

// env.js validates and freezes its configuration on first import, so the proxy
// setting must exist before any application module is loaded. Static imports
// are hoisted, hence the dynamic imports below.
process.env.TRUST_PROXY = '1';

const { createTestApp } = await import('../helpers/app.js');
const { setupTestDb, teardownTestDb, truncateAll } = await import('../helpers/db.js');
const { createUserFactory } = await import('../helpers/factories.js');

const PASSWORD = 'Proxy!23456';
const CSRF_INPUT_PATTERN = /name="_csrf" value="([^"]+)"/;
const HSTS = 'max-age=15552000; includeSubDomains';

test.before(async () => {
  await setupTestDb();
});

test.beforeEach(async () => {
  await truncateAll();
});

test.after(async () => {
  await teardownTestDb();
});

function sessionCookie(response) {
  return (response.headers['set-cookie'] ?? []).find((cookie) =>
    cookie.startsWith('motherload.sid='),
  );
}

test('trusted proxy HTTPS marks the session cookie Secure and enables HSTS', async () => {
  await createUserFactory({ email: 'proxy@test.by', password: PASSWORD, role: 'storekeeper' });
  const { agent } = createTestApp();

  const landing = await agent.get('/').set('X-Forwarded-Proto', 'https');
  assert.equal(landing.status, 200);
  assert.equal(landing.headers['strict-transport-security'], HSTS);
  const landingCookie = sessionCookie(landing);
  assert.match(landingCookie, /Secure/);

  // Supertest speaks plain HTTP, so its cookie jar refuses to replay a Secure
  // cookie. Send the session pair by hand to exercise the real login path.
  const sessionPair = landingCookie.split(';')[0];
  const token = CSRF_INPUT_PATTERN.exec(landing.text)[1];
  const login = await agent
    .post('/login')
    .set('X-Forwarded-Proto', 'https')
    .set('Cookie', sessionPair)
    .set('User-Agent', 'motherload-test')
    .type('form')
    .send({ email: 'proxy@test.by', password: PASSWORD, _csrf: token });

  assert.equal(login.status, 302);
  assert.equal(login.headers.location, '/dashboard');
  // Login rotates the session id, so this response carries a fresh cookie.
  assert.match(sessionCookie(login), /Secure/);
  assert.equal(login.headers['strict-transport-security'], HSTS);
});

test('plain HTTP through the same trusted proxy stays non-Secure without HSTS', async () => {
  const { agent } = createTestApp();

  const response = await agent.get('/');
  assert.equal(response.status, 200);
  assert.doesNotMatch(sessionCookie(response), /Secure/);
  assert.equal(response.headers['strict-transport-security'], undefined);
});

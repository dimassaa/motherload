import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestApp } from '../helpers/app.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';
import { createUserFactory } from '../helpers/factories.js';
import { getCsrf, loginAs } from '../helpers/http.js';

const PASSWORD = 'Role!23456';

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
 * Create a user with the requested role and sign it in through the real form.
 * @param {'admin' | 'storekeeper' | 'analyst'} role
 * @param {{ email?: string }} [overrides]
 */
async function loginAsRole(role, { email = `${role}@test.by` } = {}) {
  const user = await createUserFactory({ email, password: PASSWORD, role });
  const { agent } = createTestApp();
  await loginAs(agent, email, PASSWORD);
  return { agent, user };
}

test('a guest is redirected to the landing page from an admin page', async () => {
  const { agent } = createTestApp();

  const res = await agent.get('/admin/users');

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');
});

test('analyst cannot POST to an admin route', async () => {
  const { agent } = await loginAsRole('analyst');
  const token = await getCsrf(agent, '/dashboard');

  const res = await agent
    .post('/admin/users')
    .type('form')
    .send({ fullName: 'Взлом', email: 'hack@test.by', role: 'admin', _csrf: token });

  assert.equal(res.status, 403);
  assert.match(res.text, /Недостаточно прав/);
});

test('analyst cannot read the user list or the audit log', async () => {
  const { agent } = await loginAsRole('analyst');

  const users = await agent.get('/admin/users');
  const audit = await agent.get('/admin/audit');

  assert.equal(users.status, 403);
  assert.equal(audit.status, 403);
  assert.match(users.text, /Недостаточно прав/);
});

test('storekeeper cannot read the user list', async () => {
  const { agent } = await loginAsRole('storekeeper');

  const res = await agent.get('/admin/users');

  assert.equal(res.status, 403);
});

test('admin opens the user list and the audit log', async () => {
  const { agent } = await loginAsRole('admin');

  const users = await agent.get('/admin/users');
  const audit = await agent.get('/admin/audit');

  assert.equal(users.status, 200);
  assert.match(users.text, /Пользователи/);
  assert.equal(audit.status, 200);
  assert.match(audit.text, /Аудит/);
});

test('admin navigation shows users and audit, other roles do not', async () => {
  const admin = await loginAsRole('admin');
  const analyst = await loginAsRole('analyst', { email: 'second-analyst@test.by' });

  const adminPage = await admin.agent.get('/dashboard');
  const analystPage = await analyst.agent.get('/dashboard');

  assert.match(adminPage.text, /href="\/admin\/users"/);
  assert.match(adminPage.text, /Пользователи/);
  assert.match(adminPage.text, /href="\/admin\/audit"/);
  assert.match(adminPage.text, /Аудит/);

  assert.doesNotMatch(analystPage.text, /\/admin\/users/);
  assert.doesNotMatch(analystPage.text, /\/admin\/audit/);
});

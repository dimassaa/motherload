import assert from 'node:assert/strict';
import test from 'node:test';
import { query } from '../../src/db/pool.js';
import * as usersService from '../../src/services/users.js';
import { createTestApp } from '../helpers/app.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';
import { createUserFactory } from '../helpers/factories.js';
import { getCsrf, loginAs } from '../helpers/http.js';

const PASSWORD = 'User!23456';
const NEW_PASSWORD = 'Fresh!23456';

test.before(async () => {
  await setupTestDb();
});

test.beforeEach(async () => {
  await truncateAll();
});

test.after(async () => {
  // A forced-audit-failure test renames the table for the duration of one
  // request. If that test aborted before its finally block, put the name back
  // before the shared pool is closed so later runs are not poisoned.
  const { rows } = await query(
    "select to_regclass('public.audit_log') as present, to_regclass('public.audit_log_unavailable') as renamed",
  );
  if (!rows[0].present && rows[0].renamed) {
    await query('alter table audit_log_unavailable rename to audit_log');
  }
  await teardownTestDb();
});

async function signIn(email, role = 'storekeeper', overrides = {}) {
  const user = await createUserFactory({ email, password: PASSWORD, role, ...overrides });
  const { agent } = createTestApp();
  await loginAs(agent, email, PASSWORD);
  return { agent, user };
}

async function signInAsAdmin() {
  const user = await createUserFactory({
    email: 'admin@test.by',
    password: PASSWORD,
    role: 'admin',
    fullName: 'Алексей Ковалёв',
  });
  const { agent } = createTestApp();
  await loginAs(agent, 'admin@test.by', PASSWORD);
  return { agent, user };
}

async function findAudit(action) {
  const { rows } = await query(
    'select user_id, action, entity_type, entity_id, details from audit_log where action = $1 order by id',
    [action],
  );
  return rows;
}

async function findUserByEmail(email) {
  const { rows } = await query(
    'select id, email, full_name, role, phone, is_active, password_hash from users where email = $1',
    [email],
  );
  return rows[0] ?? null;
}

/** Submit the create-user form with sensible defaults. */
function createUserPayload(overrides = {}) {
  return {
    fullName: 'Марина Сидорова',
    email: 'sklad@test.by',
    role: 'storekeeper',
    phone: '+375 (29) 123-45-67',
    password: 'Sklad!23456',
    ...overrides,
  };
}

/** Minimal request shape for service-level calls that only need actor + audit data. */
function requestAs(userId) {
  return { user: { id: userId }, ip: '127.0.0.1', get: () => 'task-5-test' };
}

test('admin creates a user through the form and the action is audited without the password', async () => {
  const { agent, user: admin } = await signInAsAdmin();
  const token = await getCsrf(agent, '/admin/users');

  const res = await agent
    .post('/admin/users/new')
    .type('form')
    .send({ ...createUserPayload(), _csrf: token });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/users');

  const created = await findUserByEmail('sklad@test.by');
  assert.ok(created, 'the user must exist after a successful create');
  assert.equal(created.full_name, 'Марина Сидорова');
  assert.equal(created.role, 'storekeeper');
  assert.equal(created.phone, '+375 (29) 123-45-67');
  assert.match(created.password_hash, /^\$argon2id\$/);

  const entries = await findAudit('user.create');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].user_id, admin.id);
  assert.equal(entries[0].entity_type, 'user');
  assert.equal(entries[0].entity_id, String(created.id));
  assert.doesNotMatch(JSON.stringify(entries[0].details), /Sklad!23456/);
});

test('a failed audit insert rolls the user mutation back', async () => {
  const { agent } = await signInAsAdmin();
  const token = await getCsrf(agent, '/admin/users');

  // Renaming the table makes the audit insert fail after the user insert has
  // already run inside the transaction. The transaction must undo both.
  await query('alter table audit_log rename to audit_log_unavailable');

  let res;
  try {
    res = await agent
      .post('/admin/users')
      .type('form')
      .send({ ...createUserPayload({ email: 'rollback@test.by' }), _csrf: token });
  } finally {
    await query('alter table audit_log_unavailable rename to audit_log');
  }

  assert.equal(res.status, 500);
  assert.equal(await findUserByEmail('rollback@test.by'), null);

  const { rows } = await query(
    "select count(*)::integer as count from audit_log where action = 'user.create'",
  );
  assert.equal(rows[0].count, 0);
});

test('weak password is rejected by the server-side policy and the form keeps the input', async () => {
  const { agent } = await signInAsAdmin();
  const token = await getCsrf(agent, '/admin/users');

  const res = await agent
    .post('/admin/users/new')
    .type('form')
    .send({
      ...createUserPayload({ password: 'weakpass', phone: '12345' }),
      _csrf: token,
    });

  assert.equal(res.status, 400);
  assert.match(res.text, /не короче 10 символов/);
  assert.match(res.text, /sklad@test\.by/, 'the submitted email must survive the re-render');
  assert.equal(await findUserByEmail('sklad@test.by'), null);

  // Hint and error share one aria-describedby; a second attribute would be
  // invalid HTML and one of the two ids would be ignored.
  assert.match(res.text, /aria-describedby="user-phone-hint user-phone-error"/);
  assert.match(res.text, /aria-describedby="user-password-hint user-password-error"/);
  assert.doesNotMatch(res.text, /aria-describedby="[^"]*"[^>]*aria-describedby=/);
});

test('duplicate email is refused with a readable message', async () => {
  await createUserFactory({ email: 'sklad@test.by', password: PASSWORD });
  const { agent } = await signInAsAdmin();
  const token = await getCsrf(agent, '/admin/users');

  const res = await agent
    .post('/admin/users/new')
    .type('form')
    .send({ ...createUserPayload(), _csrf: token });

  assert.equal(res.status, 400);
  assert.match(res.text, /уже существует/);
});

test('email is immutable when an existing user is edited', async () => {
  const target = await createUserFactory({
    email: 'target@test.by',
    password: PASSWORD,
    fullName: 'Старое Имя',
  });
  const { agent } = await signInAsAdmin();
  const token = await getCsrf(agent, '/admin/users');

  const res = await agent.post(`/admin/users/${target.id}`).type('form').send({
    fullName: 'Новое Имя',
    email: 'hijack@test.by',
    role: 'analyst',
    phone: '+375 (17) 245-67-89',
    _csrf: token,
  });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/users');

  const updated = await findUserByEmail('target@test.by');
  assert.equal(updated.full_name, 'Новое Имя');
  assert.equal(updated.role, 'analyst');
  assert.equal(updated.phone, '+375 (17) 245-67-89');
  assert.equal(await findUserByEmail('hijack@test.by'), null);

  const entries = await findAudit('user.update');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entity_id, String(target.id));
});

test('admin cannot deactivate the last active admin', async () => {
  const { agent, user } = await signInAsAdmin();
  const token = await getCsrf(agent, '/admin/users');

  const res = await agent
    .post(`/admin/users/${user.id}/toggle`)
    .type('form')
    .send({ _csrf: token });

  assert.equal(res.status, 400);
  assert.match(res.text, /последнего администратора/i);
});

test('admin cannot demote the last active admin to another role', async () => {
  const { agent, user } = await signInAsAdmin();
  const token = await getCsrf(agent, '/admin/users');

  const res = await agent.post(`/admin/users/${user.id}`).type('form').send({
    fullName: user.full_name,
    role: 'analyst',
    phone: '',
    _csrf: token,
  });

  assert.equal(res.status, 400);
  assert.match(res.text, /последнего администратора/i);

  const { rows } = await query('select role from users where id = $1', [user.id]);
  assert.equal(rows[0].role, 'admin');
});

test('two concurrent deactivations cannot leave zero active admins', async () => {
  const first = await createUserFactory({
    email: 'admin-one@test.by',
    password: PASSWORD,
    role: 'admin',
  });
  const second = await createUserFactory({
    email: 'admin-two@test.by',
    password: PASSWORD,
    role: 'admin',
  });

  const results = await Promise.allSettled([
    usersService.toggleActive(second.id, { req: requestAs(first.id) }),
    usersService.toggleActive(first.id, { req: requestAs(second.id) }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.match(rejected.reason.message, /последнего администратора/i);

  const { rows } = await query(
    "select count(*)::integer as count from users where role = 'admin' and is_active",
  );
  assert.equal(rows[0].count, 1, 'at least one active admin must remain');
});

test('two concurrent demotions cannot leave zero active admins', async () => {
  const first = await createUserFactory({
    email: 'admin-one@test.by',
    password: PASSWORD,
    role: 'admin',
    fullName: 'Первый Администратор',
  });
  const second = await createUserFactory({
    email: 'admin-two@test.by',
    password: PASSWORD,
    role: 'admin',
    fullName: 'Второй Администратор',
  });

  const results = await Promise.allSettled([
    usersService.update(
      second.id,
      { fullName: second.full_name, role: 'analyst', phone: null },
      { req: requestAs(first.id) },
    ),
    usersService.update(
      first.id,
      { fullName: first.full_name, role: 'analyst', phone: null },
      { req: requestAs(second.id) },
    ),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.match(rejected.reason.message, /последнего администратора/i);

  const { rows } = await query(
    "select count(*)::integer as count from users where role = 'admin' and is_active",
  );
  assert.equal(rows[0].count, 1, 'at least one active admin must remain');
});

test('admin cannot deactivate their own account while another admin exists', async () => {
  const { agent, user } = await signInAsAdmin();
  await createUserFactory({ email: 'admin2@test.by', password: PASSWORD, role: 'admin' });
  const token = await getCsrf(agent, '/admin/users');

  const res = await agent
    .post(`/admin/users/${user.id}/toggle`)
    .type('form')
    .send({ _csrf: token });

  assert.equal(res.status, 400);
  assert.match(res.text, /собственную учётную запись/i);
});

test('admin deactivates another user and the change is audited', async () => {
  const target = await createUserFactory({ email: 'target@test.by', password: PASSWORD });
  const { agent } = await signInAsAdmin();
  const token = await getCsrf(agent, '/admin/users');

  const res = await agent
    .post(`/admin/users/${target.id}/toggle`)
    .type('form')
    .send({ _csrf: token });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin/users');

  const { rows } = await query('select is_active from users where id = $1', [target.id]);
  assert.equal(rows[0].is_active, false);

  const entries = await findAudit('user.toggle');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entity_id, String(target.id));
  assert.equal(entries[0].details.isActive, false);
});

test('admin password reset invalidates every session of the target user', async () => {
  await createUserFactory({ email: 'target@test.by', password: PASSWORD });
  const targetApp = createTestApp();
  await loginAs(targetApp.agent, 'target@test.by', PASSWORD);

  const { agent } = await signInAsAdmin();
  const token = await getCsrf(agent, '/admin/users');
  const target = await findUserByEmail('target@test.by');

  const res = await agent
    .post(`/admin/users/${target.id}/password`)
    .type('form')
    .send({ password: NEW_PASSWORD, _csrf: token });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/admin/users/${target.id}`);

  const revoked = await targetApp.agent.get('/dashboard');
  assert.equal(revoked.status, 302);
  assert.equal(revoked.headers.location, '/');

  const { rows } = await query(
    "select count(*)::integer as count from sessions where sess->>'userId' = $1",
    [String(target.id)],
  );
  assert.equal(rows[0].count, 0);

  const entries = await findAudit('user.password_reset');
  assert.equal(entries.length, 1);
  assert.doesNotMatch(JSON.stringify(entries[0].details), new RegExp(NEW_PASSWORD));
});

test('admin resetting their own password keeps the current session', async () => {
  const { agent, user } = await signInAsAdmin();
  const second = createTestApp();
  await loginAs(second.agent, 'admin@test.by', PASSWORD);

  const token = await getCsrf(agent, '/admin/users');
  const res = await agent
    .post(`/admin/users/${user.id}/password`)
    .type('form')
    .send({ password: NEW_PASSWORD, _csrf: token });

  assert.equal(res.status, 302);

  const page = await agent.get(`/admin/users/${user.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Текущий сеанс сохранён/);

  assert.equal((await agent.get('/admin/users')).status, 200, 'the acting session survives');

  const other = await second.agent.get('/dashboard');
  assert.equal(other.status, 302);
  assert.equal(other.headers.location, '/');

  const { rows } = await query(
    "select count(*)::integer as count from sessions where sess->>'userId' = $1",
    [String(user.id)],
  );
  assert.equal(rows[0].count, 1, 'only the acting session remains');
});

test('admin password reset enforces the password policy', async () => {
  const target = await createUserFactory({ email: 'target@test.by', password: PASSWORD });
  const { agent } = await signInAsAdmin();
  const token = await getCsrf(agent, '/admin/users');

  const res = await agent
    .post(`/admin/users/${target.id}/password`)
    .type('form')
    .send({ password: 'weakpass', _csrf: token });

  assert.equal(res.status, 400);
  assert.match(res.text, /не короче 10 символов/);

  const relogin = createTestApp();
  await loginAs(relogin.agent, 'target@test.by', PASSWORD);
});

test('profile shows the email as read-only and saves name and phone', async () => {
  const { agent, user } = await signIn('profile@test.by', 'storekeeper');
  const token = await getCsrf(agent, '/profile');

  const page = await agent.get('/profile');
  assert.equal(page.status, 200);
  assert.match(page.text, /profile@test\.by/);
  assert.match(page.text, /readonly/);

  const res = await agent.post('/profile').type('form').send({
    fullName: 'Марина Сидорова-Обновлённая',
    phone: '+375 (17) 245-67-89',
    email: 'hijack@test.by',
    _csrf: token,
  });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/profile');

  const { rows } = await query('select full_name, phone, email from users where id = $1', [
    user.id,
  ]);
  assert.equal(rows[0].full_name, 'Марина Сидорова-Обновлённая');
  assert.equal(rows[0].phone, '+375 (17) 245-67-89');
  assert.equal(rows[0].email, 'profile@test.by');

  const entries = await findAudit('profile.update');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entity_id, String(user.id));
});

test('changing own password keeps the current session and ends the others', async () => {
  await createUserFactory({ email: 'profile@test.by', password: PASSWORD });
  const first = createTestApp();
  const second = createTestApp();
  await loginAs(first.agent, 'profile@test.by', PASSWORD);
  await loginAs(second.agent, 'profile@test.by', PASSWORD);

  const token = await getCsrf(first.agent, '/profile');
  const res = await first.agent.post('/profile/password').type('form').send({
    currentPassword: PASSWORD,
    newPassword: NEW_PASSWORD,
    repeatPassword: NEW_PASSWORD,
    _csrf: token,
  });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/profile');

  const current = await first.agent.get('/profile');
  assert.equal(current.status, 200);

  const other = await second.agent.get('/dashboard');
  assert.equal(other.status, 302);
  assert.equal(other.headers.location, '/');

  const entries = await findAudit('profile.password');
  assert.equal(entries.length, 1);
  const serialized = JSON.stringify(entries[0].details);
  assert.doesNotMatch(serialized, new RegExp(PASSWORD));
  assert.doesNotMatch(serialized, new RegExp(NEW_PASSWORD));

  const oldLogin = createTestApp();
  const oldToken = await getCsrf(oldLogin.agent, '/');
  const oldAttempt = await oldLogin.agent
    .post('/login')
    .type('form')
    .send({ email: 'profile@test.by', password: PASSWORD, _csrf: oldToken });
  assert.equal(oldAttempt.status, 401);

  const newLogin = createTestApp();
  await loginAs(newLogin.agent, 'profile@test.by', NEW_PASSWORD);
});

test('profile password change refuses a wrong current password', async () => {
  await createUserFactory({ email: 'profile@test.by', password: PASSWORD });
  const { agent } = createTestApp();
  await loginAs(agent, 'profile@test.by', PASSWORD);
  const token = await getCsrf(agent, '/profile');

  const res = await agent.post('/profile/password').type('form').send({
    currentPassword: 'Wrong!23456',
    newPassword: NEW_PASSWORD,
    repeatPassword: NEW_PASSWORD,
    _csrf: token,
  });

  assert.equal(res.status, 400);
  assert.match(res.text, /Текущий пароль/);

  const relogin = createTestApp();
  await loginAs(relogin.agent, 'profile@test.by', PASSWORD);
});

test('profile password change rejects a repeated password mismatch', async () => {
  await createUserFactory({ email: 'profile@test.by', password: PASSWORD });
  const { agent } = createTestApp();
  await loginAs(agent, 'profile@test.by', PASSWORD);
  const token = await getCsrf(agent, '/profile');

  const res = await agent.post('/profile/password').type('form').send({
    currentPassword: PASSWORD,
    newPassword: NEW_PASSWORD,
    repeatPassword: 'Different!23456',
    _csrf: token,
  });

  assert.equal(res.status, 400);
  assert.match(res.text, /не совпадают/i);
  assert.match(res.text, /aria-describedby="profile-repeat-password-error"/);
  assert.doesNotMatch(res.text, /aria-describedby="[^"]*"[^>]*aria-describedby=/);
});

test('audit page renders filters, escapes JSON details and applies action, entity and date filters', async () => {
  const { agent, user: admin } = await signInAsAdmin();

  await query(
    `insert into audit_log (user_id, action, entity_type, entity_id, details, created_at)
     values ($1, 'user.create', 'user', '10', $2, '2026-11-20T10:00:00Z')`,
    [admin.id, JSON.stringify({ marker: 'alpha-marker', note: '<script>alert(1)</script>' })],
  );
  await query(
    `insert into audit_log (user_id, action, entity_type, details, created_at)
     values (null, 'auth.login', 'auth', '{"marker":"beta-marker"}', '2026-01-15T10:00:00Z')`,
  );

  const filtered = await agent.get('/admin/audit?action=user.create&entityType=user');
  assert.equal(filtered.status, 200);
  assert.match(filtered.text, /alpha-marker/);
  assert.doesNotMatch(filtered.text, /beta-marker/);
  assert.doesNotMatch(filtered.text, /<script>alert\(1\)<\/script>/);
  assert.match(filtered.text, /&lt;script&gt;/);
  assert.match(filtered.text, /details class="details-json"/);

  const byUserAndDate = await agent.get(
    `/admin/audit?userId=${admin.id}&from=2026-11-01&to=2026-11-22`,
  );
  assert.equal(byUserAndDate.status, 200);
  assert.match(byUserAndDate.text, /alpha-marker/);
  assert.doesNotMatch(byUserAndDate.text, /beta-marker/);

  const beforeDate = await agent.get('/admin/audit?to=2026-10-31');
  assert.doesNotMatch(beforeDate.text, /alpha-marker/);
});

test('audit page paginates long histories', async () => {
  const { agent, user: admin } = await signInAsAdmin();

  for (let index = 1; index <= 30; index += 1) {
    await query(
      `insert into audit_log (user_id, action, entity_type, entity_id, details, created_at)
       values ($1, 'user.update', 'user', $2, $3, $4)`,
      [
        admin.id,
        String(index),
        JSON.stringify({ marker: `row-${String(index).padStart(2, '0')}` }),
        `2026-11-21T10:${String(index).padStart(2, '0')}:00Z`,
      ],
    );
  }

  const firstPage = await agent.get('/admin/audit?action=user.update');
  assert.match(firstPage.text, /Страница 1 из 2/);
  assert.match(firstPage.text, /row-30/);
  assert.doesNotMatch(firstPage.text, /row-01/);

  const secondPage = await agent.get('/admin/audit?action=user.update&page=2');
  assert.match(secondPage.text, /Страница 2 из 2/);
  assert.match(secondPage.text, /row-01/);

  // A stale bookmark beyond the end shows the last page, not an empty table.
  const clamped = await agent.get('/admin/audit?action=user.update&page=999');
  assert.equal(clamped.status, 200);
  assert.match(clamped.text, /Страница 2 из 2/);
  assert.match(clamped.text, /row-01/);
});

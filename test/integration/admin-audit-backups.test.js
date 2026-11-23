import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { query } from '../../src/db/pool.js';
import { createTestApp } from '../helpers/app.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';
import { createUserFactory } from '../helpers/factories.js';
import { loginAs } from '../helpers/http.js';

const PASSWORD = 'Audit!23456';
const BACKUPS_DIR = fileURLToPath(new URL('../../backups', import.meta.url));

test.before(async () => {
  await setupTestDb();
});

test.beforeEach(async () => {
  await truncateAll();
});

test.after(async () => {
  await teardownTestDb();
});

async function signIn(role = 'admin', email = `${role}@test.by`) {
  const user = await createUserFactory({ email, password: PASSWORD, role });
  const { agent } = createTestApp();
  await loginAs(agent, email, PASSWORD);
  return { agent, user };
}

/**
 * Insert an audit row directly: the page must defend itself even when a future
 * caller writes details the service contract forbids.
 */
async function insertAuditEntry({ action, entityType = null, details = {}, createdAt = null }) {
  const { rows } = await query(
    `insert into audit_log (action, entity_type, details, ip, created_at)
     values ($1, $2, $3::jsonb, '127.0.0.1', coalesce($4::timestamptz, now()))
     returning id`,
    [action, entityType, JSON.stringify(details), createdAt],
  );
  return rows[0].id;
}

test('audit page filters by action and hides secrets in details', async () => {
  const { agent } = await signIn();
  await insertAuditEntry({
    action: 'test.alpha',
    details: {
      marker: 'alpha-marker',
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$hidden-hash',
      csrfToken: 'csrf-secret-value',
      note: 'visible-note',
    },
  });
  await insertAuditEntry({ action: 'test.beta', details: { marker: 'beta-marker' } });

  const res = await agent.get('/admin/audit?action=test.alpha');

  assert.equal(res.status, 200);
  assert.match(res.text, /alpha-marker/);
  assert.doesNotMatch(res.text, /beta-marker/);
  assert.doesNotMatch(res.text, /hidden-hash/);
  assert.doesNotMatch(res.text, /csrf-secret-value/);
  assert.match(res.text, /visible-note/);
  assert.match(res.text, /class="details-json"/);
});

test('audit page filters by entity type and date range', async () => {
  const { agent } = await signIn();
  await insertAuditEntry({
    action: 'test.range',
    entityType: 'component',
    details: { marker: 'old-marker' },
    createdAt: '2020-01-01T10:00:00+03:00',
  });
  await insertAuditEntry({
    action: 'test.range',
    entityType: 'user',
    details: { marker: 'new-marker' },
    createdAt: '2020-01-03T10:00:00+03:00',
  });

  const byEntity = await agent.get('/admin/audit?entityType=component');
  assert.equal(byEntity.status, 200);
  assert.match(byEntity.text, /old-marker/);
  assert.doesNotMatch(byEntity.text, /new-marker/);

  const byDate = await agent.get('/admin/audit?from=2020-01-03&to=2020-01-03');
  assert.equal(byDate.status, 200);
  assert.match(byDate.text, /new-marker/);
  assert.doesNotMatch(byDate.text, /old-marker/);
});

test('audit page shows an explicit notice for an inverted date range', async () => {
  const { agent } = await signIn();

  const res = await agent.get('/admin/audit?from=2020-01-05&to=2020-01-01');

  assert.equal(res.status, 200);
  assert.match(res.text, /позже/i);
});

test('backups page lists dump files without offering a download', async () => {
  const { agent } = await signIn();
  await mkdir(BACKUPS_DIR, { recursive: true });

  const fileName = `test-fixture-${process.pid}-${Date.now()}.dump`;
  const filePath = path.join(BACKUPS_DIR, fileName);
  await writeFile(filePath, Buffer.alloc(2048));

  try {
    const res = await agent.get('/admin/backups');

    assert.equal(res.status, 200);
    assert.ok(res.text.includes(fileName), 'the fixture dump must be listed');
    assert.match(res.text, /2 КБ/);
    assert.match(res.text, /Последний бэкап/);
    assert.match(res.text, /npm run backup/);
    assert.match(res.text, /npm run restore/);
    // Dumps stay on disk: no link may point at a file in backups/.
    assert.doesNotMatch(res.text, /href="[^"]*\.dump/);
    assert.doesNotMatch(res.text, /Скачать/);
  } finally {
    await rm(filePath, { force: true });
  }
});

test('backups page always explains how to create and restore a dump', async () => {
  const { agent } = await signIn();
  await mkdir(BACKUPS_DIR, { recursive: true });

  // A developer machine may already hold real dumps, so this test asserts only
  // the instructional part that is independent of the directory contents.
  const res = await agent.get('/admin/backups');

  assert.equal(res.status, 200);
  assert.match(res.text, /backups\//);
  assert.match(res.text, /7 дней/);
});

test('non-admin roles get 403 on the audit and backups pages', async () => {
  const storekeeper = await signIn('storekeeper');

  const audit = await storekeeper.agent.get('/admin/audit');
  const backups = await storekeeper.agent.get('/admin/backups');

  assert.equal(audit.status, 403);
  assert.equal(backups.status, 403);
  assert.match(backups.text, /Недостаточно прав/);
});

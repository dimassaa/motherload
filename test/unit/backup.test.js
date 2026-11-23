import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildBackupFileName,
  formatFileSize,
  selectExpiredBackups,
} from '../../src/domain/backup.js';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const restoreScript = path.join(projectRoot, 'scripts', 'restore.js');

// The two file-validation tests are skipped when PostgreSQL client tools are
// absent: the archive test shells out to `pg_restore --list`, and keeping the
// pair together avoids a misleading half-covered validation story. This keeps
// `npm run test:unit` runnable without PostgreSQL installed at all.
const pgRestoreAvailable =
  spawnSync('pg_restore', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;
const skipWithoutPgRestore = pgRestoreAvailable ? false : 'pg_restore is not installed';

function runRestore(args) {
  return spawnSync(process.execPath, [restoreScript, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    // The script must decide on its own inputs; inheriting the test environment
    // keeps DATABASE_URL available without touching a real database.
    env: { ...process.env, NODE_ENV: 'test' },
  });
}

test('backup file name carries a sortable local timestamp', () => {
  const date = new Date(2026, 10, 23, 15, 45, 1);

  assert.equal(buildBackupFileName(date), 'motherload-20261123-154501.dump');
});

test('retention removes only dumps older than seven days', () => {
  const now = new Date('2026-11-23T12:00:00Z');
  const files = [
    // Eight days old: past the seven-day window.
    { name: 'motherload-20261115-120000.dump', modifiedAt: new Date('2026-11-15T12:00:00Z') },
    // Six days old: still inside the window and must survive.
    { name: 'motherload-20261117-120000.dump', modifiedAt: new Date('2026-11-17T12:00:00Z') },
    // An operator's own copy must never be deleted by the retention pass.
    { name: 'manual-copy.dump', modifiedAt: new Date('2020-01-01T00:00:00Z') },
  ];

  const expired = selectExpiredBackups(files, now);

  assert.deepEqual(
    expired.map((file) => file.name),
    ['motherload-20261115-120000.dump'],
  );
});

test('file sizes are rendered for an operator, not as raw bytes', () => {
  assert.equal(formatFileSize(512), '512 Б');
  assert.equal(formatFileSize(1536), '1,5 КБ');
  assert.equal(formatFileSize(2048), '2 КБ');
  assert.equal(formatFileSize(5 * 1024 * 1024), '5 МБ');
});

test('restore refuses to run without the explicit --yes flag', () => {
  const result = runRestore(['backups/example.dump']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--yes/);
  assert.match(result.stderr, /не запущено/i);
});

test('restore refuses a dump path that does not exist even with --yes', () => {
  const result = runRestore(['backups/missing-for-test.dump', '--yes']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /не найден/i);
});

test('restore requires the .dump extension', { skip: skipWithoutPgRestore }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'motherload-restore-'));
  const file = path.join(directory, 'dump-without-extension');
  await writeFile(file, 'not a dump');

  try {
    const result = runRestore([file, '--yes']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /расширение \.dump/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'restore refuses a .dump file that is not a PostgreSQL archive',
  { skip: skipWithoutPgRestore },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'motherload-restore-'));
    const file = path.join(directory, 'not-a-dump.dump');
    await writeFile(file, 'this is a plain text file, not a custom-format archive\n');

    try {
      const result = runRestore([file, '--yes']);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /не похож на дамп/i);
      assert.match(result.stderr, /база не изменена/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

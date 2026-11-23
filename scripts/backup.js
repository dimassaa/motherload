/**
 * Create a PostgreSQL dump for the administration screen (`npm run backup`).
 *
 * Output goes to stdout/stderr as plain text instead of the Pino logger: this is
 * a CLI command read by an operator or a scheduler, and a JSON log line would
 * only be useful to the application. Secrets are never echoed: the connection
 * string is handed to pg_dump but this script never prints it.
 */
import 'dotenv/config';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKUP_RETENTION_DAYS,
  buildBackupFileName,
  formatFileSize,
  isBackupFileName,
  selectExpiredBackups,
} from '../src/domain/backup.js';
import { runPgCommand } from './lib/run-pg.js';

const BACKUPS_DIR = fileURLToPath(new URL('../backups', import.meta.url));

/**
 * Delete dumps this tool created more than {@link BACKUP_RETENTION_DAYS} days
 * ago. Operator copies in `backups/` are left alone.
 * @param {Date} [now]
 * @returns {Promise<string[]>} names that were removed
 */
async function removeExpiredBackups(now = new Date()) {
  const names = await readdir(BACKUPS_DIR);
  const candidates = [];

  for (const name of names) {
    if (!isBackupFileName(name)) continue;
    const info = await stat(path.join(BACKUPS_DIR, name));
    if (info.isFile()) candidates.push({ name, modifiedAt: info.mtime });
  }

  const expired = selectExpiredBackups(candidates, now);
  for (const file of expired) {
    await unlink(path.join(BACKUPS_DIR, file.name));
  }
  return expired.map((file) => file.name);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'Не задан DATABASE_URL. Пропишите строку подключения в .env или передайте её в переменной окружения.',
    );
  }

  await mkdir(BACKUPS_DIR, { recursive: true });

  const fileName = buildBackupFileName();
  const filePath = path.join(BACKUPS_DIR, fileName);

  try {
    await runPgCommand('pg_dump', [
      '--format=custom',
      `--file=${filePath}`,
      `--dbname=${databaseUrl}`,
    ]);
  } catch (error) {
    // A failed dump usually leaves a truncated file behind; keeping it would
    // make the backups screen look like there is a usable copy.
    await unlink(filePath).catch(() => {});

    if (error.code === 'ENOENT') {
      throw new Error(
        'Не найден pg_dump. Установите PostgreSQL и добавьте его папку bin в PATH (на Windows это, например, C:\\Program Files\\PostgreSQL\\18\\bin).',
      );
    }
    throw new Error(
      `Не удалось создать резервную копию. pg_dump сообщил: ${error.message}. Проверьте DATABASE_URL и доступность сервера.`,
    );
  }

  const info = await stat(filePath);
  process.stdout.write(
    `Резервная копия создана: backups/${fileName} (${formatFileSize(info.size)}).\n`,
  );

  const removed = await removeExpiredBackups();
  if (removed.length > 0) {
    process.stdout.write(
      `Удалены копии старше ${BACKUP_RETENTION_DAYS} дней: ${removed.join(', ')}.\n`,
    );
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`Резервное копирование не выполнено: ${error.message}\n`);
  process.exitCode = 1;
}

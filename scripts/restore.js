/**
 * Restore a custom-format dump (`npm run restore -- <file> --yes`).
 *
 * Restoring drops and recreates every object in the target database, so the
 * command refuses to run without an explicit `--yes`. As with the backup
 * script, plain stdout/stderr is deliberate: the output is read by an operator,
 * and the connection string is never printed.
 */
import 'dotenv/config';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { runPgCommand } from './lib/run-pg.js';

const USAGE =
  'Укажите файл дампа и подтвердите действие:\n' +
  '  npm run restore -- backups/motherload-20261123-120000.dump --yes\n';

function missingPgRestoreError() {
  return new Error(
    'Не найден pg_restore. Установите PostgreSQL и добавьте его папку bin в PATH (на Windows это, например, C:\\Program Files\\PostgreSQL\\18\\bin).',
  );
}

async function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--yes');
  const fileArg = args.find((arg) => !arg.startsWith('--'));

  if (!fileArg) {
    process.stderr.write(`Восстановление не запущено.\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  if (!confirmed) {
    process.stderr.write(
      'Восстановление не запущено: команда заменит все данные в целевой базе.\n' +
        `Если это осознанное действие, добавьте флаг --yes.\n${USAGE}`,
    );
    process.exitCode = 1;
    return;
  }

  const filePath = path.resolve(process.cwd(), fileArg);
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    throw new Error(`Файл ${fileArg} не найден. Укажите путь к дампу из папки backups/.`);
  }

  if (!filePath.toLowerCase().endsWith('.dump')) {
    throw new Error(
      `Файл ${fileArg} должен иметь расширение .dump — так называются дампы, созданные npm run backup.`,
    );
  }

  // Dry run before touching the target database: `pg_restore --list` parses the
  // archive header and fails on a text file or a partial download. A plain
  // `--clean` run against a non-archive would still connect and could drop
  // objects before failing, so this check must come first.
  try {
    await runPgCommand('pg_restore', ['--list', filePath]);
  } catch (error) {
    if (error.code === 'ENOENT') throw missingPgRestoreError();
    throw new Error(
      `Файл ${fileArg} не похож на дамп PostgreSQL: pg_restore --list сообщил «${error.message}». Восстановление отменено, база не изменена.`,
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'Не задан DATABASE_URL. Пропишите строку подключения в .env или передайте её в переменной окружения.',
    );
  }

  process.stdout.write('Восстанавливаю базу. Убедитесь, что приложение остановлено.\n');

  try {
    await runPgCommand('pg_restore', [
      '--clean',
      '--if-exists',
      `--dbname=${databaseUrl}`,
      filePath,
    ]);
  } catch (error) {
    if (error.code === 'ENOENT') throw missingPgRestoreError();
    throw new Error(
      `Восстановление не удалось. pg_restore сообщил: ${error.message}. Проверьте DATABASE_URL и доступность сервера.`,
    );
  }

  process.stdout.write(`База восстановлена из ${fileArg}.\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`Восстановление не выполнено: ${error.message}\n`);
  process.exitCode = 1;
}

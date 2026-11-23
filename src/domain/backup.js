/**
 * Backup naming, retention and display helpers.
 *
 * These live in the domain layer because both the CLI scripts and the admin
 * page need the same rules, and none of them touches the filesystem or Express.
 * The scripts own the IO; this module only decides names, ages and sizes.
 */

/** Dumps older than this are removed by the next `npm run backup`. */
export const BACKUP_RETENTION_DAYS = 7;

// Only files this tool created are eligible for retention. A manual copy an
// operator drops into `backups/` must survive an automated cleanup.
const BACKUP_FILE_NAME_PATTERN = /^motherload-\d{8}-\d{6}\.dump$/;

const FILE_SIZE_FORMATTER = new Intl.NumberFormat('ru-BY', {
  maximumFractionDigits: 1,
});

function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * Build the dump file name for one run: `motherload-YYYYMMDD-HHmmss.dump`.
 *
 * Local time is intentional: an operator matches the file to the wall clock on
 * the server, and the name stays readable without opening the file.
 * @param {Date} [date]
 * @returns {string}
 */
export function buildBackupFileName(date = new Date()) {
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');

  return `motherload-${stamp}.dump`;
}

/** @param {string} name */
export function isBackupFileName(name) {
  return BACKUP_FILE_NAME_PATTERN.test(name);
}

/**
 * An unparsable `modifiedAt` must never mark a file for deletion, so only a
 * finite age counts as expired.
 * @param {Date} modifiedAt
 * @param {Date} [now]
 * @param {number} [retentionDays]
 */
export function isBackupExpired(
  modifiedAt,
  now = new Date(),
  retentionDays = BACKUP_RETENTION_DAYS,
) {
  const ageMs = now.getTime() - modifiedAt.getTime();
  if (!Number.isFinite(ageMs)) return false;
  return ageMs > retentionDays * 24 * 60 * 60 * 1000;
}

/**
 * Pick the files the retention pass may delete.
 * @param {Array<{ name: string, modifiedAt: Date }>} files
 * @param {Date} [now]
 * @param {number} [retentionDays]
 * @returns {Array<{ name: string, modifiedAt: Date }>}
 */
export function selectExpiredBackups(
  files,
  now = new Date(),
  retentionDays = BACKUP_RETENTION_DAYS,
) {
  return files.filter(
    (file) => isBackupFileName(file.name) && isBackupExpired(file.modifiedAt, now, retentionDays),
  );
}

/**
 * Format a byte count for the admin table: `512 Б`, `1,5 КБ`, `5 МБ`.
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new TypeError(`formatFileSize: expected a non-negative number, got ${String(bytes)}`);
  }
  if (bytes < 1024) return `${bytes} Б`;

  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${FILE_SIZE_FORMATTER.format(kilobytes)} КБ`;

  return `${FILE_SIZE_FORMATTER.format(kilobytes / 1024)} МБ`;
}

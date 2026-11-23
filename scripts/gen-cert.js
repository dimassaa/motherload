/**
 * Generate a self-signed certificate for local HTTPS (`npm run cert`).
 *
 * The `selfsigned` package keeps the command dependency-free on Windows, where
 * OpenSSL is not part of the default PostgreSQL/Node installation. The pair is
 * written to the gitignored `certs/` directory and is valid for `localhost` and
 * `127.0.0.1` only: it is a development convenience, never a production
 * certificate. Browsers will still warn until the certificate is trusted
 * manually, which is expected for a self-signed chain.
 *
 * Paths are resolved from the project root rather than the current directory,
 * so the command behaves the same when started from a shortcut or a scheduler.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

const CERT_DIR = fileURLToPath(new URL('../certs', import.meta.url));
const KEY_PATH = path.join(CERT_DIR, 'key.pem');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');

// One year is long enough for a course demo without teaching the operator to
// ignore an expired certificate; regenerating the pair is one command.
const VALID_DAYS = 365;
const KEY_SIZE = 2048;

function generate() {
  return selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: KEY_SIZE,
    days: VALID_DAYS,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        // type 2 is DNS, type 7 is IP. Both names are needed because the server
        // may be opened as http://localhost or https://127.0.0.1.
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  });
}

async function main() {
  let pems;
  try {
    pems = generate();
  } catch (error) {
    throw new Error(`Не удалось создать сертификат: ${error.message}`);
  }

  if (!pems?.private || !pems?.cert) {
    throw new Error('Генератор сертификата вернул неполную пару ключей.');
  }

  await mkdir(CERT_DIR, { recursive: true });
  // The private key is readable only by the account that runs the server.
  await writeFile(KEY_PATH, pems.private, { mode: 0o600 });
  await writeFile(CERT_PATH, pems.cert);

  process.stdout.write(
    `Сертификат создан для localhost и 127.0.0.1:\n` +
      `  certs/key.pem\n` +
      `  certs/cert.pem\n\n` +
      `Включите HTTPS в .env:\n` +
      `  HTTPS=1\n` +
      `  TLS_CERT_PATH=certs/cert.pem\n` +
      `  TLS_KEY_PATH=certs/key.pem\n\n` +
      `Затем перезапустите приложение. Браузер предупредит о самоподписанном ` +
      `сертификате — для локальной проверки это ожидаемо.\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`Сертификат не создан: ${error.message}\n`);
  process.exitCode = 1;
}

/**
 * Copy self-hosted assets out of node_modules into public/.
 *
 * Runs as `postinstall` and must stay dependency-free: it executes before the
 * rest of the source tree is copied in Docker, and production installs omit dev
 * dependencies. Fails loudly when an expected file is missing, because a
 * silently skipped font or chart build produces broken pages that no test sees.
 */
import { access, copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const publicDir = path.join(rootDir, 'public');
const fontsDir = path.join(publicDir, 'fonts');
const vendorDir = path.join(publicDir, 'vendor');

// Entries are [source in node_modules, destination under public/]. The official
// NBRB font is committed instead of copied and is intentionally not checked
// here: Docker runs postinstall before the public tree is copied in.
const FONT_COPIES = [
  [
    'node_modules/@fontsource-variable/inter/files/inter-cyrillic-wght-normal.woff2',
    'fonts/inter-cyrillic-wght-normal.woff2',
  ],
  [
    'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
    'fonts/inter-latin-wght-normal.woff2',
  ],
  [
    'node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-cyrillic-wght-normal.woff2',
    'fonts/jetbrains-mono-cyrillic-wght-normal.woff2',
  ],
  [
    'node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
    'fonts/jetbrains-mono-latin-wght-normal.woff2',
  ],
  ['node_modules/chart.js/dist/chart.umd.js', 'vendor/chart.umd.js'],
];

async function exists(relativePath) {
  try {
    await access(path.join(rootDir, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(fontsDir, { recursive: true });
  await mkdir(vendorDir, { recursive: true });

  const missing = [];
  for (const [from] of FONT_COPIES) {
    if (!(await exists(from))) missing.push(from);
  }
  if (missing.length > 0) {
    throw new Error(
      `copy-vendor: missing required assets:\n  ${missing.join('\n  ')}\n` +
        'Run `npm ci` so node_modules is complete.',
    );
  }

  for (const [from, to] of FONT_COPIES) {
    await copyFile(path.join(rootDir, from), path.join(publicDir, to));
  }

  process.stdout.write(
    `copy-vendor: ${FONT_COPIES.length} assets ready in public/fonts and public/vendor\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

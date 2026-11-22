/**
 * Prepare self-hosted assets under public/.
 *
 * Runs as `postinstall`. Fonts are copied from node_modules; Chart.js is bundled
 * with esbuild into one browser-safe ESM file. The bundle is committed so that a
 * production install without devDependencies (`npm ci --omit=dev`) and the final
 * Docker image still serve it; in that case the committed file is kept as-is.
 *
 * Fails loudly when an expected source is missing, because a silently skipped
 * font or chart bundle produces broken pages that no test sees.
 */
import { access, copyFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const publicDir = path.join(rootDir, 'public');
const fontsDir = path.join(publicDir, 'fonts');
const vendorDir = path.join(publicDir, 'vendor');
const chartEntry = path.join(rootDir, 'node_modules/chart.js/auto/auto.js');
const chartBundle = path.join(vendorDir, 'chart.esm.js');

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
];

async function exists(absolutePath) {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bundle Chart.js's `auto` entry (all controllers and scales registered) into a
 * single ESM file. No UMD global is produced: the file only exports modules.
 */
async function buildChartBundle() {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
    if (await exists(chartBundle)) {
      process.stdout.write(
        'copy-vendor: esbuild unavailable, keeping committed public/vendor/chart.esm.js\n',
      );
      return;
    }
    throw new Error(
      'copy-vendor: esbuild is unavailable and public/vendor/chart.esm.js is missing.\n' +
        'Install dev dependencies (`npm ci`) or commit the generated bundle.',
    );
  }

  if (!(await exists(chartEntry))) {
    throw new Error('copy-vendor: node_modules/chart.js/auto/auto.js is missing; run `npm ci`.');
  }

  await esbuild.build({
    entryPoints: [chartEntry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    outfile: chartBundle,
    logLevel: 'silent',
  });

  const info = await stat(chartBundle);
  if (info.size === 0) {
    throw new Error('copy-vendor: esbuild produced an empty chart.esm.js');
  }
}

async function main() {
  await mkdir(fontsDir, { recursive: true });
  await mkdir(vendorDir, { recursive: true });

  const missing = [];
  for (const [from] of FONT_COPIES) {
    if (!(await exists(path.join(rootDir, from)))) missing.push(from);
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

  await buildChartBundle();

  process.stdout.write(
    `copy-vendor: ${FONT_COPIES.length} font files ready; Chart.js ESM bundle ready\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

/**
 * Render the 1200×630 Open Graph cover from its SVG source.
 *
 * Kept as a separate script instead of a postinstall step: sharp is a dev
 * dependency, pruned from the runtime image, and the PNG is generated once per
 * asset change. The SVG source is not committed yet; missing SEO assets are an
 * open item in IMPROVEMENTS.md.
 */
import { access, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const sourcePath = path.join(rootDir, 'public/img/og-cover.svg');
const targetPath = path.join(rootDir, 'public/img/og-cover.png');

async function main() {
  try {
    await access(sourcePath);
  } catch {
    throw new Error(
      'og-cover.svg missing — expected public/img/og-cover.svg (open item in IMPROVEMENTS.md)',
    );
  }

  await mkdir(path.dirname(targetPath), { recursive: true });

  // `density` keeps SVG strokes crisp when the artwork uses a larger viewBox.
  await sharp(sourcePath, { density: 144 })
    .resize(1200, 630, { fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toFile(targetPath);

  process.stdout.write('build-og: wrote public/img/og-cover.png (1200×630)\n');
}

main().catch((error) => {
  process.stderr.write(`build-og: ${error.message}\n`);
  process.exitCode = 1;
});

import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const publicDir = fileURLToPath(new URL('../../public', import.meta.url));

const GENERATED_ASSETS = [
  'vendor/chart.umd.js',
  'fonts/inter-cyrillic-wght-normal.woff2',
  'fonts/inter-latin-wght-normal.woff2',
  'fonts/jetbrains-mono-cyrillic-wght-normal.woff2',
  'fonts/jetbrains-mono-latin-wght-normal.woff2',
];

const COMMITTED_FONTS = ['fonts/nbrb.woff2', 'fonts/nbrb.woff', 'fonts/nbrb.ttf'];

test('postinstall copied Chart.js and the self-hosted UI fonts', async () => {
  for (const relativePath of GENERATED_ASSETS) {
    const info = await stat(path.join(publicDir, relativePath));
    assert.ok(info.size > 0, `${relativePath} is empty`);
  }
});

test('the official NBRB font ships with the repository', async () => {
  for (const relativePath of COMMITTED_FONTS) {
    const info = await stat(path.join(publicDir, relativePath));
    assert.ok(info.size > 0, `${relativePath} is empty`);
  }
});

test('the stylesheet references every hosted font file', async () => {
  const css = await readFile(path.join(publicDir, 'css/app.css'), 'utf8');
  const fonts = [
    ...GENERATED_ASSETS.filter((file) => file.startsWith('fonts/')),
    ...COMMITTED_FONTS,
  ];

  for (const relativePath of fonts) {
    const fileName = path.basename(relativePath);
    assert.ok(css.includes(`/fonts/${fileName}`), `app.css does not reference ${fileName}`);
  }
});

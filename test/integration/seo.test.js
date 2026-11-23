import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createTestApp } from '../helpers/app.js';
import { setupTestDb, teardownTestDb, truncateAll } from '../helpers/db.js';
import { createUserFactory, DEFAULT_TEST_PASSWORD } from '../helpers/factories.js';
import { loginAs } from '../helpers/http.js';

const ogCoverPath = fileURLToPath(new URL('../../public/img/og-cover.png', import.meta.url));

test.before(async () => {
  await setupTestDb();
});

test.beforeEach(async () => {
  await truncateAll();
});

test.after(async () => {
  await teardownTestDb();
});

test('landing exposes title, description, canonical and JSON-LD', async () => {
  const res = await request(createApp()).get('/');

  assert.equal(res.status, 200);
  assert.match(res.text, /<title>Motherload — /);
  assert.match(res.text, /<meta name="description" content="[^"]+">/);
  assert.match(res.text, /<link rel="canonical" href="http:\/\/localhost:3000\/">/);
  assert.match(res.text, /"@type":"SoftwareApplication"/);
  assert.match(res.text, /"name":"Motherload"/);
  assert.match(res.text, /"applicationCategory":"BusinessApplication"/);
  assert.match(res.text, /"operatingSystem":"Web"/);
  assert.match(res.text, /"inLanguage":"ru-BY"/);
});

test('landing exposes Open Graph and Twitter Card metadata', async () => {
  const res = await request(createApp()).get('/');

  assert.match(res.text, /property="og:type" content="website"/);
  assert.match(res.text, /property="og:title" content="Motherload/);
  assert.match(res.text, /property="og:url" content="http:\/\/localhost:3000\/"/);
  assert.match(
    res.text,
    /property="og:image" content="http:\/\/localhost:3000\/img\/og-cover\.png"/,
  );
  assert.match(res.text, /property="og:image:width" content="1200"/);
  assert.match(res.text, /property="og:image:height" content="630"/);
  assert.match(res.text, /name="twitter:card" content="summary_large_image"/);
  assert.match(
    res.text,
    /name="twitter:image" content="http:\/\/localhost:3000\/img\/og-cover\.png"/,
  );
});

test('landing stays indexable and has one h1', async () => {
  const res = await request(createApp()).get('/');

  assert.doesNotMatch(res.text, /name="robots" content="noindex/);
  assert.equal((res.text.match(/<h1[\s>]/g) ?? []).length, 1);
});

test('the committed OG cover is a 1200x630 PNG', async () => {
  const png = await readFile(ogCoverPath);

  // PNG signature followed by the IHDR chunk: width and height are big-endian
  // 32-bit integers at offsets 16 and 20.
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

test('robots disallows private areas and points to an absolute sitemap', async () => {
  const res = await request(createApp()).get('/robots.txt');

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/plain/);
  assert.match(res.text, /^User-agent: \*/m);
  assert.match(res.text, /^Allow: \/$/m);
  for (const area of [
    '/dashboard',
    '/components',
    '/stock',
    '/inventory',
    '/analytics',
    '/alerts',
    '/reports',
    '/admin',
    '/profile',
    '/api',
  ]) {
    assert.match(res.text, new RegExp(`^Disallow: ${area.replaceAll('/', '\\/')}$`, 'm'));
  }
  assert.match(res.text, /^Sitemap: http:\/\/localhost:3000\/sitemap\.xml$/m);
});

test('sitemap lists only the public landing with an absolute URL', async () => {
  const res = await request(createApp()).get('/sitemap.xml');

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/xml/);
  assert.match(res.text, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(res.text, /<loc>http:\/\/localhost:3000\/<\/loc>/);
  assert.equal((res.text.match(/<url>/g) ?? []).length, 1);
});

test('authenticated pages are noindex and carry no landing canonical', async () => {
  await createUserFactory({ email: 'seo@test.by', password: DEFAULT_TEST_PASSWORD });
  const { agent } = createTestApp();
  await loginAs(agent, 'seo@test.by', DEFAULT_TEST_PASSWORD);

  const res = await agent.get('/dashboard');

  assert.equal(res.status, 200);
  assert.match(res.text, /<meta name="robots" content="noindex, nofollow">/);
  assert.doesNotMatch(res.text, /rel="canonical"/);
  assert.doesNotMatch(res.text, /property="og:image"/);
});

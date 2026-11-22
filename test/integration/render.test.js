import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db/pool.js';

test('GET / renders the public landing inside the base layout', async () => {
  const res = await request(createApp()).get('/');

  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.text, /<html lang="ru">/);
  assert.match(res.text, /MOTHERLOAD/);
  assert.match(res.text, /Складской терминал для комплектующих/);
  assert.match(res.text, /href="\/css\/app\.css"/);
});

test('GET / ships no inline style attributes or blocks', async () => {
  const res = await request(createApp()).get('/');

  assert.doesNotMatch(res.text, /\sstyle="/);
  assert.doesNotMatch(res.text, /<style[\s>]/);
});

test('GET / keeps public pages indexable and sends no inline scripts', async () => {
  const res = await request(createApp()).get('/');

  assert.doesNotMatch(res.text, /noindex/);
  assert.doesNotMatch(res.text, /<script(?![^>]*\bsrc=)/);
});

test.after(async () => {
  await closePool();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db/pool.js';

test('GET /healthz returns ok when database is reachable', async () => {
  const res = await request(createApp()).get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.body.db, 'up');
});

test.after(async () => {
  await closePool();
});

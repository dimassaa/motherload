import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTrustProxy } from '../../src/config/env.js';

test('TRUST_PROXY parses explicit false and hop counts', () => {
  assert.equal(parseTrustProxy(''), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('0'), 0);
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('3'), 3);
});

test('TRUST_PROXY accepts loopback keywords and IP/CIDR lists', () => {
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.equal(parseTrustProxy('loopback, linklocal'), 'loopback,linklocal');
  assert.equal(parseTrustProxy('10.0.0.0/8'), '10.0.0.0/8');
  assert.equal(parseTrustProxy('::1'), '::1');
});

test('TRUST_PROXY rejects blanket trust and junk values instead of failing per request', () => {
  assert.throws(() => parseTrustProxy('true'), /TRUST_PROXY/);
  assert.throws(() => parseTrustProxy('banana'), /TRUST_PROXY/);
  assert.throws(() => parseTrustProxy('10.0.0.0/33'), /TRUST_PROXY/);
  assert.throws(() => parseTrustProxy('99'), /TRUST_PROXY/);
});

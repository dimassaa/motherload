import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyXyz } from '../../src/domain/xyz.js';
import { ValidationError } from '../../src/domain/errors.js';

test('stable monthly demand is X', () => {
  assert.equal(classifyXyz([10, 10, 10, 10, 10, 10]).class, 'X');
});

test('high variation is Z', () => {
  assert.equal(classifyXyz([0, 0, 0, 100, 0, 0]).class, 'Z');
});

test('zero mean is Z with null cv', () => {
  const r = classifyXyz([0, 0, 0, 0, 0, 0]);
  assert.equal(r.cv, null);
  assert.equal(r.class, 'Z');
});

test('cv upper bounds are inclusive: 0.10 is X, 0.25 is Y', () => {
  // mean 10, population stddev 1 -> cv exactly 0.1
  assert.equal(classifyXyz([9, 11, 9, 11, 9, 11]).class, 'X');
  // mean 8, population stddev 2 -> cv exactly 0.25
  assert.equal(classifyXyz([6, 10, 6, 10, 6, 10]).class, 'Y');
});

test('moderate variation is Y', () => {
  // mean 10, population stddev 2 -> cv 0.2
  assert.equal(classifyXyz([8, 12, 8, 12, 8, 12]).class, 'Y');
});

test('returns cv as a number for non-zero mean', () => {
  assert.equal(classifyXyz([8, 12, 8, 12, 8, 12]).cv, 0.2);
});

test('requires exactly six months', () => {
  assert.throws(() => classifyXyz([1, 2, 3]), ValidationError);
  assert.throws(() => classifyXyz([]), ValidationError);
});

test('rejects negative or non-numeric quantities', () => {
  assert.throws(() => classifyXyz([1, 2, -3, 4, 5, 6]), ValidationError);
  assert.throws(() => classifyXyz([1, 2, '3', 4, 5, 6]), ValidationError);
});

test('does not mutate the input', () => {
  const months = [0, 0, 0, 100, 0, 0];
  classifyXyz(months);
  assert.deepEqual(months, [0, 0, 0, 100, 0, 0]);
});

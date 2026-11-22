import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyAbc } from '../../src/domain/abc.js';
import { ValidationError } from '../../src/domain/errors.js';

test('ABC boundaries are inclusive and stable for ties', () => {
  const r = classifyAbc([
    { id: 1, value: '80' },
    { id: 2, value: '15' },
    { id: 3, value: '5' },
  ]);
  assert.deepEqual(
    r.map((x) => x.class),
    ['A', 'B', 'C'],
  );
});

test('zero total marks everything C without NaN', () => {
  const r = classifyAbc([{ id: 1, value: '0' }]);
  assert.equal(r[0].class, 'C');
  assert.equal(r[0].share, 0);
  assert.equal(r[0].cumulativeShare, 0);
});

test('sorts by value descending and id ascending on ties', () => {
  const r = classifyAbc([
    { id: 3, value: '30' },
    { id: 1, value: '30' },
    { id: 2, value: '40' },
  ]);
  assert.deepEqual(
    r.map((x) => x.id),
    [2, 1, 3],
  );
});

test('computes shares and cumulative shares as numbers', () => {
  const r = classifyAbc([
    { id: 1, value: '50' },
    { id: 2, value: '30' },
    { id: 3, value: '20' },
  ]);
  assert.deepEqual(
    r.map((x) => [x.share, x.cumulativeShare]),
    [
      [0.5, 0.5],
      [0.3, 0.8],
      [0.2, 1],
    ],
  );
});

test('keeps the incoming value untouched for the view layer', () => {
  const r = classifyAbc([{ id: 1, value: '123.4500' }]);
  assert.equal(r[0].value, '123.4500');
});

test('honours custom class thresholds', () => {
  const r = classifyAbc(
    [
      { id: 1, value: '70' },
      { id: 2, value: '20' },
      { id: 3, value: '10' },
    ],
    { a: 0.7, b: 0.9 },
  );
  assert.deepEqual(
    r.map((x) => x.class),
    ['A', 'B', 'C'],
  );
});

test('an item without value never reaches A or B', () => {
  const r = classifyAbc(
    [
      { id: 1, value: '10' },
      { id: 2, value: '0' },
    ],
    { a: 1, b: 1 },
  );
  assert.equal(r.find((x) => x.id === 2).class, 'C');
});

test('does not mutate the input items', () => {
  const items = [
    { id: 2, value: '10' },
    { id: 1, value: '30' },
  ];
  classifyAbc(items);
  assert.deepEqual(
    items.map((x) => x.id),
    [2, 1],
  );
});

test('rejects values that are not finite non-negative numbers', () => {
  assert.throws(() => classifyAbc([{ id: 1, value: 'abc' }]), ValidationError);
  assert.throws(() => classifyAbc([{ id: 1, value: '-5' }]), ValidationError);
});

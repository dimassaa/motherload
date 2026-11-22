import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ValidationError } from '../../src/domain/errors.js';
import { calculateReorder } from '../../src/domain/reorder.js';

test('ROP uses z=1.645 and 90-day demand', () => {
  const r = calculateReorder({
    dailyQuantities: Array(90).fill(2),
    leadTimeDays: 5,
    minStock: 10,
    balance: 30,
    unitCost: '100.0000',
  });
  assert.equal(r.avgDaily, 2);
  assert.equal(r.safetyStock, 0);
  assert.equal(r.rop, 10);
  assert.ok(r.eoq > 0);
  assert.equal(r.lowData, false);
  assert.equal(r.suggested, 0);
});

test('low history falls back to min_stock', () => {
  const r = calculateReorder({
    dailyQuantities: Array(90).fill(0),
    historyDays: 3,
    leadTimeDays: 5,
    minStock: 12,
    balance: 4,
    unitCost: '10.0000',
  });
  assert.equal(r.lowData, true);
  assert.equal(r.rop, 12);
  assert.equal(r.suggested, 8);
});

test('adds safety stock from population stddev of the window', () => {
  // Alternating 0 and 4 -> mean 2, population stddev 2.
  const dailyQuantities = Array.from({ length: 90 }, (_, i) => (i % 2 === 0 ? 0 : 4));
  const r = calculateReorder({
    dailyQuantities,
    leadTimeDays: 4,
    minStock: 0,
    balance: 100,
    unitCost: '10.0000',
  });
  assert.equal(r.avgDaily, 2);
  assert.equal(r.stddev, 2);
  assert.equal(r.safetyStock, 6.58);
  assert.equal(r.rop, 14.58);
});

test('suggests a full EOQ rounded up when balance is at or below ROP', () => {
  const r = calculateReorder({
    dailyQuantities: Array(90).fill(1),
    leadTimeDays: 5,
    minStock: 0,
    balance: 0,
    unitCost: '100.0000',
  });
  // sqrt(2 * 365 * 50 / (100 * 0.20)) = sqrt(1825) = 42.72
  assert.equal(r.eoq, 42.72);
  assert.equal(r.suggested, 43);
});

test('zero or negative unit cost means no order quantity', () => {
  const base = {
    dailyQuantities: Array(90).fill(2),
    leadTimeDays: 5,
    minStock: 10,
    balance: 0,
  };
  assert.equal(calculateReorder({ ...base, unitCost: '0' }).eoq, 0);
  assert.equal(calculateReorder({ ...base, unitCost: '-1' }).eoq, 0);
  assert.equal(calculateReorder({ ...base, unitCost: '0' }).suggested, 0);
});

test('fourteen days of history is enough data', () => {
  const r = calculateReorder({
    dailyQuantities: Array(90).fill(2),
    historyDays: 14,
    leadTimeDays: 5,
    minStock: 10,
    balance: 30,
    unitCost: '100.0000',
  });
  assert.equal(r.lowData, false);
});

test('low data never suggests a negative quantity', () => {
  const r = calculateReorder({
    dailyQuantities: Array(90).fill(0),
    historyDays: 0,
    leadTimeDays: 5,
    minStock: 12,
    balance: 20,
    unitCost: '10.0000',
  });
  assert.equal(r.suggested, 0);
});

test('rejects a demand window shorter than 90 days', () => {
  assert.throws(
    () =>
      calculateReorder({
        dailyQuantities: Array(30).fill(2),
        leadTimeDays: 5,
        minStock: 12,
        balance: 30,
        unitCost: '10.0000',
      }),
    ValidationError,
  );
});

test('rejects incomplete input instead of producing NaN', () => {
  assert.throws(() => calculateReorder({}), ValidationError);
  assert.throws(
    () =>
      calculateReorder({
        dailyQuantities: [],
        leadTimeDays: 5,
        minStock: 0,
        balance: 0,
        unitCost: '1',
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      calculateReorder({
        dailyQuantities: [1, 2, -3],
        leadTimeDays: 5,
        minStock: 0,
        balance: 0,
        unitCost: '1',
      }),
    ValidationError,
  );
});

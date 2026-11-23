import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatMoney,
  formatScaled,
  parseQty,
  parseScaled,
  roundScaled,
} from '../../public/js/money.js';

test('client money: parseScaled accepts comma and dot decimals', () => {
  assert.equal(parseScaled('250,50', 4), 2_505_000n);
  assert.equal(parseScaled('250.50', 4), 2_505_000n);
  assert.equal(parseScaled(' 1 250,5 ', 4), 12_505_000n);
  assert.equal(parseScaled('0', 4), 0n);
});

test('client money: parseScaled rejects malformed input', () => {
  for (const value of ['', ' ', 'abc', '1,2,3', '-1', '1.2.3', NaN, null, undefined]) {
    assert.equal(parseScaled(value, 4), null, `${String(value)} must not parse`);
  }
});

test('client money: parseScaled rounds half up at the requested scale', () => {
  assert.equal(parseScaled('1.23456', 4), 12_346n);
  assert.equal(parseScaled('1.23444', 4), 12_344n);
  assert.equal(parseScaled('1.005', 2), 101n);
  assert.equal(parseScaled('1.004', 2), 100n);
});

test('client money: roundScaled carries half up', () => {
  assert.equal(roundScaled(9_999n, 4, 2), 100n);
  assert.equal(roundScaled(8_649n, 4, 2), 86n);
  assert.equal(roundScaled(8_650n, 4, 2), 87n);
  assert.equal(roundScaled(999n, 4, 2), 10n);
  assert.equal(roundScaled(5n, 0, 2), 500n);
});

test('client money: line totals match the server examples', () => {
  // 3 × 0.3333 = 0.9999 → 1.00, and 7 × 12.3456 = 86.4192 → 86.42.
  const first = roundScaled(3n * parseScaled('0.3333', 4), 4, 2);
  const second = roundScaled(7n * parseScaled('12.3456', 4), 4, 2);
  assert.equal(formatScaled(first, 2), '1,00');
  assert.equal(formatScaled(second, 2), '86,42');
});

test('client money: formatScaled groups thousands with a plain space', () => {
  assert.equal(formatScaled(100_200n, 2), '1 002,00');
  assert.equal(formatScaled(1_234_567_89n, 2), '1 234 567,89');
  assert.equal(formatScaled(0n, 2), '0,00');
  assert.equal(formatScaled(5n, 0), '5');
});

test('client money: formatMoney normalises server strings to two decimals', () => {
  assert.equal(formatMoney('50.00'), '50,00');
  assert.equal(formatMoney('180.0000'), '180,00');
  assert.equal(formatMoney('0.9999'), '1,00');
  assert.equal(formatMoney('nope'), '—');
});

test('client money: parseQty accepts whole quantities only', () => {
  assert.equal(parseQty('4'), 4n);
  assert.equal(parseQty(' 1 000 '), 1000n);
  assert.equal(parseQty('4,5'), null);
  assert.equal(parseQty('0.5'), null);
  assert.equal(parseQty(''), null);
});

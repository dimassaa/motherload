import assert from 'node:assert/strict';
import { test } from 'node:test';

import { d, formatMoney, formatQty, toCost } from '../../src/domain/money.js';
import { ValidationError } from '../../src/domain/errors.js';

test('formats BYN with space grouping and comma', () => {
  assert.equal(formatMoney('1234.5'), '1 234,50');
  assert.equal(formatMoney('1234.56'), '1 234,56');
  assert.equal(formatMoney('0'), '0,00');
});

test('adds without float drift', () => {
  assert.equal(d('0.1').plus('0.2').toFixed(2), '0.30');
});

test('rounds costs half up to four decimals', () => {
  assert.equal(toCost('1.23455'), '1.2346');
  assert.equal(toCost('1.23454'), '1.2345');
  assert.equal(toCost(2), '2.0000');
});

test('normalizes the non-breaking space from Intl', () => {
  assert.equal(formatMoney('1234.5').includes('\u00A0'), false);
});

test('formats quantities as grouped integers', () => {
  assert.equal(formatQty(1234567), '1 234 567');
  assert.equal(formatQty(0), '0');
});

test('rejects values that are not numbers', () => {
  assert.throws(() => d('not-a-number'), ValidationError);
  assert.throws(() => d(Number.NaN), ValidationError);
});

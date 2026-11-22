import assert from 'node:assert/strict';
import { test } from 'node:test';

import { calculateKpi } from '../../src/domain/kpi.js';

test('KPI returns null instead of dividing by zero', () => {
  assert.deepEqual(calculateKpi({ stockValue: '0', cogs90: '0', deadValue: '0' }), {
    turnoverYear: null,
    coverageDays: null,
  });
});

test('turnover is annualised from the 90-day COGS', () => {
  const r = calculateKpi({ stockValue: '1000.00', cogs90: '500.00', deadValue: '0' });
  assert.equal(r.turnoverYear, 2);
  assert.equal(r.coverageDays, 180);
});

test('zero COGS with stock on hand means infinite coverage', () => {
  const r = calculateKpi({ stockValue: '250.00', cogs90: '0', deadValue: '250.00' });
  assert.equal(r.turnoverYear, 0);
  assert.equal(r.coverageDays, null);
});

test('no stock on hand leaves turnover unknown', () => {
  const r = calculateKpi({ stockValue: '0', cogs90: '300.00', deadValue: '0' });
  assert.equal(r.turnoverYear, null);
  assert.equal(r.coverageDays, 0);
});

test('keeps decimal precision without float money', () => {
  const r = calculateKpi({ stockValue: '0.10', cogs90: '0.10', deadValue: '0' });
  assert.equal(r.turnoverYear, 4);
  assert.equal(r.coverageDays, 90);
});

test('returns numbers rounded for display', () => {
  const r = calculateKpi({ stockValue: '300.00', cogs90: '100.00', deadValue: '0' });
  // 100 / 300 * 4 = 1.333...
  assert.equal(r.turnoverYear, 1.3333);
  assert.equal(r.coverageDays, 270);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateStockStatus, stockStatus } from '../../src/domain/stock-status.js';

test('stockStatus treats zero stock as its own status, not below minimum', () => {
  assert.equal(stockStatus({ qty: 0, minStock: 5, maxStock: 20 }), 'zero');
  assert.equal(stockStatus({ qty: 1, minStock: 5, maxStock: 20 }), 'below_min');
  assert.equal(stockStatus({ qty: 7, minStock: 5, maxStock: 20 }), 'ok');
  assert.equal(stockStatus({ qty: 21, minStock: 5, maxStock: 20 }), 'overstock');
});

test('stockStatus never reports overstock without a maximum', () => {
  assert.equal(stockStatus({ qty: 999, minStock: 5, maxStock: null }), 'ok');
});

test('aggregateStockStatus reduces to the local rule for one warehouse', () => {
  assert.equal(aggregateStockStatus({ qty: 0, warehouses: [{ minStock: 5 }] }), 'zero');
  assert.equal(aggregateStockStatus({ qty: 3, warehouses: [{ minStock: 5 }] }), 'below_min');
  assert.equal(aggregateStockStatus({ qty: 7, warehouses: [{ minStock: 5 }] }), 'ok');
  assert.equal(
    aggregateStockStatus({ qty: 21, warehouses: [{ minStock: 5, maxStock: 20 }] }),
    'overstock',
  );
});

test('aggregateStockStatus measures the total against the summed thresholds', () => {
  const thresholds = { minStock: 5, maxStock: 12 };

  // 10 units is below each single 5-unit minimum only if a local row is
  // inspected; against the summed minimum of two warehouses it is healthy.
  assert.equal(
    aggregateStockStatus({
      qty: 10,
      warehouses: [thresholds, thresholds],
    }),
    'ok',
  );
  assert.equal(
    aggregateStockStatus({
      qty: 9,
      warehouses: [thresholds, thresholds],
    }),
    'below_min',
  );
  assert.equal(
    aggregateStockStatus({
      qty: 25,
      warehouses: [thresholds, thresholds],
    }),
    'overstock',
  );
});

test('aggregateStockStatus reports zero only when the total balance is zero', () => {
  // A warehouse with no stock does not make the whole position empty when
  // another warehouse holds units.
  assert.equal(
    aggregateStockStatus({
      qty: 4,
      warehouses: [
        { qty: 0, minStock: 0, maxStock: null },
        { qty: 4, minStock: 0, maxStock: null },
      ],
    }),
    'ok',
  );
  assert.equal(
    aggregateStockStatus({
      qty: 0,
      warehouses: [
        { qty: 0, minStock: 5, maxStock: null },
        { qty: 0, minStock: 5, maxStock: null },
      ],
    }),
    'zero',
  );
});

test('aggregateStockStatus treats an unbounded maximum as no upper limit', () => {
  assert.equal(
    aggregateStockStatus({
      qty: 500,
      warehouses: [
        { qty: 250, minStock: 0, maxStock: 20 },
        { qty: 250, minStock: 0, maxStock: null },
      ],
    }),
    'ok',
  );
});

test('aggregateStockStatus leaves a position without participating warehouses healthy', () => {
  assert.equal(aggregateStockStatus({ qty: 3, warehouses: [] }), 'ok');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { stockStatus, worstStockStatus } from '../../src/domain/stock-status.js';

test('stockStatus treats zero stock as its own status, not below minimum', () => {
  assert.equal(stockStatus({ qty: 0, minStock: 5, maxStock: 20 }), 'zero');
  assert.equal(stockStatus({ qty: 1, minStock: 5, maxStock: 20 }), 'below_min');
  assert.equal(stockStatus({ qty: 7, minStock: 5, maxStock: 20 }), 'ok');
  assert.equal(stockStatus({ qty: 21, minStock: 5, maxStock: 20 }), 'overstock');
});

test('stockStatus never reports overstock without a maximum', () => {
  assert.equal(stockStatus({ qty: 999, minStock: 5, maxStock: null }), 'ok');
});

test('worstStockStatus ranks zero above below_min above overstock above ok', () => {
  assert.equal(worstStockStatus(['ok', 'overstock']), 'overstock');
  assert.equal(worstStockStatus(['overstock', 'below_min']), 'below_min');
  assert.equal(worstStockStatus(['below_min', 'zero']), 'zero');
  assert.equal(worstStockStatus([]), 'ok');
});

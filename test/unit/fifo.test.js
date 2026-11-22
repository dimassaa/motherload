import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allocateFifo } from '../../src/domain/fifo.js';
import { InsufficientStockError, ValidationError } from '../../src/domain/errors.js';

test('allocates across batches in received_at then id order', () => {
  const r = allocateFifo(
    [
      { id: 2, unitCost: '12.5000', qtyRemaining: 5, receivedAt: '2026-01-02' },
      { id: 1, unitCost: '10.0000', qtyRemaining: 3, receivedAt: '2026-01-01' },
    ],
    6,
  );
  assert.deepEqual(
    r.allocations.map((a) => [a.batchId, a.qty]),
    [
      [1, 3],
      [2, 3],
    ],
  );
  assert.equal(r.totalCost, '67.5000');
});

test('breaks ties on the same received_at by batch id', () => {
  const r = allocateFifo(
    [
      { id: 7, unitCost: '5.0000', qtyRemaining: 2, receivedAt: '2026-01-01' },
      { id: 3, unitCost: '4.0000', qtyRemaining: 2, receivedAt: '2026-01-01' },
    ],
    3,
  );
  assert.deepEqual(
    r.allocations.map((a) => [a.batchId, a.qty]),
    [
      [3, 2],
      [7, 1],
    ],
  );
  assert.equal(r.totalCost, '13.0000');
});

test('does not mutate the input batches', () => {
  const batches = [
    { id: 2, unitCost: '12.5000', qtyRemaining: 5, receivedAt: '2026-01-02' },
    { id: 1, unitCost: '10.0000', qtyRemaining: 3, receivedAt: '2026-01-01' },
  ];
  allocateFifo(batches, 6);
  assert.deepEqual(
    batches.map((b) => b.id),
    [2, 1],
  );
  assert.equal(batches[0].qtyRemaining, 5);
  assert.equal(batches[1].qtyRemaining, 3);
});

test('throws InsufficientStockError with available quantity', () => {
  assert.throws(
    () => allocateFifo([{ id: 1, unitCost: '1', qtyRemaining: 2, receivedAt: '2026-01-01' }], 3),
    (e) =>
      e instanceof InsufficientStockError &&
      e.code === 'INSUFFICIENT_STOCK' &&
      e.available === 2 &&
      e.message === 'На складе недостаточно: доступно 2 шт.',
  );
});

test('rejects non-positive and fractional quantities', () => {
  assert.throws(() => allocateFifo([], 0), ValidationError);
  assert.throws(() => allocateFifo([], -1), ValidationError);
  assert.throws(() => allocateFifo([], 1.5), ValidationError);
  assert.throws(() => allocateFifo([], '3'), ValidationError);
});

test('keeps four-decimal precision on small unit costs', () => {
  const r = allocateFifo(
    [{ id: 1, unitCost: '0.1', qtyRemaining: 3, receivedAt: '2026-01-01' }],
    3,
  );
  assert.equal(r.allocations[0].totalCost, '0.3000');
  assert.equal(r.totalCost, '0.3000');
});

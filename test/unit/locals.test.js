import assert from 'node:assert/strict';
import test from 'node:test';
import { attachLocals } from '../../src/middleware/locals.js';

test('attachLocals tolerates a request without req.user', () => {
  const req = { path: '/dashboard' };
  const res = { locals: {} };
  let called = false;

  attachLocals(req, res, () => {
    called = true;
  });

  assert.equal(called, true);
  assert.equal(res.locals.currentUser, null);
  assert.equal(res.locals.currentPath, '/dashboard');
  assert.equal(res.locals.alertCount, 0);
  assert.equal(typeof res.locals.formatMoney, 'function');
  assert.equal(res.locals.csrfField(), '');
});

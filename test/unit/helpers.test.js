import assert from 'node:assert/strict';
import test from 'node:test';
import {
  csrfField,
  formatDate,
  formatDateTime,
  formatMoney,
  formatPct,
  formatQty,
  money,
  queryString,
  statusChip,
} from '../../src/views/helpers.js';

test('formatMoney uses ru-BY grouping and comma', () => {
  assert.equal(formatMoney('1234.5'), '1 234,50');
});

test('formatMoney always renders two decimals and a plain space separator', () => {
  assert.equal(formatMoney(0), '0,00');
  assert.equal(formatMoney('1234567.891'), '1 234 567,89');
  assert.equal(formatMoney(null), '0,00');
});

test('formatMoney rejects values that are not finite numbers', () => {
  assert.throws(() => formatMoney('not-a-number'), TypeError);
  assert.throws(() => formatMoney('<script>'), TypeError);
});

test('formatQty groups integers without fraction digits', () => {
  assert.equal(formatQty('1234'), '1 234');
  assert.equal(formatQty(42), '42');
});

test('formatQty keeps up to three meaningful decimals', () => {
  assert.equal(formatQty('1234.50'), '1 234,5');
  assert.equal(formatQty('0.125'), '0,125');
});

test('formatDate keeps document date without timezone shift', () => {
  assert.equal(formatDate('2026-11-22'), '22.11.2026');
});

test('formatDate accepts Date instances and rejects invalid input', () => {
  assert.equal(formatDate(new Date('2026-11-22T00:00:00+03:00')), '22.11.2026');
  assert.throws(() => formatDate('22.11.2026'), TypeError);
  assert.throws(() => formatDate('2026-02-31'), TypeError);
});

test('formatDateTime renders Europe/Minsk wall-clock time', () => {
  assert.equal(formatDateTime('2026-11-22T21:05:00Z'), '23.11.2026 00:05');
  assert.equal(formatDateTime(new Date('2026-11-22T06:30:00Z')), '22.11.2026 09:30');
});

test('formatPct uses a comma and one decimal by default', () => {
  assert.equal(formatPct('12.345'), '12,3%');
  assert.equal(formatPct(12), '12,0%');
  assert.equal(formatPct('7.25', 0), '7%');
});

test('money returns trusted markup with the NBRB sign', () => {
  assert.equal(
    money('1234.5'),
    '<span class="money">1 234,50 <i class="nbrb-icon" aria-hidden="true">BYN</i></span>',
  );
});

test('money refuses arbitrary markup', () => {
  assert.throws(() => money('<img src=x onerror=alert(1)>'), TypeError);
});

test('statusChip maps known statuses to Russian labels and classes', () => {
  assert.deepEqual(statusChip('approved'), { label: 'Утверждена', className: 'chip--success' });
  assert.deepEqual(statusChip('warning'), { label: 'Предупреждение', className: 'chip--warning' });
  assert.deepEqual(statusChip('critical'), { label: 'Критично', className: 'chip--danger' });
  assert.deepEqual(statusChip('archived'), { label: 'В архиве', className: 'chip--muted' });
});

test('statusChip falls back to the raw status without inventing a colour', () => {
  assert.deepEqual(statusChip('custom'), { label: 'custom', className: 'chip--muted' });
});

test('queryString preserves existing params and overrides page', () => {
  assert.equal(queryString('/components', { q: 'ssd', page: 2 }), '/components?q=ssd&page=2');
});

test('queryString keeps base params, drops empty values and encodes text', () => {
  assert.equal(
    queryString('/components?status=active&page=1', { page: 2 }),
    '/components?status=active&page=2',
  );
  assert.equal(queryString('/components?status=active', { status: '', q: null }), '/components');
  assert.equal(queryString('/components', { q: 'ssd 1 ТБ' }), '/components?q=ssd+1+%D0%A2%D0%91');
});

test('csrfField renders the session token and escapes it', () => {
  const req = { session: { csrfToken: 'abc"123' } };
  assert.equal(csrfField(req), '<input type="hidden" name="_csrf" value="abc&quot;123">');
});

test('csrfField renders nothing before sessions or CSRF exist', () => {
  assert.equal(csrfField({}), '');
  assert.equal(csrfField({ session: {} }), '');
});

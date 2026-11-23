import assert from 'node:assert/strict';
import test from 'node:test';

import { csvFilename, toCsv } from '../../src/domain/csv.js';

const COLUMNS = [
  { key: 'name', label: 'Название' },
  { key: 'qty', label: 'Кол-во' },
];

test('CSV starts with BOM, uses semicolons and CRLF', () => {
  const csv = toCsv([{ name: 'SSD; 1TB', qty: 2 }], COLUMNS);

  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /Название;Кол-во\r\n/);
  assert.match(csv, /"SSD; 1TB";2/);
  assert.ok(csv.includes('\r\n'));
});

test('CSV quotes fields with quotes and newlines and escapes quotes by doubling', () => {
  const csv = toCsv(
    [
      { name: 'Он сказал "да"', qty: 1 },
      { name: 'Первая\nвторая', qty: 2 },
    ],
    COLUMNS,
  );

  assert.match(csv, /"Он сказал ""да""";1/);
  assert.match(csv, /"Первая\nвторая";2/);
});

test('CSV prefixes spreadsheet formulas and leaves numbers untouched', () => {
  const columns = [
    { key: 'text', label: 'Текст' },
    {
      key: 'amount',
      label: 'Сумма',
      format: (row) => new Intl.NumberFormat('ru-BY').format(row.amount).replaceAll('\u00A0', ' '),
    },
  ];
  const csv = toCsv(
    [
      { text: '=1+1', amount: -5 },
      { text: '+7 999', amount: 12.5 },
      { text: '@cmd', amount: 0 },
      { text: '-2+3', amount: 1000 },
    ],
    columns,
  );

  assert.match(csv, /'=1\+1;-5/);
  assert.match(csv, /'\+7 999;12,5/);
  assert.match(csv, /'@cmd;0/);
  assert.match(csv, /'-2\+3;1 000/);
  assert.doesNotMatch(csv, /'-5/);
});

test('CSV applies column formatters and renders null as an empty cell', () => {
  const columns = [
    { key: 'name', label: 'Название' },
    {
      key: 'amount',
      label: 'Сумма',
      format: (row) => (row.amount === null ? '' : row.amount.toFixed(2).replace('.', ',')),
    },
  ];
  const csv = toCsv(
    [
      { name: 'Позиция', amount: 1234.5 },
      { name: 'Без суммы', amount: null },
    ],
    columns,
  );

  assert.match(csv, /Позиция;1234,50\r\n/);
  assert.match(csv, /Без суммы;\r\n/);
});

test('csvFilename uses the report prefix and ISO date', () => {
  assert.equal(csvFilename('stock', '2026-11-22'), 'motherload-stock-2026-11-22.csv');
  assert.equal(
    csvFilename('movements', new Date('2026-11-20T10:00:00Z')),
    'motherload-movements-2026-11-20.csv',
  );
});

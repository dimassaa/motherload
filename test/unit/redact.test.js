import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSecrets } from '../../src/domain/redact.js';

test('redactSecrets replaces secret-key values at any depth and keeps the rest', () => {
  const input = {
    note: 'keep',
    passwordHash: '$argon2id$v=19$secret',
    nested: { csrfToken: 'token-value', keep: 'yes' },
    list: [{ sessionId: 'session-value', keep: 'array' }],
  };

  const result = redactSecrets(input);

  assert.deepEqual(result, {
    note: 'keep',
    passwordHash: '[скрыто]',
    nested: { csrfToken: '[скрыто]', keep: 'yes' },
    list: [{ sessionId: '[скрыто]', keep: 'array' }],
  });
});

test('redactSecrets leaves primitives untouched and caps deep nesting', () => {
  assert.equal(redactSecrets('plain'), 'plain');
  assert.equal(redactSecrets(42), 42);

  let deep = { value: 'bottom' };
  for (let index = 0; index < 8; index += 1) {
    deep = { child: deep };
  }

  assert.equal(JSON.stringify(redactSecrets(deep)).includes('вложенность скрыта'), true);
});

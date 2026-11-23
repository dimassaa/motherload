/**
 * Redaction of secret-looking audit details.
 *
 * Writers are required to keep passwords, hashes, CSRF tokens and session data
 * out of `details`, but every read surface repeats the rule: a missed call site
 * must not leak a secret to an administrator through the audit page or a CSV
 * export. The helper is pure so both surfaces can share exactly one policy.
 */

// `pass` alone catches `password`, `passwd` and future `pass`-prefixed keys;
// `hash`, `token`, `secret`, `authorization`, `cookie` and `session` cover the
// request metadata that could reach an audit row by mistake.
const SECRET_DETAIL_KEY = /pass|hash|token|secret|authorization|cookie|session/i;

/**
 * Replace values under secret-looking keys, walking nested objects and arrays.
 * Keys stay visible so an operator sees that something was recorded; only the
 * value is replaced. Depth is capped so a pathological row cannot make the page
 * or an export walk an unbounded structure.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redactSecrets(value, depth = 0) {
  if (depth > 5) return '[вложенность скрыта]';
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1));
  }
  if (value === null || typeof value !== 'object') return value;

  const redacted = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = SECRET_DETAIL_KEY.test(key) ? '[скрыто]' : redactSecrets(item, depth + 1);
  }
  return redacted;
}

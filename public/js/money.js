/**
 * Money helpers for the stock forms.
 *
 * The browser only previews totals; the server recalculates them with
 * decimal.js. To make the preview agree with the stored two-decimal line totals,
 * every operation here is integer BigInt math on a fixed scale — never a float.
 * A `Number` is used only inside Intl-less manual grouping, after the value has
 * already been reduced to a formatted string.
 */

const GROUP_PATTERN = /\B(?=(\d{3})+(?!\d))/g;

/**
 * Parse a decimal string typed by the operator (comma or dot, optional spaces)
 * into an integer scaled by `scale`, rounding half up.
 * @param {string} raw
 * @param {number} scale
 * @returns {bigint | null} null when the text is not a finite decimal
 */
export function parseScaled(raw, scale) {
  if (typeof raw !== 'string') return null;

  const normalized = raw.trim().replaceAll('\u00A0', '').replaceAll(' ', '').replaceAll(',', '.');
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;

  const [whole, fraction = ''] = normalized.split('.');
  const digits = `${fraction}${'0'.repeat(scale + 1)}`.slice(0, scale + 1);
  let value = BigInt(`${whole}${digits.slice(0, scale)}`);
  if (Number(digits[scale]) >= 5) value += 1n;

  return value;
}

/**
 * Parse a whole, non-negative quantity.
 * @param {string} raw
 * @returns {bigint | null}
 */
export function parseQty(raw) {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().replaceAll(' ', '');
  if (!/^\d+$/.test(normalized)) return null;
  return BigInt(normalized);
}

/**
 * Round a scaled integer to a smaller scale, half up.
 * @param {bigint} value
 * @param {number} fromScale
 * @param {number} toScale
 * @returns {bigint}
 */
export function roundScaled(value, fromScale, toScale) {
  if (fromScale <= toScale) return value * 10n ** BigInt(toScale - fromScale);

  const divisor = 10n ** BigInt(fromScale - toScale);
  const quotient = value / divisor;
  const remainder = value % divisor;

  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

/**
 * Format a scaled integer as `1 234,56`.
 * @param {bigint} value
 * @param {number} scale
 * @returns {string}
 */
export function formatScaled(value, scale) {
  const divisor = 10n ** BigInt(scale);
  const whole = (value / divisor).toString().replace(GROUP_PATTERN, ' ');
  if (scale === 0) return whole;

  const fraction = (value % divisor).toString().padStart(scale, '0');
  return `${whole},${fraction}`;
}

/**
 * Format a server money string (`"1234.50"`, 2 or 4 decimals) for display.
 * Returns an em dash for a value the preview cannot parse.
 * @param {string} raw
 * @returns {string}
 */
export function formatMoney(raw) {
  const scaled = parseScaled(raw, 4);
  if (scaled === null) return '—';

  return formatScaled(roundScaled(scaled, 4, 2), 2);
}

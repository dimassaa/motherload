/**
 * CSV serialisation for spreadsheet export.
 *
 * Russian Excel installations split columns on `;` and expect a UTF-8 BOM;
 * without both, a report opens as one garbled column. Cells are quoted only
 * when the value contains a delimiter, a quote or a line break, which keeps the
 * file readable in a diff while remaining valid RFC 4180 CSV.
 */

const BOM = '\uFEFF';
const SEPARATOR = ';';
const LINE_BREAK = '\r\n';

// A leading =, +, - or @ makes spreadsheet software treat text as a formula.
// The formatters never emit a leading plus, so only a negative number is a
// legitimate leading dash; the pattern accepts the grouped Russian form too.
const NUMERIC_TEXT = /^[+-]?(?:\d{1,3}(?: \d{3})+|\d+)(?:[.,]\d+)?$/;

/**
 * Escape one cell and neutralise spreadsheet formulas.
 *
 * @param {unknown} value cell text; null and undefined render as an empty cell
 * @returns {string}
 */
function escapeCell(value) {
  if (value === null || value === undefined) return '';

  let text = String(value);
  const dangerous = /^[=+@]/.test(text) || (text.startsWith('-') && !NUMERIC_TEXT.test(text));
  if (dangerous) text = `'${text}`;

  if (/[;"\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

/**
 * Serialise rows into an Excel-ready CSV string.
 *
 * @param {Array<Record<string, unknown>>} rows plain objects, one per CSV row
 * @param {Array<{
 *   key: string,
 *   label: string,
 *   format?: (row: Record<string, unknown>) => unknown,
 * }>} columns ordered column definitions; `format` owns Russian money, date
 *   and quantity formatting so the domain stays locale-agnostic
 * @returns {string} BOM-prefixed CSV with `;` separators and CRLF line breaks
 * @throws {TypeError} when rows or columns are not arrays
 */
export function toCsv(rows, columns) {
  if (!Array.isArray(rows)) throw new TypeError('toCsv: rows must be an array');
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new TypeError('toCsv: columns must be a non-empty array');
  }

  const lines = [columns.map((column) => escapeCell(column.label)).join(SEPARATOR)];

  for (const row of rows) {
    const cells = columns.map((column) => {
      const value = column.format ? column.format(row) : row[column.key];
      return escapeCell(value);
    });
    lines.push(cells.join(SEPARATOR));
  }

  return `${BOM}${lines.join(LINE_BREAK)}${LINE_BREAK}`;
}

/**
 * Build the download filename required by the specification.
 *
 * @param {string} prefix report identifier such as `stock` or `movements`
 * @param {string | Date} date report date; a Date is reduced to its UTC day
 * @returns {string} e.g. `motherload-stock-2026-11-22.csv`
 * @throws {TypeError} when the prefix or date is malformed
 */
export function csvFilename(prefix, date) {
  if (typeof prefix !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(prefix)) {
    throw new TypeError('csvFilename: prefix must be lower-case kebab-case');
  }

  const isoDate = date instanceof Date ? date.toISOString().slice(0, 10) : String(date);
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== isoDate) {
    throw new TypeError('csvFilename: date must be a real YYYY-MM-DD date or a Date');
  }

  return `motherload-${prefix}-${isoDate}.csv`;
}

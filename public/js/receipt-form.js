/**
 * Receipt form: per-line totals and the document total.
 *
 * The numbers are a preview only; the server rounds every line with decimal.js
 * and sums the stored line totals again. BigInt math keeps the preview from
 * drifting by a kopeck on values such as 0.3333 × 3.
 */

import { formatScaled, parseQty, parseScaled, roundScaled } from './money.js';
import { initStockLines } from './stock-lines.js';

const COST_SCALE = 4;
const MONEY_SCALE = 2;

const form = document.querySelector('[data-stock-form]');

if (form) {
  const lines = initStockLines(form);
  const documentTotal = form.querySelector('[data-receipt-total]');

  function recalculate() {
    let total = 0n;

    for (const row of lines.rows()) {
      const qty = parseQty(row.qty);
      const unitCost = parseScaled(row.unitCost, COST_SCALE);
      const cell = row.element.querySelector('[data-line-total]');

      if (qty === null || unitCost === null) {
        if (cell) cell.textContent = formatScaled(0n, MONEY_SCALE);
        continue;
      }

      const lineTotal = roundScaled(qty * unitCost, COST_SCALE, MONEY_SCALE);
      if (cell) cell.textContent = formatScaled(lineTotal, MONEY_SCALE);
      total += lineTotal;
    }

    if (documentTotal) documentTotal.textContent = formatScaled(total, MONEY_SCALE);
  }

  lines.onChange(recalculate);
  recalculate();
}

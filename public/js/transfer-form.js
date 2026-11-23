/**
 * Transfer form: dynamic rows, the cost preview and the same-warehouse guard.
 *
 * The server also refuses identical warehouses with a 400; the client check
 * exists so the operator sees the mistake immediately, next to the destination
 * field, without waiting for a round trip.
 */

import { initFifoPreview } from './fifo-preview.js';
import { initStockLines } from './stock-lines.js';

const form = document.querySelector('[data-stock-form]');

if (form) {
  const lines = initStockLines(form);
  const preview = initFifoPreview(form, lines);

  const from = form.querySelector('[data-from-warehouse]');
  const to = form.querySelector('[data-to-warehouse]');
  const errorBox = form.querySelector('[data-same-warehouse-error]');
  const message =
    form.dataset.sameWarehouseMessage ?? 'Склад-источник и склад-назначение должны различаться.';

  function checkSameWarehouse() {
    const same = Boolean(from?.value) && from.value === to?.value;
    if (errorBox) {
      errorBox.textContent = same ? message : '';
      errorBox.hidden = !same;
    }
    if (to) {
      if (same) to.setAttribute('aria-invalid', 'true');
      else to.removeAttribute('aria-invalid');
    }
    return same;
  }

  from?.addEventListener('change', () => {
    checkSameWarehouse();
    preview.schedule();
  });
  to?.addEventListener('change', checkSameWarehouse);

  form.addEventListener('submit', (event) => {
    if (!checkSameWarehouse()) return;
    event.preventDefault();
    to?.focus();
  });
}

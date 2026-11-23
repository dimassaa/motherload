/**
 * Issue form: dynamic rows and the FIFO preview.
 *
 * Posting stays a plain form submit. The preview is an enhancement that tells
 * the operator which batches would be consumed and at what cost; the server
 * re-checks stock and re-allocates during the transaction.
 */

import { initFifoPreview } from './fifo-preview.js';
import { initStockLines } from './stock-lines.js';

const form = document.querySelector('[data-stock-form]');

if (form) {
  const lines = initStockLines(form);
  initFifoPreview(form, lines);
}

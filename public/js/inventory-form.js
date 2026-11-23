/**
 * Progressive enhancement for the inventory detail screen.
 *
 * The screen works without this module: editing and saving is a plain form, the
 * search and "only discrepancies" filters are a normal GET request, and submit,
 * approve and cancel all post normally. JavaScript adds three conveniences that
 * cannot be expressed in HTML: bulk filling the fact from the accounting
 * quantity, live filtering while typing, and a confirmation dialog before a
 * status change.
 */

const entryForm = document.querySelector('[data-inventory-entry]');
const filterForm = document.querySelector('[data-inventory-filter]');
const table = document.querySelector('[data-inventory-table]');
const filterEmpty = document.querySelector('[data-inventory-filter-empty]');

/** @returns {HTMLElement[]} */
function tableRows() {
  return table ? Array.from(table.querySelectorAll('[data-inventory-row]')) : [];
}

/**
 * Recompute the difference cell and the row flags the filters rely on.
 * Invalid or empty input means "not entered" and shows a dash, never zero.
 * @param {HTMLTableRowElement} row
 * @param {HTMLInputElement} input
 */
function updateDifference(row, input) {
  const expected = Number(input.dataset.expected);
  const raw = input.value.trim();
  const cell = row.querySelector('[data-inventory-difference]');
  const valid = /^\d+$/.test(raw);

  row.dataset.entered = valid ? 'true' : 'false';

  if (!valid) {
    row.dataset.difference = '';
    if (cell) {
      cell.textContent = '—';
      cell.className = 'inventory-diff inventory-diff--none';
    }
    return;
  }

  const difference = Number(raw) - expected;
  row.dataset.difference = String(difference);
  if (!cell) return;

  cell.textContent = difference > 0 ? `+${difference}` : String(difference);
  cell.className = 'inventory-diff inventory-diff--none';
  if (difference > 0) cell.className = 'inventory-diff inventory-diff--surplus';
  if (difference < 0) cell.className = 'inventory-diff inventory-diff--shortage';
}

/** @param {Event} event */
function handleActualInput(event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.matches('[data-inventory-actual]')) return;

  const row = input.closest('[data-inventory-row]');
  if (row) updateDifference(row, input);
}

/** Fill every visible, still empty fact from its accounting quantity. */
function fillFromExpected() {
  for (const row of tableRows()) {
    if (row.hidden) continue;
    const input = row.querySelector('[data-inventory-actual]');
    if (!input || input.value.trim() !== '') continue;
    input.value = input.dataset.expected ?? '';
    updateDifference(row, input);
  }
}

/** Clear the facts that are currently visible; comments are notes, not values. */
function clearFacts() {
  for (const row of tableRows()) {
    if (row.hidden) continue;
    const input = row.querySelector('[data-inventory-actual]');
    if (!input) continue;
    input.value = '';
    updateDifference(row, input);
  }
}

/**
 * Apply the search and "only" filters to the rows already on the page.
 * The same controls submit a GET request, so nothing is lost without scripting.
 */
function applyRowFilter() {
  const search = filterForm?.querySelector('[data-inventory-search]');
  const only = filterForm?.querySelector('[data-inventory-only]');
  const needle = (search?.value ?? '').trim().toLowerCase();
  const mode = only?.value ?? 'all';
  let visible = 0;

  for (const row of tableRows()) {
    const text = `${row.dataset.sku ?? ''} ${row.dataset.name ?? ''}`.toLowerCase();
    const difference = row.dataset.difference ?? '';
    const entered = row.dataset.entered === 'true';

    const matchesText = needle === '' || text.includes(needle);
    const matchesMode =
      mode === 'all' ||
      (mode === 'discrepancy' && difference !== '' && Number(difference) !== 0) ||
      (mode === 'unfilled' && !entered);

    const show = matchesText && matchesMode;
    row.hidden = !show;
    if (show) visible += 1;
  }

  if (filterEmpty) filterEmpty.hidden = visible > 0 || tableRows().length === 0;
}

if (entryForm) {
  entryForm.addEventListener('input', handleActualInput);

  entryForm.querySelector('[data-inventory-fill]')?.addEventListener('click', fillFromExpected);
  entryForm.querySelector('[data-inventory-clear]')?.addEventListener('click', clearFacts);

  // A rejected save re-renders the typed values without a difference column;
  // recomputing on load keeps the two sides consistent immediately.
  for (const row of tableRows()) {
    const input = row.querySelector('[data-inventory-actual]');
    if (input) updateDifference(row, input);
  }
}

if (filterForm) {
  filterForm.addEventListener('submit', (event) => {
    event.preventDefault();
    applyRowFilter();
  });
  filterForm.querySelector('[data-inventory-search]')?.addEventListener('input', applyRowFilter);
  filterForm.querySelector('[data-inventory-only]')?.addEventListener('change', applyRowFilter);
}

for (const form of document.querySelectorAll('form[data-inventory-confirm]')) {
  form.addEventListener('submit', (event) => {
    const question = form.dataset.confirm;
    if (question && !window.confirm(question)) {
      event.preventDefault();
    }
  });
}

document.querySelector('[data-inventory-print]')?.addEventListener('click', (event) => {
  // The control is a plain link to the act so it still does something without
  // JavaScript; with scripting it prints instead of jumping.
  event.preventDefault();
  window.print();
});

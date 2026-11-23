/**
 * Dynamic line rows for the receipt, issue and transfer forms.
 *
 * Without this module each form still submits: the server renders a native
 * `<select>` of active positions and one row. With JavaScript the select is
 * replaced by a type-ahead backed by `/api/components/search`, rows can be added
 * and removed, and the document total can be previewed. Field names stay in the
 * `lines[i][field]` shape the server already parses.
 */

const SEARCH_URL = '/api/components/search';
const SEARCH_DEBOUNCE_MS = 180;

let outsideClickBound = false;

function debounce(callback, delay) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => callback(...args), delay);
  };
}

/**
 * @param {HTMLFormElement} form
 * @returns {{
 *   rows: () => Array<{
 *     element: HTMLTableRowElement,
 *     componentId: string,
 *     label: string,
 *     qty: string,
 *     unitCost: string,
 *   }>,
 *   onChange: (callback: () => void) => void,
 * } | null}
 */
export function initStockLines(form) {
  const container = form.querySelector('[data-stock-lines]');
  if (!container) return null;

  const tbody = container.querySelector('[data-stock-rows]');
  const template = container.querySelector('[data-stock-row-template]');
  const addButton = container.querySelector('[data-stock-add]');
  const listeners = [];

  function entries() {
    return Array.from(tbody.querySelectorAll('[data-stock-row]')).map((element) => ({
      element,
      select: element.querySelector('[data-component-select]'),
      hidden: element.querySelector('[data-component-value]'),
      search: element.querySelector('[data-component-search]'),
      searchWrap: element.querySelector('[data-component-search-wrap]'),
      suggestions: element.querySelector('[data-component-suggestions]'),
      qty: element.querySelector('[data-line-qty]'),
      unitCost: element.querySelector('[data-line-unit-cost]'),
      remove: element.querySelector('[data-line-remove]'),
    }));
  }

  function notify() {
    for (const listener of listeners) listener();
  }

  function closeSuggestions(row) {
    if (!row.suggestions) return;
    row.suggestions.hidden = true;
    row.suggestions.replaceChildren();
    row.search?.setAttribute('aria-expanded', 'false');
    delete row.activeIndex;
  }

  function setActive(row, direction) {
    const options = Array.from(row.suggestions.querySelectorAll('[data-component-option]'));
    if (options.length === 0) return;

    const current = Number.isInteger(row.activeIndex) ? row.activeIndex : -1;
    const next = (current + direction + options.length) % options.length;
    row.activeIndex = next;
    options.forEach((option, index) => {
      option.classList.toggle('stock-line__suggestion--active', index === next);
      option.setAttribute('aria-selected', index === next ? 'true' : 'false');
    });
  }

  function choose(row, option) {
    if (!row.hidden) return;

    row.hidden.value = option.dataset.id ?? '';
    row.hidden.dataset.componentLabel = option.dataset.label ?? '';
    if (row.search) row.search.value = option.dataset.label ?? '';

    // Keep the native select in sync for any code that still reads it.
    if (
      row.select &&
      Array.from(row.select.options).some((item) => item.value === option.dataset.id)
    ) {
      row.select.value = option.dataset.id;
    }

    closeSuggestions(row);
    row.hidden.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function renderSuggestions(row, items, errorMessage = null) {
    row.suggestions.replaceChildren();
    delete row.activeIndex;

    if (errorMessage) {
      const message = document.createElement('li');
      message.className = 'stock-line__suggestion stock-line__suggestion--muted';
      message.textContent = errorMessage;
      row.suggestions.append(message);
      row.suggestions.hidden = false;
      row.search.setAttribute('aria-expanded', 'true');
      return;
    }

    if (items.length === 0) {
      const message = document.createElement('li');
      message.className = 'stock-line__suggestion stock-line__suggestion--muted';
      message.textContent = 'Ничего не найдено. Уточните SKU или название.';
      row.suggestions.append(message);
      row.suggestions.hidden = false;
      row.search.setAttribute('aria-expanded', 'true');
      return;
    }

    for (const item of items) {
      const option = document.createElement('li');
      option.className = 'stock-line__suggestion';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.dataset.componentOption = '';
      option.dataset.id = String(item.id);
      option.dataset.label = `${item.sku} — ${item.name}`;
      option.textContent = option.dataset.label;
      row.suggestions.append(option);
    }

    row.suggestions.hidden = false;
    row.search.setAttribute('aria-expanded', 'true');
  }

  async function search(row) {
    const query = row.search.value.trim();
    // A slow response for an older prefix must not replace the newer list.
    row.searchSequence = (row.searchSequence ?? 0) + 1;
    const sequence = row.searchSequence;

    try {
      const response = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(query)}`, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`search failed: ${response.status}`);
      const items = await response.json();
      if (sequence !== row.searchSequence) return;
      renderSuggestions(row, items);
    } catch {
      if (sequence !== row.searchSequence) return;
      renderSuggestions(row, [], 'Не удалось загрузить позиции. Попробуйте ещё раз.');
    }
  }

  const debouncedSearch = debounce((row) => {
    search(row);
  }, SEARCH_DEBOUNCE_MS);

  function enhanceRow(row) {
    if (!row.select || row.element.dataset.enhanced === 'true') return;
    row.element.dataset.enhanced = 'true';

    // The native select is what makes the form work without JavaScript. With
    // the module running it becomes a backing store only: a hidden input keeps
    // the submitted name because an empty select cannot hold a fetched id.
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.name = row.select.name;
    hidden.value = row.select.value;
    hidden.dataset.componentValue = '';
    hidden.dataset.componentLabel =
      row.select.value === ''
        ? ''
        : (row.select.selectedOptions[0]?.textContent ?? '').replace(/\s+/g, ' ').trim();
    row.select.removeAttribute('name');
    // The native control is no longer the submitted value, so its `required`
    // flag would block submission on a hidden empty select the operator cannot
    // fix. The server validates the chosen component and re-renders the form.
    row.select.removeAttribute('required');
    row.select.hidden = true;
    row.select.after(hidden);
    row.hidden = hidden;

    if (row.searchWrap) row.searchWrap.hidden = false;
    if (row.search && hidden.dataset.componentLabel) {
      row.search.value = hidden.dataset.componentLabel.replace(/\s+/g, ' ');
    }

    row.search?.addEventListener('input', () => {
      const chosenLabel = row.hidden.dataset.componentLabel ?? '';
      if (row.search.value !== chosenLabel) row.hidden.value = '';
      debouncedSearch(row);
    });
    row.search?.addEventListener('focus', () => {
      if (!row.suggestions.hidden) return;
      debouncedSearch(row);
    });
    row.search?.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive(row, event.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (event.key === 'Enter') {
        const options = Array.from(row.suggestions.querySelectorAll('[data-component-option]'));
        const active = options[Number.isInteger(row.activeIndex) ? row.activeIndex : 0];
        if (!row.suggestions.hidden && active) {
          event.preventDefault();
          choose(row, active);
        }
        return;
      }
      if (event.key === 'Escape') closeSuggestions(row);
    });
    row.suggestions?.addEventListener('mousedown', (event) => {
      const option = event.target.closest('[data-component-option]');
      if (!option) return;
      event.preventDefault();
      choose(row, option);
    });

    row.remove?.addEventListener('click', () => {
      if (entries().length <= 1) return;
      row.element.remove();
      reindex();
      updateRemoveButtons();
      notify();
    });
  }

  /** Renumber names and ids after a removal so the payload stays dense. */
  function reindex() {
    entries().forEach((row, index) => {
      row.element.dataset.rowIndex = String(index);

      for (const element of row.element.querySelectorAll('[name]')) {
        element.name = element.name.replaceAll(/lines\[\d+\]/g, `lines[${index}]`);
      }
      for (const element of row.element.querySelectorAll('[id]')) {
        element.id = element.id.replaceAll(/stock-line-\d+-/g, `stock-line-${index}-`);
      }
      for (const element of row.element.querySelectorAll('[for]')) {
        element.setAttribute(
          'for',
          element.getAttribute('for').replaceAll(/stock-line-\d+-/g, `stock-line-${index}-`),
        );
      }
      for (const element of row.element.querySelectorAll('[aria-controls]')) {
        element.setAttribute(
          'aria-controls',
          element
            .getAttribute('aria-controls')
            .replaceAll(/stock-line-\d+-/g, `stock-line-${index}-`),
        );
      }
    });
  }

  function updateRemoveButtons() {
    const rows = entries();
    for (const row of rows) {
      if (!row.remove) continue;
      row.remove.disabled = rows.length <= 1;
      row.remove.title = rows.length <= 1 ? 'В документе должна остаться хотя бы одна строка' : '';
    }
  }

  function addRow() {
    if (!template) return;

    const index = entries().length;
    const clone = template.content.firstElementChild.cloneNode(true);
    clone.innerHTML = clone.innerHTML.replaceAll('__INDEX__', String(index));
    tbody.append(clone);

    enhanceRow(entries().at(-1));
    updateRemoveButtons();
    notify();
    entries().at(-1)?.search?.focus();
  }

  for (const row of entries()) enhanceRow(row);
  updateRemoveButtons();
  addButton?.addEventListener('click', addRow);

  tbody.addEventListener('input', notify);
  tbody.addEventListener('change', notify);

  if (!outsideClickBound) {
    outsideClickBound = true;
    document.addEventListener('click', (event) => {
      for (const row of entries()) {
        if (row.searchWrap && !row.searchWrap.contains(event.target)) closeSuggestions(row);
      }
    });
  }

  return {
    rows() {
      return entries().map((row) => ({
        element: row.element,
        componentId: row.hidden ? row.hidden.value : (row.select?.value ?? ''),
        label: row.hidden?.dataset.componentLabel ?? '',
        qty: row.qty?.value ?? '',
        unitCost: row.unitCost?.value ?? '',
      }));
    },
    onChange(callback) {
      listeners.push(callback);
    },
  };
}

/**
 * FIFO preview for the issue and transfer forms.
 *
 * The preview is advisory: the server re-allocates under `FOR UPDATE` when the
 * document is posted. It is deliberately separate from the form submit path, so
 * a failed preview never blocks posting and a posting error stays inline.
 */

import { formatMoney } from './money.js';

const PREVIEW_DEBOUNCE_MS = 250;

const QTY_FORMATTER = new Intl.NumberFormat('ru-BY', { maximumFractionDigits: 0 });

function formatDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  return match ? `${match[3]}.${match[2]}.${match[1]}` : String(iso);
}

function errorMessageFor(body) {
  const message = body?.message ?? 'Не удалось рассчитать списание. Попробуйте ещё раз.';
  if (body?.error === 'INSUFFICIENT_STOCK') {
    return `${message} Уменьшите количество или выберите другой склад.`;
  }
  return message;
}

/**
 * @param {HTMLFormElement} form
 * @param {{ rows: () => Array<{ componentId: string, label: string, qty: string }> } | null} lines
 * @returns {{ schedule: () => void }}
 */
export function initFifoPreview(form, lines) {
  const panel = form.querySelector('[data-preview-panel]');
  if (!panel || !lines) return { schedule() {} };

  const warehouse = form.querySelector('[data-preview-warehouse]');
  const hint = panel.querySelector('[data-preview-hint]');
  const skeleton = panel.querySelector('[data-preview-skeleton]');
  const result = panel.querySelector('[data-preview-result]');
  const total = panel.querySelector('[data-preview-total]');
  const linesBox = panel.querySelector('[data-preview-lines]');
  const errorBox = panel.querySelector('[data-preview-error]');
  const endpoint = form.dataset.fifoPreviewUrl;
  const token = document.querySelector('meta[name="csrf-token"]')?.content ?? '';

  let controller = null;
  let timer = null;

  function collectLines() {
    const collected = [];

    for (const row of lines.rows()) {
      const componentId = Number(row.componentId);
      const qty = Number(row.qty);
      if (!Number.isSafeInteger(componentId) || componentId < 1) continue;
      if (!Number.isSafeInteger(qty) || qty < 1) continue;
      collected.push({ componentId, qty, label: row.label });
    }

    return collected;
  }

  function setIdle() {
    skeleton.hidden = true;
    result.hidden = true;
    errorBox.hidden = true;
    if (hint) hint.hidden = false;
  }

  function setLoading() {
    if (hint) hint.hidden = true;
    result.hidden = true;
    errorBox.hidden = true;
    skeleton.hidden = false;
  }

  function setError(message) {
    skeleton.hidden = true;
    result.hidden = true;
    if (hint) hint.hidden = true;
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function renderLine(line, labels) {
    const wrapper = document.createElement('div');
    wrapper.className = 'stock-preview__line';

    const title = document.createElement('p');
    title.className = 'stock-preview__line-title';
    const label = labels.get(line.componentId) ?? `Позиция #${line.componentId}`;
    title.textContent = `${label} · ${formatMoney(line.totalCost)} BYN`;
    wrapper.append(title);

    const list = document.createElement('ul');
    list.className = 'stock-preview__allocations';

    for (const allocation of line.allocations) {
      const item = document.createElement('li');
      item.textContent =
        `Партия №${allocation.batchId} · приход ${formatDate(allocation.receivedAt)} · ` +
        `${allocation.documentNo ?? 'без документа'} · ` +
        `${QTY_FORMATTER.format(allocation.qty)} шт. × ${formatMoney(allocation.unitCost)} BYN`;
      list.append(item);
    }

    wrapper.append(list);
    return wrapper;
  }

  function render(payload, labels) {
    skeleton.hidden = true;
    if (hint) hint.hidden = true;
    errorBox.hidden = true;

    total.textContent = formatMoney(payload.totalCost);
    linesBox.replaceChildren();

    for (const line of payload.lines) {
      linesBox.append(renderLine(line, labels));
    }

    result.hidden = false;
  }

  async function refresh() {
    const warehouseId = Number(warehouse?.value);
    const collected = collectLines();

    if (!endpoint || !token || !Number.isSafeInteger(warehouseId) || warehouseId < 1) {
      setIdle();
      return;
    }
    if (collected.length === 0) {
      setIdle();
      return;
    }

    controller?.abort();
    controller = new AbortController();
    const current = controller;
    setLoading();

    const labels = new Map(collected.map((line) => [line.componentId, line.label]));

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-csrf-token': token,
        },
        body: JSON.stringify({
          warehouseId,
          lines: collected.map(({ componentId, qty }) => ({ componentId, qty })),
        }),
        signal: current.signal,
      });

      const body = await response.json();
      if (current !== controller) return;

      if (!response.ok) {
        setError(errorMessageFor(body));
        return;
      }

      render(body, labels);
    } catch (error) {
      if (error.name === 'AbortError' || current !== controller) return;
      setError('Не удалось рассчитать списание. Проверьте подключение и попробуйте ещё раз.');
    }
  }

  function schedule() {
    window.clearTimeout(timer);
    timer = window.setTimeout(refresh, PREVIEW_DEBOUNCE_MS);
  }

  warehouse?.addEventListener('change', schedule);
  lines.onChange(schedule);

  return { schedule };
}

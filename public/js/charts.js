/**
 * Chart rendering for analytics screens.
 *
 * Server-rendered HTML carries the data in a `data-chart` JSON attribute; this
 * module only turns it into a canvas chart. Without JavaScript the tables and
 * summaries remain the source of truth, so the page never depends on Chart.js.
 */

import Chart from '/vendor/chart.esm.js';

const GROUP_SPACES = /[\u00A0\u2009\u202F]/g;

const moneyFormatter = new Intl.NumberFormat('ru-BY', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const percentFormatter = new Intl.NumberFormat('ru-BY', {
  maximumFractionDigits: 2,
});

// Axis ticks are narrow: dropping the cents keeps four labels readable on a
// phone without changing the exact values in the table or the tooltip.
const axisMoneyFormatter = new Intl.NumberFormat('ru-BY', {
  maximumFractionDigits: 0,
});

function formatAxisMoney(value) {
  return axisMoneyFormatter.format(value).replaceAll(GROUP_SPACES, ' ');
}

function formatMoney(value) {
  return moneyFormatter.format(value).replaceAll(GROUP_SPACES, ' ');
}

function formatPercent(value) {
  return `${percentFormatter.format(value).replaceAll(GROUP_SPACES, ' ')}%`;
}

/** Read a design token so the chart cannot drift from the stylesheet. */
function token(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

function readConfig(node) {
  try {
    return JSON.parse(node.dataset.chart);
  } catch {
    // A malformed attribute means the server sent something this module does
    // not understand; the adjacent table still renders the same numbers.
    return null;
  }
}

/**
 * Pareto chart: stock value bars with the cumulative share on a second axis.
 * @param {HTMLCanvasElement} canvas
 * @param {{ labels: string[], values: number[], cumulative: number[] }} config
 */
function renderPareto(canvas, config) {
  const ink = token('--color-forest-ink', '#09352e');
  const moss = token('--color-moss', '#85c093');
  const muted = token('--color-text-muted', '#4f5c5b');
  const bodyFont = getComputedStyle(document.body).fontFamily;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  new Chart(canvas, {
    type: 'bar',
    data: {
      labels: config.labels,
      datasets: [
        {
          type: 'bar',
          label: 'Стоимость, BYN',
          data: config.values,
          backgroundColor: moss,
          borderRadius: 4,
          borderSkipped: false,
          yAxisID: 'value',
          order: 2,
        },
        {
          type: 'line',
          label: 'Накопленная доля, %',
          data: config.cumulative,
          borderColor: ink,
          backgroundColor: ink,
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 4,
          tension: 0.2,
          yAxisID: 'share',
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: reduceMotion ? false : { duration: 400 },
      color: ink,
      font: { family: bodyFont, size: 11 },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: muted,
            maxRotation: 60,
            minRotation: 0,
            autoSkip: true,
            maxTicksLimit: 24,
          },
        },
        value: {
          beginAtZero: true,
          title: { display: true, text: 'Стоимость, BYN', color: muted },
          grid: { color: token('--color-lichen', '#cad3d2') },
          ticks: {
            color: muted,
            callback: (value) => formatMoney(value),
          },
        },
        share: {
          beginAtZero: true,
          max: 100,
          position: 'right',
          title: { display: true, text: 'Накопленная доля, %', color: muted },
          grid: { drawOnChartArea: false },
          ticks: { color: muted, callback: (value) => formatPercent(value) },
        },
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: ink, boxWidth: 12, usePointStyle: true },
        },
        tooltip: {
          callbacks: {
            label: (context) =>
              context.datasetIndex === 0
                ? `${context.dataset.label}: ${formatMoney(context.parsed.y)}`
                : `${context.dataset.label}: ${formatPercent(context.parsed.y)}`,
          },
        },
      },
    },
  });
}

/**
 * Horizontal bars for stock value per category.
 *
 * Categories read as text, so a horizontal bar keeps their labels on one line
 * instead of rotating a date-like axis. One series, no legend: the card title
 * already names it.
 * @param {HTMLCanvasElement} canvas
 * @param {{ labels: string[], values: number[] }} config
 */
function renderCategoryBar(canvas, config) {
  const ink = token('--color-forest-ink', '#09352e');
  const moss = token('--color-moss', '#85c093');
  const muted = token('--color-text-muted', '#4f5c5b');
  const bodyFont = getComputedStyle(document.body).fontFamily;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  new Chart(canvas, {
    type: 'bar',
    data: {
      labels: config.labels,
      datasets: [
        {
          label: 'Стоимость, BYN',
          data: config.values,
          backgroundColor: moss,
          borderRadius: 4,
          borderSkipped: false,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: reduceMotion ? false : { duration: 400 },
      color: ink,
      font: { family: bodyFont, size: 11 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => `Стоимость: ${formatMoney(context.parsed.x)} BYN`,
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          title: { display: true, text: 'Стоимость, BYN', color: muted },
          grid: { color: token('--color-lichen', '#cad3d2') },
          ticks: { color: muted, maxTicksLimit: 5, callback: (value) => formatAxisMoney(value) },
        },
        y: {
          grid: { display: false },
          ticks: { color: ink, autoSkip: false },
        },
      },
    },
  });
}

function init() {
  for (const node of document.querySelectorAll('canvas[data-chart]')) {
    const config = readConfig(node);
    if (!config || !Array.isArray(config.labels) || config.labels.length === 0) continue;
    if (config.type === 'pareto') renderPareto(node, config);
    if (config.type === 'category-bar') renderCategoryBar(node, config);
  }
}

init();

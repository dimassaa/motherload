import { getDashboard } from '../services/analytics.js';

/**
 * `GET /dashboard` — the KPI overview.
 *
 * The screen is read-only and available to every role, so the controller does
 * nothing beyond loading the read model and choosing whether the chart bundle is
 * needed. An empty database still renders the cards with zeros instead of
 * hiding the page behind an empty state: the dashboard is the landing page after
 * login and must always answer.
 */
export async function showDashboard(req, res, next) {
  try {
    const result = await getDashboard();

    res.render('pages/dashboard', {
      title: 'Обзор — Motherload',
      ...result,
      // A dashboard with no stock has no chart worth downloading 200 KB for.
      loadCharts: result.categoryChart.labels.length > 0,
    });
  } catch (error) {
    next(error);
  }
}

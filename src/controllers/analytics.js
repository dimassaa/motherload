import { z } from 'zod';
import * as directoriesService from '../services/directories.js';
import { getAbc, getReorder, getXyz } from '../services/analytics.js';

/**
 * Query parsing for the analytics screens.
 *
 * A stale bookmark with `warehouseId=abc` falls back to "all warehouses"
 * instead of returning a 400 the user cannot fix from the URL. The same pattern
 * is used by the catalog filters.
 */
const optionalFilterId = z.preprocess(
  (value) => (value === undefined || value === null || value === '' ? null : value),
  z.union([z.null(), z.coerce.number().int().positive()]).catch(null),
);

const filterSchema = z.object({
  warehouseId: optionalFilterId,
  categoryId: optionalFilterId,
});

/** Select options shared by both analytics filter bars. */
async function loadOptions() {
  const [warehouses, categories] = await Promise.all([
    directoriesService.list('warehouses'),
    directoriesService.list('categories'),
  ]);
  return { warehouses, categories };
}

/** `GET /analytics/abc` — stock value ranking with the Pareto chart. */
export async function showAbc(req, res, next) {
  try {
    const filters = filterSchema.parse(req.query ?? {});
    const [result, options] = await Promise.all([getAbc(filters), loadOptions()]);

    res.render('pages/analytics/abc', {
      title: 'ABC-анализ — Motherload',
      ...result,
      filters,
      options,
      // The page owns an external chart module; the base layout loads it only
      // when a screen asks, and an empty ABC page has no canvas to render.
      loadCharts: result.rows.length > 0,
    });
  } catch (error) {
    next(error);
  }
}

/** `GET /analytics/xyz` — demand regularity and the ABC×XYZ matrix. */
export async function showXyz(req, res, next) {
  try {
    const filters = filterSchema.parse(req.query ?? {});
    const [result, options] = await Promise.all([getXyz(filters), loadOptions()]);

    res.render('pages/analytics/xyz', {
      title: 'XYZ-анализ — Motherload',
      ...result,
      filters,
      options,
      // XYZ renders a matrix, not a canvas: the 206 KB Chart.js bundle would be
      // dead weight on every XYZ page, including an empty one.
      loadCharts: false,
    });
  } catch (error) {
    next(error);
  }
}

/** `GET /analytics/reorder` — reorder points, safety stock and EOQ. */
export async function showReorder(req, res, next) {
  try {
    const filters = filterSchema.parse(req.query ?? {});
    const [result, options] = await Promise.all([getReorder(filters), loadOptions()]);

    res.render('pages/analytics/reorder', {
      title: 'Точка заказа — Motherload',
      ...result,
      filters,
      options,
      // The reorder table is the product here; it has no canvas at all.
      loadCharts: false,
    });
  } catch (error) {
    next(error);
  }
}

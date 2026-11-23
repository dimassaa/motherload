import { z } from 'zod';
import { NotFoundError } from '../domain/errors.js';
import * as reportsService from '../services/reports.js';

/**
 * CSV report screens.
 *
 * The page is read-only for every authenticated role. The audit export is the
 * one privileged report: its type is a path segment, so the role check lives in
 * the report service instead of a separate `requireRole` route.
 */

const optionalFilterId = z.preprocess(
  (value) => (value === undefined || value === null || value === '' ? null : value),
  z.union([z.null(), z.coerce.number().int().positive()]).catch(null),
);

const optionalDate = z.preprocess(
  (value) => (value === undefined || value === null || value === '' ? undefined : value),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Укажите дату в формате ГГГГ-ММ-ДД.')
    .optional(),
);

const optionalCountId = z.preprocess(
  (value) => (value === undefined || value === null || value === '' ? undefined : value),
  z.coerce
    .number({ error: 'Укажите номер инвентаризации.' })
    .int('Укажите номер инвентаризации.')
    .positive('Укажите номер инвентаризации.')
    .optional(),
);

const exportQuerySchema = z.object({
  warehouseId: optionalFilterId,
  categoryId: optionalFilterId,
  dateFrom: optionalDate,
  dateTo: optionalDate,
  countId: optionalCountId,
});

/** `GET /reports` — the export hub with per-report cards. */
export function showReports(req, res) {
  res.render('pages/reports', {
    title: 'Отчёты — Motherload',
    movementRange: reportsService.defaultMovementRange(),
    isAdmin: req.user?.role === 'admin',
    loadCharts: false,
  });
}

/** `GET /reports/export/:type` — send one CSV file. */
export async function exportReport(req, res, next) {
  try {
    const type = String(req.params.type);
    if (!reportsService.REPORT_TYPES.includes(type)) throw new NotFoundError('Отчёт не найден.');

    const filters = exportQuerySchema.parse(req.query ?? {});
    const { filename, content } = await reportsService.export(type, filters, {
      user: req.user,
      req,
    });

    // The BOM lives in the content; the charset in the header is what makes a
    // browser and Excel treat the bytes as UTF-8 instead of the local codepage.
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(content);
  } catch (error) {
    next(error);
  }
}

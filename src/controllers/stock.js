import { z } from 'zod';
import { AppError } from '../lib/app-error.js';
import { previewIssue } from '../services/stock.js';

// Upper bounds match the `integer` columns: a larger id or quantity could only
// fail in PostgreSQL with an opaque 22003, so it is rejected at the boundary.
const INTEGER_MAX = 2_147_483_647;
const QTY_MAX = 1_000_000_000;

const idSchema = z.coerce.number().int().min(1).max(INTEGER_MAX);

const previewSchema = z.object({
  warehouseId: idSchema,
  lines: z
    .array(
      z.object({
        componentId: idSchema,
        qty: z.coerce.number().int().min(1).max(QTY_MAX),
      }),
    )
    .min(1),
});

/**
 * `POST /api/fifo-preview`
 *
 * Returns how the issue would consume batches and what it would cost. The
 * response mirrors `previewIssue` so the issue form can render the split without
 * duplicating FIFO logic. All money values are strings, never JSON numbers.
 *
 * Domain failures are answered here instead of by the HTML error middleware:
 * API clients need `{ error, message, available? }`, while browser errors stay
 * Russian HTML. Unexpected failures still reach the central handler and become a
 * logged 500.
 */
export async function previewFifo(req, res) {
  const parsed = previewSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'Проверьте склад и строки расхода: количество должно быть целым числом больше нуля.',
    });
    return;
  }

  try {
    res.json(await previewIssue(parsed.data));
  } catch (error) {
    if (!(error instanceof AppError)) throw error;

    const body = { error: error.code, message: error.message };
    if (error.available !== undefined) body.available = error.available;
    res.status(error.status).json(body);
  }
}

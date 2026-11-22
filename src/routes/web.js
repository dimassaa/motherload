import { Router } from 'express';
import { isDatabaseUp } from '../repositories/health.js';

export const webRouter = Router();

webRouter.get('/healthz', async (req, res) => {
  const up = await isDatabaseUp();
  res.status(up ? 200 : 503).json({
    status: up ? 'ok' : 'degraded',
    db: up ? 'up' : 'down',
  });
});

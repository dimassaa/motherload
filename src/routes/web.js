import { Router } from 'express';
import { isDatabaseUp } from '../repositories/health.js';

export const webRouter = Router();

webRouter.get('/', (req, res) => {
  res.render('pages/landing', {
    title: 'Motherload — складской терминал',
  });
});

webRouter.get('/healthz', async (req, res) => {
  const up = await isDatabaseUp();
  res.status(up ? 200 : 503).json({
    status: up ? 'ok' : 'degraded',
    db: up ? 'up' : 'down',
  });
});

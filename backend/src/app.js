import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import './db.js'; // initialize schema
import ordersRouter from './routes/orders.js';
import authRouter from './routes/auth.js';
import metaRouter from './routes/meta.js';
import { adminRouter, arbitratorRouter } from './routes/admin.js';
import { authenticate } from './lib/auth.js';
import { rateLimit } from './lib/ratelimit.js';
import { logError } from './lib/log.js';

/** Builds the Express app (no listener) so tests and index.js share one definition. */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.env === 'production' ? 1 : false);

  const allowed = new Set([config.appBaseUrl, ...config.corsOrigins]);
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || allowed.has(origin) || config.env !== 'production'),
    allowedHeaders: ['content-type', 'authorization'],
  }));
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/', (_req, res) => res.json({ service: 'CoSeal API', status: 'ok', docs: '/api/status' }));

  app.use('/api', rateLimit({ bucket: 'api', limit: config.rateLimit.perMinute }));
  app.use('/api/auth', rateLimit({ bucket: 'auth', limit: config.rateLimit.authPerMinute }));
  app.use('/api', authenticate);

  app.use('/api', metaRouter);
  app.use('/api', authRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/arbitrator', arbitratorRouter);

  // Uploaded evidence is NOT served statically: it is private and only reachable through
  // /api/orders/:ref/evidence/:id/file, which enforces per-order RBAC.

  app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));

  // Central error handler. Never leaks stack traces or secrets.
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.name === 'SyntaxError' ? 400 : 500);
    if (status >= 500) logError('[error]', err);
    res.status(status).json({ error: status >= 500 && config.env === 'production' ? 'Internal error' : err.message || 'Internal error' });
  });
  return app;
}

import express from 'express';
import cors from 'cors';
import { config, summarizeConfig } from './config.js';
import './db.js'; // initialize schema
import ordersRouter from './routes/orders.js';
import blockchainRouter from './routes/blockchain.js';
import adminRouter from './routes/admin.js';
import metaRouter from './routes/meta.js';
import { runReviewWindowSweep, runChainSweep } from './services/orderService.js';

const app = express();
app.disable('x-powered-by');
app.use(cors());

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded evidence (read-only) with light caching.
app.use('/uploads', express.static(config.paths.uploads, { maxAge: '1h', immutable: false }));

app.get('/', (_req, res) => res.json({ service: 'CoSeal API', status: 'ok', docs: '/api/status' }));

app.use('/api', metaRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/blockchain', blockchainRouter);
app.use('/api/admin', adminRouter);

// 404
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));

// Central error handler.
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: err.message || 'Internal error' });
});

const server = app.listen(config.port, () => {
  console.log('\n  CoSeal API — deals, sealed by both sides');
  console.table(summarizeConfig());
  console.log(`  Listening on http://localhost:${config.port}\n`);
});

// Review-window sweep: a ghosted buyer review window escalates to arbitration — it does NOT
// auto-release, because no backend timer can spend a Bitcoin multisig output (PRD §6.4).
const SWEEP_MS = 10_000;
const sweep = setInterval(async () => {
  try {
    const escalated = await runReviewWindowSweep();
    if (escalated.length) console.log(`[sweep] escalated to arbitration: ${escalated.join(', ')}`);
  } catch (err) {
    console.error('[sweep] error:', err.message);
  }
}, SWEEP_MS);
sweep.unref?.();

// Chain watcher: funding detection (with confirmation policy), settlement confirmations and
// reorg detection. No-op in simulation mode.
const chainSweep = setInterval(async () => {
  try {
    const r = await runChainSweep();
    if (r.funded.length) console.log(`[chain] funded: ${r.funded.join(', ')}`);
    if (r.lost.length) console.warn(`[chain] funding output missing: ${r.lost.join(', ')}`);
  } catch (err) {
    console.error('[chain] sweep error:', err.message);
  }
}, 15_000);
chainSweep.unref?.();

function shutdown() {
  clearInterval(sweep);
  clearInterval(chainSweep);
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

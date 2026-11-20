import { config, summarizeConfig } from './config.js';
import { createApp } from './app.js';
import { logError } from './lib/log.js';
import { runReviewWindowSweep, runChainSweep } from './services/orderService.js';

const app = createApp();

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
    logError('[sweep] error:', err);
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
    logError('[chain] sweep error:', err);
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

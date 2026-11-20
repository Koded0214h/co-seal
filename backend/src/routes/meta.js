import { Router } from 'express';
import { config, summarizeConfig } from '../config.js';

const router = Router();

router.get('/status', (_req, res) => {
  res.json({ ok: true, service: 'coseal', ...summarizeConfig() });
});

/* Relays + network info the frontend needs to initialize a Nostr client / wallet connection. */
router.get('/network', (_req, res) => {
  res.json({
    bitcoinNetwork: config.bitcoin.network,
    nostrRelays: config.nostr.relays,
    arbitratorPubkey: config.bitcoin.arbitratorPubkey || null,
  });
});

export default router;

import { Router } from 'express';
import { config, summarizeConfig } from '../config.js';
import { db } from '../db.js';
import { AUTH_EVENT_KIND } from '../lib/auth.js';

const router = Router();

router.get('/status', (_req, res) => {
  const s = summarizeConfig();
  res.json({ ok: true, service: 'coseal', bitcoinMode: s.bitcoinMode, bitcoinNetwork: s.bitcoinNetwork, demoMode: s.demoMode });
});

/* Relays, network and auth parameters the frontend needs to initialise wallet + Nostr + login. */
router.get('/network', (_req, res) => {
  res.json({
    bitcoinNetwork: config.bitcoin.network,
    bitcoinLive: config.bitcoin.live,
    minConfirmations: config.bitcoin.minConfirmations,
    nostrRelays: config.nostr.relays,
    authEventKind: AUTH_EVENT_KIND,
  });
});

/* Active arbitrators a seller can choose from (escrow key is public by nature). */
router.get('/arbitrators', (_req, res) => {
  const rows = db.prepare("SELECT id, display_name, btc_pubkey FROM users WHERE role = 'ARBITRATOR' AND status = 'ACTIVE' AND btc_pubkey IS NOT NULL").all();
  res.json(rows.map((r) => ({ id: r.id, displayName: r.display_name, btcPubkey: r.btc_pubkey })));
});

export default router;

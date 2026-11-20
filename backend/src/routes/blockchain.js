import { Router } from 'express';

const router = Router();

/**
 * Funding notifications. LinkLock had a real Monnify webhook here (HMAC-verified push on
 * every inbound transfer). Bitcoin Core itself doesn't push webhooks — funding detection is
 * normally a poll loop against bitcoind/an indexer (see lib/bitcoin.js, orderService's
 * checkFundingStatus). This endpoint is a placeholder for IF you front that poll with a
 * third-party indexer (e.g. an Esplora/BlockCypher-style service) that can push a
 * notification instead — verify its signature/auth scheme the same way the Monnify
 * webhook did before trusting the payload, then call svc.checkFundingStatus / a dedicated
 * "fundingObserved" handler keyed by escrow address.
 */
router.post('/funding', (_req, res) => {
  res.status(501).json({ error: 'Not implemented — funding is currently detected by polling, see /api/orders/:ref/check-funding' });
});

export default router;

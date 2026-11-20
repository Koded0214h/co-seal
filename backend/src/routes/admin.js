import { Router } from 'express';
import path from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';
import * as svc from '../services/orderService.js';
import * as ai from '../lib/ai.js';

const router = Router();

// Simple bearer-token guard for the internal arbitration console (FR-08).
// TODO: PRD §9 asks that "arbitrator access must be restricted to assigned disputes" —
// this single shared ADMIN_TOKEN (ported from LinkLock) is a hackathon stand-in, not
// per-arbitrator access control.
router.use((req, res, next) => {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.token;
  if (token !== config.adminToken) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* All transactions (newest first) for the ops board, with an optional ?state= filter. */
router.get('/orders', ah(async (req, res) => {
  const rows = req.query.state
    ? db.prepare('SELECT * FROM orders WHERE state = ? ORDER BY created_at DESC').all(req.query.state)
    : db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  res.json(rows.map((o) => svc.serializeOrder(o)));
}));

/* The arbitration queue: everything currently frozen or under review. */
router.get('/review-queue', ah(async (req, res) => {
  const rows = db.prepare("SELECT * FROM orders WHERE state IN ('DISPUTED','UNDER_REVIEW') ORDER BY updated_at DESC").all();
  res.json(rows.map((o) => svc.serializeOrder(o)));
}));

/* Re-run the AI evidence comparison for a case (assist for the arbitrator, FR-08). */
router.post('/orders/:ref/recompare', ah(async (req, res) => {
  const order = svc.getOrderByRef(req.params.ref);
  if (!order) return res.status(404).json({ error: 'Transaction not found' });
  const sellerEv = db.prepare("SELECT * FROM evidence WHERE order_id=? AND side='SELLER' ORDER BY captured_at DESC LIMIT 1").get(order.id);
  const buyerEv = db.prepare("SELECT * FROM evidence WHERE order_id=? AND side='BUYER' ORDER BY captured_at DESC LIMIT 1").get(order.id);
  if (!sellerEv || !buyerEv) return res.status(400).json({ error: 'Need both seller and buyer evidence to compare' });
  const comparison = await ai.compareEvidence({
    dispatchFilePath: path.join(config.paths.uploads, sellerEv.stored_file),
    problemFilePath: path.join(config.paths.uploads, buyerEv.stored_file),
    itemDescription: order.item_description,
  });
  svc.saveDisputeAiComparison(order.id, comparison);
  res.json({ comparison, order: svc.serializeOrder(order) });
}));

/* Arbitrator decision: RELEASE | REFUND | SPLIT on a case under review. */
router.post('/orders/:ref/resolve', ah(async (req, res) => {
  const order = svc.getOrderByRef(req.params.ref);
  if (!order) return res.status(404).json({ error: 'Transaction not found' });
  const decision = String(req.body?.decision || '').toUpperCase();
  const note = req.body?.note;
  const result = await svc.resolveByArbitrator(order, { decision, note });
  res.json(svc.serializeOrder(result.order));
}));

export default router;

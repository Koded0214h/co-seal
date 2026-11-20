import { Router } from 'express';
import path from 'node:path';
import { config } from '../config.js';
import { upload } from '../lib/upload.js';
import * as svc from '../services/orderService.js';
import * as ai from '../lib/ai.js';
import { STATES } from '../stateMachine.js';

const router = Router();

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function loadOrder(req, res, next) {
  const order = svc.getOrderByRef(req.params.ref);
  if (!order) return res.status(404).json({ error: 'Transaction not found', ref: req.params.ref });
  req.order = order;
  next();
}

function bad(res, msg, code = 400) {
  return res.status(code).json({ error: msg });
}

/* FR-01: seller creates a transaction → mints the isolated escrow, returns the shareable link. */
router.post('/', ah(async (req, res) => {
  const { itemDescription, amountSats, sellerPubkey, sellerName, buyerPubkey, deliveryConditions, expectedDeliveryAt, disputeTerms } = req.body || {};
  if (!itemDescription || String(itemDescription).trim().length < 2) return bad(res, 'itemDescription is required');
  const amt = Number(amountSats);
  if (!Number.isInteger(amt) || amt <= 0) return bad(res, 'amountSats must be a positive integer');
  if (!sellerPubkey) return bad(res, 'sellerPubkey is required');

  const order = await svc.createOrder({
    itemDescription: String(itemDescription).trim(),
    amountSats: amt,
    sellerPubkey: String(sellerPubkey).trim(),
    sellerName: sellerName?.trim(),
    buyerPubkey: buyerPubkey?.trim(),
    deliveryConditions: deliveryConditions?.trim(),
    expectedDeliveryAt: expectedDeliveryAt ? Number(expectedDeliveryAt) : null,
    disputeTerms: disputeTerms?.trim(),
  });
  res.status(201).json(svc.serializeOrder(order));
}));

/* Public transaction view (buyer/seller share this). */
router.get('/:ref', loadOrder, ah(async (req, res) => {
  res.json(svc.serializeOrder(req.order));
}));

/* DEMO: simulate Bitcoin funding landing (stands in for a real Signet transfer). */
router.post('/:ref/simulate-funding', loadOrder, ah(async (req, res) => {
  if (!config.demoMode) return bad(res, 'Simulation is disabled (DEMO_MODE=false)', 403);
  if (req.order.state !== STATES.AWAITING_FUNDING) return bad(res, `Transaction is already ${req.order.state}`, 409);
  const { order } = await svc.simulateFunding(req.order);
  res.json(svc.serializeOrder(order));
}));

/* Poll the escrow address directly rather than waiting on a funding webhook/watcher. */
router.post('/:ref/check-funding', loadOrder, ah(async (req, res) => {
  if (req.order.state !== STATES.AWAITING_FUNDING) return res.json(svc.serializeOrder(req.order));
  const { order, matched } = await svc.checkFundingStatus(req.order);
  if (!matched) return res.status(202).json({ ...svc.serializeOrder(order), fundingDetected: false });
  res.json({ ...svc.serializeOrder(order), fundingDetected: true });
}));

/* FR-04: seller dispatches & proves. Uploads dispatch evidence; AI gates genuineness before DISPATCHED. */
router.post('/:ref/dispatch', loadOrder, upload.single('proof'), ah(async (req, res) => {
  const order = req.order;
  if (order.state !== STATES.FUNDED) return bad(res, `Can only dispatch a FUNDED transaction (currently ${order.state})`, 409);
  if (!req.file) return bad(res, 'A dispatch proof image is required');
  const dispatchReference = (req.body?.dispatchReference || '').trim();
  const acknowledgeFlag = /^(1|true|yes)$/i.test(String(req.body?.acknowledgeFlag || ''));

  const assessment = await ai.verifyDispatchProof({
    filePath: path.join(config.paths.uploads, req.file.filename),
    itemDescription: order.item_description,
  });

  const evidence = svc.addEvidence({
    orderId: order.id, side: 'SELLER', storedFile: req.file.filename,
    category: 'dispatch', note: dispatchReference ? `Dispatch ref: ${dispatchReference}` : null,
  });
  svc.addAssessment({ orderId: order.id, evidenceId: evidence.id, assessment });

  // Block progress on a genuine AI failure (assist), unless explicitly acknowledged.
  if (assessment.available && assessment.passed === false && !acknowledgeFlag) {
    return res.status(422).json({
      error: 'Dispatch proof was flagged by AI verification. Please re-submit genuine proof.',
      assessment, evidence: { id: evidence.id, url: `/uploads/${req.file.filename}` },
      order: svc.serializeOrder(order),
    });
  }

  const dispatched = svc.markDispatched(order, { dispatchReference });
  res.json(svc.serializeOrder(dispatched));
}));

/* Optional shipping-update milestone (PRD §6.2 IN_TRANSIT). */
router.post('/:ref/in-transit', loadOrder, ah(async (req, res) => {
  if (req.order.state !== STATES.DISPATCHED) return bad(res, `Can only mark in-transit from DISPATCHED (currently ${req.order.state})`, 409);
  res.json(svc.serializeOrder(svc.reportInTransit(req.order)));
}));

/* Seller: report delivery → opens the buyer review window (starts the timer). */
router.post('/:ref/deliver', loadOrder, ah(async (req, res) => {
  if (![STATES.DISPATCHED, STATES.IN_TRANSIT].includes(req.order.state)) {
    return bad(res, `Can only mark delivered from DISPATCHED or IN_TRANSIT (currently ${req.order.state})`, 409);
  }
  res.json(svc.serializeOrder(svc.reportDelivered(req.order)));
}));

/* Buyer: confirm received → proposes the RELEASE settlement (PSBT awaiting signatures). */
router.post('/:ref/confirm', loadOrder, ah(async (req, res) => {
  if (req.order.state !== STATES.REVIEW_PENDING) return bad(res, `Nothing to confirm (transaction is ${req.order.state})`, 409);
  const result = await svc.buyerConfirm(req.order);
  res.json(svc.serializeOrder(result.order));
}));

/* Buyer: dispute → freezes settlement, uploads problem proof, runs AI checks. */
router.post('/:ref/dispute', loadOrder, upload.single('proof'), ah(async (req, res) => {
  const order = req.order;
  if (order.state !== STATES.REVIEW_PENDING) return bad(res, `Cannot dispute a transaction in state ${order.state}`, 409);
  const category = (req.body?.category || '').trim();
  const reason = (req.body?.reason || 'Item not as described').trim();

  // Freeze first — the buyer's right to dispute does not depend on AI (PRD §3.5 / FR-06).
  svc.openDispute(order, { category, reason });

  let assessment = null;
  let comparison = null;
  if (req.file) {
    const problemPath = path.join(config.paths.uploads, req.file.filename);
    const sellerEv = svc.latestSellerEvidence(order.id);

    if (sellerEv) {
      const analysis = await ai.analyzeDispute({
        dispatchFilePath: path.join(config.paths.uploads, sellerEv.stored_file),
        problemFilePath: problemPath,
        itemDescription: order.item_description,
        complaint: reason,
      });
      if (analysis.available) {
        assessment = analysis.buyerProof;
        comparison = analysis.comparison;
        svc.saveDisputeAiComparison(order.id, comparison);
      } else {
        assessment = { available: false, reason: analysis.reason };
      }
    } else {
      assessment = await ai.verifyProblemProof({ filePath: problemPath, itemDescription: order.item_description, complaint: reason });
    }
    const evidence = svc.addEvidence({ orderId: order.id, side: 'BUYER', storedFile: req.file.filename, category: category || 'problem', note: reason });
    svc.addAssessment({ orderId: order.id, evidenceId: evidence.id, assessment });
  }

  res.json({ order: svc.serializeOrder(svc.getOrderById(order.id)), assessment, comparison });
}));

/* Seller: respond to a dispute — ACCEPT or CONTEST (both escalate to arbitration). */
router.post('/:ref/seller-response', loadOrder, ah(async (req, res) => {
  const response = String(req.body?.response || '').toUpperCase();
  if (!['ACCEPT', 'CONTEST'].includes(response)) return bad(res, 'response must be ACCEPT or CONTEST');
  if (req.order.state !== STATES.DISPUTED) return bad(res, `No open dispute to respond to (transaction is ${req.order.state})`, 409);
  const result = svc.sellerRespondToDispute(req.order, { response });
  res.json(svc.serializeOrder(result.order));
}));

/* A participant submits their signature over the currently-proposed settlement PSBT. */
router.post('/:ref/sign', loadOrder, ah(async (req, res) => {
  const { type, signerPubkey, signature } = req.body || {};
  if (!['RELEASE', 'REFUND', 'SPLIT'].includes(String(type).toUpperCase())) return bad(res, 'type must be RELEASE | REFUND | SPLIT');
  if (!signerPubkey || !signature) return bad(res, 'signerPubkey and signature are required');
  const result = await svc.signSettlement(req.order, { type: String(type).toUpperCase(), signerPubkey, signature });
  res.json(svc.serializeOrder(result.order));
}));

export default router;

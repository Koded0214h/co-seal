import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { upload, MAX_FILES, removeUpload } from '../lib/upload.js';
import * as svc from '../services/orderService.js';
import * as assess from '../services/assessmentService.js';
import * as auth from '../lib/auth.js';
import { STATES } from '../stateMachine.js';
import { ah, bad } from './helpers.js';

const router = Router();

/**
 * RBAC summary (per-order roles are derived from the authenticated user, see lib/auth.js):
 *   anyone with the link .... GET /:ref (public agreement view), GET /:ref/escrow/verify
 *   any signed-in user ...... POST / (becomes SELLER), POST /:ref/join (becomes BUYER)
 *   SELLER .................. terms, amendments, dispatch, in-transit, deliver, seller-response
 *   BUYER ................... confirm, dispute, amendment responses
 *   BUYER|SELLER ............ evidence upload, check-funding
 *   BUYER|SELLER|ARBITRATOR . sign, events, evidence files, nostr refs
 *   ARBITRATOR (assigned) ... resolve, recompare   (ADMIN acts as arbitrator on unassigned orders)
 */

function loadOrder(req, res, next) {
  const order = svc.getOrderByRef(req.params.ref);
  if (!order) return res.status(404).json({ error: 'Transaction not found', ref: req.params.ref });
  req.order = order;
  req.orderRoles = auth.orderRoles(order, req.user);
  next();
}

const view = (req, order = req.order) => svc.serializeOrder(order, auth.orderRoles(order, req.user));
const participants = auth.requireOrderRole('BUYER', 'SELLER', 'ARBITRATOR');
const files = upload.array('proof', MAX_FILES);

/** Run multer, turning its errors into clean 4xx responses. */
const withFiles = (req, res, next) => files(req, res, (err) => {
  if (!err) return next();
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err.code?.startsWith?.('LIMIT_') ? 400 : 400);
  res.status(status).json({ error: err.message });
});

function uploaded(req, side) {
  const added = [];
  try {
    for (const f of req.files || []) {
      added.push(svc.addEvidence({
        orderId: req.order.id, side, storedFile: f.filename,
        category: (req.body?.category || '').trim() || null,
        note: req.body?.note || req.body?.reason || null,
        deviceCapturedAt: req.body?.deviceCapturedAt, uploadedBy: req.user.id,
      }));
    }
  } catch (err) {
    for (const f of req.files || []) if (!added.some((a) => a.stored_file === f.filename)) removeUpload(f.filename);
    throw err;
  }
  return added;
}

/* FR-01: a signed-in user becomes the SELLER of a new transaction. */
router.post('/', auth.requireAuth, ah(async (req, res) => {
  const b = req.body || {};
  if (!b.itemDescription || String(b.itemDescription).trim().length < 2) return bad(res, 'itemDescription is required');
  const amt = Number(b.amountSats);
  if (!Number.isInteger(amt) || amt <= 0) return bad(res, 'amountSats must be a positive integer');
  const invited = b.invitedBuyerNostr ? String(b.invitedBuyerNostr).trim().toLowerCase() : null;
  if (invited && !/^[0-9a-f]{64}$/.test(invited)) return bad(res, 'invitedBuyerNostr must be a 64-hex Nostr pubkey');
  if (!config.bitcoin.live && !b.sellerPubkey) b.sellerPubkey = req.user.pubkey; // simulation convenience
  if (!b.sellerPubkey) return bad(res, 'sellerPubkey (your escrow key) is required');

  const order = await svc.createOrder({
    itemDescription: String(b.itemDescription).trim(),
    amountSats: amt,
    sellerPubkey: String(b.sellerPubkey).trim(),
    sellerName: b.sellerName?.trim() || req.user.display_name || null,
    sellerPayoutAddress: b.sellerPayoutAddress?.trim(),
    sellerUserId: req.user.id,
    invitedBuyerNostr: invited,
    arbitratorUserId: b.arbitratorUserId || undefined,
    deliveryConditions: b.deliveryConditions?.trim(),
    expectedDeliveryAt: b.expectedDeliveryAt ? Number(b.expectedDeliveryAt) : null,
    disputeTerms: b.disputeTerms?.trim(),
  });
  res.status(201).json(view(req, order));
}));

/* The link: public agreement view for everyone, full view for participants. */
router.get('/:ref', loadOrder, (req, res) => res.json(view(req)));

/* FR-02: anyone can recompute and verify the escrow from the three keys. */
router.get('/:ref/escrow/verify', loadOrder, (req, res) => {
  const escrow = svc.getEscrowByOrderId(req.order.id);
  if (!escrow) return bad(res, 'No escrow yet — waiting for the buyer to join', 404);
  res.json({ address: escrow.address, ...svc.verifyEscrowRecord(escrow) });
});

/* Buyer opens the link and joins with their escrow key + payout address. */
router.post('/:ref/join', auth.requireAuth, loadOrder, ah(async (req, res) => {
  const { buyerPubkey, buyerPayoutAddress, agreementHash } = req.body || {};
  const order = svc.joinAsBuyer(req.order, {
    buyerPubkey: String(buyerPubkey || '').trim(), buyerPayoutAddress: String(buyerPayoutAddress || '').trim(),
    agreementHash, userId: req.user.id,
  });
  res.json(view(req, order));
}));

/* Agreement changes (FR-01). */
router.patch('/:ref/terms', loadOrder, auth.requireOrderRole('SELLER'), ah(async (req, res) => {
  res.json(view(req, svc.editTerms(req.order, req.body)));
}));
router.post('/:ref/amendments', loadOrder, auth.requireOrderRole('SELLER'), ah(async (req, res) => {
  const a = svc.proposeAmendment(req.order, { userId: req.user.id, changes: req.body?.changes });
  res.status(201).json({ amendment: svc.listAmendments(req.order.id).find((x) => x.id === a.id) });
}));
router.post('/:ref/amendments/:id/respond', loadOrder, auth.requireOrderRole('BUYER'), ah(async (req, res) => {
  const r = svc.respondAmendment(req.order, { amendmentId: req.params.id, accept: req.body?.accept === true, agreementHash: req.body?.agreementHash });
  res.json(view(req, r.order));
}));

/* FR-11 / §9: audit trail, evidence files and hash verification — participants only. */
router.get('/:ref/events', loadOrder, participants, ah(async (req, res) => res.json(svc.getEventHistory(req.order))));

router.get('/:ref/evidence/:evidenceId/verify', loadOrder, participants, ah(async (req, res) => {
  res.json(svc.verifyEvidence(req.order.id, req.params.evidenceId));
}));

router.get('/:ref/evidence/:evidenceId/file', loadOrder, participants, ah(async (req, res) => {
  const ev = svc.getEvidence(req.order.id, req.params.evidenceId);
  const full = path.join(config.paths.uploads, ev.stored_file);
  if (!fs.existsSync(full)) return bad(res, 'File missing', 404);
  res.set({
    'Content-Type': ev.mime || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'private, max-age=300',
  });
  res.sendFile(full);
}));

/* Either side can add evidence once the order is funded (FR-06). */
router.post('/:ref/evidence', loadOrder, auth.requireOrderRole('BUYER', 'SELLER'), withFiles, ah(async (req, res) => {
  const early = [STATES.CREATED, STATES.AWAITING_FUNDING].includes(req.order.state);
  const done = ['RELEASED', 'REFUNDED', 'SPLIT'].includes(req.order.state);
  if (early || done) { for (const f of req.files || []) removeUpload(f.filename); return bad(res, `Evidence cannot be added while the transaction is ${req.order.state}`, 409); }
  if (!req.files?.length) return bad(res, 'Attach at least one file (field "proof")');
  const side = req.orderRoles.has('SELLER') ? 'SELLER' : 'BUYER';
  const added = uploaded(req, side);
  const assessment = await assess.assessAdditional(req.order, added);
  res.status(201).json({ evidence: added.map((e) => ({ id: e.id, sha256: e.sha256, mime: e.mime })), assessment, order: view(req) });
}));

/* Nostr message references (content stays on relays, encrypted — FR-09). */
router.get('/:ref/nostr/events', loadOrder, participants, (req, res) => {
  res.json({ conversationTag: view(req).conversationTag, events: svc.listNostrRefs(req.order) });
});
router.post('/:ref/nostr/events', loadOrder, auth.requireOrderRole('BUYER', 'SELLER'), ah(async (req, res) => {
  const { eventId, kind, authorPubkey, relay, event } = req.body || {};
  const r = svc.addNostrRef(req.order, { eventId, kind, authorPubkey, relay, event });
  res.status(r.fresh ? 201 : 200).json(r.reference);
}));

/* DEMO: simulate Bitcoin funding landing. Simulation mode + DEMO_MODE only. */
router.post('/:ref/simulate-funding', loadOrder, auth.requireOrderRole('BUYER'), ah(async (req, res) => {
  if (!config.demoMode) return bad(res, 'Simulation is disabled (DEMO_MODE=false)', 403);
  if (req.order.state !== STATES.AWAITING_FUNDING) return bad(res, `Transaction is already ${req.order.state}`, 409);
  const { order } = await svc.simulateFunding(req.order);
  res.json(view(req, order));
}));

/* Poll the chain for the escrow's funding right now. */
router.post('/:ref/check-funding', loadOrder, auth.requireOrderRole('BUYER', 'SELLER'), ah(async (req, res) => {
  if (req.order.state !== STATES.AWAITING_FUNDING) return res.json(view(req));
  const { order, matched, observed } = await svc.checkFundingStatus(req.order);
  const body = { ...view(req, order), fundingDetected: matched };
  if (observed) body.observed = { amountSats: observed.amountSats, confirmedSats: observed.confirmedSats, confirmations: observed.confirmations };
  res.status(matched ? 200 : 202).json(body);
}));

/* FR-04: seller dispatches with evidence. The AI warns but never permanently blocks. */
router.post('/:ref/dispatch', loadOrder, auth.requireOrderRole('SELLER'), withFiles, ah(async (req, res) => {
  const order = req.order;
  const cleanup = () => { for (const f of req.files || []) removeUpload(f.filename); };
  if (order.state !== STATES.FUNDED) { cleanup(); return bad(res, `Can only dispatch a FUNDED transaction (currently ${order.state})`, 409); }
  if (!req.files?.length) return bad(res, 'At least one dispatch proof file is required (field "proof")');
  const dispatchReference = (req.body?.dispatchReference || '').trim();
  const acknowledged = /^(1|true|yes)$/i.test(String(req.body?.acknowledgeFlag || ''));

  req.body.category = req.body.category || 'dispatch';
  req.body.note = dispatchReference ? `Dispatch ref: ${dispatchReference}` : null;
  const evidences = uploaded(req, 'SELLER');
  const assessment = await assess.assessDispatch(order, evidences);

  const flagged = (assessment.available && assessment.passed === false) || assessment.flagged;
  if (flagged && !acknowledged) {
    return res.status(422).json({
      error: 'Dispatch proof was flagged. Review the findings and re-submit, or acknowledge the warning to proceed.',
      assessment, evidence: evidences.map((e) => ({ id: e.id, sha256: e.sha256 })), order: view(req),
    });
  }
  if (flagged) svc.recordEvent(order.id, 'DISPATCH_WARNING_ACKNOWLEDGED', null, null, { evidenceIds: evidences.map((e) => e.id) });
  const dispatched = svc.markDispatched(order, { dispatchReference });
  res.json({ ...view(req, dispatched), assessment });
}));

router.post('/:ref/in-transit', loadOrder, auth.requireOrderRole('SELLER'), ah(async (req, res) => {
  if (req.order.state !== STATES.DISPATCHED) return bad(res, `Can only mark in-transit from DISPATCHED (currently ${req.order.state})`, 409);
  res.json(view(req, svc.reportInTransit(req.order)));
}));

router.post('/:ref/deliver', loadOrder, auth.requireOrderRole('SELLER'), ah(async (req, res) => {
  if (![STATES.DISPATCHED, STATES.IN_TRANSIT].includes(req.order.state)) {
    return bad(res, `Can only mark delivered from DISPATCHED or IN_TRANSIT (currently ${req.order.state})`, 409);
  }
  res.json(view(req, svc.reportDelivered(req.order)));
}));

/* Buyer confirms receipt → RELEASE settlement (buyer + seller sign). */
router.post('/:ref/confirm', loadOrder, auth.requireOrderRole('BUYER'), ah(async (req, res) => {
  if (req.order.state !== STATES.REVIEW_PENDING) return bad(res, `Nothing to confirm (transaction is ${req.order.state})`, 409);
  const result = await svc.buyerConfirm(req.order);
  res.json(view(req, result.order));
}));

/* FR-06: buyer disputes. Freeze FIRST — the right to dispute never depends on AI or uploads. */
router.post('/:ref/dispute', loadOrder, auth.requireOrderRole('BUYER'), withFiles, ah(async (req, res) => {
  const order = req.order;
  if (order.state !== STATES.REVIEW_PENDING) {
    for (const f of req.files || []) removeUpload(f.filename);
    return bad(res, `Cannot dispute a transaction in state ${order.state}`, 409);
  }
  const category = (req.body?.category || '').trim();
  const reason = (req.body?.reason || 'Item not as described').trim();
  svc.openDispute(order, { category, reason });

  let result = { assessment: null, comparison: null };
  let evidences = [];
  if (req.files?.length) {
    req.body.category = category || 'problem';
    req.body.note = reason;
    evidences = uploaded(req, 'BUYER');
    result = await assess.assessDispute(order, evidences, reason);
  }
  res.json({ order: view(req, svc.getOrderById(order.id)), ...result });
}));

/* FR-07: seller ACCEPT (→ refund proposal) or CONTEST (→ arbitration). */
router.post('/:ref/seller-response', loadOrder, auth.requireOrderRole('SELLER'), ah(async (req, res) => {
  const response = String(req.body?.response || '').toUpperCase();
  if (!['ACCEPT', 'CONTEST'].includes(response)) return bad(res, 'response must be ACCEPT or CONTEST');
  if (req.order.state !== STATES.DISPUTED) return bad(res, `No open dispute to respond to (transaction is ${req.order.state})`, 409);
  const result = await svc.sellerRespondToDispute(req.order, { response });
  res.json(view(req, result.order));
}));

/* FR-08: the assigned arbitrator decides. SPLIT takes sellerShareBps (1–9999). */
router.post('/:ref/resolve', loadOrder, auth.requireOrderRole('ARBITRATOR'), ah(async (req, res) => {
  const decision = String(req.body?.decision || '').toUpperCase();
  const sellerShareBps = req.body?.sellerShareBps == null ? undefined : Number(req.body.sellerShareBps);
  const result = await svc.resolveByArbitrator(req.order, { decision, note: req.body?.note, sellerShareBps });
  res.json(view(req, result.order));
}));

router.post('/:ref/recompare', loadOrder, auth.requireOrderRole('ARBITRATOR'), ah(async (req, res) => {
  const comparison = await assess.recompare(req.order);
  if (!comparison) return bad(res, 'Need both seller and buyer image evidence to compare');
  res.json({ comparison, order: view(req) });
}));

/* A participant submits the PSBT they signed in their own wallet. */
router.post('/:ref/sign', loadOrder, participants, ah(async (req, res) => {
  const { type, signerPubkey, signature, psbt } = req.body || {};
  const t = String(type).toUpperCase();
  if (!['RELEASE', 'REFUND', 'SPLIT'].includes(t)) return bad(res, 'type must be RELEASE | REFUND | SPLIT');
  // Live mode: `psbt` is the base64 PSBT signed in the participant's wallet.
  // Simulation mode keeps the legacy { signerPubkey, signature } shape.
  if (!psbt && (!signerPubkey || !signature)) return bad(res, 'psbt (signed, base64) is required');
  const actorRoles = new Set([...req.orderRoles].filter((r) => r !== 'ADMIN'));
  const result = await svc.signSettlement(req.order, { type: t, signerPubkey, signature, psbt, actorRoles });
  res.json({ ...view(req, result.order), broadcast: result.broadcast });
}));

export default router;

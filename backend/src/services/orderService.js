import { db, now } from '../db.js';
import { config, bitcoinLive, reviewWindowMs } from '../config.js';
import { uid, orderRef } from '../lib/ids.js';
import { STATES, assertTransition, STATE_LABELS } from '../stateMachine.js';
import { sendNotification, listNotifications } from '../lib/notify.js';
import { hashUploadedFile } from '../lib/upload.js';
import * as btc from '../lib/bitcoin.js';

/* ─────────────────────────── helpers ─────────────────────────── */

function recordEvent(orderId, type, fromState, toState, detail) {
  db.prepare(
    `INSERT INTO events (id, order_id, type, from_state, to_state, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(uid('evt'), orderId, type, fromState || null, toState || null, detail ? JSON.stringify(detail) : null, now());
}

function setState(order, toState, detail) {
  assertTransition(order.state, toState);
  db.prepare('UPDATE orders SET state = ?, updated_at = ? WHERE id = ?').run(toState, now(), order.id);
  recordEvent(order.id, 'TRANSITION', order.state, toState, detail);
  order.state = toState;
  return order;
}

export function getOrderByRef(ref) {
  return db.prepare('SELECT * FROM orders WHERE ref = ?').get(ref);
}
export function getOrderById(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}
export function getEscrowByOrderId(orderId) {
  return db.prepare('SELECT * FROM escrows WHERE order_id = ?').get(orderId);
}
export function getOrderByEscrowAddress(address) {
  const escrow = db.prepare('SELECT * FROM escrows WHERE address = ?').get(address);
  return escrow ? getOrderById(escrow.order_id) : null;
}
export function listParticipants(orderId) {
  return db.prepare('SELECT * FROM participants WHERE order_id = ?').all(orderId);
}

/**
 * Idempotent settlement/funding writer, same shape as LinkLock's `recordMoney`. Keyed by
 * idempotency_key (UNIQUE): a duplicate webhook, retried API call, or re-run sweep that
 * reuses the key is a no-op and returns the existing row. `run` performs the real side
 * effect (today: a simulated one, see lib/bitcoin.js) and returns the outcome.
 */
async function recordSettlement(orderId, type, amountSats, idempotencyKey, run) {
  const existing = db.prepare('SELECT * FROM settlements WHERE idempotency_key = ?').get(idempotencyKey);
  if (existing) return { settlement: existing, fresh: false };

  const id = uid('stl');
  db.prepare(
    `INSERT INTO settlements (id, order_id, type, amount_sats, idempotency_key, status, occurred_at)
     VALUES (?, ?, ?, ?, ?, 'PROPOSED', ?)`,
  ).run(id, orderId, type, amountSats, idempotencyKey, now());

  let outcome;
  try {
    outcome = await run();
  } catch (err) {
    db.prepare('UPDATE settlements SET status = ?, detail = ? WHERE id = ?').run(
      'FAILED', JSON.stringify({ error: err.message }), id,
    );
    throw err;
  }
  db.prepare('UPDATE settlements SET status = ?, psbt = ?, txid = ?, detail = ? WHERE id = ?').run(
    outcome.status || 'AWAITING_SIGNATURES', outcome.psbt || null, outcome.txid || null,
    outcome.detail ? JSON.stringify(outcome.detail) : null, id,
  );
  return { settlement: db.prepare('SELECT * FROM settlements WHERE id = ?').get(id), fresh: true };
}

function getSettlement(orderId, type) {
  return db.prepare('SELECT * FROM settlements WHERE order_id = ? AND type = ? ORDER BY occurred_at DESC LIMIT 1').get(orderId, type);
}

/* ─────────────────────────── create ─────────────────────────── */

/**
 * FR-01: seller creates a transaction. Mints the order's isolated 2-of-3 escrow (real
 * Bitcoin once lib/bitcoin.js is implemented; simulated — same shape, deterministic fake
 * address — until then, exactly like LinkLock fell back to a simulated reserved account
 * when Monnify's contract code was unset).
 */
export async function createOrder(input) {
  const id = uid('ord');
  const ref = orderRef();
  const ts = now();

  db.prepare(
    `INSERT INTO orders (
      id, ref, item_description, amount_sats, seller_pubkey, seller_name,
      delivery_conditions, expected_delivery_at, dispute_terms,
      state, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, ref, input.itemDescription, input.amountSats, input.sellerPubkey, input.sellerName || null,
    input.deliveryConditions || null, input.expectedDeliveryAt || null, input.disputeTerms || null,
    STATES.CREATED, ts, ts,
  );

  db.prepare(
    `INSERT INTO participants (id, order_id, role, pubkey, created_at) VALUES (?, ?, 'SELLER', ?, ?)`,
  ).run(uid('ptc'), id, input.sellerPubkey, ts);
  if (input.buyerPubkey) {
    db.prepare(
      `INSERT INTO participants (id, order_id, role, pubkey, created_at) VALUES (?, ?, 'BUYER', ?, ?)`,
    ).run(uid('ptc'), id, input.buyerPubkey, ts);
  }

  let escrow;
  if (bitcoinLive) {
    escrow = await btc.createEscrow({
      buyerPubkey: input.buyerPubkey,
      sellerPubkey: input.sellerPubkey,
      arbitratorPubkey: config.bitcoin.arbitratorPubkey,
    });
  } else {
    escrow = simulatedEscrow(ref);
  }
  db.prepare(
    `INSERT INTO escrows (id, order_id, network, redeem_script, witness_script, address, buyer_pubkey, seller_pubkey, arbitrator_pubkey, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    uid('esc'), id, config.bitcoin.network, escrow.redeemScript || null, escrow.witnessScript || null,
    escrow.address, input.buyerPubkey || null, input.sellerPubkey, config.bitcoin.arbitratorPubkey || null, ts,
  );

  setState(getOrderById(id), STATES.AWAITING_FUNDING, { escrowAddress: escrow.address });
  recordEvent(id, 'CREATED', null, STATES.CREATED, { mode: bitcoinLive ? 'LIVE' : 'SIMULATION' });
  return getOrderById(id);
}

function simulatedEscrow(ref) {
  // Deterministic-looking signet bech32 address for simulation mode — not a real UTXO.
  const n = Math.abs(hashCode(ref)).toString(36).padStart(12, '0').slice(0, 12);
  return { address: `tb1q-sim-${n}`, redeemScript: null, witnessScript: null };
}
function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/* ─────────────── funding: AWAITING_FUNDING → FUNDED ─────────────── */

/**
 * FR-03: verify funding against the escrow address rather than trusting a frontend click.
 * Real mode polls lib/bitcoin.js for a confirmed UTXO; simulation mode (today's default)
 * mimics that observation so the rest of the lifecycle can be demoed and tested now.
 */
export async function checkFundingStatus(order) {
  if (order.state !== STATES.AWAITING_FUNDING) {
    return { order, matched: order.state !== STATES.CREATED };
  }
  const escrow = getEscrowByOrderId(order.id);

  let hit;
  if (bitcoinLive) {
    const status = await btc.getEscrowFundingStatus(escrow.address);
    if (!status || status.confirmations < config.bitcoin.minConfirmations) return { order, matched: false };
    hit = status;
  } else {
    hit = { txid: `sim-${order.id.slice(-10)}`, vout: 0, amountSats: order.amount_sats, confirmations: config.bitcoin.minConfirmations };
  }

  await recordFunding(order, hit);
  setState(order, STATES.FUNDED, { txid: hit.txid });
  sendNotification(order.id, 'SELLER', 'ESCROW_FUNDED',
    `Escrow funded for ${order.ref} (${hit.amountSats} sats, tx ${hit.txid}). Safe to dispatch "${order.item_description}".`);
  return { order: getOrderById(order.id), matched: true };
}

/** DEMO helper: mimic funding detection without a real Signet transaction. */
export async function simulateFunding(order) {
  return checkFundingStatus({ ...order, state: STATES.AWAITING_FUNDING });
}

async function recordFunding(order, hit) {
  const key = `${order.id}-FUNDING`;
  const existing = db.prepare('SELECT * FROM transactions WHERE idempotency_key = ?').get(key);
  if (existing) return existing;
  const id = uid('txn');
  db.prepare(
    `INSERT INTO transactions (id, order_id, type, txid, vout, amount_sats, confirmations, idempotency_key, status, occurred_at)
     VALUES (?, ?, 'FUNDING', ?, ?, ?, ?, ?, 'CONFIRMED', ?)`,
  ).run(id, order.id, hit.txid, hit.vout ?? 0, hit.amountSats, hit.confirmations, key, now());
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
}

/* ─────────────── dispatch: FUNDED → DISPATCHED ─────────────── */

export function markDispatched(order, { dispatchReference }) {
  assertTransition(order.state, STATES.DISPATCHED);
  db.prepare('UPDATE orders SET dispatch_reference = ?, updated_at = ? WHERE id = ?').run(
    dispatchReference || null, now(), order.id,
  );
  setState(order, STATES.DISPATCHED, { dispatchReference });
  return getOrderById(order.id);
}

/* ─────────── shipping milestone (optional): DISPATCHED → IN_TRANSIT ─────────── */

export function reportInTransit(order) {
  assertTransition(order.state, STATES.IN_TRANSIT);
  setState(order, STATES.IN_TRANSIT, {});
  return getOrderById(order.id);
}

/* ─────── delivery reported: {DISPATCHED,IN_TRANSIT} → DELIVERED → REVIEW_PENDING ─────── */

export function reportDelivered(order) {
  assertTransition(order.state, STATES.DELIVERED);
  setState(order, STATES.DELIVERED, {});
  const expiresAt = now() + reviewWindowMs();
  db.prepare('UPDATE orders SET review_window_expires_at = ?, updated_at = ? WHERE id = ?').run(
    expiresAt, now(), order.id,
  );
  setState(getOrderById(order.id), STATES.REVIEW_PENDING, { expiresAt });
  sendNotification(order.id, 'BUYER', 'REVIEW_WINDOW_OPEN',
    `${order.ref} was delivered. Confirm if it's correct, or raise a dispute if there's a problem. ${config.appBaseUrl}/t/${order.ref}/confirm`);
  return getOrderById(order.id);
}

/* ─────────────── settlement proposals (AWAITING_SIGNATURES) ─────────────── */

/**
 * Propose a settlement (RELEASE/REFUND/SPLIT): builds the PSBT (stub — see lib/bitcoin.js)
 * and moves the order to AWAITING_SIGNATURES. Idempotent per order+type.
 */
async function proposeSettlement(order, { type, amountSats, trigger }) {
  const key = `${order.id}-${type}`;
  const escrow = getEscrowByOrderId(order.id);

  const { settlement } = await recordSettlement(order.id, type, amountSats, key, async () => {
    if (bitcoinLive) {
      const outputs = buildOutputsFor(type, amountSats);
      const psbt = await btc.buildSettlementPsbt({ order, escrow, outputs });
      return { status: 'AWAITING_SIGNATURES', psbt: psbt.base64, detail: { trigger } };
    }
    return { status: 'AWAITING_SIGNATURES', psbt: `sim-psbt-${type}-${order.id.slice(-8)}`, detail: { simulated: true, trigger } };
  });

  if ([STATES.REVIEW_PENDING, STATES.RESOLUTION_PROPOSED].includes(order.state)) {
    setState(order, STATES.AWAITING_SIGNATURES, { type, trigger });
  }
  sendNotification(order.id, 'SELLER', 'SETTLEMENT_PROPOSED',
    `${order.ref}: a ${type.toLowerCase()} settlement is awaiting signatures (trigger: ${trigger}).`);
  return { order: getOrderById(order.id), settlement };
}

function buildOutputsFor(type, amountSats) {
  if (type === 'RELEASE') return [{ to: 'seller', amountSats }];
  if (type === 'REFUND') return [{ to: 'buyer', amountSats }];
  const half = Math.round(amountSats / 2);
  return [{ to: 'seller', amountSats: half }, { to: 'buyer', amountSats: amountSats - half }];
}

/* ─────────────── buyer confirm / dispute ─────────────── */

export async function buyerConfirm(order) {
  return proposeSettlement(order, { type: 'RELEASE', amountSats: order.amount_sats, trigger: 'BUYER_CONFIRM' });
}

export function openDispute(order, { category, reason }) {
  assertTransition(order.state, STATES.DISPUTED);
  const disputeId = uid('disp');
  db.prepare(
    `INSERT INTO disputes (id, order_id, opened_by, category, reason, state, created_at, updated_at)
     VALUES (?, ?, 'BUYER', ?, ?, 'OPEN', ?, ?)`,
  ).run(disputeId, order.id, category || null, reason || 'Item not as described', now(), now());
  setState(order, STATES.DISPUTED, { reason });
  sendNotification(order.id, 'SELLER', 'DISPUTE_OPENED',
    `The buyer disputed ${order.ref} ("${reason || 'Item not as described'}"). Escrow stays frozen — respond ACCEPT or CONTEST.`);
  return getDisputeByOrder(order.id);
}

/** Seller responds to a dispute. Both ACCEPT and CONTEST escalate to arbitration (see stateMachine.js note). */
export function sellerRespondToDispute(order, { response }) {
  const dispute = getDisputeByOrder(order.id);
  if (!dispute || dispute.state === 'RESOLVED') {
    const e = new Error('No open dispute to respond to'); e.status = 409; throw e;
  }
  db.prepare('UPDATE disputes SET seller_response = ?, state = ?, updated_at = ? WHERE id = ?')
    .run(response, 'UNDER_REVIEW', now(), dispute.id);
  setState(order, STATES.UNDER_REVIEW, { sellerResponse: response });
  sendNotification(order.id, 'BUYER', 'UNDER_REVIEW',
    `${order.ref}: the seller responded (${response}). An arbitrator will review both sides' evidence.`);
  return { order: getOrderById(order.id), dispute: getDisputeByOrder(order.id) };
}

/* ─────────────── arbitration (UNDER_REVIEW → RESOLUTION_PROPOSED → AWAITING_SIGNATURES) ─────────────── */

/** FR-08: arbitrator proposes RELEASE | REFUND | SPLIT. Advisory AI findings inform this but never decide it. */
export async function resolveByArbitrator(order, { decision, note }) {
  if (order.state !== STATES.UNDER_REVIEW) {
    const e = new Error(`${order.ref} is not under review`); e.status = 409; throw e;
  }
  setState(order, STATES.RESOLUTION_PROPOSED, { decision, note });
  markDisputeResolved(order.id, decision, note);

  const amount = order.amount_sats;
  const updated = getOrderById(order.id);
  if (decision === 'RELEASE') return proposeSettlement(updated, { type: 'RELEASE', amountSats: amount, trigger: 'ARBITRATOR' });
  if (decision === 'REFUND') return proposeSettlement(updated, { type: 'REFUND', amountSats: amount, trigger: 'ARBITRATOR' });
  if (decision === 'SPLIT') return proposeSettlement(updated, { type: 'SPLIT', amountSats: amount, trigger: 'ARBITRATOR' });
  const e = new Error('decision must be RELEASE | REFUND | SPLIT'); e.status = 400; throw e;
}

/* ─────────────── PSBT signing → broadcast (AWAITING_SIGNATURES → terminal) ─────────────── */

/**
 * FR-08/§6.3: a participant submits their signature over the proposed settlement PSBT.
 * Once the 2-of-3 threshold is met, lib/bitcoin.js finalizes and broadcasts it. No private
 * key ever reaches the backend — only the resulting signature (PRD §9).
 */
export async function signSettlement(order, { type, signerPubkey, signature }) {
  const settlement = getSettlement(order.id, type);
  if (!settlement || settlement.status === 'BROADCAST') {
    const e = new Error('No pending settlement of this type to sign'); e.status = 409; throw e;
  }
  const signatures = JSON.parse(settlement.signatures || '[]');
  if (!signatures.some((s) => s.pubkey === signerPubkey)) {
    signatures.push({ pubkey: signerPubkey, signedAt: now() });
  }
  db.prepare('UPDATE settlements SET signatures = ? WHERE id = ?').run(JSON.stringify(signatures), settlement.id);

  if (signatures.length < 2) {
    return { order: getOrderById(order.id), settlement: getSettlement(order.id, type), broadcast: false };
  }

  let txid;
  if (bitcoinLive) {
    const res = await btc.broadcastSettlement({ psbt: settlement.psbt });
    txid = res.txid;
  } else {
    txid = `sim-txid-${settlement.id.slice(-10)}`;
  }
  db.prepare('UPDATE settlements SET status = ?, txid = ? WHERE id = ?').run('BROADCAST', txid, settlement.id);
  finalizeSettlement(order, type, txid);
  return { order: getOrderById(order.id), settlement: getSettlement(order.id, type), broadcast: true };
}

function finalizeSettlement(order, type, txid) {
  const toState = { RELEASE: STATES.RELEASED, REFUND: STATES.REFUNDED, SPLIT: STATES.SPLIT }[type];
  const ts = now();
  if (type === 'RELEASE') db.prepare('UPDATE orders SET released_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, order.id);
  if (type === 'REFUND') db.prepare('UPDATE orders SET refunded_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, order.id);
  if (type === 'SPLIT') db.prepare('UPDATE orders SET released_at = ?, refunded_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, ts, order.id);
  setState(order, toState, { txid });
  sendNotification(order.id, 'SELLER', 'SETTLEMENT_BROADCAST', `${order.ref}: ${type} settlement broadcast (${txid}).`);
  sendNotification(order.id, 'BUYER', 'SETTLEMENT_BROADCAST', `${order.ref}: ${type} settlement broadcast (${txid}).`);
}

/* ─────────────── review-window timeout escalation ─────────────── */

/**
 * PRD §6.4: no backend timer spends Bitcoin, so a ghosted review window escalates straight
 * into arbitration instead of auto-releasing. This sweep only flags orders — a human still
 * makes the RELEASE/REFUND/SPLIT call via resolveByArbitrator.
 */
export async function runReviewWindowSweep() {
  const due = db.prepare(
    `SELECT * FROM orders WHERE state = 'REVIEW_PENDING'
       AND review_window_expires_at IS NOT NULL AND review_window_expires_at <= ?`,
  ).all(now());
  const escalated = [];
  for (const order of due) {
    try {
      setState(order, STATES.UNDER_REVIEW, { trigger: 'REVIEW_WINDOW_TIMEOUT' });
      sendNotification(order.id, 'SELLER', 'TIMEOUT_ESCALATED',
        `${order.ref}: the buyer review window expired without a response. Escalated to arbitration.`);
      escalated.push(order.ref);
    } catch (err) {
      console.error(`[sweep] escalation failed for ${order.ref}: ${err.message}`);
    }
  }
  return escalated;
}

/* ─────────────── evidence / disputes / assessments ─────────────── */

export function getDisputeByOrder(orderId) {
  return db.prepare('SELECT * FROM disputes WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(orderId);
}
function markDisputeResolved(orderId, decision, note) {
  const d = getDisputeByOrder(orderId);
  if (d && d.state !== 'RESOLVED') {
    db.prepare('UPDATE disputes SET state = ?, arbitrator_decision = ?, resolution_note = ?, updated_at = ? WHERE id = ?')
      .run('RESOLVED', decision, note || null, now(), d.id);
  }
}
export function saveDisputeAiComparison(orderId, comparison) {
  const d = getDisputeByOrder(orderId);
  if (d) db.prepare('UPDATE disputes SET ai_comparison = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(comparison), now(), d.id);
}

export function addEvidence({ orderId, side, storedFile, category, note, mediaType = 'image' }) {
  const id = uid('ev');
  const sha256 = hashUploadedFile(storedFile);
  db.prepare(
    `INSERT INTO evidence (id, order_id, side, category, media_type, stored_file, sha256, note, captured_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, orderId, side, category || null, mediaType, storedFile, sha256, note || null, now());
  return db.prepare('SELECT * FROM evidence WHERE id = ?').get(id);
}
export function listEvidence(orderId) {
  return db.prepare('SELECT * FROM evidence WHERE order_id = ? ORDER BY captured_at ASC').all(orderId);
}
export function latestSellerEvidence(orderId) {
  return db.prepare("SELECT * FROM evidence WHERE order_id = ? AND side = 'SELLER' ORDER BY captured_at DESC LIMIT 1").get(orderId);
}

export function addAssessment({ orderId, evidenceId, assessment }) {
  const id = uid('as');
  db.prepare(
    `INSERT INTO assessments (id, order_id, evidence_id, available, assessment, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, orderId, evidenceId || null, assessment?.available ? 1 : 0, JSON.stringify(assessment || null), now());
  return db.prepare('SELECT * FROM assessments WHERE id = ?').get(id);
}
export function listAssessments(orderId) {
  return db.prepare('SELECT * FROM assessments WHERE order_id = ? ORDER BY created_at ASC').all(orderId);
}

/* ─────────────────── serialization for the API ─────────────────── */

function parse(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

export function serializeOrder(order) {
  const escrow = getEscrowByOrderId(order.id);
  const participants = listParticipants(order.id).map((p) => ({ role: p.role, pubkey: p.pubkey }));
  const evidence = listEvidence(order.id).map((e) => ({
    id: e.id, side: e.side, category: e.category, mediaType: e.media_type,
    url: `/uploads/${e.stored_file}`, sha256: e.sha256, note: e.note, capturedAt: e.captured_at,
  }));
  const assessments = listAssessments(order.id).map((a) => ({
    id: a.id, evidenceId: a.evidence_id, available: Boolean(a.available), assessment: parse(a.assessment), createdAt: a.created_at,
  }));
  const settlements = db.prepare('SELECT * FROM settlements WHERE order_id = ? ORDER BY occurred_at ASC').all(order.id)
    .map((s) => ({
      id: s.id, type: s.type, amountSats: s.amount_sats, status: s.status, txid: s.txid,
      signatures: parse(s.signatures) || [], detail: parse(s.detail), occurredAt: s.occurred_at,
    }));
  const dispute = getDisputeByOrder(order.id);
  const notifications = listNotifications(order.id).map((n) => ({ id: n.id, audience: n.audience, kind: n.kind, body: n.body, createdAt: n.created_at }));

  return {
    id: order.id,
    ref: order.ref,
    itemDescription: order.item_description,
    amountSats: order.amount_sats,
    state: order.state,
    stateLabel: STATE_LABELS[order.state] || order.state,
    bitcoinNetwork: config.bitcoin.network,
    escrow: escrow ? { address: escrow.address, network: escrow.network, arbitratorPubkey: escrow.arbitrator_pubkey } : null,
    participants,
    dispatchReference: order.dispatch_reference,
    reviewWindowExpiresAt: order.review_window_expires_at,
    releasedAt: order.released_at,
    refundedAt: order.refunded_at,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    transactionLink: `${config.appBaseUrl}/t/${order.ref}`,
    evidence,
    assessments,
    settlements,
    notifications,
    dispute: dispute ? {
      id: dispute.id, openedBy: dispute.opened_by, category: dispute.category, reason: dispute.reason,
      sellerResponse: dispute.seller_response, state: dispute.state,
      arbitratorDecision: dispute.arbitrator_decision, resolutionNote: dispute.resolution_note,
      aiComparison: parse(dispute.ai_comparison), createdAt: dispute.created_at,
    } : null,
  };
}

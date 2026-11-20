import crypto from 'node:crypto';
import { db, now } from '../db.js';
import { config, bitcoinLive, reviewWindowMs } from '../config.js';
import { uid, orderRef } from '../lib/ids.js';
import { STATES, assertTransition, STATE_LABELS } from '../stateMachine.js';
import { sendNotification, listNotifications } from '../lib/notify.js';
import { hashUploadedFile, sniffFileType, removeUpload } from '../lib/upload.js';
import * as btc from '../lib/bitcoin.js';
import * as nostr from '../lib/nostr.js';
import { currentActor } from '../lib/context.js';
import { logError } from '../lib/log.js';

/* ─────────────────────────── helpers ─────────────────────────── */

const eventHash = (prev, e) => crypto.createHash('sha256')
  .update(JSON.stringify([prev || '', e.id, e.order_id, e.type, e.from_state, e.to_state, e.detail, e.created_at, e.actor]))
  .digest('hex');

/** Append-only, hash-chained audit event (FR-11). Each hash commits to the previous one and the actor. */
export function recordEvent(orderId, type, fromState, toState, detail) {
  const prev = db.prepare('SELECT hash FROM events WHERE order_id = ? ORDER BY rowid DESC LIMIT 1').get(orderId)?.hash || null;
  const e = {
    id: uid('evt'), order_id: orderId, type, from_state: fromState || null, to_state: toState || null,
    detail: detail ? JSON.stringify(detail) : null, created_at: now(), actor: currentActor(),
  };
  db.prepare(
    `INSERT INTO events (id, order_id, type, from_state, to_state, detail, created_at, actor, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.id, e.order_id, e.type, e.from_state, e.to_state, e.detail, e.created_at, e.actor, prev, eventHash(prev, e));
}

/** Public audit trail + chain verification. `valid:false` pinpoints the first broken link. */
export function getEventHistory(order) {
  const rows = db.prepare('SELECT * FROM events WHERE order_id = ? ORDER BY rowid ASC').all(order.id);
  let prev = null;
  let valid = true;
  let brokenAt = null;
  const events = rows.map((r) => {
    const ok = r.prev_hash === prev && r.hash === eventHash(prev, r);
    if (!ok && valid) { valid = false; brokenAt = r.id; }
    prev = r.hash;
    return { id: r.id, type: r.type, fromState: r.from_state, toState: r.to_state, detail: parse(r.detail), actor: r.actor, createdAt: r.created_at, prevHash: r.prev_hash, hash: r.hash };
  });
  return { orderRef: order.ref, valid, brokenAt, headHash: prev, events };
}

function setState(order, toState, detail) {
  assertTransition(order.state, toState);
  db.prepare('UPDATE orders SET state = ?, updated_at = ? WHERE id = ?').run(toState, now(), order.id);
  recordEvent(order.id, 'TRANSITION', order.state, toState, detail);
  order.state = toState;
  return order;
}

/** Canonical hash of the agreed terms. Terms are immutable once accepted; a change = a new order/agreement. */
export function agreementHash(o) {
  return crypto.createHash('sha256').update(JSON.stringify([
    o.item_description, o.amount_sats, o.seller_pubkey, o.delivery_conditions || null,
    o.expected_delivery_at || null, o.dispute_terms || null,
  ])).digest('hex');
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
  if (existing && existing.status !== 'FAILED') return { settlement: existing, fresh: false };
  // A proposal that failed before anything was signed or broadcast is safe to rebuild.
  if (existing) db.prepare('DELETE FROM settlements WHERE id = ?').run(existing.id);

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

/** Pick the arbitrator for a new order: the requested one, else the least-loaded active arbitrator. */
export function pickArbitrator(preferredUserId) {
  if (preferredUserId) {
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'ARBITRATOR' AND status = 'ACTIVE' AND btc_pubkey IS NOT NULL").get(preferredUserId);
    if (!u) throw httpError(400, 'Requested arbitrator is not an active arbitrator');
    return u;
  }
  return db.prepare(
    `SELECT u.*, (SELECT COUNT(*) FROM orders o WHERE o.arbitrator_user_id = u.id
                    AND o.state NOT IN ('RELEASED','REFUNDED','SPLIT')) AS load
       FROM users u WHERE u.role = 'ARBITRATOR' AND u.status = 'ACTIVE' AND u.btc_pubkey IS NOT NULL
      ORDER BY load ASC, u.created_at ASC LIMIT 1`,
  ).get() || null;
}

/**
 * FR-01: seller creates a transaction. `input.sellerUserId` binds the seller side to an
 * authenticated user; an arbitrator is assigned now because their key is part of the escrow.
 *
 * SIMULATION mode: a fake escrow is minted immediately.
 * LIVE mode: a 2-of-3 escrow needs the buyer's key, so the order waits in CREATED until the
 * buyer joins (`joinAsBuyer`) — unless the caller already supplied `buyerPubkey` (service-level only).
 */
export async function createOrder(input) {
  const id = uid('ord');
  const ref = orderRef();
  const ts = now();

  const arbitrator = pickArbitrator(input.arbitratorUserId);
  if (bitcoinLive) {
    if (!input.sellerPayoutAddress || !btc.isValidAddress(input.sellerPayoutAddress)) {
      throw httpError(400, 'sellerPayoutAddress must be a valid address on the configured network');
    }
    btc.normalizePubkey(input.sellerPubkey, 'sellerPubkey');
    if (input.buyerPubkey) btc.normalizePubkey(input.buyerPubkey, 'buyerPubkey');
    if (input.buyerPubkey && !input.buyerPayoutAddress) throw httpError(400, 'buyerPayoutAddress is required with buyerPubkey');
    if (!arbitrator && !config.bitcoin.arbitratorPubkey) throw httpError(503, 'No arbitrator is available to assign to this order');
  }

  db.prepare(
    `INSERT INTO orders (
      id, ref, item_description, amount_sats, seller_pubkey, seller_name, buyer_pubkey,
      delivery_conditions, expected_delivery_at, dispute_terms,
      seller_user_id, arbitrator_user_id, invited_buyer_nostr,
      state, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, ref, input.itemDescription, input.amountSats, input.sellerPubkey, input.sellerName || null,
    input.buyerPubkey || null,
    input.deliveryConditions || null, input.expectedDeliveryAt || null, input.disputeTerms || null,
    input.sellerUserId || null, arbitrator?.id || null, input.invitedBuyerNostr?.toLowerCase() || null,
    STATES.CREATED, ts, ts,
  );
  recordEvent(id, 'CREATED', null, STATES.CREATED, { mode: bitcoinLive ? 'LIVE' : 'SIMULATION', arbitratorAssigned: Boolean(arbitrator) });
  recordEvent(id, 'AGREEMENT_ACCEPTED', null, null, { by: 'SELLER', agreementHash: agreementHash(getOrderById(id)) });

  addParticipant(id, 'SELLER', input.sellerPubkey, input.sellerPayoutAddress, input.sellerUserId);
  if (input.buyerPubkey) addParticipant(id, 'BUYER', input.buyerPubkey, input.buyerPayoutAddress, input.buyerUserId);

  if (!bitcoinLive || input.buyerPubkey) attachEscrow(getOrderById(id), ref);
  return getOrderById(id);
}

function addParticipant(orderId, role, pubkey, payoutAddress, userId) {
  const nostrPk = userId ? db.prepare('SELECT pubkey FROM users WHERE id = ?').get(userId)?.pubkey : null;
  db.prepare(
    `INSERT INTO participants (id, order_id, role, pubkey, nostr_pubkey, payout_address, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(uid('ptc'), orderId, role, pubkey, nostrPk || null, payoutAddress || null, userId || null, now());
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** The arbitrator's escrow key for this order: the assigned arbitrator's, else the configured fallback. */
function arbitratorKeyFor(order) {
  if (order.arbitrator_user_id) return db.prepare('SELECT btc_pubkey FROM users WHERE id = ?').get(order.arbitrator_user_id)?.btc_pubkey || null;
  return config.bitcoin.arbitratorPubkey || null;
}

/** Create the escrow row and move CREATED → AWAITING_FUNDING. */
function attachEscrow(order, ref) {
  const sellerPubkey = order.seller_pubkey;
  const buyerPubkey = order.buyer_pubkey;
  const arbitratorPubkey = arbitratorKeyFor(order);
  const escrow = bitcoinLive
    ? btc.createEscrow({ buyerPubkey, sellerPubkey, arbitratorPubkey })
    : simulatedEscrow(ref);

  if (bitcoinLive && db.prepare('SELECT 1 FROM escrows WHERE address = ?').get(escrow.address)) {
    // Same three keys as an earlier order → same address → funds from two orders would be
    // indistinguishable. Participants must use a fresh key per order (PRD §3.2).
    throw httpError(409, 'This key set was already used for another order. Use a fresh key per order.');
  }
  db.prepare(
    `INSERT INTO escrows (id, order_id, network, redeem_script, witness_script, address, buyer_pubkey, seller_pubkey, arbitrator_pubkey, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    uid('esc'), order.id, config.bitcoin.network, escrow.redeemScript || null, escrow.witnessScript || null,
    escrow.address, buyerPubkey || null, sellerPubkey, arbitratorPubkey || null, now(),
  );
  // Start watching the address on the chain backend; a failure here is retried lazily on first poll.
  if (bitcoinLive) Promise.resolve(btc.getChain().watch?.(escrow.address)).catch((e) => logError('[chain] watch failed:', e));
  recordEvent(order.id, 'ESCROW_GENERATED', null, null, { address: escrow.address, witnessScript: escrow.witnessScript || null });
  setState(order, STATES.AWAITING_FUNDING, { escrowAddress: escrow.address });
}

/** Buyer opens the link and joins: supplies their escrow key + payout address, which completes the escrow. */
export function joinAsBuyer(order, { buyerPubkey, buyerPayoutAddress, agreementHash: accepted, userId }) {
  // Live: the buyer's key is needed to build the escrow, so joining happens in CREATED.
  // Simulation: a placeholder escrow already exists, so the buyer can still join while awaiting funding.
  const joinable = bitcoinLive
    ? order.state === STATES.CREATED && !order.buyer_pubkey
    : [STATES.CREATED, STATES.AWAITING_FUNDING].includes(order.state) && !order.buyer_user_id;
  if (!joinable || order.buyer_user_id) throw httpError(409, 'This transaction already has a buyer');
  if (userId && userId === order.seller_user_id) throw httpError(403, 'The seller cannot be the buyer on their own transaction');
  if (userId && order.invited_buyer_nostr) {
    const me = db.prepare('SELECT pubkey FROM users WHERE id = ?').get(userId)?.pubkey;
    if (me !== order.invited_buyer_nostr) throw httpError(403, 'This transaction is reserved for a specific buyer');
  }
  // The buyer must accept exactly the terms the seller committed to.
  const expected = agreementHash(order);
  if (accepted ? accepted !== expected : bitcoinLive) {
    throw httpError(409, 'agreementHash must match the current agreement terms');
  }
  if (bitcoinLive) {
    btc.normalizePubkey(buyerPubkey, 'buyerPubkey');
    if (!buyerPayoutAddress || !btc.isValidAddress(buyerPayoutAddress)) throw httpError(400, 'buyerPayoutAddress must be a valid address on the configured network');
    if (buyerPubkey.toLowerCase() === order.seller_pubkey.toLowerCase()) throw httpError(400, 'Buyer and seller must use different keys');
  } else if (!buyerPubkey) {
    throw httpError(400, 'buyerPubkey is required');
  }
  const key = buyerPubkey.toLowerCase?.() ?? buyerPubkey;
  db.prepare('UPDATE orders SET buyer_pubkey = ?, buyer_user_id = ?, updated_at = ? WHERE id = ?').run(key, userId || null, now(), order.id);
  addParticipant(order.id, 'BUYER', key, buyerPayoutAddress, userId);
  const fresh = getOrderById(order.id);
  recordEvent(order.id, 'BUYER_JOINED', null, null, { buyerPubkey: key });
  recordEvent(order.id, 'AGREEMENT_ACCEPTED', null, null, { by: 'BUYER', agreementHash: expected });
  if (!getEscrowByOrderId(order.id)) attachEscrow(fresh, fresh.ref);
  return getOrderById(order.id);
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
 * FR-03: verify funding against the chain, never a frontend click. LIVE mode polls the
 * escrow address; the observation is stored as one idempotent `{orderId}-FUNDING` row whose
 * confirmations are refreshed on every poll, and the order only flips to FUNDED once the
 * output pays at least the agreed amount with `minConfirmations` confirmations.
 */
export async function checkFundingStatus(order) {
  if (order.state !== STATES.AWAITING_FUNDING) {
    return { order, matched: order.state !== STATES.CREATED };
  }
  const escrow = getEscrowByOrderId(order.id);
  if (!escrow) return { order, matched: false };

  let hit;
  if (bitcoinLive) {
    const status = await btc.getEscrowFundingStatus(escrow.address, { expectedSats: order.amount_sats });
    if (!status) return { order, matched: false };
    observeFunding(order, status);
    if (!status.sufficient) return { order, matched: false, observed: status };
    hit = { ...status, amountSats: status.confirmedSats };
  } else {
    hit = { txid: `sim-${order.id.slice(-10)}`, vout: 0, amountSats: order.amount_sats, confirmations: config.bitcoin.minConfirmations };
  }

  confirmFunding(order, hit);
  db.prepare("UPDATE amendments SET status = 'SUPERSEDED', decided_at = ? WHERE order_id = ? AND status = 'PROPOSED'").run(now(), order.id);
  setState(order, STATES.FUNDED, { txid: hit.txid, vout: hit.vout, amountSats: hit.amountSats, confirmations: hit.confirmations });
  sendNotification(order.id, 'SELLER', 'ESCROW_FUNDED',
    `Escrow funded for ${order.ref} (${hit.amountSats} sats, tx ${hit.txid}). Safe to dispatch "${order.item_description}".`);
  return { order: getOrderById(order.id), matched: true };
}

/** DEMO helper: mimic funding detection without a real Signet transaction. Simulation mode only. */
export async function simulateFunding(order) {
  if (bitcoinLive) throw httpError(403, 'Funding simulation is disabled in live mode — send Signet BTC to the escrow address');
  return checkFundingStatus({ ...order, state: STATES.AWAITING_FUNDING });
}

const FUNDING_KEY = (order) => `${order.id}-FUNDING`;

/** Upsert the pending funding observation; emits an event only when something new is seen. */
function observeFunding(order, status) {
  const key = FUNDING_KEY(order);
  const existing = db.prepare('SELECT * FROM transactions WHERE idempotency_key = ?').get(key);
  const detail = JSON.stringify({ sufficient: status.sufficient });
  if (!existing) {
    db.prepare(
      `INSERT INTO transactions (id, order_id, type, txid, vout, amount_sats, confirmations, idempotency_key, status, detail, occurred_at)
       VALUES (?, ?, 'FUNDING', ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
    ).run(uid('txn'), order.id, status.txid, status.vout, status.amountSats, status.confirmations, key, detail, now());
    recordEvent(order.id, 'FUNDING_DETECTED', null, null, { txid: status.txid, vout: status.vout, amountSats: status.amountSats, confirmations: status.confirmations, sufficient: status.sufficient });
    return;
  }
  if (existing.status === 'CONFIRMED') return;
  if (existing.txid !== status.txid || existing.confirmations !== status.confirmations || existing.amount_sats !== status.amountSats) {
    if (existing.txid !== status.txid) {
      recordEvent(order.id, 'FUNDING_REPLACED', null, null, { previous: existing.txid, current: status.txid });
    }
    db.prepare('UPDATE transactions SET txid = ?, vout = ?, amount_sats = ?, confirmations = ?, detail = ?, occurred_at = ? WHERE id = ?')
      .run(status.txid, status.vout, status.amountSats, status.confirmations, detail, now(), existing.id);
  }
}

function confirmFunding(order, hit) {
  const key = FUNDING_KEY(order);
  const existing = db.prepare('SELECT * FROM transactions WHERE idempotency_key = ?').get(key);
  if (existing) {
    db.prepare("UPDATE transactions SET txid = ?, vout = ?, amount_sats = ?, confirmations = ?, status = 'CONFIRMED', occurred_at = ? WHERE id = ?")
      .run(hit.txid, hit.vout ?? 0, hit.amountSats, hit.confirmations, now(), existing.id);
  } else {
    db.prepare(
      `INSERT INTO transactions (id, order_id, type, txid, vout, amount_sats, confirmations, idempotency_key, status, occurred_at)
       VALUES (?, ?, 'FUNDING', ?, ?, ?, ?, ?, 'CONFIRMED', ?)`,
    ).run(uid('txn'), order.id, hit.txid, hit.vout ?? 0, hit.amountSats, hit.confirmations, key, now());
  }
}

function getFundingTx(orderId) {
  return db.prepare("SELECT * FROM transactions WHERE order_id = ? AND type = 'FUNDING' AND status = 'CONFIRMED'").get(orderId);
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
 * Who may co-sign each kind of settlement (PRD §6.3). A raw 2-of-3 script accepts ANY two keys,
 * so this policy — enforced here and shown to signers — is what stops, say, buyer+seller from
 * releasing funds out from under an open dispute.
 */
export function signerPolicy(type, trigger) {
  if (trigger === 'SELLER_ACCEPT') return { allowed: ['BUYER', 'SELLER'], mustInclude: [] }; // seller conceded: refund
  if (trigger === 'BUYER_CONFIRM') return { allowed: ['BUYER', 'SELLER'], mustInclude: [] };
  if (type === 'RELEASE') return { allowed: ['SELLER', 'ARBITRATOR'], mustInclude: [] };
  if (type === 'REFUND') return { allowed: ['BUYER', 'ARBITRATOR'], mustInclude: [] };
  return { allowed: ['BUYER', 'SELLER', 'ARBITRATOR'], mustInclude: ['ARBITRATOR'] }; // SPLIT
}

/**
 * Propose a settlement (RELEASE/REFUND/SPLIT): builds the PSBT spending EVERY confirmed escrow
 * output (nothing is stranded) and moves the order to AWAITING_SIGNATURES. Idempotent per
 * order+type via the `{orderId}-{TYPE}` key. Nothing changes state until the PSBT exists, so a
 * failure (chain unreachable, dust split, …) leaves the order retryable.
 */
async function proposeSettlement(order, { type, amountSats, trigger, sellerShareBps }) {
  const key = `${order.id}-${type}`;
  const policy = signerPolicy(type, trigger);

  const { settlement } = await recordSettlement(order.id, type, amountSats, key, async () => {
    if (!bitcoinLive) {
      return { status: 'AWAITING_SIGNATURES', psbt: `sim-psbt-${type}-${order.id.slice(-8)}`, detail: { simulated: true, trigger, policy, sellerShareBps: sellerShareBps ?? null } };
    }
    const escrow = getEscrowByOrderId(order.id);
    const utxos = await btc.getSpendableUtxos(escrow.address);
    const total = utxos.reduce((n, u) => n + u.amountSats, 0);
    if (total < order.amount_sats) throw httpError(409, 'The escrow no longer holds the agreed amount on-chain (reorg or already spent)');

    const outputs = buildOutputsFor(order, type, total, utxos.length, sellerShareBps);
    const built = btc.buildSettlementPsbt({ escrow, utxos, outputs });
    return { status: 'AWAITING_SIGNATURES', psbt: built.base64, detail: { trigger, policy, outputs, feeSats: built.feeSats, inputCount: utxos.length, sellerShareBps: sellerShareBps ?? null } };
  });

  order.state = getOrderById(order.id).state; // a concurrent duplicate request may already have advanced it
  if ([STATES.DISPUTED, STATES.UNDER_REVIEW].includes(order.state)) setState(order, STATES.RESOLUTION_PROPOSED, { type, trigger });
  if ([STATES.REVIEW_PENDING, STATES.RESOLUTION_PROPOSED].includes(order.state)) {
    setState(order, STATES.AWAITING_SIGNATURES, { type, trigger });
  }
  recordEvent(order.id, 'PSBT_CREATED', null, null, { type, trigger, settlementId: settlement.id });
  for (const aud of ['SELLER', 'BUYER']) {
    sendNotification(order.id, aud, 'SETTLEMENT_PROPOSED',
      `${order.ref}: a ${type.toLowerCase()} settlement is awaiting signatures (trigger: ${trigger}).`);
  }
  return { order: getOrderById(order.id), settlement };
}

/** Settlement outputs for the escrow value minus the miner fee. The fee is borne by the receiving side(s). */
function buildOutputsFor(order, type, totalSats, inputCount, sellerShareBps) {
  const payout = (role) => {
    const p = listParticipants(order.id).find((x) => x.role === role);
    if (!p?.payout_address) throw httpError(409, `${role.toLowerCase()} payout address is missing`);
    return p.payout_address;
  };
  if (type === 'RELEASE') return [{ address: payout('SELLER'), amountSats: totalSats - btc.estimateFeeSats(1, undefined, inputCount) }];
  if (type === 'REFUND') return [{ address: payout('BUYER'), amountSats: totalSats - btc.estimateFeeSats(1, undefined, inputCount) }];
  const bps = sellerShareBps ?? 5000;
  if (!Number.isInteger(bps) || bps < 1 || bps > 9999) throw httpError(400, 'sellerShareBps must be an integer between 1 and 9999');
  const net = totalSats - btc.estimateFeeSats(2, undefined, inputCount);
  const seller = Math.floor((net * bps) / 10000);
  const buyer = net - seller;
  if (seller < 546 || buyer < 546) throw httpError(400, 'That split leaves one side below the dust limit; use RELEASE or REFUND instead');
  return [{ address: payout('SELLER'), amountSats: seller }, { address: payout('BUYER'), amountSats: buyer }];
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

/**
 * FR-07: the seller responds to a dispute.
 *   ACCEPT  → the seller concedes: a REFUND is proposed immediately, to be co-signed by buyer + seller.
 *   CONTEST → escalates to human arbitration.
 * Neither response moves Bitcoin by itself; funds only move when the PSBT is signed.
 */
export async function sellerRespondToDispute(order, { response }) {
  const dispute = getDisputeByOrder(order.id);
  if (!dispute || dispute.state === 'RESOLVED' || order.state !== STATES.DISPUTED) {
    throw httpError(409, 'No open dispute to respond to');
  }
  if (response === 'ACCEPT') {
    db.prepare('UPDATE disputes SET seller_response = ?, updated_at = ? WHERE id = ?').run('ACCEPT', now(), dispute.id);
    const result = await proposeSettlement(order, { type: 'REFUND', amountSats: order.amount_sats, trigger: 'SELLER_ACCEPT' });
    markDisputeResolved(order.id, 'REFUND', 'Seller accepted the buyer claim');
    sendNotification(order.id, 'BUYER', 'SELLER_ACCEPTED', `${order.ref}: the seller accepted your claim. A refund is awaiting signatures.`);
    return { order: result.order, dispute: getDisputeByOrder(order.id), settlement: result.settlement };
  }
  db.prepare('UPDATE disputes SET seller_response = ?, state = ?, updated_at = ? WHERE id = ?')
    .run('CONTEST', 'UNDER_REVIEW', now(), dispute.id);
  setState(order, STATES.UNDER_REVIEW, { sellerResponse: 'CONTEST' });
  sendNotification(order.id, 'BUYER', 'UNDER_REVIEW',
    `${order.ref}: the seller contested. An arbitrator will review both sides' evidence.`);
  return { order: getOrderById(order.id), dispute: getDisputeByOrder(order.id) };
}

/* ─────────────── arbitration (UNDER_REVIEW → RESOLUTION_PROPOSED → AWAITING_SIGNATURES) ─────────────── */

/**
 * FR-08: arbitrator proposes RELEASE | REFUND | SPLIT. For SPLIT, `sellerShareBps` (1–9999) sets the
 * seller's share in basis points (default 50/50). AI findings inform this but never decide it.
 */
export async function resolveByArbitrator(order, { decision, note, sellerShareBps }) {
  if (order.state !== STATES.UNDER_REVIEW) throw httpError(409, `${order.ref} is not under review`);
  if (!['RELEASE', 'REFUND', 'SPLIT'].includes(decision)) throw httpError(400, 'decision must be RELEASE | REFUND | SPLIT');
  if (decision === 'SPLIT' && sellerShareBps != null && (!Number.isInteger(sellerShareBps) || sellerShareBps < 1 || sellerShareBps > 9999)) {
    throw httpError(400, 'sellerShareBps must be an integer between 1 and 9999');
  }
  const result = await proposeSettlement(order, {
    type: decision, amountSats: order.amount_sats, trigger: 'ARBITRATOR',
    sellerShareBps: decision === 'SPLIT' ? (sellerShareBps ?? 5000) : undefined,
  });
  markDisputeResolved(order.id, decision, note);
  recordEvent(order.id, 'ARBITRATOR_DECISION', null, null, { decision, note: note || null, sellerShareBps: sellerShareBps ?? null });
  return result;
}

/* ─────────────── PSBT signing → broadcast (AWAITING_SIGNATURES → terminal) ─────────────── */

function roleOfPubkey(escrow, pubkey) {
  if (pubkey === escrow.buyer_pubkey) return 'BUYER';
  if (pubkey === escrow.seller_pubkey) return 'SELLER';
  if (pubkey === escrow.arbitrator_pubkey) return 'ARBITRATOR';
  return null;
}

function policySatisfied(policy, roles) {
  const distinct = new Set(roles);
  return distinct.size >= 2 && (policy.mustInclude || []).every((r) => distinct.has(r));
}

/**
 * FR-08/§6.3: a participant submits their *signed PSBT* for the pending settlement. We verify
 * it is the same transaction we proposed and that every signature is valid and from an
 * escrow key, enforce the role policy, and once 2 permitted roles have signed, finalize and
 * broadcast — exactly once. No private key ever reaches the backend (PRD §9).
 *
 * SIMULATION mode keeps the old `{signerPubkey, signature}` shape so the demo UI still works.
 */
export async function signSettlement(order, { type, signerPubkey, signature, psbt, actorRoles }) {
  const settlement = getSettlement(order.id, type);
  if (!settlement || ['BROADCASTING', 'BROADCAST'].includes(settlement.status) || settlement.status === 'FAILED') {
    throw httpError(409, 'No pending settlement of this type to sign');
  }

  if (!bitcoinLive) return signSimulated(order, settlement, type, signerPubkey);

  if (!psbt) throw httpError(400, 'psbt (base64, signed in your wallet) is required');
  const escrow = getEscrowByOrderId(order.id);
  const detail = parse(settlement.detail) || {};
  const policy = detail.policy || signerPolicy(type, detail.trigger);

  const merged = btc.mergeSignedPsbt({ storedBase64: settlement.psbt, submittedBase64: psbt, escrow });
  const roles = merged.signers.map((pk) => roleOfPubkey(escrow, pk));
  const bad = merged.signers.filter((_, i) => !policy.allowed.includes(roles[i]));
  if (bad.length) {
    throw httpError(403, `A ${type.toLowerCase()} settlement (${detail.trigger}) may only be signed by ${policy.allowed.join(' / ')}`);
  }

  const known = parse(settlement.signatures) || [];
  // The submitting user may only contribute signatures made by their OWN role's key — an
  // authenticated buyer cannot push in a PSBT signed by the arbitrator's key, and vice versa.
  if (actorRoles) {
    const foreign = merged.signers.some((pk, i) => !known.some((k) => k.pubkey === pk) && !actorRoles.has(roles[i]));
    if (foreign) throw httpError(403, 'You can only submit signatures made with your own key');
  }
  const signatures = merged.signers.map((pk, i) => {
    const prev = known.find((s) => s.pubkey === pk);
    return prev || { pubkey: pk, role: roles[i], signedAt: now() };
  });
  db.prepare('UPDATE settlements SET psbt = ?, signatures = ? WHERE id = ?').run(merged.base64, JSON.stringify(signatures), settlement.id);
  for (const sig of signatures.filter((s) => !known.some((k) => k.pubkey === s.pubkey))) {
    recordEvent(order.id, 'SETTLEMENT_SIGNED', null, null, { type, role: sig.role, pubkey: sig.pubkey });
  }

  if (!policySatisfied(policy, signatures.map((s) => s.role))) {
    return { order: getOrderById(order.id), settlement: getSettlement(order.id, type), broadcast: false };
  }

  // Claim the broadcast atomically: concurrent/duplicate requests lose this UPDATE and no-op.
  const claim = db.prepare("UPDATE settlements SET status = 'BROADCASTING' WHERE id = ? AND status IN ('AWAITING_SIGNATURES','PROPOSED')").run(settlement.id);
  if (claim.changes !== 1) {
    return { order: getOrderById(order.id), settlement: getSettlement(order.id, type), broadcast: false };
  }
  let result;
  try {
    result = await btc.broadcastSettlement({ psbt: merged.base64, preferKey: escrow.arbitrator_pubkey });
  } catch (err) {
    db.prepare("UPDATE settlements SET status = 'AWAITING_SIGNATURES' WHERE id = ?").run(settlement.id);
    recordEvent(order.id, 'BROADCAST_FAILED', null, null, { type, error: err.message });
    throw err;
  }
  db.prepare("UPDATE settlements SET status = 'BROADCAST', txid = ? WHERE id = ?").run(result.txid, settlement.id);
  recordSettlementTx(order, type, result.txid, settlement.amount_sats);
  finalizeSettlement(order, type, result.txid);
  return { order: getOrderById(order.id), settlement: getSettlement(order.id, type), broadcast: true };
}

function signSimulated(order, settlement, type, signerPubkey) {
  if (!signerPubkey) throw httpError(400, 'signerPubkey is required');
  const signatures = parse(settlement.signatures) || [];
  if (!signatures.some((s) => s.pubkey === signerPubkey)) signatures.push({ pubkey: signerPubkey, signedAt: now() });
  db.prepare('UPDATE settlements SET signatures = ? WHERE id = ?').run(JSON.stringify(signatures), settlement.id);
  if (signatures.length < 2) {
    return { order: getOrderById(order.id), settlement: getSettlement(order.id, type), broadcast: false };
  }
  const txid = `sim-txid-${settlement.id.slice(-10)}`;
  db.prepare("UPDATE settlements SET status = 'BROADCAST', txid = ? WHERE id = ?").run(txid, settlement.id);
  finalizeSettlement(order, type, txid);
  return { order: getOrderById(order.id), settlement: getSettlement(order.id, type), broadcast: true };
}

function recordSettlementTx(order, type, txid, amountSats) {
  const key = `${order.id}-${type}-SETTLEMENT`;
  if (db.prepare('SELECT 1 FROM transactions WHERE idempotency_key = ?').get(key)) return;
  db.prepare(
    `INSERT INTO transactions (id, order_id, type, txid, vout, amount_sats, confirmations, idempotency_key, status, occurred_at)
     VALUES (?, ?, 'SETTLEMENT', ?, NULL, ?, 0, ?, 'PENDING', ?)`,
  ).run(uid('txn'), order.id, txid, amountSats, key, now());
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

/* ─────────────── chain watcher (funding + settlement confirmations) ─────────────── */

/**
 * Poll the chain for (a) unfunded orders, (b) broadcast settlements still awaiting
 * confirmations, and (c) funded orders whose funding output has vanished (reorg). Every
 * write is idempotent so overlapping/duplicate sweeps are harmless.
 */
export async function runChainSweep() {
  if (!bitcoinLive) return { funded: [], confirmed: [], lost: [], dropped: [], orphans: [] };
  const out = { funded: [], confirmed: [], lost: [], dropped: [], orphans: [] };

  for (const order of db.prepare("SELECT * FROM orders WHERE state = 'AWAITING_FUNDING'").all()) {
    try {
      const r = await checkFundingStatus(order);
      if (r.matched) out.funded.push(order.ref);
    } catch (err) { logError(`[chain] funding check ${order.ref}:`, err); }
  }

  for (const t of db.prepare("SELECT * FROM transactions WHERE type = 'SETTLEMENT' AND status = 'PENDING'").all()) {
    try {
      const st = await btc.getTransactionStatus(t.txid);
      const detail = parse(t.detail) || {};
      if (st.confirmed && st.confirmations >= config.bitcoin.minConfirmations) {
        db.prepare("UPDATE transactions SET status = 'CONFIRMED', confirmations = ? WHERE id = ?").run(st.confirmations, t.id);
        recordEvent(t.order_id, 'SETTLEMENT_CONFIRMED', null, null, { txid: t.txid, confirmations: st.confirmations });
        out.confirmed.push(t.txid);
      } else if (!st.found && !detail.notFoundFlagged && now() - t.occurred_at > config.bitcoin.settlementDropMinutes * 60_000) {
        // Broadcast accepted but the tx vanished (evicted / replaced / reorged out): flag for humans.
        db.prepare('UPDATE transactions SET detail = ? WHERE id = ?').run(JSON.stringify({ ...detail, notFoundFlagged: true }), t.id);
        recordEvent(t.order_id, 'SETTLEMENT_NOT_FOUND', null, null, { txid: t.txid });
        out.dropped.push(t.txid);
      } else if (st.confirmations !== t.confirmations) {
        db.prepare('UPDATE transactions SET confirmations = ? WHERE id = ?').run(st.confirmations, t.id);
      }
    } catch (err) { logError(`[chain] settlement status ${t.txid}:`, err); }
  }

  const live = ['FUNDED', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'REVIEW_PENDING', 'DISPUTED', 'UNDER_REVIEW', 'RESOLUTION_PROPOSED', 'AWAITING_SIGNATURES'];
  for (const order of db.prepare(`SELECT * FROM orders WHERE state IN (${live.map(() => '?').join(',')})`).all(...live)) {
    try {
      const funding = getFundingTx(order.id);
      const escrow = getEscrowByOrderId(order.id);
      if (!funding || !escrow) continue;
      const hasSettlement = db.prepare("SELECT 1 FROM settlements WHERE order_id = ? AND status IN ('BROADCASTING','BROADCAST')").get(order.id);
      if (hasSettlement) continue;
      const status = await btc.getEscrowFundingStatus(escrow.address, { expectedSats: order.amount_sats });
      const present = Boolean(status?.sufficient);
      const last = db.prepare("SELECT type FROM events WHERE order_id = ? AND type IN ('FUNDING_LOST','FUNDING_RESTORED') ORDER BY created_at DESC, rowid DESC LIMIT 1").get(order.id);
      if (!present && last?.type !== 'FUNDING_LOST') {
        recordEvent(order.id, 'FUNDING_LOST', null, null, { txid: funding.txid });
        sendNotification(order.id, 'SELLER', 'FUNDING_LOST', `${order.ref}: the funding output is no longer visible on-chain (possible reorg). Do not ship until it reappears.`);
        out.lost.push(order.ref);
      } else if (present && last?.type === 'FUNDING_LOST') {
        recordEvent(order.id, 'FUNDING_RESTORED', null, null, { txid: funding.txid });
      }
    } catch (err) { logError(`[chain] funding presence ${order.ref}:`, err); }
  }

  // Deposits that land after a settlement was confirmed would otherwise sit unnoticed.
  const recent = now() - 7 * 24 * 3600_000;
  for (const order of db.prepare("SELECT * FROM orders WHERE state IN ('RELEASED','REFUNDED','SPLIT') AND updated_at > ?").all(recent)) {
    try {
      const confirmed = db.prepare("SELECT 1 FROM transactions WHERE order_id = ? AND type = 'SETTLEMENT' AND status = 'CONFIRMED'").get(order.id);
      const escrow = getEscrowByOrderId(order.id);
      if (!confirmed || !escrow) continue;
      for (const u of await btc.getChain().getUtxos(escrow.address)) {
        const seen = db.prepare("SELECT 1 FROM events WHERE order_id = ? AND type = 'ORPHAN_DEPOSIT' AND detail LIKE ?").get(order.id, `%${u.txid}%`);
        if (seen) continue;
        recordEvent(order.id, 'ORPHAN_DEPOSIT', null, null, { txid: u.txid, vout: u.vout, amountSats: u.value });
        out.orphans.push(u.txid);
      }
    } catch (err) { logError(`[chain] orphan check ${order.ref}:`, err); }
  }
  return out;
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

export function addEvidence({ orderId, side, storedFile, category, note, deviceCapturedAt, uploadedBy }) {
  const id = uid('ev');
  const sniffed = sniffFileType(storedFile);
  if (!sniffed) {
    removeUpload(storedFile);
    throw httpError(415, 'File content is not a valid jpeg/png/webp/gif image or PDF');
  }
  const mediaType = sniffed === 'application/pdf' ? 'document' : 'image';
  const sha256 = hashUploadedFile(storedFile);
  const device = Number.isFinite(Number(deviceCapturedAt)) && Number(deviceCapturedAt) > 0 ? Number(deviceCapturedAt) : null;
  db.prepare(
    `INSERT INTO evidence (id, order_id, side, category, media_type, stored_file, sha256, note, captured_at, device_captured_at, mime, uploaded_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, orderId, side, category || null, mediaType, storedFile, sha256, note || null, now(), device, sniffed, uploadedBy || null);
  recordEvent(orderId, 'EVIDENCE_SUBMITTED', null, null, { evidenceId: id, side, category: category || null, sha256, contentType: sniffed });
  return db.prepare('SELECT * FROM evidence WHERE id = ?').get(id);
}

/** FR-10/§9: recompute the hash from the stored original bytes and compare with the recorded one. */
export function getEvidence(orderId, evidenceId) {
  const ev = db.prepare('SELECT * FROM evidence WHERE id = ? AND order_id = ?').get(evidenceId, orderId);
  if (!ev) throw httpError(404, 'Evidence not found');
  return ev;
}

export function verifyEvidence(orderId, evidenceId) {
  const ev = db.prepare('SELECT * FROM evidence WHERE id = ? AND order_id = ?').get(evidenceId, orderId);
  if (!ev) throw httpError(404, 'Evidence not found');
  let recomputed = null;
  try { recomputed = hashUploadedFile(ev.stored_file); } catch { /* file missing */ }
  return {
    evidenceId: ev.id, recordedSha256: ev.sha256, recomputedSha256: recomputed,
    match: recomputed != null && recomputed === ev.sha256,
    serverReceivedAt: ev.captured_at,
    deviceCapturedAt: ev.device_captured_at, deviceCapturedAtVerified: false,
    note: 'A matching hash proves the file is unchanged since upload; it does not prove when or where the photo was taken.',
  };
}
export function listEvidence(orderId) {
  return db.prepare('SELECT * FROM evidence WHERE order_id = ? ORDER BY captured_at ASC').all(orderId);
}
export function latestSellerEvidence(orderId) {
  return db.prepare("SELECT * FROM evidence WHERE order_id = ? AND side = 'SELLER' AND media_type = 'image' ORDER BY captured_at DESC, rowid DESC LIMIT 1").get(orderId);
}
export function latestBuyerEvidence(orderId) {
  return db.prepare("SELECT * FROM evidence WHERE order_id = ? AND side = 'BUYER' AND media_type = 'image' ORDER BY captured_at DESC, rowid DESC LIMIT 1").get(orderId);
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

export function serializeOrder(order, viewer) {
  // viewer: Set of per-order roles. undefined => trusted internal caller (full view).
  if (viewer && viewer.size === 0) return serializePublic(order);
  const escrow = getEscrowByOrderId(order.id);
  const participants = listParticipants(order.id).map((p) => ({ role: p.role, pubkey: p.pubkey, nostrPubkey: p.nostr_pubkey, payoutAddress: p.payout_address }));
  const evidence = listEvidence(order.id).map((e) => ({
    id: e.id, side: e.side, category: e.category, mediaType: e.media_type,
    url: `/api/orders/${order.ref}/evidence/${e.id}/file`, mime: e.mime, sha256: e.sha256, note: e.note,
    capturedAt: e.captured_at, // server-received time (trusted)
    deviceCapturedAt: e.device_captured_at, deviceCapturedAtVerified: false, // claimed by the uploader, unverified
  }));
  const assessments = listAssessments(order.id).map((a) => ({
    id: a.id, evidenceId: a.evidence_id, available: Boolean(a.available), assessment: parse(a.assessment), createdAt: a.created_at,
  }));
  const settlements = db.prepare('SELECT * FROM settlements WHERE order_id = ? ORDER BY occurred_at ASC').all(order.id)
    .map((s) => {
      const detail = parse(s.detail);
      return {
        id: s.id, type: s.type, amountSats: s.amount_sats, status: s.status, txid: s.txid,
        psbt: s.psbt, // base64 in live mode — signers inspect `outputs` below, then sign in their wallet
        outputs: detail?.outputs || null, feeSats: detail?.feeSats ?? null,
        signerPolicy: detail?.policy || null, trigger: detail?.trigger || null,
        signatures: parse(s.signatures) || [], detail, occurredAt: s.occurred_at,
      };
    });
  const dispute = getDisputeByOrder(order.id);
  const notifications = listNotifications(order.id)
    .filter((n) => !viewer || viewer.has('ADMIN') || viewer.has(n.audience))
    .map((n) => ({ id: n.id, audience: n.audience, kind: n.kind, body: n.body, createdAt: n.created_at }));

  return {
    id: order.id,
    ref: order.ref,
    itemDescription: order.item_description,
    amountSats: order.amount_sats,
    state: order.state,
    stateLabel: STATE_LABELS[order.state] || order.state,
    bitcoinNetwork: config.bitcoin.network,
    bitcoinLive,
    escrow: escrow ? {
      address: escrow.address, network: escrow.network, arbitratorPubkey: escrow.arbitrator_pubkey,
      witnessScript: escrow.witness_script,
      pubkeys: { buyer: escrow.buyer_pubkey, seller: escrow.seller_pubkey, arbitrator: escrow.arbitrator_pubkey },
      verified: bitcoinLive ? btc.verifyEscrow(escrow).valid : null,
    } : null,
    participants,
    dispatchReference: order.dispatch_reference,
    reviewWindowExpiresAt: order.review_window_expires_at,
    releasedAt: order.released_at,
    refundedAt: order.refunded_at,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    transactionLink: `${config.appBaseUrl}/t/${order.ref}`,
    agreementHash: agreementHash(order),
    conversationTag: nostr.conversationTag(order.ref),
    nostrEvents: nostr.listEventReferences(order.id),
    amendments: listAmendments(order.id),
    roles: viewer ? [...viewer] : undefined,
    arbitratorAssigned: Boolean(order.arbitrator_user_id),
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

/* ─────────────── escrow verification + Nostr references ─────────────── */

export function verifyEscrowRecord(escrow) {
  return bitcoinLive ? btc.verifyEscrow(escrow) : { valid: null, simulated: true };
}

export function setNostrIdentity(order, role, nostrPubkey) {
  nostr.setParticipantNostrPubkey(order.id, role, nostrPubkey);
  recordEvent(order.id, 'NOSTR_IDENTITY_SET', null, null, { role, nostrPubkey: String(nostrPubkey).toLowerCase() });
}

export function addNostrRef(order, ref) {
  const r = nostr.recordEventReference({ orderId: order.id, ...ref });
  if (r.fresh) recordEvent(order.id, 'NOSTR_EVENT_REFERENCED', null, null, { eventId: r.reference.event_id, kind: r.reference.kind });
  return r;
}

export function listNostrRefs(order) {
  return nostr.listEventReferences(order.id);
}

/* ─────────────── agreement changes (FR-01) ─────────────── */

const EDITABLE = {
  itemDescription: 'item_description', amountSats: 'amount_sats', deliveryConditions: 'delivery_conditions',
  expectedDeliveryAt: 'expected_delivery_at', disputeTerms: 'dispute_terms',
};

function validateChanges(changes) {
  const clean = {};
  for (const [k, v] of Object.entries(changes || {})) {
    if (!(k in EDITABLE)) throw httpError(400, `Field "${k}" cannot be changed (allowed: ${Object.keys(EDITABLE).join(', ')})`);
    if (k === 'amountSats') {
      if (!Number.isInteger(v) || v <= 0) throw httpError(400, 'amountSats must be a positive integer');
    } else if (k === 'expectedDeliveryAt') {
      if (v != null && !Number.isFinite(Number(v))) throw httpError(400, 'expectedDeliveryAt must be a timestamp');
    } else if (k === 'itemDescription' && String(v).trim().length < 2) {
      throw httpError(400, 'itemDescription is required');
    }
    clean[k] = typeof v === 'string' ? v.trim() : v;
  }
  if (!Object.keys(clean).length) throw httpError(400, 'No changes supplied');
  return clean;
}

const withChanges = (order, changes) => {
  const next = { ...order };
  for (const [k, col] of Object.entries(EDITABLE)) if (k in changes) next[col] = changes[k];
  return next;
};

const hasFundingObserved = (orderId) => Boolean(db.prepare("SELECT 1 FROM transactions WHERE order_id = ? AND type = 'FUNDING'").get(orderId));

/** Before a buyer joins nothing is agreed yet, so the seller may simply edit the terms. */
export function editTerms(order, changes) {
  if (order.state !== STATES.CREATED || order.buyer_pubkey) throw httpError(409, 'Terms can only be edited before a buyer joins; propose an amendment instead');
  const clean = validateChanges(changes);
  const before = agreementHash(order);
  for (const [k, v] of Object.entries(clean)) db.prepare(`UPDATE orders SET ${EDITABLE[k]} = ?, updated_at = ? WHERE id = ?`).run(v, now(), order.id);
  const fresh = getOrderById(order.id);
  recordEvent(order.id, 'TERMS_EDITED', null, null, { fields: Object.keys(clean), previousHash: before, agreementHash: agreementHash(fresh) });
  recordEvent(order.id, 'AGREEMENT_ACCEPTED', null, null, { by: 'SELLER', agreementHash: agreementHash(fresh) });
  return fresh;
}

/** After the buyer accepted, changes need a new agreement the buyer explicitly accepts — and only before funding. */
export function proposeAmendment(order, { userId, changes }) {
  if (order.state !== STATES.AWAITING_FUNDING || hasFundingObserved(order.id)) {
    throw httpError(409, 'Terms are locked once funding has started');
  }
  const clean = validateChanges(changes);
  db.prepare("UPDATE amendments SET status = 'SUPERSEDED', decided_at = ? WHERE order_id = ? AND status = 'PROPOSED'").run(now(), order.id);
  const id = uid('amd');
  db.prepare('INSERT INTO amendments (id, order_id, proposed_by, changes, new_hash, status, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, order.id, userId, JSON.stringify(clean), agreementHash(withChanges(order, clean)), 'PROPOSED', now());
  recordEvent(order.id, 'AMENDMENT_PROPOSED', null, null, { amendmentId: id, fields: Object.keys(clean) });
  sendNotification(order.id, 'BUYER', 'AMENDMENT_PROPOSED', `${order.ref}: the seller proposed changes to the agreement. Review and accept or reject before funding.`);
  return db.prepare('SELECT * FROM amendments WHERE id = ?').get(id);
}

export function respondAmendment(order, { amendmentId, accept, agreementHash: acceptedHash }) {
  const a = db.prepare("SELECT * FROM amendments WHERE id = ? AND order_id = ? AND status = 'PROPOSED'").get(amendmentId, order.id);
  if (!a) throw httpError(404, 'No pending amendment with that id');
  if (!accept) {
    db.prepare("UPDATE amendments SET status = 'REJECTED', decided_at = ? WHERE id = ?").run(now(), a.id);
    recordEvent(order.id, 'AMENDMENT_REJECTED', null, null, { amendmentId: a.id });
    return { order, amendment: db.prepare('SELECT * FROM amendments WHERE id = ?').get(a.id) };
  }
  if (order.state !== STATES.AWAITING_FUNDING || hasFundingObserved(order.id)) throw httpError(409, 'Terms are locked once funding has started');
  if (acceptedHash !== a.new_hash) throw httpError(409, 'agreementHash must match the amended terms');
  const changes = JSON.parse(a.changes);
  const before = agreementHash(order);
  for (const [k, v] of Object.entries(changes)) db.prepare(`UPDATE orders SET ${EDITABLE[k]} = ?, updated_at = ? WHERE id = ?`).run(v, now(), order.id);
  db.prepare("UPDATE amendments SET status = 'ACCEPTED', decided_at = ? WHERE id = ?").run(now(), a.id);
  recordEvent(order.id, 'AMENDMENT_ACCEPTED', null, null, { amendmentId: a.id, previousHash: before, agreementHash: a.new_hash });
  return { order: getOrderById(order.id), amendment: db.prepare('SELECT * FROM amendments WHERE id = ?').get(a.id) };
}

export function listAmendments(orderId) {
  return db.prepare('SELECT * FROM amendments WHERE order_id = ? ORDER BY created_at ASC').all(orderId)
    .map((a) => ({ id: a.id, changes: parse(a.changes), agreementHash: a.new_hash, status: a.status, createdAt: a.created_at, decidedAt: a.decided_at }));
}

/* ─────────────── users' view of their transactions ─────────────── */

export function listOrdersForUser(userId, { role } = {}) {
  const cols = { SELLER: 'seller_user_id', BUYER: 'buyer_user_id', ARBITRATOR: 'arbitrator_user_id' };
  const where = role && cols[role] ? `${cols[role]} = ?` : 'seller_user_id = ? OR buyer_user_id = ? OR arbitrator_user_id = ?';
  const args = role && cols[role] ? [userId] : [userId, userId, userId];
  return db.prepare(`SELECT * FROM orders WHERE ${where} ORDER BY created_at DESC`).all(...args);
}

export function summarizeOrder(order, roles) {
  return {
    ref: order.ref, itemDescription: order.item_description, amountSats: order.amount_sats,
    state: order.state, stateLabel: STATE_LABELS[order.state] || order.state, roles: [...roles],
    createdAt: order.created_at, updatedAt: order.updated_at, transactionLink: `${config.appBaseUrl}/t/${order.ref}`,
  };
}

/** What anyone holding the link (even logged out) may see: the agreement and the escrow to verify. */
export function serializePublic(order) {
  const escrow = getEscrowByOrderId(order.id);
  const seller = listParticipants(order.id).find((p) => p.role === 'SELLER');
  return {
    view: 'PUBLIC',
    ref: order.ref, itemDescription: order.item_description, amountSats: order.amount_sats,
    deliveryConditions: order.delivery_conditions, expectedDeliveryAt: order.expected_delivery_at, disputeTerms: order.dispute_terms,
    sellerName: order.seller_name, state: order.state, stateLabel: STATE_LABELS[order.state] || order.state,
    bitcoinNetwork: config.bitcoin.network, bitcoinLive,
    agreementHash: agreementHash(order), openForBuyer: !order.buyer_user_id && !order.buyer_pubkey && (order.state === STATES.CREATED || (!bitcoinLive && order.state === STATES.AWAITING_FUNDING)),
    sellerNostrPubkey: seller?.nostr_pubkey || null,
    escrow: escrow ? { address: escrow.address, network: escrow.network } : null,
    createdAt: order.created_at,
  };
}

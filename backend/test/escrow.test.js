import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keys, chain, payoutAddress, signAs } from './helpers.js';
import * as btc from '../src/lib/bitcoin.js';
import * as svc from '../src/services/orderService.js';
import { db } from '../src/db.js';

import { newKey } from './helpers.js';
const K = { b: keys.buyer.pubkey, s: keys.seller.pubkey, a: keys.arbitrator.pubkey };

// Each order gets fresh buyer/seller keys (as a per-order wallet derivation would). The
// arbitrator key is the configured one. `keys.buyer/seller` always point at the latest order's keys.
async function freshOrder(amountSats = 100_000) {
  keys.buyer = newKey();
  keys.seller = newKey();
  K.b = keys.buyer.pubkey;
  K.s = keys.seller.pubkey;
  const order = await svc.createOrder({
    itemDescription: 'Test sneakers', amountSats,
    sellerPubkey: K.s, buyerPubkey: K.b,
    sellerPayoutAddress: payoutAddress(), buyerPayoutAddress: payoutAddress(),
  });
  return order;
}
const escrowOf = (o) => svc.getEscrowByOrderId(o.id);
const get = (o) => svc.getOrderById(o.id);

async function fundAndDeliver(order, amount = order.amount_sats) {
  chain.fund(escrowOf(order).address, amount, { confirmations: 1 });
  const r = await svc.checkFundingStatus(get(order));
  assert.equal(r.matched, true);
  svc.markDispatched(get(order), { dispatchReference: 'DHL123' });
  svc.reportDelivered(get(order));
  assert.equal(get(order).state, 'REVIEW_PENDING');
}

test('escrow address is deterministic, order-independent and independently verifiable', () => {
  const a = btc.createEscrow({ buyerPubkey: K.b, sellerPubkey: K.s, arbitratorPubkey: K.a });
  const b = btc.createEscrow({ buyerPubkey: K.s, sellerPubkey: K.a, arbitratorPubkey: K.b });
  assert.equal(a.address, b.address);
  assert.match(a.address, /^tb1q/);
  assert.equal(a.witnessScript.slice(0, 2), '52'); // OP_2
  assert.equal(a.witnessScript.slice(-4), '53ae'); // OP_3 OP_CHECKMULTISIG
});

test('escrow rejects bad / duplicate keys', () => {
  assert.throws(() => btc.createEscrow({ buyerPubkey: 'abcd', sellerPubkey: K.s, arbitratorPubkey: K.a }), /33-byte/);
  assert.throws(() => btc.createEscrow({ buyerPubkey: K.b, sellerPubkey: K.b, arbitratorPubkey: K.a }), /distinct/);
});

test('every order gets its own escrow and a verifiable stored record', async () => {
  const o1 = await freshOrder();
  const reused = { itemDescription: 'x', amountSats: 1000, sellerPubkey: K.s, buyerPubkey: K.b, sellerPayoutAddress: payoutAddress(), buyerPayoutAddress: payoutAddress() };
  await assert.rejects(() => svc.createOrder(reused), (e) => e.status === 409); // same keys → same address → refused
  const o2 = await freshOrder();
  assert.notEqual(escrowOf(o1).address, escrowOf(o2).address);
  assert.equal(o1.state, 'AWAITING_FUNDING');
  assert.equal(btc.verifyEscrow(escrowOf(o1)).valid, true);
  const tampered = { ...escrowOf(o1), seller_pubkey: K.a };
  assert.equal(btc.verifyEscrow(tampered).valid, false);
});

test('order waits in CREATED until the buyer joins, then escrow is minted', async () => {
  const fresh = { b: newKey().pubkey, s: newKey().pubkey };
  const order = await svc.createOrder({ itemDescription: 'Radio', amountSats: 50_000, sellerPubkey: fresh.s, sellerPayoutAddress: payoutAddress() });
  assert.equal(order.state, 'CREATED');
  assert.equal(escrowOf(order), undefined);
  const joined = svc.joinAsBuyer(order, { buyerPubkey: fresh.b, buyerPayoutAddress: payoutAddress(), agreementHash: svc.agreementHash(order) });
  assert.equal(joined.state, 'AWAITING_FUNDING');
  assert.ok(escrowOf(joined).address);
  assert.throws(() => svc.joinAsBuyer(get(order), { buyerPubkey: newKey().pubkey, buyerPayoutAddress: payoutAddress(), agreementHash: 'deadbeef' }), /already has a buyer/);
  assert.throws(() => svc.joinAsBuyer(get(order), { buyerPubkey: fresh.b, buyerPayoutAddress: payoutAddress() }), /already has a buyer/);
});

test('funding is only accepted from chain: underfunded and unconfirmed outputs do not fund', async () => {
  const order = await freshOrder(100_000);
  const addr = escrowOf(order).address;

  chain.fund(addr, 40_000, { confirmations: 1 });
  assert.equal((await svc.checkFundingStatus(get(order))).matched, false);
  assert.equal(get(order).state, 'AWAITING_FUNDING');

  const full = chain.fund(addr, 100_000, { confirmations: 0 }); // in mempool only
  assert.equal((await svc.checkFundingStatus(get(order))).matched, false);

  chain.mine(1);
  chain.utxos.get(addr).find((u) => u.txid === full.txid).height = chain.height;
  const r = await svc.checkFundingStatus(get(order));
  assert.equal(r.matched, true);
  assert.equal(get(order).state, 'FUNDED');
});

test('repeated funding observations create exactly one funding record', async () => {
  const order = await freshOrder();
  chain.fund(escrowOf(order).address, order.amount_sats);
  await svc.checkFundingStatus(get(order));
  await svc.checkFundingStatus(get(order));
  await svc.runChainSweep();
  const rows = db.prepare("SELECT * FROM transactions WHERE order_id = ? AND type = 'FUNDING'").all(order.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'CONFIRMED');
});

test('simulate-funding is refused in live mode', async () => {
  const order = await freshOrder();
  await assert.rejects(() => svc.simulateFunding(get(order)), /disabled in live mode/);
});

test('happy path: buyer confirms, buyer+seller sign, broadcast once, RELEASED', async () => {
  const order = await freshOrder(100_000);
  await fundAndDeliver(order);

  const { settlement } = await svc.buyerConfirm(get(order));
  assert.equal(get(order).state, 'AWAITING_SIGNATURES');
  const view = btc.inspectPsbt(settlement.psbt);
  assert.equal(view.outputs.length, 1);
  assert.equal(view.outputs[0].address, svc.listParticipants(order.id).find((p) => p.role === 'SELLER').payout_address);
  assert.ok(view.feeSats > 0 && view.feeSats < 1000);
  assert.equal(view.outputs[0].amountSats + view.feeSats, 100_000);

  // idempotent proposal
  const again = await svc.buyerConfirm({ ...get(order), state: 'REVIEW_PENDING' });
  assert.equal(again.settlement.id, settlement.id);

  let r = await svc.signSettlement(get(order), { type: 'RELEASE', psbt: signAs(settlement.psbt, 'buyer') });
  assert.equal(r.broadcast, false);
  assert.equal(get(order).state, 'AWAITING_SIGNATURES');

  r = await svc.signSettlement(get(order), { type: 'RELEASE', psbt: signAs(r.settlement.psbt, 'seller') });
  assert.equal(r.broadcast, true);
  assert.equal(get(order).state, 'RELEASED');
  assert.equal(chain.broadcasts.filter((t) => t === r.settlement.txid).length, 1);

  // Replay / duplicate sign cannot pay twice.
  await assert.rejects(() => svc.signSettlement(get(order), { type: 'RELEASE', psbt: signAs(settlement.psbt, 'seller') }), /No pending settlement/);
  assert.equal(chain.broadcasts.filter((t) => t === r.settlement.txid).length, 1);

  const stl = db.prepare("SELECT * FROM transactions WHERE order_id = ? AND type = 'SETTLEMENT'").all(order.id);
  assert.equal(stl.length, 1);
  chain.mine(1);
  const sweep = await svc.runChainSweep();
  assert.deepEqual(sweep.confirmed, [r.settlement.txid]);
});

test('concurrent final signatures broadcast exactly once', async () => {
  const order = await freshOrder();
  await fundAndDeliver(order);
  const { settlement } = await svc.buyerConfirm(get(order));
  const signedB = signAs(settlement.psbt, 'buyer');
  const signedS = signAs(settlement.psbt, 'seller');
  const before = chain.broadcasts.length;
  const results = await Promise.allSettled([
    svc.signSettlement(get(order), { type: 'RELEASE', psbt: signedB }),
    svc.signSettlement(get(order), { type: 'RELEASE', psbt: signedS }),
    svc.signSettlement(get(order), { type: 'RELEASE', psbt: signedS }),
  ]);
  assert.equal(chain.broadcasts.length - before, 1);
  assert.equal(get(order).state, 'RELEASED');
  assert.ok(results.some((r) => r.status === 'fulfilled'));
});

test('dispute path: buyer+seller cannot release; arbitrator+seller can', async () => {
  const order = await freshOrder(200_000);
  await fundAndDeliver(order);
  svc.openDispute(get(order), { category: 'WRONG_ITEM', reason: 'Not what I ordered' });
  svc.sellerRespondToDispute(get(order), { response: 'CONTEST' });
  const { settlement } = await svc.resolveByArbitrator(get(order), { decision: 'RELEASE', note: 'Evidence favours seller' });
  assert.equal(get(order).state, 'AWAITING_SIGNATURES');

  // buyer is not a permitted signer of an arbitrated RELEASE
  await assert.rejects(() => svc.signSettlement(get(order), { type: 'RELEASE', psbt: signAs(settlement.psbt, 'buyer') }), (e) => e.status === 403);
  // state untouched
  assert.equal(get(order).state, 'AWAITING_SIGNATURES');

  let r = await svc.signSettlement(get(order), { type: 'RELEASE', psbt: signAs(settlement.psbt, 'seller') });
  assert.equal(r.broadcast, false);
  r = await svc.signSettlement(get(order), { type: 'RELEASE', psbt: signAs(r.settlement.psbt, 'arbitrator') });
  assert.equal(r.broadcast, true);
  assert.equal(get(order).state, 'RELEASED');
});

test('arbitrated REFUND pays the buyer and needs buyer+arbitrator', async () => {
  const order = await freshOrder(150_000);
  await fundAndDeliver(order);
  svc.openDispute(get(order), { category: 'NOT_RECEIVED', reason: 'Never came' });
  svc.sellerRespondToDispute(get(order), { response: 'CONTEST' });
  const { settlement } = await svc.resolveByArbitrator(get(order), { decision: 'REFUND', note: 'ok' });
  const view = btc.inspectPsbt(settlement.psbt);
  assert.equal(view.outputs[0].address, svc.listParticipants(order.id).find((p) => p.role === 'BUYER').payout_address);
  await assert.rejects(() => svc.signSettlement(get(order), { type: 'REFUND', psbt: signAs(settlement.psbt, 'seller') }), (e) => e.status === 403);
  let r = await svc.signSettlement(get(order), { type: 'REFUND', psbt: signAs(settlement.psbt, 'buyer') });
  r = await svc.signSettlement(get(order), { type: 'REFUND', psbt: signAs(r.settlement.psbt, 'arbitrator') });
  assert.equal(get(order).state, 'REFUNDED');
});

test('split pays both parties and requires the arbitrator', async () => {
  const order = await freshOrder(300_000);
  await fundAndDeliver(order);
  svc.openDispute(get(order), { category: 'DAMAGED', reason: 'Cracked' });
  svc.sellerRespondToDispute(get(order), { response: 'CONTEST' });
  const { settlement } = await svc.resolveByArbitrator(get(order), { decision: 'SPLIT', note: 'half each' });
  const view = btc.inspectPsbt(settlement.psbt);
  assert.equal(view.outputs.length, 2);
  // buyer+seller alone must not be able to split without the arbitrator
  let r = await svc.signSettlement(get(order), { type: 'SPLIT', psbt: signAs(settlement.psbt, 'buyer') });
  r = await svc.signSettlement(get(order), { type: 'SPLIT', psbt: signAs(r.settlement.psbt, 'seller') });
  assert.equal(r.broadcast, false);
  assert.equal(get(order).state, 'AWAITING_SIGNATURES');
  r = await svc.signSettlement(get(order), { type: 'SPLIT', psbt: signAs(r.settlement.psbt, 'arbitrator') });
  assert.equal(r.broadcast, true);
  assert.equal(get(order).state, 'SPLIT');
});

test('tampered PSBT (changed outputs) is rejected', async () => {
  const order = await freshOrder(100_000);
  await fundAndDeliver(order);
  const { settlement } = await svc.buyerConfirm(get(order));

  const bitcoin = (await import('bitcoinjs-lib')).default;
  const net = bitcoin.networks.testnet;
  const evil = new bitcoin.Psbt({ network: net });
  const stored = bitcoin.Psbt.fromBase64(settlement.psbt, { network: net });
  evil.setVersion(2);
  evil.addInput({ hash: stored.txInputs[0].hash, index: stored.txInputs[0].index, witnessUtxo: stored.data.inputs[0].witnessUtxo, witnessScript: stored.data.inputs[0].witnessScript });
  evil.addOutput({ address: payoutAddress(), value: 99_000 }); // attacker address
  evil.signInput(0, keys.buyer.kp);

  await assert.rejects(() => svc.signSettlement(get(order), { type: 'RELEASE', psbt: evil.toBase64() }), (e) => e.status === 409);
});

test('signature from a non-escrow key is rejected', async () => {
  const order = await freshOrder(100_000);
  await fundAndDeliver(order);
  const { settlement } = await svc.buyerConfirm(get(order));
  const bitcoin = (await import('bitcoinjs-lib')).default;
  const { newKey } = await import('./helpers.js');
  const stranger = newKey();
  const p = bitcoin.Psbt.fromBase64(settlement.psbt, { network: bitcoin.networks.testnet });
  const real = bitcoin.Psbt.fromBase64(signAs(settlement.psbt, 'buyer'), { network: bitcoin.networks.testnet });
  p.updateInput(0, { partialSig: [{ pubkey: Buffer.from(stranger.kp.publicKey), signature: real.data.inputs[0].partialSig[0].signature }] });
  await assert.rejects(() => svc.signSettlement(get(order), { type: 'RELEASE', psbt: p.toBase64() }));
});

test('failed broadcast leaves the settlement signable/retryable and funds untouched', async () => {
  const order = await freshOrder(100_000);
  await fundAndDeliver(order);
  const { settlement } = await svc.buyerConfirm(get(order));
  const orig = chain.broadcast.bind(chain);
  chain.broadcast = async () => { const e = new Error('node down'); e.status = 502; throw e; };
  let r = await svc.signSettlement(get(order), { type: 'RELEASE', psbt: signAs(settlement.psbt, 'buyer') });
  await assert.rejects(() => svc.signSettlement(get(order), { type: 'RELEASE', psbt: signAs(r.settlement.psbt, 'seller') }), /node down/);
  assert.equal(get(order).state, 'AWAITING_SIGNATURES');
  chain.broadcast = orig;
  const cur = svc.serializeOrder(get(order)).settlements[0];
  r = await svc.signSettlement(get(order), { type: 'RELEASE', psbt: cur.psbt });
  assert.equal(r.broadcast, true);
  assert.equal(get(order).state, 'RELEASED');
});

test('reorg: funded order whose output vanishes is flagged once, and restored later', async () => {
  const order = await freshOrder(100_000);
  const fund = chain.fund(escrowOf(order).address, 100_000);
  await svc.checkFundingStatus(get(order));
  chain.drop(escrowOf(order).address, fund.txid);
  let sweep = await svc.runChainSweep();
  assert.ok(sweep.lost.includes(order.ref));
  sweep = await svc.runChainSweep();
  assert.ok(!sweep.lost.includes(order.ref)); // deduped
  const evts = db.prepare("SELECT type FROM events WHERE order_id = ? AND type = 'FUNDING_LOST'").all(order.id);
  assert.equal(evts.length, 1);
});

test('PSBT outputs can be reviewed: fee is bounded', () => {
  const escrow = { ...escrowRow(), };
  assert.throws(() => btc.buildSettlementPsbt({
    escrow, utxo: { txid: '11'.repeat(32), vout: 0, amountSats: 100_000 },
    outputs: [{ address: payoutAddress(), amountSats: 50_000 }],
  }), /unreasonably high/);
});

function escrowRow() {
  const e = btc.createEscrow({ buyerPubkey: K.b, sellerPubkey: K.s, arbitratorPubkey: K.a });
  return { network: 'signet', witness_script: e.witnessScript, address: e.address, buyer_pubkey: K.b, seller_pubkey: K.s, arbitrator_pubkey: K.a };
}

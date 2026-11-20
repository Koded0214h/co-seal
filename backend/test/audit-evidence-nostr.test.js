import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { keys, chain, payoutAddress, newKey } from './helpers.js';
import * as svc from '../src/services/orderService.js';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';

async function order() {
  const b = newKey(), s = newKey();
  return svc.createOrder({
    itemDescription: 'Phone', amountSats: 80_000, sellerPubkey: s.pubkey, buyerPubkey: b.pubkey,
    sellerPayoutAddress: payoutAddress(), buyerPayoutAddress: payoutAddress(),
  });
}

test('audit history is hash-chained and verifies', async () => {
  const o = await order();
  chain.fund(svc.getEscrowByOrderId(o.id).address, 80_000);
  await svc.checkFundingStatus(svc.getOrderById(o.id));
  const h = svc.getEventHistory(o);
  assert.equal(h.valid, true);
  assert.ok(h.events.length >= 5);
  const types = h.events.map((e) => e.type);
  for (const t of ['CREATED', 'AGREEMENT_ACCEPTED', 'ESCROW_GENERATED', 'FUNDING_DETECTED', 'TRANSITION']) assert.ok(types.includes(t), t);
  assert.equal(h.events[1].prevHash, h.events[0].hash);
});

test('events are append-only at the database level', async () => {
  const o = await order();
  assert.throws(() => db.prepare("UPDATE events SET type = 'X' WHERE order_id = ?").run(o.id), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM events WHERE order_id = ?').run(o.id), /append-only/);
});

test('buyer must accept the exact agreement hash', async () => {
  const s = newKey(), b = newKey();
  const o = await svc.createOrder({ itemDescription: 'Lamp', amountSats: 20_000, sellerPubkey: s.pubkey, sellerPayoutAddress: payoutAddress() });
  assert.throws(() => svc.joinAsBuyer(o, { buyerPubkey: b.pubkey, buyerPayoutAddress: payoutAddress(), agreementHash: 'nope' }), /agreementHash/);
  assert.throws(() => svc.joinAsBuyer(o, { buyerPubkey: b.pubkey, buyerPayoutAddress: payoutAddress() }), /agreementHash/); // required in live mode
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function putFile(name, bytes) {
  fs.writeFileSync(path.join(config.paths.uploads, name), bytes);
  return name;
}

test('evidence hash is recomputable; tampering is detected; device time flagged unverified', async () => {
  const o = await order();
  const ev = svc.addEvidence({ orderId: o.id, side: 'SELLER', storedFile: putFile('a.png', PNG), category: 'dispatch', deviceCapturedAt: 1600000000000 });
  let v = svc.verifyEvidence(o.id, ev.id);
  assert.equal(v.match, true);
  assert.equal(v.deviceCapturedAtVerified, false);
  assert.ok(v.serverReceivedAt > 1700000000000);
  fs.appendFileSync(path.join(config.paths.uploads, 'a.png'), 'x');
  v = svc.verifyEvidence(o.id, ev.id);
  assert.equal(v.match, false);
});

test('non-image bytes are rejected even with an image mimetype/extension, and removed', async () => {
  const o = await order();
  const f = putFile('evil.png', Buffer.from('<?php echo 1; ?>'));
  assert.throws(() => svc.addEvidence({ orderId: o.id, side: 'BUYER', storedFile: f }), (e) => e.status === 415);
  assert.equal(fs.existsSync(path.join(config.paths.uploads, f)), false);
});

test('nostr: references are idempotent, validated, and signature-checked', async () => {
  const o = await order();
  const sk = generateSecretKey();
  const ev = finalizeEvent({ kind: 1059, created_at: Math.floor(Date.now() / 1000), tags: [['p', getPublicKey(sk)]], content: 'ciphertext' }, sk);

  const a = svc.addNostrRef(o, { event: ev, relay: 'wss://relay.damus.io' });
  assert.equal(a.fresh, true);
  assert.equal(svc.addNostrRef(o, { event: ev }).fresh, false);
  assert.equal(svc.listNostrRefs(o).length, 1);
  assert.equal(svc.listNostrRefs(o)[0].kind, 1059);

  assert.throws(() => svc.addNostrRef(o, { event: { ...ev, content: 'tampered' } }), /invalid/);
  assert.throws(() => svc.addNostrRef(o, { eventId: 'zz' }), /64 hex/);

  svc.setNostrIdentity(o, 'BUYER', getPublicKey(sk));
  assert.equal(svc.serializeOrder(svc.getOrderById(o.id)).participants.find((p) => p.role === 'BUYER').nostrPubkey, getPublicKey(sk));
  assert.match(svc.serializeOrder(o).conversationTag, /^coseal:/);
});

// Shared test setup: live-mode config against an in-memory chain and a throwaway DB.
// Must be imported BEFORE any src/ module so config reads these env vars.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as ecc from 'tiny-secp256k1';
import { ECPairFactory } from 'ecpair';

export const ECPair = ECPairFactory(ecc);

export function newKey() {
  const kp = ECPair.makeRandom();
  return { kp, pubkey: Buffer.from(kp.publicKey).toString('hex') };
}

export const keys = { buyer: newKey(), seller: newKey(), arbitrator: newKey() };

process.env.BITCOIN_LIVE = 'true';
process.env.BITCOIN_NETWORK = 'signet';
process.env.BITCOIN_MIN_CONFIRMATIONS = '1';
process.env.ARBITRATOR_PUBKEY = keys.arbitrator.pubkey;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `coseal-test-${randomBytes(4).toString('hex')}-`));

const { MemoryChain } = await import('../src/lib/chain.js');
const btc = await import('../src/lib/bitcoin.js');
export const chain = new MemoryChain();
btc.setChain(chain);

/** Real signet-format payout addresses derived from throwaway keys. */
import bitcoin from 'bitcoinjs-lib';
export function payoutAddress() {
  const { kp } = newKey();
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(kp.publicKey), network: bitcoin.networks.testnet }).address;
}

/** Sign a PSBT (base64) as `who`, exactly as a participant's wallet would, and return base64. */
export function signAs(psbtBase64, who) {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.testnet });
  psbt.signInput(0, keys[who].kp);
  return psbt.toBase64();
}

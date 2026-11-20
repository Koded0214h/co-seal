import bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { config } from '../config.js';
import { EsploraChain } from './chain.js';

/**
 * Bitcoin escrow + settlement — PRD §11, FR-02, FR-03, FR-08.
 *
 * Non-custodial by construction: this module builds scripts and *unsigned* PSBTs, validates
 * PSBTs that participants signed in their own wallets, combines them, and broadcasts. It never
 * receives or derives a private key (PRD §9).
 *
 * Escrow = P2WSH `2 <sorted pubkeys…> 3 OP_CHECKMULTISIG`. Keys are sorted (BIP-67 style) so
 * the address is a pure function of the three pubkeys — anyone can recompute and verify it
 * with `verifyEscrow`. Signet shares testnet address/WIF parameters (tb1…).
 */

// bitcoinjs calls validator(pubkey, msghash, signature); tiny-secp256k1 v2 wants (hash, pubkey, sig).
const validator = (pubkey, msghash, signature) => ecc.verify(msghash, pubkey, signature);

const POLICY_DUST_SATS = 546;
// vsize of a 1-input 2-of-3 P2WSH spend: ~11 overhead + 41 input + ~64 witness + 43 per output.
const VSIZE_BASE = 116;
const VSIZE_PER_OUTPUT = 43;

export function getNetwork(name = config.bitcoin.network) {
  switch (name) {
    case 'signet':
    case 'testnet':
      return bitcoin.networks.testnet;
    case 'regtest':
      return bitcoin.networks.regtest;
    default:
      // PRD §4: mainnet is an explicit non-goal for the MVP.
      throw new BitcoinError(`Unsupported network "${name}" (MVP supports signet/testnet/regtest only)`, 400);
  }
}

export class BitcoinError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'BitcoinError';
    this.status = status;
  }
}

let _chain = null;
export function getChain() {
  if (!_chain) _chain = new EsploraChain(config.bitcoin.esploraUrl);
  return _chain;
}
/** Swap the chain backend (tests, bitcoind adapter, demos). */
export function setChain(chain) {
  _chain = chain;
}

/* ───────────────────────── keys & escrow ───────────────────────── */

export function normalizePubkey(hex, label = 'pubkey') {
  const s = String(hex || '').trim().toLowerCase();
  if (!/^(02|03)[0-9a-f]{64}$/.test(s)) {
    throw new BitcoinError(`${label} must be a 33-byte compressed secp256k1 public key (66 hex chars)`, 400);
  }
  if (!ecc.isPoint(Buffer.from(s, 'hex'))) throw new BitcoinError(`${label} is not a valid curve point`, 400);
  return s;
}

export function sortedPubkeys(keys) {
  return [...keys].map((k) => Buffer.from(k, 'hex')).sort(Buffer.compare).map((b) => b.toString('hex'));
}

/** Build the order's isolated 2-of-3 P2WSH escrow. Returns { address, witnessScript, redeemScript, pubkeys }. */
export function createEscrow({ buyerPubkey, sellerPubkey, arbitratorPubkey = config.bitcoin.arbitratorPubkey, network } = {}) {
  const keys = [
    normalizePubkey(buyerPubkey, 'buyerPubkey'),
    normalizePubkey(sellerPubkey, 'sellerPubkey'),
    normalizePubkey(arbitratorPubkey, 'arbitratorPubkey'),
  ];
  if (new Set(keys).size !== 3) throw new BitcoinError('Buyer, seller and arbitrator must use three distinct keys', 400);

  const net = getNetwork(network);
  const p2ms = bitcoin.payments.p2ms({ m: 2, pubkeys: sortedPubkeys(keys).map((k) => Buffer.from(k, 'hex')), network: net });
  const p2wsh = bitcoin.payments.p2wsh({ redeem: p2ms, network: net });
  return {
    address: p2wsh.address,
    witnessScript: p2ms.output.toString('hex'),
    redeemScript: null, // native segwit: no P2SH redeem script
    pubkeys: keys,
  };
}

/** PRD §FR-02: anyone can recompute an escrow from the stored keys and compare. */
export function verifyEscrow(escrow) {
  try {
    const rebuilt = createEscrow({
      buyerPubkey: escrow.buyer_pubkey, sellerPubkey: escrow.seller_pubkey,
      arbitratorPubkey: escrow.arbitrator_pubkey, network: escrow.network,
    });
    return {
      valid: rebuilt.address === escrow.address && rebuilt.witnessScript === escrow.witness_script,
      expectedAddress: rebuilt.address,
    };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/* ───────────────────────── funding detection ───────────────────────── */

/**
 * FR-03. Look at the escrow address on-chain. Returns the best candidate funding output:
 *   { txid, vout, amountSats, confirmations, confirmed, sufficient }
 * or null if nothing is paid to the address. Confirmations are recomputed from the live tip
 * on every call, so a reorg that unconfirms/drops the output is visible on the next poll.
 */
export async function getEscrowFundingStatus(address, { expectedSats = 0 } = {}) {
  const chain = getChain();
  const [utxos, tip] = await Promise.all([chain.getUtxos(address), chain.getTipHeight()]);
  if (!utxos.length) return null;

  const withConf = utxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    amountSats: u.value,
    confirmed: u.confirmed,
    confirmations: u.confirmed && u.blockHeight != null ? Math.max(1, tip - u.blockHeight + 1) : 0,
    sufficient: u.value >= expectedSats,
  }));
  // Prefer a sufficient output, then the most-confirmed, then the largest.
  withConf.sort((a, b) =>
    Number(b.sufficient) - Number(a.sufficient) || b.confirmations - a.confirmations || b.amountSats - a.amountSats);
  return withConf[0];
}

/* ───────────────────────── PSBT build / inspect ───────────────────────── */

export function estimateFeeSats(outputCount, feeRate = config.bitcoin.feeRate) {
  return Math.ceil((VSIZE_BASE + VSIZE_PER_OUTPUT * outputCount) * feeRate);
}

/**
 * Build an unsigned PSBT spending the escrow UTXO to `outputs` ([{ address, amountSats }]).
 * Any difference between UTXO value and outputs is the miner fee; it is validated here so a
 * proposal can never silently burn funds to fees.
 */
export function buildSettlementPsbt({ escrow, utxo, outputs, network }) {
  const net = getNetwork(network || escrow.network);
  if (!outputs?.length) throw new BitcoinError('Settlement needs at least one output');

  const total = outputs.reduce((s, o) => s + o.amountSats, 0);
  const fee = utxo.amountSats - total;
  const maxFee = estimateFeeSats(outputs.length, Math.max(config.bitcoin.feeRate * 10, 20));
  if (fee < 0) throw new BitcoinError('Outputs exceed escrow value');
  if (fee > maxFee) throw new BitcoinError(`Fee ${fee} sats is unreasonably high (max ${maxFee})`);

  const witnessScript = Buffer.from(escrow.witness_script, 'hex');
  const psbt = new bitcoin.Psbt({ network: net });
  psbt.setVersion(2);
  psbt.addInput({
    hash: utxo.txid,
    index: utxo.vout,
    witnessUtxo: { script: bitcoin.payments.p2wsh({ redeem: { output: witnessScript, network: net }, network: net }).output, value: utxo.amountSats },
    witnessScript,
  });
  for (const o of outputs) {
    if (o.amountSats < POLICY_DUST_SATS) throw new BitcoinError(`Output of ${o.amountSats} sats is below dust`);
    psbt.addOutput({ address: o.address, value: o.amountSats });
  }
  return { base64: psbt.toBase64(), feeSats: fee };
}

/** Human-reviewable summary of a PSBT — what a signer must see before signing (PRD §9). */
export function inspectPsbt(base64, { network = config.bitcoin.network } = {}) {
  const net = getNetwork(network);
  const psbt = bitcoin.Psbt.fromBase64(base64, { network: net });
  const inValue = psbt.data.inputs.reduce((s, i) => s + (i.witnessUtxo?.value || 0), 0);
  const outputs = psbt.txOutputs.map((o) => ({ address: o.address, amountSats: o.value }));
  const outValue = outputs.reduce((s, o) => s + o.amountSats, 0);
  return {
    inputs: psbt.txInputs.map((i) => ({ txid: Buffer.from(i.hash).reverse().toString('hex'), vout: i.index })),
    outputs,
    feeSats: inValue - outValue,
    signers: psbt.data.inputs.flatMap((i) => (i.partialSig || []).map((p) => p.pubkey.toString('hex'))),
  };
}

/**
 * Merge a participant-signed PSBT into the stored proposal. Rejects anything that is not
 * byte-for-byte the same unsigned transaction (so a signer can't smuggle in different
 * outputs), any signature that does not verify, and signatures from keys outside the escrow.
 * Returns { base64, signers: [pubkeyHex…] } for the merged PSBT.
 */
export function mergeSignedPsbt({ storedBase64, submittedBase64, escrow }) {
  const net = getNetwork(escrow.network);
  let stored, submitted;
  try {
    stored = bitcoin.Psbt.fromBase64(storedBase64, { network: net });
    submitted = bitcoin.Psbt.fromBase64(submittedBase64, { network: net });
  } catch (err) {
    throw new BitcoinError(`Invalid PSBT: ${err.message}`);
  }

  if (!sameUnsignedTx(stored, submitted)) {
    throw new BitcoinError('Submitted PSBT does not match the proposed settlement (inputs/outputs differ)', 409);
  }

  const allowed = new Set([escrow.buyer_pubkey, escrow.seller_pubkey, escrow.arbitrator_pubkey]);
  for (const input of submitted.data.inputs) {
    for (const ps of input.partialSig || []) {
      const pk = ps.pubkey.toString('hex');
      if (!allowed.has(pk)) throw new BitcoinError(`Signature from unknown key ${pk}`, 403);
    }
  }
  try {
    if (!submitted.validateSignaturesOfInput(0, validator)) throw new Error('invalid signature');
  } catch (err) {
    throw new BitcoinError(`Signature verification failed: ${err.message}`, 400);
  }

  stored.combine(submitted);
  const signers = (stored.data.inputs[0].partialSig || []).map((p) => p.pubkey.toString('hex'));
  return { base64: stored.toBase64(), signers };
}

function sameUnsignedTx(a, b) {
  if (a.version !== b.version || a.locktime !== b.locktime) return false;
  if (a.txInputs.length !== b.txInputs.length || a.txOutputs.length !== b.txOutputs.length) return false;
  const ins = a.txInputs.every((i, n) =>
    Buffer.compare(i.hash, b.txInputs[n].hash) === 0 && i.index === b.txInputs[n].index && i.sequence === b.txInputs[n].sequence);
  const outs = a.txOutputs.every((o, n) =>
    Buffer.compare(o.script, b.txOutputs[n].script) === 0 && o.value === b.txOutputs[n].value);
  const utxo = Buffer.compare(a.data.inputs[0].witnessUtxo.script, b.data.inputs[0].witnessUtxo.script) === 0
    && a.data.inputs[0].witnessUtxo.value === b.data.inputs[0].witnessUtxo.value;
  return ins && outs && utxo;
}

/** Finalize a PSBT holding >= 2 valid signatures and return the raw tx. */
export function finalizeSettlementPsbt(base64, { network = config.bitcoin.network } = {}) {
  const psbt = bitcoin.Psbt.fromBase64(base64, { network: getNetwork(network) });
  if (!psbt.validateSignaturesOfInput(0, validator)) throw new BitcoinError('PSBT signatures invalid');
  // A 2-of-3 script rejects extra signatures. Keep exactly 2, preferring the arbitrator's when
  // present (SPLIT collects all three).
  const input = psbt.data.inputs[0];
  if ((input.partialSig || []).length > 2) {
    const arb = config.bitcoin.arbitratorPubkey;
    const sigs = [...input.partialSig].sort((a, b) => Number(b.pubkey.toString('hex') === arb) - Number(a.pubkey.toString('hex') === arb));
    input.partialSig = sigs.slice(0, 2);
  }
  try {
    psbt.finalizeAllInputs();
  } catch (err) {
    throw new BitcoinError(`Cannot finalize PSBT (need 2 signatures): ${err.message}`, 409);
  }
  const tx = psbt.extractTransaction();
  return { hex: tx.toHex(), txid: tx.getId() };
}

/** Finalize and broadcast. Safe to retry: an "already known" rejection resolves to the same txid. */
export async function broadcastSettlement({ psbt, network }) {
  const { hex, txid } = finalizeSettlementPsbt(psbt, { network });
  const chain = getChain();
  try {
    await chain.broadcast(hex, txid);
  } catch (err) {
    const msg = String(err.broadcastRejection || err.message || '');
    if (/already|known|duplicate|txn-already/i.test(msg)) return { txid, alreadyKnown: true };
    throw err;
  }
  return { txid, alreadyKnown: false };
}

export async function getTransactionStatus(txid) {
  const chain = getChain();
  const [s, tip] = await Promise.all([chain.getTxStatus(txid), chain.getTipHeight()]);
  return {
    found: s.found,
    confirmed: s.confirmed,
    confirmations: s.confirmed && s.blockHeight != null ? Math.max(1, tip - s.blockHeight + 1) : 0,
  };
}

export function isValidAddress(address, network = config.bitcoin.network) {
  try {
    bitcoin.address.toOutputScript(address, getNetwork(network));
    return true;
  } catch {
    return false;
  }
}

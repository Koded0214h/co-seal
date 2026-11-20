import { config } from '../config.js';

/**
 * Bitcoin escrow + settlement client — PRD §11 ("Technical architecture: Bitcoin") and
 * FR-02/FR-03/FR-08.
 *
 * NONE OF THIS IS IMPLEMENTED YET. Every export below is a stub that throws, kept only so
 * the state-machine-shaped service layer (orderService.js) has a stable interface to call
 * against while the real implementation lands. The ported LinkLock codebase gave each of
 * these calls a Monnify REST equivalent; here they need:
 *
 *   - A Bitcoin Core RPC client (or descriptor-wallet equivalent) against config.bitcoin.rpcUrl.
 *   - A P2WSH 2-of-3 multisig script builder (buyer pubkey, seller pubkey,
 *     config.bitcoin.arbitratorPubkey) — see createEscrow.
 *   - A funding watcher: poll the escrow address via RPC/Esplora for confirmed UTXOs,
 *     matching PRD §6.3's "funding verified according to the configured confirmation
 *     policy" (config.bitcoin.minConfirmations).
 *   - PSBT construction for release/refund/split spends out of the multisig UTXO, returned
 *     to the frontend for each required participant to inspect and sign (never signed
 *     server-side — PRD §9: "Bitcoin private keys must never be stored by the backend").
 *   - Broadcast of a fully-signed PSBT once the required signature threshold is met.
 *
 * Suggested libraries: bitcoinjs-lib + ecpair for script/PSBT construction, and either a
 * bitcoind RPC client or an Esplora-style indexer for funding/confirmation queries.
 */

class BitcoinNotImplementedError extends Error {
  constructor(fn) {
    super(`backend/src/lib/bitcoin.js: ${fn}() is not implemented — see file header for what's needed.`);
    this.name = 'BitcoinNotImplementedError';
    this.status = 501;
  }
}

/**
 * Build the order's isolated 2-of-3 P2WSH escrow script from buyer/seller pubkeys plus
 * the configured arbitrator pubkey. Returns { address, redeemScript, witnessScript }.
 */
export async function createEscrow({ buyerPubkey, sellerPubkey, arbitratorPubkey = config.bitcoin.arbitratorPubkey }) {
  throw new BitcoinNotImplementedError('createEscrow');
}

/** Poll the escrow address for a funding UTXO and its confirmation count. */
export async function getEscrowFundingStatus(escrowAddress) {
  throw new BitcoinNotImplementedError('getEscrowFundingStatus');
}

/**
 * Build an unsigned PSBT spending the escrow UTXO to one or more outputs (release / refund /
 * split), for the required signers to review and sign client-side.
 */
export async function buildSettlementPsbt({ order, escrow, outputs }) {
  throw new BitcoinNotImplementedError('buildSettlementPsbt');
}

/** Merge a participant's partial signature into a settlement's PSBT. */
export async function addSignatureToPsbt({ psbt, signerPubkey, signature }) {
  throw new BitcoinNotImplementedError('addSignatureToPsbt');
}

/** Finalize and broadcast a PSBT once the 2-of-3 signature threshold is satisfied. */
export async function broadcastSettlement({ psbt }) {
  throw new BitcoinNotImplementedError('broadcastSettlement');
}

export async function getTransactionStatus(txid) {
  throw new BitcoinNotImplementedError('getTransactionStatus');
}

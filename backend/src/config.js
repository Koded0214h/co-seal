import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');

const bool = (v, d = false) => (v == null ? d : /^(1|true|yes|on)$/i.test(String(v).trim()));
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 4000),
  appBaseUrl: (process.env.APP_BASE_URL || 'http://localhost:5173').replace(/\/$/, ''),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/$/, ''),

  paths: {
    root,
    data: dataDir,
    db: path.join(dataDir, 'coseal.db'),
    uploads: path.join(root, 'uploads'),
  },

  // PRD §11: Bitcoin Core RPC + Signet, order-specific P2WSH 2-of-3 multisig escrow.
  // TODO (payment rail — not implemented yet, see backend/src/lib/bitcoin.js): wire a real
  // bitcoind RPC client (or an Esplora/electrum-style indexer for funding detection) here.
  bitcoin: {
    network: (process.env.BITCOIN_NETWORK || 'signet').trim(), // signet only for the hackathon MVP
    // BITCOIN_LIVE=true switches off simulation: real P2WSH escrows, Esplora funding detection,
    // real PSBT signing + broadcast. Requires ARBITRATOR_PUBKEY.
    live: bool(process.env.BITCOIN_LIVE, false),
    esploraUrl: (process.env.BITCOIN_ESPLORA_URL || 'https://mempool.space/signet/api').replace(/\/$/, ''),
    feeRate: num(process.env.BITCOIN_FEE_RATE, 2), // sat/vB
    rpcUrl: (process.env.BITCOIN_RPC_URL || 'http://127.0.0.1:38332').replace(/\/$/, ''),
    rpcUser: process.env.BITCOIN_RPC_USER || '',
    rpcPassword: process.env.BITCOIN_RPC_PASSWORD || '',
    // Confirmations required before a funding tx flips an order AWAITING_FUNDING → FUNDED.
    minConfirmations: num(process.env.BITCOIN_MIN_CONFIRMATIONS, 1),
    // The arbitrator's own multisig pubkey — the third key in every order's 2-of-3 escrow.
    arbitratorPubkey: (process.env.ARBITRATOR_PUBKEY || '').trim(),
  },

  // PRD §11/FR-09: Nostr identity + NIP-17 private messaging between buyer and seller.
  // TODO (not implemented yet, see backend/src/lib/nostr.js): wire NDK + real relays.
  nostr: {
    relays: (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://nos.lol')
      .split(',').map((r) => r.trim()).filter(Boolean),
    // CoSeal's own service-side identity, used only to publish transaction-linked event
    // references/metadata — never to read or hold participants' private message content.
    servicePrivkey: process.env.NOSTR_SERVICE_PRIVKEY || '',
  },

  llm: {
    baseUrl: (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'qwen/qwen3.6-27b',
  },

  // PRD §6.4: there is deliberately no backend-timer default-release. A buyer who ghosts
  // after delivery escalates into arbitration once the review window lapses; a real
  // default-release needs a pre-agreed Bitcoin timelock script, not a server cron job.
  escrow: {
    reviewWindowHours: num(process.env.REVIEW_WINDOW_HOURS, 24),
    reviewWindowSeconds: num(process.env.REVIEW_WINDOW_SECONDS, 0),
  },

  adminToken: process.env.ADMIN_TOKEN || 'change-me-admin-token',
  demoMode: bool(process.env.DEMO_MODE, true),
};

/**
 * SIMULATION mode (default): fake escrow address / funding / txids so the state machine, AI
 * layer and arbitration flow can be demoed without a chain. BITCOIN_LIVE=true uses the real
 * Bitcoin path in lib/bitcoin.js.
 */
export const bitcoinLive = config.bitcoin.live;
if (bitcoinLive && !config.bitcoin.arbitratorPubkey) {
  throw new Error('BITCOIN_LIVE=true requires ARBITRATOR_PUBKEY (33-byte compressed hex)');
}

/** How long the buyer review window stays open, in milliseconds. */
export function reviewWindowMs() {
  if (config.escrow.reviewWindowSeconds > 0) {
    return config.escrow.reviewWindowSeconds * 1000;
  }
  return config.escrow.reviewWindowHours * 60 * 60 * 1000;
}

export function summarizeConfig() {
  return {
    env: config.env,
    port: config.port,
    bitcoinMode: bitcoinLive ? `LIVE (${config.bitcoin.network})` : 'SIMULATION (set BITCOIN_LIVE=true)',
    bitcoinNetwork: config.bitcoin.network,
    esplora: bitcoinLive ? config.bitcoin.esploraUrl : undefined,
    arbitratorPubkeyConfigured: Boolean(config.bitcoin.arbitratorPubkey),
    nostrRelays: config.nostr.relays,
    llmModel: config.llm.model,
    llmConfigured: Boolean(config.llm.apiKey),
    reviewWindow: config.escrow.reviewWindowSeconds > 0
      ? `${config.escrow.reviewWindowSeconds}s (demo override)`
      : `${config.escrow.reviewWindowHours}h`,
    demoMode: config.demoMode,
  };
}

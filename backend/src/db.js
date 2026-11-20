import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { config } from './config.js';

fs.mkdirSync(config.paths.data, { recursive: true });
fs.mkdirSync(config.paths.uploads, { recursive: true });

export const db = new DatabaseSync(config.paths.db);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Schema follows CoSeal PRD §10. Ten tables; `orders` stays the hub, everything else
// keys off order_id the same way LinkLock's schema did, so the idempotent-transaction
// and append-only-event patterns carry over unchanged — only the payment-rail-specific
// columns (escrow scripts, PSBTs, Nostr refs) are new.
db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id                   TEXT PRIMARY KEY,
  ref                  TEXT UNIQUE NOT NULL,          -- human ref, e.g. cs-order-893
  item_description     TEXT NOT NULL,
  amount_sats          INTEGER NOT NULL,
  buyer_pubkey         TEXT,                          -- Nostr pubkey (optional until buyer opens the link)
  seller_pubkey        TEXT,
  seller_name          TEXT,
  delivery_conditions  TEXT,
  expected_delivery_at INTEGER,
  dispute_terms        TEXT,
  state                TEXT NOT NULL DEFAULT 'CREATED',
  dispatch_reference   TEXT,
  review_window_expires_at INTEGER,
  released_at          INTEGER,
  refunded_at          INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_state ON orders(state);
CREATE INDEX IF NOT EXISTS idx_orders_window ON orders(review_window_expires_at);

-- Buyer / seller / arbitrator public-key references for one order (PRD §10, §6.3).
CREATE TABLE IF NOT EXISTS participants (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,                           -- BUYER | SELLER | ARBITRATOR
  pubkey     TEXT NOT NULL,                           -- Bitcoin pubkey used in the 2-of-3 multisig
  nostr_pubkey TEXT,                                  -- Nostr identity, if different
  payout_address TEXT,                                -- where this party is paid on settlement
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_participants_order ON participants(order_id);

-- The order's isolated 2-of-3 P2WSH escrow (PRD §6.3, FR-02). One row per order.
CREATE TABLE IF NOT EXISTS escrows (
  id              TEXT PRIMARY KEY,
  order_id        TEXT UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  network         TEXT NOT NULL DEFAULT 'signet',
  redeem_script   TEXT,                                -- hex
  witness_script  TEXT,                                -- hex
  address         TEXT UNIQUE,                         -- funding address; UNIQUE so two orders can never share an escrow
  buyer_pubkey    TEXT,
  seller_pubkey   TEXT,
  arbitrator_pubkey TEXT,
  created_at      INTEGER NOT NULL
);

-- Evidence: original file + its content hash (PRD §9 — hashes computed from original bytes).
CREATE TABLE IF NOT EXISTS evidence (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  side          TEXT NOT NULL,                          -- SELLER | BUYER
  category      TEXT,                                   -- dispatch photo | packaging | damage | fraud | ...
  media_type    TEXT NOT NULL DEFAULT 'image',
  stored_file   TEXT NOT NULL,                          -- filename under /uploads
  sha256        TEXT,                                   -- content hash of the original uploaded bytes
  note          TEXT,
  captured_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_order ON evidence(order_id);

-- AI findings, split out from evidence per PRD §10 (an assessment references evidence, it isn't the evidence).
CREATE TABLE IF NOT EXISTS assessments (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  evidence_id TEXT REFERENCES evidence(id) ON DELETE CASCADE,
  available   INTEGER NOT NULL DEFAULT 1,               -- 0 when the AI provider was unavailable
  assessment  TEXT,                                      -- JSON string, shape per PRD §8
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assessments_order ON assessments(order_id);

CREATE TABLE IF NOT EXISTS disputes (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  opened_by       TEXT NOT NULL DEFAULT 'BUYER',
  category        TEXT,
  reason          TEXT,
  seller_response TEXT,                                  -- ACCEPT | CONTEST | null
  ai_comparison   TEXT,                                   -- JSON string
  state           TEXT NOT NULL DEFAULT 'OPEN',           -- OPEN | UNDER_REVIEW | RESOLVED
  arbitrator_decision TEXT,                                -- RELEASE | REFUND | SPLIT | null
  resolution_note TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_disputes_order ON disputes(order_id);

-- Settlement proposals + PSBT lifecycle (PRD §6.3, §6.5, FR-08). idempotency_key is UNIQUE
-- so a duplicate settlement request / retried broadcast never produces a second payout.
CREATE TABLE IF NOT EXISTS settlements (
  id                TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type              TEXT NOT NULL,                       -- RELEASE | REFUND | SPLIT
  amount_sats       INTEGER NOT NULL,
  idempotency_key   TEXT UNIQUE NOT NULL,
  psbt              TEXT,                                -- base64 PSBT, updated as signatures are added
  signers_required  TEXT,                                -- JSON array of roles/pubkeys needed
  signatures        TEXT,                                -- JSON array of { pubkey, signedAt }
  status            TEXT NOT NULL,                        -- PROPOSED | AWAITING_SIGNATURES | SIGNED | BROADCAST | FAILED
  txid              TEXT,                                 -- broadcast transaction id, once known
  detail            TEXT,                                 -- JSON string
  occurred_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settlements_order ON settlements(order_id);

-- Bitcoin funding + settlement transaction observations (PRD §10, FR-03).
CREATE TABLE IF NOT EXISTS transactions (
  id                TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type              TEXT NOT NULL,                       -- FUNDING | SETTLEMENT
  txid              TEXT,
  vout              INTEGER,
  amount_sats       INTEGER,
  confirmations     INTEGER NOT NULL DEFAULT 0,
  idempotency_key   TEXT UNIQUE NOT NULL,
  status            TEXT NOT NULL,                        -- PENDING | CONFIRMED | FAILED
  detail            TEXT,                                 -- JSON string (raw observation)
  occurred_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txn_order ON transactions(order_id);

-- System-generated, in-app notifications (funding detected, dispute opened, settlement
-- broadcast, ...) — distinct from the private Nostr DMs between buyer and seller, which
-- CoSeal never stores the content of (see nostr_events below).
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  audience   TEXT NOT NULL,                              -- BUYER | SELLER | ARBITRATOR
  kind       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_order ON notifications(order_id);

-- Nostr event references only — CoSeal stores metadata, never the private message content
-- itself (PRD §9/FR-09: "store message references ... rather than ... the authoritative owner").
CREATE TABLE IF NOT EXISTS nostr_events (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_id    TEXT NOT NULL,                              -- the Nostr event id
  kind        INTEGER,
  author_pubkey TEXT,
  relay       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nostr_events_order ON nostr_events(order_id);

-- Append-only audit trail of every state transition and notable action (PRD §FR-11).
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  from_state TEXT,
  to_state   TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_order ON events(order_id);
`);

export function now() {
  return Date.now();
}

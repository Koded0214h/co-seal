import { verifyEvent } from 'nostr-tools/pure';
import { db, now } from '../db.js';
import { uid } from './ids.js';

/**
 * Nostr integration — PRD FR-09.
 *
 * Division of labour (PRD §9: the DB must not be the owner of private conversations):
 *   - Clients (browser, NIP-07 signer) author, encrypt and publish messages themselves using
 *     NIP-17 DMs (NIP-44 encryption inside NIP-59 gift wraps). The backend never sees keys or
 *     plaintext.
 *   - The backend stores only *references*: event id, kind, author, relay, timestamp, scoped to
 *     an order. That gives transaction-linked conversations, an audit pointer, and the
 *     arbitrator a list of "communication references relevant to the dispute".
 *
 * Linking convention: every message belonging to an order carries the tag
 *   ["t", conversationTag(ref)]   (and the gift-wrapped rumor carries it inside the encryption)
 * so a client can re-subscribe to its conversation from relays alone.
 */

export const conversationTag = (ref) => `coseal:${ref}`;

const HEX64 = /^[0-9a-f]{64}$/;
const err = (status, message) => Object.assign(new Error(message), { status });

/**
 * Record a reference to a Nostr event for an order. Idempotent per (order, eventId).
 * If the full signed `event` JSON is supplied, its id and signature are verified so a
 * reference can't be forged for an event that doesn't exist / wasn't signed by `authorPubkey`.
 * (Gift wraps are signed by throwaway keys, so the author is only checked when it's present.)
 */
export function recordEventReference({ orderId, eventId, kind, authorPubkey, relay, event }) {
  if (event) {
    // Strip symbol-keyed caches (nostr-tools memoises "verified" on the object) before verifying.
    event = JSON.parse(JSON.stringify(event));
    if (!verifyEvent(event)) throw err(400, 'Nostr event signature/id is invalid');
    eventId = event.id;
    kind = event.kind;
    authorPubkey = event.pubkey;
  }
  eventId = String(eventId || '').toLowerCase();
  if (!HEX64.test(eventId)) throw err(400, 'eventId must be 64 hex characters');
  if (authorPubkey && !HEX64.test(String(authorPubkey).toLowerCase())) throw err(400, 'authorPubkey must be a 64-hex Nostr pubkey');

  const existing = db.prepare('SELECT * FROM nostr_events WHERE order_id = ? AND event_id = ?').get(orderId, eventId);
  if (existing) return { reference: existing, fresh: false };

  const id = uid('nev');
  db.prepare(
    `INSERT INTO nostr_events (id, order_id, event_id, kind, author_pubkey, relay, created_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(id, orderId, eventId, Number.isInteger(kind) ? kind : null, authorPubkey?.toLowerCase() || null, relay || null, now());
  return { reference: db.prepare('SELECT * FROM nostr_events WHERE id = ?').get(id), fresh: true };
}

export function listEventReferences(orderId) {
  return db.prepare('SELECT * FROM nostr_events WHERE order_id = ? ORDER BY created_at ASC').all(orderId)
    .map((r) => ({ eventId: r.event_id, kind: r.kind, authorPubkey: r.author_pubkey, relay: r.relay, recordedAt: r.created_at }));
}

/** Set a participant's Nostr identity (so clients know whom to DM). */
export function setParticipantNostrPubkey(orderId, role, nostrPubkey) {
  const pk = String(nostrPubkey || '').toLowerCase();
  if (!HEX64.test(pk)) throw err(400, 'nostrPubkey must be a 64-hex (x-only) pubkey');
  const res = db.prepare('UPDATE participants SET nostr_pubkey = ? WHERE order_id = ? AND role = ?').run(pk, orderId, role);
  if (res.changes !== 1) throw err(404, `No ${role} participant on this order`);
}

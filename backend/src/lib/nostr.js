import { config } from '../config.js';

/**
 * Nostr identity + messaging client — PRD §11 ("Technical architecture: Nostr") and FR-09.
 *
 * NONE OF THIS IS IMPLEMENTED YET. Stubs only, same reasoning as lib/bitcoin.js. Real work
 * needed:
 *
 *   - A Nostr client (NDK — @nostr-dev-kit/ndk — or similar) connected to config.nostr.relays.
 *   - NIP-07 browser-signer integration on the frontend for buyer/seller identities; this
 *     backend module only needs to publish/subscribe to transaction-linked event metadata,
 *     never hold a participant's private key.
 *   - NIP-17 (private DMs, itself built on NIP-44 encryption + NIP-59 gift-wrapping) for the
 *     actual buyer↔seller conversation — the backend should record event ids/refs in the
 *     `nostr_events` table (see db.js) but never the decrypted message content, per PRD §9.
 *   - Transaction notifications (a seller pinged on dispute, a buyer pinged on delivery) can
 *     either ride the same relays as a kind-appropriate event, or stay as the in-app
 *     `notifications` table (lib/notify.js) does today — PRD §FR-09/P1 treats Nostr push as
 *     an additional channel, not a replacement for the in-app notification.
 */

class NostrNotImplementedError extends Error {
  constructor(fn) {
    super(`backend/src/lib/nostr.js: ${fn}() is not implemented — see file header for what's needed.`);
    this.name = 'NostrNotImplementedError';
    this.status = 501;
  }
}

/** Record a reference to a Nostr event relevant to this order (not its private content). */
export async function recordEventReference({ orderId, eventId, kind, authorPubkey, relay }) {
  throw new NostrNotImplementedError('recordEventReference');
}

/** Publish a transaction notification as a Nostr event (P1 — optional alongside in-app notify). */
export async function publishNotification({ toPubkey, orderRef, body }) {
  throw new NostrNotImplementedError('publishNotification');
}

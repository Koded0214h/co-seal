import { db, now } from '../db.js';
import { uid } from './ids.js';

/**
 * Records an in-app notification to a party (funding detected, dispute opened, settlement
 * broadcast, ...). This is distinct from the private Nostr DMs buyer/seller exchange with
 * each other (see lib/nostr.js) — CoSeal never owns the content of those, only references
 * to them. These notifications are CoSeal's own system messages, surfaced in the UI.
 */
export function sendNotification(orderId, audience, kind, body) {
  const row = { id: uid('ntf'), order_id: orderId, audience, kind, body, created_at: now() };
  db.prepare(
    `INSERT INTO notifications (id, order_id, audience, kind, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.order_id, row.audience, row.kind, row.body, row.created_at);
  return row;
}

export function listNotifications(orderId) {
  return db
    .prepare('SELECT * FROM notifications WHERE order_id = ? ORDER BY created_at ASC')
    .all(orderId);
}

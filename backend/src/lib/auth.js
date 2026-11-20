import crypto from 'node:crypto';
import { verifyEvent } from 'nostr-tools/pure';
import { db, now } from '../db.js';
import { config } from '../config.js';
import { uid } from './ids.js';
import { runWithActor } from './context.js';
import { normalizePubkey } from './bitcoin.js';

/**
 * Authentication + RBAC.
 *
 * Login is passwordless and account-free in the PRD sense: a user is a Nostr pubkey that proves
 * control by signing a one-time challenge (NIP-07 `signEvent` in the browser). Flow:
 *   1. POST /api/auth/challenge            -> { nonce, expiresAt }
 *   2. client signs a kind-22242 event with tags [["challenge", nonce]] (created_at ≈ now)
 *   3. POST /api/auth/login { event }      -> { token, user }
 * Tokens are opaque; only their SHA-256 is stored, so a DB leak does not leak sessions.
 *
 * Roles
 *   Global (users.role):  USER < ARBITRATOR < ADMIN
 *   Per order:            SELLER / BUYER / ARBITRATOR — derived from orders.*_user_id.
 */

export const AUTH_EVENT_KIND = 22242;
export const ROLES = ['USER', 'ARBITRATOR', 'ADMIN'];
const HEX64 = /^[0-9a-f]{64}$/;

const httpError = (status, message) => Object.assign(new Error(message), { status });
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createChallenge() {
  const nonce = crypto.randomBytes(24).toString('hex');
  const expiresAt = now() + config.auth.challengeTtlSeconds * 1000;
  db.prepare('INSERT INTO auth_challenges (nonce, expires_at) VALUES (?, ?)').run(nonce, expiresAt);
  db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').run(now() - 3600_000); // housekeeping
  return { nonce, expiresAt, kind: AUTH_EVENT_KIND, instructions: 'Sign an event of this kind with tags [["challenge", nonce]] and POST it to /api/auth/login' };
}

/** Verify a signed login event and open a session. Returns { token, expiresAt, user }. */
export function login(event, meta = {}) {
  if (!event || typeof event !== 'object') throw httpError(400, 'event is required');
  const clean = JSON.parse(JSON.stringify(event)); // strip nostr-tools' memoised symbols
  if (clean.kind !== AUTH_EVENT_KIND) throw httpError(400, `event kind must be ${AUTH_EVENT_KIND}`);
  if (!verifyEvent(clean)) throw httpError(401, 'Invalid event signature');
  if (Math.abs(Math.floor(now() / 1000) - clean.created_at) > config.auth.maxClockSkewSeconds) {
    throw httpError(401, 'Event timestamp outside the allowed window');
  }
  const nonce = clean.tags?.find((t) => t[0] === 'challenge')?.[1];
  if (!nonce) throw httpError(400, 'Missing challenge tag');

  // Atomic single-use: only one request can flip used_at from NULL.
  const claimed = db.prepare('UPDATE auth_challenges SET used_at = ? WHERE nonce = ? AND used_at IS NULL AND expires_at > ?')
    .run(now(), nonce, now());
  if (claimed.changes !== 1) throw httpError(401, 'Challenge unknown, expired or already used');

  const user = upsertUser(clean.pubkey);
  if (user.status !== 'ACTIVE') throw httpError(403, 'This account is suspended');
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), user.id);

  const token = `cs_${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = now() + config.auth.sessionTtlHours * 3600_000;
  db.prepare('INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?)')
    .run(uid('ses'), user.id, sha256(token), now(), expiresAt, meta.ip || null, (meta.userAgent || '').slice(0, 200) || null);
  return { token, expiresAt, user: publicUser(getUserById(user.id)) };
}

function upsertUser(pubkey) {
  if (!HEX64.test(pubkey)) throw httpError(400, 'Invalid pubkey');
  let user = db.prepare('SELECT * FROM users WHERE pubkey = ?').get(pubkey);
  const isBootstrapAdmin = config.auth.adminPubkeys.includes(pubkey);
  if (!user) {
    const id = uid('usr');
    db.prepare('INSERT INTO users (id, pubkey, role, status, created_at) VALUES (?,?,?,?,?)')
      .run(id, pubkey, isBootstrapAdmin ? 'ADMIN' : 'USER', 'ACTIVE', now());
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  } else if (isBootstrapAdmin && user.role !== 'ADMIN') {
    db.prepare("UPDATE users SET role = 'ADMIN' WHERE id = ?").run(user.id);
    user.role = 'ADMIN';
  }
  return user;
}

export function updateProfile(userId, { displayName, contactEmail }) {
  const name = displayName == null ? null : String(displayName).trim().slice(0, 80);
  const email = contactEmail == null ? null : String(contactEmail).trim().slice(0, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'contactEmail is not a valid email');
  db.prepare('UPDATE users SET display_name = COALESCE(?, display_name), contact_email = COALESCE(?, contact_email) WHERE id = ?').run(name, email, userId);
  return getUserById(userId);
}

export function logout(token) {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(now(), sha256(token));
}

export function revokeAllSessions(userId) {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now(), userId);
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
export function getUserByPubkey(pubkey) {
  return db.prepare('SELECT * FROM users WHERE pubkey = ?').get(String(pubkey || '').toLowerCase());
}

export const publicUser = (u) => u && ({
  id: u.id, pubkey: u.pubkey, displayName: u.display_name, contactEmail: u.contact_email,
  role: u.role, status: u.status, btcPubkey: u.btc_pubkey, createdAt: u.created_at, lastLoginAt: u.last_login_at,
});

function userFromToken(token) {
  const row = db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
  ).get(sha256(token), now());
  return row || null;
}

/* ───────────────────────── admin operations ───────────────────────── */

export function setUserRole(userId, role, { btcPubkey } = {}) {
  if (!ROLES.includes(role)) throw httpError(400, `role must be one of ${ROLES.join(', ')}`);
  const user = getUserById(userId);
  if (!user) throw httpError(404, 'User not found');
  let btc = user.btc_pubkey;
  if (role === 'ARBITRATOR') {
    if (btcPubkey) btc = normalizePubkey(btcPubkey, 'btcPubkey');
    if (!btc) throw httpError(400, 'btcPubkey is required to make a user an arbitrator (the key used in escrows)');
  }
  db.prepare('UPDATE users SET role = ?, btc_pubkey = ? WHERE id = ?').run(role, btc, userId);
  return getUserById(userId);
}

/** Admin pre-registers an arbitrator by Nostr identity (they need not have logged in yet). */
export function registerArbitrator({ nostrPubkey, btcPubkey, displayName }) {
  const pk = String(nostrPubkey || '').toLowerCase();
  if (!HEX64.test(pk)) throw httpError(400, 'nostrPubkey must be a 64-hex pubkey');
  const btc = normalizePubkey(btcPubkey, 'btcPubkey');
  const user = upsertUser(pk);
  db.prepare("UPDATE users SET role = 'ARBITRATOR', btc_pubkey = ?, display_name = COALESCE(?, display_name) WHERE id = ?")
    .run(btc, displayName || null, user.id);
  return getUserById(user.id);
}

export function userStats(userId) {
  const row = db.prepare(
    `SELECT
       SUM(CASE WHEN seller_user_id = ? THEN 1 ELSE 0 END) AS sold,
       SUM(CASE WHEN buyer_user_id = ? THEN 1 ELSE 0 END) AS bought,
       SUM(CASE WHEN arbitrator_user_id = ? THEN 1 ELSE 0 END) AS arbitrated,
       SUM(CASE WHEN seller_user_id = ? AND state = 'RELEASED' THEN amount_sats ELSE 0 END) AS soldVolumeSats,
       SUM(CASE WHEN buyer_user_id = ? AND state IN ('RELEASED','SPLIT') THEN amount_sats ELSE 0 END) AS boughtVolumeSats,
       SUM(CASE WHEN (seller_user_id = ? OR buyer_user_id = ?) AND state IN ('DISPUTED','UNDER_REVIEW','RESOLUTION_PROPOSED') THEN 1 ELSE 0 END) AS openDisputes
     FROM orders WHERE seller_user_id = ? OR buyer_user_id = ? OR arbitrator_user_id = ?`,
  ).get(...Array(9).fill(userId));
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v || 0]));
}

export function setUserStatus(userId, status) {
  if (!['ACTIVE', 'SUSPENDED'].includes(status)) throw httpError(400, 'status must be ACTIVE or SUSPENDED');
  const user = getUserById(userId);
  if (!user) throw httpError(404, 'User not found');
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
  if (status === 'SUSPENDED') revokeAllSessions(userId); // suspension takes effect immediately
  return getUserById(userId);
}

/* ───────────────────────── middleware ───────────────────────── */

/** Parses the bearer token (if any) into req.user. Never rejects by itself. */
export function authenticate(req, _res, next) {
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer\s+(\S+)$/i);
  req.token = m ? m[1] : null;
  req.user = req.token ? userFromToken(req.token) : null;
  if (req.user && req.user.status !== 'ACTIVE') req.user = null;
  // Everything downstream (audit events) can see who is acting.
  if (req.user) return runWithActor(req.user, () => next());
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

/** Global role gate. ADMIN satisfies every global role check. */
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.role === 'ADMIN' || roles.includes(req.user.role)) return next();
  res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
};

/**
 * Per-order roles for a user. If an order has no assigned arbitrator, an ADMIN acts as the
 * arbitrator-of-last-resort (but cannot sign — they hold no escrow key).
 */
export function orderRoles(order, user) {
  const roles = new Set();
  if (!user) return roles;
  if (order.seller_user_id === user.id) roles.add('SELLER');
  if (order.buyer_user_id === user.id) roles.add('BUYER');
  if (order.arbitrator_user_id === user.id) roles.add('ARBITRATOR');
  if (user.role === 'ADMIN') {
    roles.add('ADMIN');
    if (!order.arbitrator_user_id) roles.add('ARBITRATOR');
  }
  return roles;
}

/** Order-scoped gate (use after loadOrder). */
export const requireOrderRole = (...allowed) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const roles = orderRoles(req.order, req.user);
  req.orderRoles = roles;
  if (allowed.some((r) => roles.has(r))) return next();
  res.status(403).json({ error: `Requires ${allowed.join(' or ')} on this transaction` });
};

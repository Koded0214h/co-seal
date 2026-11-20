import { Router } from 'express';
import { db } from '../db.js';
import * as auth from '../lib/auth.js';
import * as svc from '../services/orderService.js';
import { ah, bad } from './helpers.js';

/** ADMIN-only: customer/user management and platform overview. */
export const adminRouter = Router();
adminRouter.use(auth.requireRole('ADMIN'));

adminRouter.get('/users', (req, res) => {
  const where = [];
  const args = [];
  if (req.query.role) { where.push('role = ?'); args.push(String(req.query.role).toUpperCase()); }
  if (req.query.status) { where.push('status = ?'); args.push(String(req.query.status).toUpperCase()); }
  if (req.query.q) { where.push('(pubkey LIKE ? OR display_name LIKE ? OR contact_email LIKE ?)'); const q = `%${String(req.query.q)}%`; args.push(q, q, q); }
  const rows = db.prepare(`SELECT * FROM users ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 500`).all(...args);
  res.json(rows.map((u) => ({ ...auth.publicUser(u), stats: auth.userStats(u.id) })));
});

adminRouter.get('/users/:id', (req, res) => {
  const user = auth.getUserById(req.params.id);
  if (!user) return bad(res, 'User not found', 404);
  res.json({
    user: auth.publicUser(user), stats: auth.userStats(user.id),
    orders: svc.listOrdersForUser(user.id).map((o) => svc.summarizeOrder(o, auth.orderRoles(o, user))),
    sessions: db.prepare('SELECT id, created_at, expires_at, revoked_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(user.id),
  });
});

adminRouter.patch('/users/:id', ah(async (req, res) => {
  const { role, btcPubkey, status } = req.body || {};
  if (req.params.id === req.user.id && ((role && role !== 'ADMIN') || status === 'SUSPENDED')) {
    return bad(res, 'You cannot demote or suspend yourself', 409);
  }
  let user = auth.getUserById(req.params.id);
  if (!user) return bad(res, 'User not found', 404);
  if (role) user = auth.setUserRole(user.id, String(role).toUpperCase(), { btcPubkey });
  if (status) user = auth.setUserStatus(user.id, String(status).toUpperCase());
  res.json({ user: auth.publicUser(user) });
}));

adminRouter.post('/arbitrators', ah(async (req, res) => {
  const user = auth.registerArbitrator({ nostrPubkey: req.body?.nostrPubkey, btcPubkey: req.body?.btcPubkey, displayName: req.body?.displayName });
  res.status(201).json({ user: auth.publicUser(user) });
}));

adminRouter.get('/orders', (req, res) => {
  const rows = req.query.state
    ? db.prepare('SELECT * FROM orders WHERE state = ? ORDER BY created_at DESC LIMIT 500').all(String(req.query.state).toUpperCase())
    : db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500').all();
  res.json(rows.map((o) => svc.summarizeOrder(o, auth.orderRoles(o, req.user))));
});

adminRouter.get('/stats', (_req, res) => {
  const byState = Object.fromEntries(db.prepare('SELECT state, COUNT(*) AS n FROM orders GROUP BY state').all().map((r) => [r.state, r.n]));
  const vol = db.prepare("SELECT COALESCE(SUM(amount_sats),0) AS v FROM orders WHERE state IN ('RELEASED','REFUNDED','SPLIT')").get().v;
  const users = db.prepare('SELECT role, COUNT(*) AS n FROM users GROUP BY role').all();
  res.json({
    orders: { total: Object.values(byState).reduce((a, b) => a + b, 0), byState },
    settledVolumeSats: vol,
    users: Object.fromEntries(users.map((r) => [r.role, r.n])),
  });
});

/** ARBITRATOR (or ADMIN): the cases assigned to me. */
export const arbitratorRouter = Router();
arbitratorRouter.use(auth.requireRole('ARBITRATOR'));

arbitratorRouter.get('/queue', (req, res) => {
  const open = "state IN ('DISPUTED','UNDER_REVIEW','RESOLUTION_PROPOSED','AWAITING_SIGNATURES')";
  const rows = req.user.role === 'ADMIN'
    ? db.prepare(`SELECT * FROM orders WHERE arbitrator_user_id IS NULL AND ${open} ORDER BY updated_at DESC`).all()
    : db.prepare(`SELECT * FROM orders WHERE arbitrator_user_id = ? AND ${open} ORDER BY updated_at DESC`).all(req.user.id);
  res.json(rows.map((o) => svc.summarizeOrder(o, auth.orderRoles(o, req.user))));
});

export default adminRouter;

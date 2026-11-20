import { Router } from 'express';
import * as auth from '../lib/auth.js';
import * as svc from '../services/orderService.js';
import { ah, bad } from './helpers.js';

const router = Router();

/* 1) get a one-time challenge  2) sign it (kind 22242, tag ["challenge", nonce])  3) log in */
router.post('/auth/challenge', (_req, res) => res.json(auth.createChallenge()));

router.post('/auth/login', ah(async (req, res) => {
  const result = auth.login(req.body?.event, { ip: req.ip, userAgent: req.get('user-agent') });
  res.json(result);
}));

router.post('/auth/logout', auth.requireAuth, (req, res) => {
  auth.logout(req.token);
  res.json({ ok: true });
});

/* The signed-in user's own profile + transactions (customer view). */
router.get('/me', auth.requireAuth, (req, res) => {
  res.json({ user: auth.publicUser(req.user), stats: auth.userStats(req.user.id) });
});

router.patch('/me', auth.requireAuth, (req, res) => {
  const user = auth.updateProfile(req.user.id, { displayName: req.body?.displayName, contactEmail: req.body?.contactEmail });
  res.json({ user: auth.publicUser(user) });
});

router.get('/me/orders', auth.requireAuth, (req, res) => {
  const role = req.query.role ? String(req.query.role).toUpperCase() : undefined;
  if (role && !['SELLER', 'BUYER', 'ARBITRATOR'].includes(role)) return bad(res, 'role must be SELLER | BUYER | ARBITRATOR');
  res.json(svc.listOrdersForUser(req.user.id, { role }).map((o) => svc.summarizeOrder(o, auth.orderRoles(o, req.user))));
});

export default router;

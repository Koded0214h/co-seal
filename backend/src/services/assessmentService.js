import path from 'node:path';
import { config } from '../config.js';
import * as ai from '../lib/ai.js';
import { registerPhash, findReuse, buildAssessment } from '../lib/assess.js';
import * as svc from './orderService.js';
import { logError } from '../lib/log.js';

/**
 * Glue between evidence, the AI provider and the deterministic reuse check. Everything here is
 * isolated from the transaction lifecycle: a failing provider yields an "unavailable"
 * assessment and the caller carries on (PRD §3.5, §8).
 */

const filePath = (ev) => path.join(config.paths.uploads, ev.stored_file);
const isImage = (ev) => ev.mime?.startsWith('image/');

async function safeAi(fn) {
  try {
    return await fn();
  } catch (err) {
    logError('[ai] provider call failed:', err);
    return { available: false, reason: 'AI_PROVIDER_UNAVAILABLE' };
  }
}

/** Perceptual hash + reuse lookup for each new image (never throws). */
async function reuseFor(evidences) {
  const out = new Map();
  for (const ev of evidences) {
    try {
      await registerPhash(ev);
      const fresh = svc.getEvidence(ev.order_id, ev.id);
      out.set(ev.id, findReuse(fresh));
    } catch (err) {
      logError('[assess] reuse check failed:', err);
    }
  }
  return out;
}

const mergeReuse = (map) => {
  const merged = { sameOrder: [], otherOrders: 0 };
  for (const r of map.values()) { merged.sameOrder.push(...r.sameOrder); merged.otherOrders += r.otherOrders; }
  return merged;
};

/** Seller dispatch proof. Returns the stored assessment (also persisted against the first image). */
export async function assessDispatch(order, evidences) {
  const images = evidences.filter(isImage);
  const primary = images[0] || evidences[0];
  const reuse = mergeReuse(await reuseFor(images));
  const raw = images.length
    ? await safeAi(() => ai.verifyDispatchProof({ filePath: filePath(images[0]), itemDescription: order.item_description }))
    : { available: false, reason: 'No image evidence to analyse' };
  const built = buildAssessment({ order, kind: 'dispatch', raw, evidence: primary, reuse });
  svc.addAssessment({ orderId: order.id, evidenceId: primary.id, assessment: built });
  return built;
}

/** Buyer dispute proof, compared with the seller's dispatch photo when there is one. */
export async function assessDispute(order, evidences, reason) {
  const images = evidences.filter(isImage);
  if (!images.length) return { assessment: null, comparison: null };
  const primary = images[0];
  const reuse = mergeReuse(await reuseFor(images));
  const sellerEv = svc.latestSellerEvidence(order.id);

  let raw; let kind; let comparison = null;
  if (sellerEv) {
    kind = 'dispute';
    raw = await safeAi(() => ai.analyzeDispute({
      dispatchFilePath: filePath(sellerEv), problemFilePath: filePath(primary),
      itemDescription: order.item_description, complaint: reason,
    }));
    if (raw.available) { comparison = raw.comparison; svc.saveDisputeAiComparison(order.id, comparison); }
  } else {
    kind = 'problem';
    raw = await safeAi(() => ai.verifyProblemProof({ filePath: filePath(primary), itemDescription: order.item_description, complaint: reason }));
  }
  const built = buildAssessment({ order, kind, raw, evidence: primary, reuse });
  const stored = { ...(raw.buyerProof || {}), ...built }; // keep legacy flat fields for the existing UI
  svc.addAssessment({ orderId: order.id, evidenceId: primary.id, assessment: stored });
  return { assessment: stored, comparison };
}

/** Extra evidence added later by either side. */
export async function assessAdditional(order, evidences) {
  const images = evidences.filter(isImage);
  if (!images.length) return null;
  const reuse = mergeReuse(await reuseFor(images));
  const built = buildAssessment({ order, kind: 'extra', raw: { available: false }, evidence: images[0], reuse });
  built.reason = 'NOT_REQUESTED';
  built.prd.reason = 'NOT_REQUESTED';
  svc.addAssessment({ orderId: order.id, evidenceId: images[0].id, assessment: built });
  return built;
}

/** Arbitrator re-run: compare the latest seller and buyer images. */
export async function recompare(order) {
  const sellerEv = svc.latestSellerEvidence(order.id);
  const buyerEv = svc.latestBuyerEvidence(order.id);
  if (!sellerEv || !buyerEv) return null;
  const comparison = await safeAi(() => ai.compareEvidence({
    dispatchFilePath: filePath(sellerEv), problemFilePath: filePath(buyerEv), itemDescription: order.item_description,
  }));
  svc.saveDisputeAiComparison(order.id, comparison);
  return comparison;
}

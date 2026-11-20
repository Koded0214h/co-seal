import path from 'node:path';
import { Jimp } from 'jimp';
import { db } from '../db.js';
import { config } from '../config.js';

/**
 * Evidence assessment — PRD §8 / FR-10.
 *
 * Two sources, both ADVISORY (`money_movement_authorized` is always false):
 *   1. Deterministic checks that never depend on a provider: perceptual-hash reuse detection
 *      against every photo previously submitted to CoSeal.
 *   2. The vision model (lib/ai.js), mapped into the PRD's structured finding format.
 *
 * Provider failure yields `{ available:false, reason:'AI_PROVIDER_UNAVAILABLE' }` and never
 * blocks submission, disputes or settlement.
 */

export const CATEGORIES = [
  'PRODUCT_MISMATCH', 'PACKAGING_INCONSISTENCY', 'SUSPICIOUS_OR_REUSED_PHOTO',
  'DISPATCH_EVIDENCE_INCONSISTENCY', 'DELIVERY_EVIDENCE_INCONSISTENCY',
  'INSUFFICIENT_EVIDENCE', 'CONTRADICTORY_CLAIMS',
];

const REUSE_MAX_HAMMING = 6; // of 64 bits

export async function computePhash(filePath) {
  try {
    const img = await Jimp.read(filePath);
    return img.hash(2); // 64-char binary string
  } catch {
    return null;
  }
}

export const hamming = (a, b) => {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
};

/** Compute + store the perceptual hash for an image evidence row. */
export async function registerPhash(evidence) {
  if (!evidence.mime?.startsWith('image/')) return null;
  const phash = await computePhash(path.join(config.paths.uploads, evidence.stored_file));
  if (phash) db.prepare('UPDATE evidence SET phash = ? WHERE id = ?').run(phash, evidence.id);
  return phash;
}

/**
 * Other photos (any order) that look like this one. Reveals counts only — never other orders'
 * refs or content — so one customer's evidence is not exposed to another.
 */
export function findReuse(evidence) {
  if (!evidence.phash) return { sameOrder: [], otherOrders: 0 };
  const rows = db.prepare('SELECT id, order_id, side, phash FROM evidence WHERE phash IS NOT NULL AND id != ?').all(evidence.id);
  const sameOrder = [];
  let otherOrders = 0;
  for (const r of rows) {
    if (hamming(evidence.phash, r.phash) > REUSE_MAX_HAMMING) continue;
    if (r.order_id === evidence.order_id) sameOrder.push({ evidenceId: r.id, side: r.side });
    else otherOrders++;
  }
  return { sameOrder, otherOrders };
}

function reuseFindings(evidence, reuse) {
  const out = [];
  if (reuse.otherOrders > 0) {
    out.push({
      category: 'SUSPICIOUS_OR_REUSED_PHOTO', severity: 'HIGH', evidenceId: evidence.id,
      description: `This photo is visually near-identical to ${reuse.otherOrders} photo(s) previously submitted on other CoSeal transactions.`,
    });
  }
  for (const m of reuse.sameOrder) {
    if (m.side !== evidence.side) {
      out.push({
        category: 'CONTRADICTORY_CLAIMS', severity: 'MEDIUM', evidenceId: evidence.id,
        description: `This ${evidence.side.toLowerCase()} photo is near-identical to a photo submitted by the ${m.side.toLowerCase()} on the same transaction.`,
      });
    } else {
      out.push({
        category: 'SUSPICIOUS_OR_REUSED_PHOTO', severity: 'LOW', evidenceId: evidence.id,
        description: 'The same photo was submitted more than once on this transaction.',
      });
    }
  }
  return out;
}

const LIMITATION = 'An exterior photo cannot establish what is physically inside a package.';

function aiFindings(kind, raw, evidenceId) {
  const f = [];
  const add = (category, severity, description) => f.push({ category, severity, description, evidenceId });
  if (kind === 'dispatch') {
    if (raw.matchesOrder === false) add('PRODUCT_MISMATCH', 'HIGH', raw.notes || 'The photographed item does not appear to match the order.');
    if (raw.reusedOrStockImage) add('SUSPICIOUS_OR_REUSED_PHOTO', 'HIGH', 'The photo looks like a stock/catalogue image or screenshot.');
    if (raw.tampering) add('SUSPICIOUS_OR_REUSED_PHOTO', 'HIGH', 'The photo shows signs of editing or manipulation.');
    if (raw.genuine === false && !raw.reusedOrStockImage) add('DISPATCH_EVIDENCE_INCONSISTENCY', 'MEDIUM', 'The photo does not look like a freshly taken dispatch photo.');
    if ((raw.confidence ?? 1) < 0.5) add('INSUFFICIENT_EVIDENCE', 'LOW', 'The model has low confidence in this assessment; the photo may be unclear.');
  } else if (kind === 'dispute') {
    const bp = raw.buyerProof || {};
    const cmp = raw.comparison || {};
    if (cmp.dispatchVsDelivered === 'MISMATCH') add('PRODUCT_MISMATCH', 'HIGH', cmp.notes || 'The delivered item appears different from what the seller dispatched.');
    if (cmp.dispatchVsDelivered === 'INCONCLUSIVE') add('INSUFFICIENT_EVIDENCE', 'LOW', cmp.notes || 'The two photos cannot be conclusively compared.');
    if (bp.reusedOrStockImage) add('SUSPICIOUS_OR_REUSED_PHOTO', 'HIGH', "The buyer's photo looks reused, downloaded or a screenshot.");
    if (bp.tampering) add('SUSPICIOUS_OR_REUSED_PHOTO', 'HIGH', "The buyer's photo shows signs of manipulation.");
    if (bp.problemVisible === false) add('DELIVERY_EVIDENCE_INCONSISTENCY', 'MEDIUM', "The claimed problem is not visible in the buyer's photo.");
  } else if (kind === 'problem') {
    if (raw.reusedOrStockImage) add('SUSPICIOUS_OR_REUSED_PHOTO', 'HIGH', 'The photo looks reused, downloaded or a screenshot.');
    if (raw.tampering) add('SUSPICIOUS_OR_REUSED_PHOTO', 'HIGH', 'The photo shows signs of manipulation.');
    if (raw.problemVisible === false) add('DELIVERY_EVIDENCE_INCONSISTENCY', 'MEDIUM', 'The claimed problem is not visible in the photo.');
  }
  return f;
}

const describeConfidence = (c) => (c == null ? 'Not reported' : c >= 0.8 ? 'High' : c >= 0.5 ? 'Moderate' : 'Low');

/**
 * Build the stored assessment. The legacy flat fields (genuine, passed, …) stay at the top level
 * for the existing UI; the PRD-shaped record is under `.prd`.
 *
 * @param kind  'dispatch' | 'problem' | 'dispute'
 * @param raw   result from lib/ai.js (may be { available:false, reason })
 */
export function buildAssessment({ order, kind, raw, evidence, reuse }) {
  const evidenceIds = Array.isArray(evidence) ? evidence.map((e) => e.id) : [evidence.id];
  const primary = Array.isArray(evidence) ? evidence[evidence.length - 1] : evidence;
  const available = Boolean(raw?.available);

  const findings = [
    ...reuseFindings(primary, reuse || { sameOrder: [], otherOrders: 0 }),
    ...(available ? aiFindings(kind, raw, primary.id) : []),
  ];
  const high = findings.some((f) => f.severity === 'HIGH');
  const humanReview = kind !== 'dispatch' || findings.length > 0 || !available;

  const prd = {
    transaction_id: order.ref,
    evidence_ids: evidenceIds,
    available,
    ...(available ? {} : { reason: 'AI_PROVIDER_UNAVAILABLE' }),
    assessment: !available && findings.length === 0 ? 'UNAVAILABLE' : findings.length ? 'REVIEW_REQUIRED' : 'CLEAR',
    findings,
    confidence_description: available
      ? `${describeConfidence(raw.confidence ?? raw.comparison?.confidence ?? raw.buyerProof?.confidence)} confidence. ${LIMITATION}`
      : `AI analysis was unavailable; only deterministic checks ran. ${LIMITATION}`,
    recommendation: humanReview || high ? 'HUMAN_REVIEW' : 'PROCEED',
    advisory_suggestion: raw?.comparison?.recommendation || raw?.recommendation || null, // never acted on automatically
    human_review_required: humanReview,
    money_movement_authorized: false,
    model: available ? config.llm.model : null,
  };

  const flagged = findings.some((f) => f.severity === 'HIGH');
  return {
    ...(raw || { available: false }),
    available,
    ...(available ? {} : { reason: 'AI_PROVIDER_UNAVAILABLE', providerReason: raw?.reason }),
    reuseDetected: reuse ? reuse.otherOrders > 0 || reuse.sameOrder.length > 0 : false,
    flagged,
    prd,
  };
}

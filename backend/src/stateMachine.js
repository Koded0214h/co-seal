/**
 * CoSeal transaction state machine (PRD §6).
 * Bitcoin only moves when the required participants sign a valid PSBT — this state
 * machine does not spend funds itself, it governs which settlement proposals are even
 * legal to make. No participant or backend service can jump a transaction into an
 * invalid state; a disputed/under-review transaction can only progress through the
 * resolution path.
 */

export const STATES = {
  CREATED: 'CREATED',
  AWAITING_FUNDING: 'AWAITING_FUNDING',
  FUNDED: 'FUNDED',
  DISPATCHED: 'DISPATCHED',
  IN_TRANSIT: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED',
  REVIEW_PENDING: 'REVIEW_PENDING',
  DISPUTED: 'DISPUTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  RESOLUTION_PROPOSED: 'RESOLUTION_PROPOSED',
  AWAITING_SIGNATURES: 'AWAITING_SIGNATURES',
  RELEASED: 'RELEASED',
  REFUNDED: 'REFUNDED',
  SPLIT: 'SPLIT',
};

export const TERMINAL = new Set([STATES.RELEASED, STATES.REFUNDED, STATES.SPLIT]);

// from -> allowed next states
const TRANSITIONS = {
  CREATED: [STATES.AWAITING_FUNDING],
  AWAITING_FUNDING: [STATES.FUNDED],
  FUNDED: [STATES.DISPATCHED],
  DISPATCHED: [STATES.IN_TRANSIT, STATES.DELIVERED], // IN_TRANSIT is optional (shipping-update milestone)
  IN_TRANSIT: [STATES.DELIVERED],
  DELIVERED: [STATES.REVIEW_PENDING],
  // confirm → release PSBT; dispute → freeze; review-window timeout → escalate straight to
  // arbitration (PRD §6.4: silence can't be allowed to hold the seller's money forever, but
  // a backend timer can't itself move Bitcoin, so it escalates into the same human-decision
  // path a contested dispute would, rather than auto-releasing).
  REVIEW_PENDING: [STATES.AWAITING_SIGNATURES, STATES.DISPUTED, STATES.UNDER_REVIEW],
  // Seller ACCEPT → straight to a proposed refund (FR-07); CONTEST → arbitration (UNDER_REVIEW).
  DISPUTED: [STATES.UNDER_REVIEW, STATES.RESOLUTION_PROPOSED],
  UNDER_REVIEW: [STATES.RESOLUTION_PROPOSED],
  RESOLUTION_PROPOSED: [STATES.AWAITING_SIGNATURES],
  AWAITING_SIGNATURES: [STATES.RELEASED, STATES.REFUNDED, STATES.SPLIT],
  RELEASED: [],
  REFUNDED: [],
  SPLIT: [],
};

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

export class TransitionError extends Error {
  constructor(from, to) {
    super(`Illegal state transition: ${from} → ${to}`);
    this.name = 'TransitionError';
    this.status = 409;
  }
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}

export const STATE_LABELS = {
  CREATED: 'Agreement created',
  AWAITING_FUNDING: 'Awaiting Bitcoin funding',
  FUNDED: 'Escrow funded & locked',
  DISPATCHED: 'Dispatched with proof',
  IN_TRANSIT: 'In transit',
  DELIVERED: 'Delivered',
  REVIEW_PENDING: 'Buyer review window open',
  DISPUTED: 'Disputed — settlement frozen',
  UNDER_REVIEW: 'Under arbitration',
  RESOLUTION_PROPOSED: 'Resolution proposed — awaiting acknowledgement',
  AWAITING_SIGNATURES: 'Awaiting PSBT signatures',
  RELEASED: 'Released to seller',
  REFUNDED: 'Refunded to buyer',
  SPLIT: 'Split resolution',
};

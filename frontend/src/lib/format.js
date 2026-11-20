export function sats(n) {
  const v = Number(n || 0);
  return v.toLocaleString('en-US') + ' sats';
}

export function btc(n) {
  const v = Number(n || 0) / 1e8;
  return `${v.toFixed(8)} BTC`;
}

export function shortPubkey(key) {
  if (!key) return '';
  return key.length <= 12 ? key : `${key.slice(0, 6)}…${key.slice(-6)}`;
}

const STATE_META = {
  CREATED: { tone: 'idle', label: 'Agreement created' },
  AWAITING_FUNDING: { tone: 'idle', label: 'Awaiting funding' },
  FUNDED: { tone: 'safe', label: 'Funded & locked' },
  DISPATCHED: { tone: 'safe', label: 'Dispatched with proof' },
  IN_TRANSIT: { tone: 'safe', label: 'In transit' },
  DELIVERED: { tone: 'safe', label: 'Delivered' },
  REVIEW_PENDING: { tone: 'review', label: 'Review window open' },
  DISPUTED: { tone: 'freeze', label: 'Disputed — frozen' },
  UNDER_REVIEW: { tone: 'review', label: 'Under arbitration' },
  RESOLUTION_PROPOSED: { tone: 'review', label: 'Resolution proposed' },
  AWAITING_SIGNATURES: { tone: 'review', label: 'Awaiting signatures' },
  RELEASED: { tone: 'safe', label: 'Released to seller' },
  REFUNDED: { tone: 'freeze', label: 'Refunded to buyer' },
  SPLIT: { tone: 'review', label: 'Split resolution' },
};

export function stateMeta(state) {
  return STATE_META[state] || { tone: 'idle', label: state };
}

export function countdown(ms) {
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function timeAgo(ts) {
  const d = Date.now() - ts;
  const s = Math.floor(d / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

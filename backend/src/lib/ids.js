import crypto from 'node:crypto';

export const uid = (prefix) => `${prefix}-${crypto.randomBytes(8).toString('hex')}`;

/** Short, human, chat-friendly order ref like "cs-8931". */
export function orderRef() {
  const n = 1000 + crypto.randomInt(0, 9000);
  return `cs-${n}`;
}

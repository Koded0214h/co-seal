import crypto from 'node:crypto';

export const uid = (prefix) => `${prefix}-${crypto.randomBytes(8).toString('hex')}`;

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (i l o 0 1)

/**
 * Order ref used in the shareable link: ~49 bits of randomness, so links cannot be enumerated
 * (the public agreement view is reachable by anyone holding the link).
 */
export function orderRef() {
  let out = '';
  for (let i = 0; i < 10; i++) out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return `cs-${out}`;
}

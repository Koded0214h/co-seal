import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context. The audit log (recordEvent) reads the current actor from here, so every
 * event is attributable to a user without threading a parameter through every service call.
 */
const als = new AsyncLocalStorage();

export const runWithActor = (actor, fn) => als.run({ actor }, fn);
export const currentActor = () => {
  const a = als.getStore()?.actor;
  return a ? `user:${a.id}:${a.role}` : 'system';
};

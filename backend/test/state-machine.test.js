import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES, assertTransition, canTransition } from '../src/stateMachine.js';

const ALL = Object.values(STATES);

test('terminal states have no exits', () => {
  for (const t of ['RELEASED', 'REFUNDED', 'SPLIT']) for (const to of ALL) assert.equal(canTransition(t, to), false, `${t}->${to}`);
});

test('disputed / under-review orders can never jump to release states or back to the happy path', () => {
  for (const from of ['DISPUTED', 'UNDER_REVIEW']) {
    for (const to of ['RELEASED', 'REFUNDED', 'SPLIT', 'AWAITING_SIGNATURES', 'FUNDED', 'DISPATCHED', 'REVIEW_PENDING']) {
      assert.equal(canTransition(from, to), false, `${from}->${to}`);
    }
  }
});

test('no state can skip funding', () => {
  assert.equal(canTransition('CREATED', 'FUNDED'), false);
  assert.equal(canTransition('AWAITING_FUNDING', 'DISPATCHED'), false);
  assert.throws(() => assertTransition('CREATED', 'RELEASED'));
});

test('happy path and dispute path are legal', () => {
  const path = ['CREATED', 'AWAITING_FUNDING', 'FUNDED', 'DISPATCHED', 'DELIVERED', 'REVIEW_PENDING', 'AWAITING_SIGNATURES', 'RELEASED'];
  for (let i = 0; i < path.length - 1; i++) assert.equal(canTransition(path[i], path[i + 1]), true, `${path[i]}->${path[i + 1]}`);
  const dispute = ['REVIEW_PENDING', 'DISPUTED', 'UNDER_REVIEW', 'RESOLUTION_PROPOSED', 'AWAITING_SIGNATURES', 'REFUNDED'];
  for (let i = 0; i < dispute.length - 1; i++) assert.equal(canTransition(dispute[i], dispute[i + 1]), true, `${dispute[i]}->${dispute[i + 1]}`);
});

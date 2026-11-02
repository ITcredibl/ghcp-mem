import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition,
  defaultLifecycleForBranch,
  isBranchValid,
  isLifecycleState,
  LIFECYCLE_STATES,
  lifecycleWeight,
  transitionLifecycle,
} from '../lifecycle';
import { CompressedSession } from '../types';

function mkSession(o: Partial<CompressedSession> = {}): CompressedSession {
  return {
    id: 's1',
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: 1,
    endTime: 2,
    summary: 'demo',
    observationType: 'feature',
    keyFiles: [],
    keyTopics: [],
    decisions: [],
    problemsSolved: [],
    rawEventCount: 0,
    userTags: [],
    redactionCount: 0,
    ...o,
  };
}

test('lifecycle: every declared state is recognized, junk is not', () => {
  for (const state of LIFECYCLE_STATES) assert.ok(isLifecycleState(state));
  assert.equal(isLifecycleState('shipped'), false);
  assert.equal(isLifecycleState(42), false);
});

test('lifecycle: forward transitions allowed, regressions rejected', () => {
  assert.ok(canTransition('proposed', 'experimental'));
  assert.ok(canTransition('implemented', 'merged'));
  assert.ok(canTransition('merged', 'deployed'));
  assert.ok(canTransition('deployed', 'reverted'));
  assert.ok(canTransition('reverted', 'proposed'));
  assert.equal(canTransition('deployed', 'proposed'), false);
  assert.equal(canTransition('merged', 'experimental'), false);
  assert.equal(canTransition('deprecated', 'merged'), false);
});

test('lifecycle: unset may enter any state; same-state is a no-op transition', () => {
  for (const state of LIFECYCLE_STATES) assert.ok(canTransition(undefined, state));
  assert.ok(canTransition('merged', 'merged'));
});

test('lifecycle: transitionLifecycle enforces the machine and names the allowed set', () => {
  const session = mkSession({ lifecycle: 'deployed' });
  assert.throws(() => transitionLifecycle(session, 'merged'), /Illegal lifecycle transition/);
  transitionLifecycle(session, 'reverted');
  assert.equal(session.lifecycle, 'reverted');
});

test('lifecycle: branch validity confines sub-merged states to their branch', () => {
  const experimental = mkSession({ lifecycle: 'experimental', branchName: 'feat/auth' });
  assert.ok(isBranchValid(experimental, 'feat/auth'));
  assert.equal(isBranchValid(experimental, 'main'), false);
  const merged = mkSession({ lifecycle: 'merged', branchName: 'feat/auth' });
  assert.ok(isBranchValid(merged, 'main'));
});

test('lifecycle: legacy sessions (no lifecycle) are valid everywhere', () => {
  const legacy = mkSession({ branchName: 'feat/old' });
  assert.ok(isBranchValid(legacy, 'main'));
});

test('lifecycle: missing branch info never confines', () => {
  assert.ok(isBranchValid(mkSession({ lifecycle: 'experimental' }), 'main'));
  assert.ok(isBranchValid(mkSession({ lifecycle: 'experimental', branchName: 'x' }), undefined));
});

test('lifecycle: weights down-rank speculative and dead states', () => {
  assert.equal(lifecycleWeight(undefined), 1);
  assert.equal(lifecycleWeight('merged'), 1);
  assert.ok(lifecycleWeight('experimental') < 1);
  assert.ok(lifecycleWeight('reverted') < lifecycleWeight('deprecated'));
});

test('lifecycle: branch defaults — mainline implemented, feature experimental, unknown unset', () => {
  assert.equal(defaultLifecycleForBranch('main'), 'implemented');
  assert.equal(defaultLifecycleForBranch('master'), 'implemented');
  assert.equal(defaultLifecycleForBranch('feat/x'), 'experimental');
  assert.equal(defaultLifecycleForBranch(undefined), undefined);
});

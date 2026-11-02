import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTask,
  transitionTask,
  assertTaskAccess,
  type ExecutionScope,
  type TaskPrincipal,
} from '../taskRuntime';

const principal: TaskPrincipal = {
  id: 'copilot-builder',
  repoScope: 'repo',
  canWrite: true,
  canVerify: false,
};
const scope: ExecutionScope = {
  repoScope: 'repo',
  worktreeId: 'tree-one',
  branch: 'feature',
  headCommit: 'a'.repeat(40),
  dirtyTreeDigest: 'b'.repeat(64),
};
const input = {
  goal: 'Implement authentication',
  visibility: 'shared',
  steps: [{ id: 'build', title: 'Build middleware' }],
  acceptanceCriteria: [{ id: 'tests', text: 'Authentication tests pass' }],
};

test('task transitions retain intent, redact secrets, and require authorized completion evidence', () => {
  const task = startTask(
    { ...input, goal: 'Rotate ghp_1234567890abcdefghijklmnopqrstuvwxyzAB' },
    principal,
    scope,
    'task',
    1000,
  );
  assert.doesNotMatch(task.goal, /ghp_/);
  assert.equal(task.authority, 'none');
  const ready = transitionTask(
    task,
    'update',
    { steps: [{ id: 'build', title: 'Build middleware', status: 'done' }] },
    principal,
    scope,
    2000,
  );
  assert.equal(ready.revision, 2);
  const evidence = [{ criterionId: 'tests', reference: 'ci/run/42', outcome: 'passed' }];
  assert.throws(
    () => transitionTask(ready, 'complete', { evidence }, principal, scope, 3000),
    /verifier/,
  );
  assert.throws(
    () =>
      transitionTask(
        ready,
        'complete',
        { evidence: [] },
        { ...principal, canVerify: true },
        scope,
        3000,
      ),
    /criterion/,
  );
  const completed = transitionTask(
    ready,
    'complete',
    { evidence },
    { ...principal, id: 'ci-verifier', canVerify: true },
    scope,
    3000,
  );
  assert.equal(completed.status, 'completed');
  assert.throws(() => transitionTask(completed, 'update', {}, principal, scope, 4000), /terminal/);
});

test('task scope drift requires explicit rebind and invalidates completed steps and checkpoints', () => {
  const task = startTask(input, principal, scope, 'task', 1000);
  const saved = transitionTask(
    task,
    'checkpoint',
    { summary: 'Middleware partially built', nextActions: ['Run tests'] },
    principal,
    scope,
    2000,
  );
  const other = { ...scope, worktreeId: 'tree-two' };
  assert.throws(() => transitionTask(saved, 'update', {}, principal, other, 3000), /rebind/);
  const rebound = transitionTask(
    saved,
    'update',
    { rebind: true },
    { ...principal, id: 'claude-builder' },
    other,
    3000,
  );
  assert.equal(rebound.status, 'verification_required');
  assert.equal(rebound.checkpoint, undefined);
  assert.equal(rebound.steps[0].status, 'pending');
  assert.equal(rebound.baseCommit, scope.headCommit);
});

test('task access denies wrong repository, private agent access, unsafe paths and duplicate criteria', () => {
  const task = startTask({ ...input, visibility: 'private' }, principal, scope, 'task', 1000);
  assert.throws(() => assertTaskAccess(task, { ...principal, id: 'other' }));
  assert.throws(() => assertTaskAccess(task, { ...principal, repoScope: 'other' }));
  assert.throws(() =>
    transitionTask(task, 'update', { modifiedFiles: ['../secret'] }, principal, scope, 2000),
  );
  assert.throws(() =>
    startTask(
      { ...input, acceptanceCriteria: [input.acceptanceCriteria[0], input.acceptanceCriteria[0]] },
      principal,
      scope,
      'task',
      1000,
    ),
  );
  assert.throws(
    () =>
      startTask(
        {
          ...input,
          acceptanceCriteria: [
            {
              id: 'ghp_1234567890abcdefghijklmnopqrstuvwxyzAB',
              text: 'Do not persist secret identifiers',
            },
          ],
        },
        principal,
        scope,
        'task',
        1000,
      ),
    /secrets/,
  );
});

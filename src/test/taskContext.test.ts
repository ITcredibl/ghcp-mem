import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { observeExecutionScope, resumeTask, compileTaskContext } from '../taskContext';
import { startTask, transitionTask, type ExecutionScope, type TaskPrincipal } from '../taskRuntime';

const principal: TaskPrincipal = {
  id: 'copilot',
  repoScope: 'repo',
  canWrite: true,
  canVerify: false,
};
const scope: ExecutionScope = {
  repoScope: 'repo',
  worktreeId: 'tree',
  branch: 'feature',
  headCommit: 'a'.repeat(40),
  dirtyTreeDigest: 'b'.repeat(64),
};
const input = {
  goal: 'Build authentication',
  visibility: 'shared',
  steps: [{ id: 'build', title: 'Build middleware', status: 'done' }],
  acceptanceCriteria: [{ id: 'test', text: 'Authentication tests pass' }],
};

test('resume distinguishes historical completion and rejects cross-repo/private disclosure', () => {
  const task = startTask(input, principal, scope, 'task', 1000);
  const completed = transitionTask(
    task,
    'complete',
    { evidence: [{ criterionId: 'test', reference: 'ci/42', outcome: 'passed' }] },
    { ...principal, canVerify: true },
    scope,
    2000,
  );
  const next = resumeTask(
    completed,
    { ...principal, id: 'claude' },
    { ...scope, worktreeId: 'other' },
  );
  assert.equal(next.status, 'verification_required');
  assert.deepEqual(next.completed, []);
  assert.equal(next.verification, undefined);
  assert.match(next.nextSafeAction, /rebind/);
  assert.throws(() => resumeTask(task, { ...principal, repoScope: 'other' }, scope));
});

test('context compiler budgets complete packets and reports omissions without dropping task intent', () => {
  const task = startTask(input, principal, scope, 'task', 1000);
  task.decisions = ['x'.repeat(5000), 'Authentication tests pass', 'Use token validation'];
  const compiled = compileTaskContext(task, principal, scope, 400);
  assert.ok(
    Math.ceil(Buffer.byteLength(JSON.stringify(compiled.packet, null, 2), 'utf8') / 4) <= 400,
  );
  assert.equal(compiled.packet.goal, input.goal);
  assert.ok(compiled.selection.some((item) => item.reason === 'budget'));
  assert.match(compiled.packet.receipt.digest, /^[a-f0-9]{64}$/);
  assert.throws(() => compileTaskContext(task, principal, scope, 128), /mandatory/);
});

test('Git-observed scope changes with tracked content, untracked content, and worktrees', async (context) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'task-scope-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=' + join(directory, 'no-hooks'),
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  git('init');
  await fs.writeFile(join(directory, 'source.txt'), 'original');
  git('add', 'source.txt');
  git(
    '-c',
    'user.name=Task Test',
    '-c',
    'user.email=task@example.invalid',
    'commit',
    '-m',
    'Initial',
  );
  const clean = await observeExecutionScope(directory, 'repo');
  await fs.writeFile(join(directory, 'source.txt'), 'changed');
  const dirty = await observeExecutionScope(directory, 'repo');
  assert.notEqual(clean.dirtyTreeDigest, dirty.dirtyTreeDigest);
  git('add', 'source.txt');
  const staged = await observeExecutionScope(directory, 'repo');
  assert.notEqual(staged.dirtyTreeDigest, dirty.dirtyTreeDigest);
  await fs.writeFile(join(directory, 'new.txt'), 'new');
  const untracked = await observeExecutionScope(directory, 'repo');
  assert.notEqual(dirty.dirtyTreeDigest, untracked.dirtyTreeDigest);
  const subdirectory = join(directory, 'nested');
  await fs.mkdir(subdirectory);
  const fromNested = await observeExecutionScope(subdirectory, 'repo');
  assert.equal(fromNested.worktreeId, untracked.worktreeId);
  assert.equal(fromNested.dirtyTreeDigest, untracked.dirtyTreeDigest);
  const other = join(directory, 'worktree');
  git('worktree', 'add', '--detach', other, 'HEAD');
  assert.notEqual((await observeExecutionScope(other, 'repo')).worktreeId, clean.worktreeId);
});

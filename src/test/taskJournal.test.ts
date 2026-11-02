import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskJournal } from '../taskJournal';
import { taskDigest, type ExecutionScope, type TaskPrincipal } from '../taskRuntime';

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
  acceptanceCriteria: [{ id: 'test', text: 'Tests pass' }],
};

test('journal persists across instances, deduplicates retries, and rejects stale revisions', async (context) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'task-journal-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journal = new TaskJournal(directory, principal, { allowPlaintext: true });
  const task = await journal.start(input, scope, 'start');
  assert.equal((await journal.start(input, scope, 'start')).id, task.id);
  await assert.rejects(
    journal.start({ ...input, goal: 'Different' }, scope, 'start'),
    /Idempotency/,
  );
  const changed = await journal.mutate(
    task.id,
    1,
    'update',
    'update',
    { blockers: ['CI unavailable'] },
    scope,
  );
  assert.equal(changed.revision, 2);
  assert.equal(
    (await journal.mutate(task.id, 1, 'update', 'update', { blockers: ['CI unavailable'] }, scope))
      .revision,
    2,
  );
  await assert.rejects(
    journal.mutate(task.id, 1, 'stale', 'update', {}, scope),
    /Revision conflict/,
  );
  const second = new TaskJournal(
    directory,
    { ...principal, id: 'claude' },
    { allowPlaintext: true },
  );
  assert.equal((await second.read(task.id)).status, 'blocked');
});

test('journal serializes competing writers and recovers committed state around interrupted temporary files', async (context) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'task-race-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journal = new TaskJournal(directory, principal, { allowPlaintext: true });
  const task = await journal.start(input, scope, 'start');
  const other = new TaskJournal(
    directory,
    { ...principal, id: 'claude' },
    { allowPlaintext: true },
  );
  const results = await Promise.allSettled([
    journal.mutate(task.id, 1, 'one', 'update', {}, scope),
    other.mutate(task.id, 1, 'two', 'update', {}, scope),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const taskDir = join(directory, taskDigest('repo').slice(0, 32), task.id);
  await fs.writeFile(join(taskDir, '.pending-interrupted.tmp'), 'partial data');
  assert.equal((await other.read(task.id)).revision, 2);
  await fs.writeFile(join(taskDir, '0000000003.json'), 'corrupt committed event');
  await assert.rejects(other.read(task.id), /corrupt/);
});

test('journal encrypts events and fails closed on a wrong key or forbidden principal', async (context) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'task-encryption-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    new TaskJournal(directory, principal).start(input, scope, 'locked'),
    /encryption/,
  );
  const key = randomBytes(32);
  const journal = new TaskJournal(directory, principal, { key });
  const task = await journal.start({ ...input, visibility: 'private' }, scope, 'start');
  const event = await fs.readFile(
    join(directory, taskDigest('repo').slice(0, 32), task.id, '0000000001.json'),
    'utf8',
  );
  assert.ok(!event.includes(input.goal));
  await assert.rejects(
    new TaskJournal(directory, principal, { key: randomBytes(32) }).read(task.id),
    /locked/,
  );
  await assert.rejects(
    new TaskJournal(directory, { ...principal, id: 'other' }, { key }).read(task.id),
    /unavailable/,
  );
  await assert.rejects(journal.read('../outside'), /Invalid task id/);
});

test('independent writer processes cannot both commit the same expected revision', async (context) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'task-process-race-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journal = new TaskJournal(directory, principal, { allowPlaintext: true });
  const task = await journal.start(input, scope, 'start');
  const script = `const {TaskJournal}=require(process.argv[1]); const journal=new TaskJournal(process.argv[2],{id:process.argv[4],repoScope:'repo',canWrite:true,canVerify:false},{allowPlaintext:true}); journal.mutate(process.argv[3],1,process.argv[4],'update',{blockers:[process.argv[4]]},JSON.parse(process.argv[5])).then(result=>process.stdout.write(JSON.stringify(result))).catch(error=>{process.stderr.write(error.message);process.exitCode=1;});`;
  const execute = promisify(execFile);
  const run = (actor: string) =>
    execute(
      process.execPath,
      [
        '-e',
        script,
        join(__dirname, '..', 'taskJournal.js'),
        directory,
        task.id,
        actor,
        JSON.stringify(scope),
      ],
      { timeout: 10000 },
    );
  const results = await Promise.allSettled([run('agent-one'), run('agent-two')]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await journal.read(task.id)).revision, 2);
});

test('a process interrupted before commit preserves state and leaves a fail-closed orphan lock', async (context) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'task-process-crash-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journal = new TaskJournal(directory, principal, { allowPlaintext: true });
  const task = await journal.start(input, scope, 'start');
  const taskDir = join(directory, taskDigest('repo').slice(0, 32), task.id);
  const script = `const fs=require('node:fs');const path=require('node:path');const root=process.argv[1];fs.writeFileSync(path.join(root,'.lock'),JSON.stringify({pid:process.pid}),{flag:'wx'});const pending=fs.openSync(path.join(root,'.pending-crash.tmp'),'wx');fs.writeSync(pending,'partial checkpoint');fs.fsyncSync(pending);process.exit(23);`;
  const child = spawnSync(process.execPath, ['-e', script, taskDir], { timeout: 10000 });
  assert.equal(child.status, 23);
  const restarted = new TaskJournal(directory, principal, { allowPlaintext: true });
  assert.equal((await restarted.read(task.id)).revision, 1);
  await assert.rejects(
    restarted.mutate(task.id, 1, 'after-crash', 'update', {}, scope),
    /orphaned lock/,
  );
  await fs.unlink(join(taskDir, '.lock'));
  assert.equal(
    (await restarted.mutate(task.id, 1, 'after-recovery', 'update', {}, scope)).revision,
    2,
  );
});

test('owner purge removes all historical content, supports retries, and prevents start replay resurrection', async (context) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'task-purge-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journal = new TaskJournal(directory, principal, { allowPlaintext: true });
  const task = await journal.start(input, scope, 'start');
  await journal.mutate(
    task.id,
    1,
    'update',
    'update',
    { decisions: ['Sensitive architectural context'] },
    scope,
  );
  const other = new TaskJournal(directory, { ...principal, id: 'other' }, { allowPlaintext: true });
  await assert.rejects(other.purge(task.id, 2, 'delete'), /owner/);
  await assert.rejects(journal.purge(task.id, 1, 'delete'), /conflict/);
  assert.equal((await journal.purge(task.id, 2, 'delete')).deleted, true);
  assert.equal((await journal.purge(task.id, 2, 'delete')).deleted, true);
  await assert.rejects(journal.read(task.id), /deleted/);
  await assert.rejects(journal.start(input, scope, 'start'), /deleted/);
  const names = await fs.readdir(join(directory, taskDigest('repo').slice(0, 32), task.id));
  assert.deepEqual(names, ['.deleted.json']);
});

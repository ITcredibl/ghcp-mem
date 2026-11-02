import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckpoint, verifyCheckpoint } from '../agentCheckpoint';

const input = {
  harness: 'ci',
  taskId: 'release-42',
  repoScope: 'repo-one',
  commit: 'a'.repeat(40),
  stage: 'verified',
  summary: 'Release passed checks',
  nextActions: ['Review rollout'],
  evidence: [
    { kind: 'test', reference: 'ci/run/42', outcome: 'passed' },
    { kind: 'artifact', reference: 'sha256:' + 'b'.repeat(64), outcome: 'unknown' },
  ],
};

test('checkpoint binds redacted evidence to a repo, commit, and expiry without granting authority', () => {
  const checkpoint = createCheckpoint(
    { ...input, summary: 'Use ghp_1234567890abcdefghijklmnopqrstuvwxyzAB', authority: 'deploy' },
    1000,
  );
  assert.equal(checkpoint.authority, 'none');
  assert.doesNotMatch(checkpoint.summary, /ghp_/);
  assert.equal(
    verifyCheckpoint(checkpoint, { repoScope: 'repo-one', commit: input.commit, now: 2000 }).valid,
    true,
  );
  assert.equal(
    verifyCheckpoint(checkpoint, { repoScope: 'other', commit: input.commit, now: 2000 }).valid,
    false,
  );
  assert.equal(
    verifyCheckpoint(checkpoint, { repoScope: 'repo-one', commit: 'c'.repeat(40), now: 2000 })
      .valid,
    false,
  );
  assert.equal(
    verifyCheckpoint(checkpoint, {
      repoScope: 'repo-one',
      commit: input.commit,
      now: checkpoint.expiresAt,
    }).valid,
    false,
  );
  assert.equal(
    verifyCheckpoint(
      { ...checkpoint, summary: 'tampered' },
      { repoScope: 'repo-one', commit: input.commit, now: 2000 },
    ).valid,
    false,
  );
});

test('checkpoint rejects ungrounded verification, excessive expiry, and malformed evidence', () => {
  assert.throws(() => createCheckpoint({ ...input, evidence: [] }));
  assert.throws(() =>
    createCheckpoint({
      ...input,
      evidence: [...input.evidence, { kind: 'test', reference: 'failure', outcome: 'failed' }],
    }),
  );
  assert.throws(() => createCheckpoint({ ...input, expiresAt: Infinity }));
  assert.throws(() => createCheckpoint({ ...input, nextActions: new Array(11).fill('action') }));
  assert.throws(() => createCheckpoint({ ...input, commit: 'branch-name' }));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEncryptedEnvelope } from '../storageCrypto';
import { bundleFileName, exportBundle, importBundle, shareableSessions } from '../teamSync';
import { CompressedSession } from '../types';

function mkSession(o: Partial<CompressedSession> = {}): CompressedSession {
  return {
    id: o.id ?? Math.random().toString(36).slice(2),
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: 1,
    endTime: 2,
    summary: o.summary ?? 'team knowledge',
    observationType: 'feature',
    keyFiles: [],
    keyTopics: [],
    decisions: [],
    problemsSolved: [],
    rawEventCount: 0,
    userTags: [],
    redactionCount: 0,
    contentHash: o.contentHash,
    ...o,
  };
}

test('teamSync: personal scopes and retracted sessions never leave the machine', () => {
  const kept = shareableSessions([
    mkSession({ id: 'repo' }),
    mkSession({ id: 'team', scopeLevel: 'team' }),
    mkSession({ id: 'branch', scopeLevel: 'branch' }),
    mkSession({ id: 'user', scopeLevel: 'user' }),
    mkSession({ id: 'task', scopeLevel: 'task' }),
    mkSession({ id: 'agent', scopeLevel: 'agent', author: 'claude:reviewer' }),
    mkSession({ id: 'retracted', retracted: true }),
  ]).map((s) => s.id);
  assert.deepEqual(kept.sort(), ['branch', 'repo', 'team']);
});

test('teamSync: bundles are encrypted envelopes with no plaintext payload', () => {
  const bundle = exportBundle(
    { sessions: [mkSession({ summary: 'super secret architecture call' })], scopeLabel: 'repo' },
    'correct horse battery',
  );
  assert.ok(isEncryptedEnvelope(bundle));
  assert.ok(!bundle.includes('super secret architecture call'));
});

test('teamSync: export rejects weak passphrases', () => {
  assert.throws(
    () => exportBundle({ sessions: [], scopeLabel: 'x' }, 'short'),
    /at least 8 characters/,
  );
});

test('teamSync: round-trip import adds new sessions, dedups by id and contentHash', () => {
  const shared = mkSession({ id: 'new-knowledge', contentHash: 'hash-1' });
  const bundle = exportBundle(
    {
      sessions: [shared, mkSession({ id: 'dupe-id' }), mkSession({ contentHash: 'hash-2' })],
      scopeLabel: 'repo',
    },
    'correct horse battery',
  );
  const result = importBundle(bundle, 'correct horse battery', {
    sessions: [mkSession({ id: 'dupe-id' }), mkSession({ contentHash: 'hash-2' })],
  });
  assert.deepEqual(
    result.added.map((s) => s.id),
    ['new-knowledge'],
  );
  assert.equal(result.skippedDuplicates, 2);
  assert.ok(result.added[0].importedAt, 'imported rows must carry importedAt for retention');
});

test('teamSync: wrong passphrase and non-bundles fail loudly', () => {
  const bundle = exportBundle(
    { sessions: [mkSession()], scopeLabel: 'repo' },
    'correct horse battery',
  );
  assert.throws(
    () => importBundle(bundle, 'wrong passphrase!', { sessions: [] }),
    /Wrong passphrase/,
  );
  assert.throws(() => importBundle('{"sessions":[]}', 'whatever-8', { sessions: [] }), /envelope/);
});

test('teamSync: bundle filenames are slugged and dated', () => {
  assert.match(
    bundleFileName('github.com/Org/Repo', 1700000000000),
    /^github-com-org-repo-2023-11-14\.ghcpmem$/,
  );
});

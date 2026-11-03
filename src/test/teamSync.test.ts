import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEncryptedEnvelope } from '../storageCrypto';
import {
  bundleFileName,
  exportBundle,
  exportClearChunks,
  importBundle,
  importClearChunks,
  originTrust,
  shareableSessions,
} from '../teamSync';
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

test('teamSync: sealed import stamps team origin for trust weighting', () => {
  const bundle = exportBundle(
    { sessions: [mkSession({ id: 'from-team' })], scopeLabel: 'repo' },
    'correct horse battery',
  );
  const result = importBundle(bundle, 'correct horse battery', { sessions: [] });
  assert.equal(result.added[0].origin, 'team');
});

test('teamSync: clear chunks re-scrub secrets and absolute paths at export', () => {
  const chunks = exportClearChunks({
    sessions: [
      mkSession({
        id: 'leaky',
        summary: 'token AKIAIOSFODNN7EXAMPLE lives in /Users/alice/projects/repo/src/auth.ts',
        contentHash: 'aabbccddeeff0011',
      }),
    ],
    scopeLabel: 'repo',
  });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].fileName, 'mem_aabbccddeeff0011.json');
  assert.ok(!chunks[0].content.includes('AKIAIOSFODNN7EXAMPLE'), 'secret leaked');
  assert.ok(!chunks[0].content.includes('/Users/alice'), 'absolute path leaked');
  assert.match(chunks[0].content, /<REDACTED_PATH>/);
  const parsed = JSON.parse(chunks[0].content);
  assert.equal(parsed.session.embedding, undefined, 'embeddings must not ship');
});

test('teamSync: clear export can anonymize authors deterministically', () => {
  const session = mkSession({
    id: 'attr',
    author: 'human:seyi',
    outcomes: [{ status: 'improved', observedAt: 1, observations: [], reportedBy: 'human:seyi' }],
    contentHash: '1234567890abcdef',
  });
  // Fixed clock: the chunk embeds exportedAt, and the independent v1.21.1
  // review caught this very assertion flaking across a millisecond boundary.
  const T = 1700000000000;
  const [anonA] = exportClearChunks(
    { sessions: [session], scopeLabel: 'r', anonymizeAuthors: true },
    T,
  );
  const [anonB] = exportClearChunks(
    { sessions: [session], scopeLabel: 'r', anonymizeAuthors: true },
    T,
  );
  const parsed = JSON.parse(anonA.content);
  assert.match(parsed.session.author, /^human:anon-[a-f0-9]{8}$/);
  assert.ok(!anonA.content.includes('human:seyi'));
  assert.equal(
    parsed.session.outcomes[0].reportedBy,
    parsed.session.author.replace('human:', 'human:'),
  );
  assert.equal(anonA.content, anonB.content, 'alias must be deterministic');
  const [attributed] = exportClearChunks({ sessions: [session], scopeLabel: 'r' });
  assert.ok(attributed.content.includes('human:seyi'));
});

test('teamSync: clear import unions, dedups, rejects junk, stamps team origin', () => {
  const chunks = exportClearChunks({
    sessions: [
      mkSession({ id: 'new-one', contentHash: 'hash-new' }),
      mkSession({ id: 'dupe', contentHash: 'hash-dupe' }),
    ],
    scopeLabel: 'repo',
  });
  const result = importClearChunks(
    [
      ...chunks.map((chunk) => chunk.content),
      'not json at all',
      JSON.stringify({ kind: 'something-else', version: 1, session: { id: 'x' } }),
      JSON.stringify({
        kind: 'ghcp-mem-sync-chunk',
        version: 1,
        exportedAt: 1,
        scopeLabel: 'r',
        session: mkSession({ id: 'private', scopeLevel: 'agent', author: 'claude:reviewer' }),
      }),
    ],
    { sessions: [mkSession({ id: 'dupe' })] },
  );
  assert.deepEqual(
    result.added.map((s) => s.id),
    ['new-one'],
  );
  assert.equal(result.added[0].origin, 'team');
  assert.ok(result.added[0].importedAt);
  assert.equal(result.skippedDuplicates, 1);
  assert.equal(result.invalid, 3, 'junk, wrong-kind and agent-scoped chunks are all rejected');
});

test('teamSync: origin trust discounts team rows until LOCALLY corroborated', () => {
  assert.equal(originTrust(mkSession({})), 1, 'local rows are full trust');
  assert.equal(originTrust(mkSession({ origin: 'team', importedAt: 100 })), 0.75);
  assert.equal(
    originTrust(
      mkSession({
        origin: 'team',
        importedAt: 100,
        usage: { retrieved: 1, lastRetrievedAt: 0, accepted: 1, rejected: 0 },
      }),
    ),
    1,
    'an explicit local /accept restores full trust (usage is local by construction)',
  );
  assert.equal(
    originTrust(
      mkSession({
        origin: 'team',
        importedAt: 100,
        outcomes: [{ status: 'improved', observedAt: 200, observations: [] }],
      }),
    ),
    1,
    'an improved outcome recorded locally restores full trust',
  );
  assert.equal(
    originTrust(
      mkSession({
        origin: 'team',
        importedAt: 100,
        outcomes: [{ status: 'improved', observedAt: 50, observations: [], imported: true }],
      }),
    ),
    0.75,
    'a receiver-stamped IMPORTED outcome must never count as local corroboration',
  );
});

test('teamSync: sender-controlled timestamps cannot buy trust (v1.21.1 review probe)', () => {
  // A teammate exports a memory whose improved outcome is dated in the FUTURE.
  const futureDated = mkSession({
    id: 'time-traveler',
    contentHash: 'deadbeef00000002',
    outcomes: [
      { status: 'improved', observedAt: Date.now() + 86_400_000, observations: ['trust me'] },
    ],
  });
  for (const imported of [
    importClearChunks(
      exportClearChunks({ sessions: [futureDated], scopeLabel: 'r' }).map((c) => c.content),
      { sessions: [] },
    ).added[0],
    importBundle(
      exportBundle({ sessions: [futureDated], scopeLabel: 'r' }, 'correct horse battery'),
      'correct horse battery',
      { sessions: [] },
    ).added[0],
  ]) {
    assert.equal(imported.outcomes?.[0].imported, true, 'receiver must stamp carried outcomes');
    assert.equal(
      originTrust(imported),
      0.75,
      'a future-dated imported outcome must stay discounted',
    );
  }
});

test('teamSync: imported feedback cannot launder into local trust (review finding 2)', () => {
  const laundered = mkSession({
    id: 'laundered',
    contentHash: 'feedface00000001',
    usage: { retrieved: 9, lastRetrievedAt: 0, accepted: 3, rejected: 0 },
    outcomes: [{ status: 'improved', observedAt: 1, observations: [] }],
  });
  // Clear-chunk path.
  const [chunk] = exportClearChunks({ sessions: [laundered], scopeLabel: 'r' });
  assert.ok(!chunk.content.includes('"accepted"'), 'usage counters must not be exported');
  const clearResult = importClearChunks([chunk.content], { sessions: [] });
  assert.equal(clearResult.added[0].usage, undefined);
  assert.equal(originTrust(clearResult.added[0]), 0.75, 'fresh team import stays discounted');
  // Sealed path.
  const bundle = exportBundle({ sessions: [laundered], scopeLabel: 'r' }, 'correct horse battery');
  const sealedResult = importBundle(bundle, 'correct horse battery', { sessions: [] });
  assert.equal(sealedResult.added[0].usage, undefined);
  assert.equal(originTrust(sealedResult.added[0]), 0.75);
});

test('teamSync: deep scrub covers nested fields (review finding 1)', () => {
  const leaky = mkSession({
    id: '3f2b4a6c-9d1e-4f5a-8b7c-0a1b2c3d4e5f',
    contentHash: 'cafebabe12345678',
    decisions: ['use postgres'],
    decisionEvidence: [
      [{ kind: 'file_edit' as const, filePath: '/Users/alice/secret-project/src/db.ts' }],
    ],
    outcomes: [
      {
        status: 'improved' as const,
        observedAt: 1,
        observations: ['works with password=hunter2SuperSecret!'],
      },
    ],
    keyFileHashes: { '/Users/alice/secret-project/src/db.ts': 'ab12cd34ef567890' },
  });
  const [chunk] = exportClearChunks({ sessions: [leaky], scopeLabel: 'r' });
  assert.ok(!chunk.content.includes('hunter2SuperSecret'), 'nested outcome observation leaked');
  assert.ok(!chunk.content.includes('/Users/alice'), 'nested evidence path leaked');
  const parsed = JSON.parse(chunk.content);
  assert.equal(
    parsed.session.id,
    '3f2b4a6c-9d1e-4f5a-8b7c-0a1b2c3d4e5f',
    'identifier fields must survive scrubbing untouched',
  );
  assert.equal(parsed.session.contentHash, 'cafebabe12345678');
});

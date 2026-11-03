/**
 * Semantic retrieval + RET-004 lineage/duplicate tests (v1.23.0).
 *
 * Everything here runs WITHOUT the downloaded model: semantic evidence is
 * injected through the `semanticSim` adapter with hand-built similarity maps,
 * which is exactly the production seam (the provider only ever contributes
 * that map). Model-dependent tests live in semanticNeural.test.ts and skip
 * when the assets are absent.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { retrieve, SEMANTIC_THRESHOLDS } from '../retrieval';
import { embeddingCompatible, NEURAL_PROVIDER_ID } from '../neuralEmbedder';
import { searchSessionsDetailed, searchSessionsSemantic } from '../mcpServer';
import { computeContentHash, CompressedSession } from '../types';

function makeSession(overrides: Partial<CompressedSession> & { id: string }): CompressedSession {
  const base = {
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_000_000 + 1000,
    summary: 'placeholder',
    observationType: 'feature' as const,
    keyFiles: [],
    keyTopics: [],
    decisions: [],
    problemsSolved: [],
    rawEventCount: 3,
    userTags: [],
    redactionCount: 0,
  };
  const s = { ...base, ...overrides } as CompressedSession;
  s.contentHash = computeContentHash({
    summary: s.summary,
    keyFiles: s.keyFiles,
    keyTopics: s.keyTopics,
    decisions: s.decisions,
    problemsSolved: s.problemsSolved,
  });
  return s;
}

const AUTH_JWT = makeSession({
  id: 'jwt',
  summary: 'Decided to use JWT access tokens with refresh rotation for authentication',
  keyTopics: ['auth', 'sessions'],
  decisions: ['use JWT access tokens with refresh rotation'],
});
const AUTH_COOKIE = makeSession({
  id: 'cookie',
  summary: 'Decided to use server-side cookie sessions for authentication',
  keyTopics: ['auth', 'sessions'],
  decisions: ['use http-only cookie sessions stored server side'],
});
const UNRELATED = makeSession({
  id: 'parquet',
  summary: 'Feature store uses partitioned parquet files keyed by entity and day',
  keyTopics: ['feature-store', 'parquet'],
});

// ---------------------------------------------------------------------------
// RET-001: independent semantic candidacy
// ---------------------------------------------------------------------------

test('semantic evidence retrieves a memory with ZERO keyword overlap', () => {
  const sim = new Map([
    ['jwt', 0.62],
    ['parquet', 0.02],
  ]);
  const out = retrieve([AUTH_JWT, UNRELATED], 'how do we verify who a caller is', 3, {
    semanticSim: sim,
    semanticProvider: NEURAL_PROVIDER_ID,
  });
  assert.equal(out.mode, 'hybrid-semantic');
  assert.equal(out.provider, NEURAL_PROVIDER_ID);
  assert.equal(out.state, 'match');
  assert.equal(out.items[0].session.id, 'jwt');
  assert.equal(out.items[0].evidence, 'semantic');
  assert.ok((out.items[0].semanticSim ?? 0) >= SEMANTIC_THRESHOLDS.match);
  assert.ok(!out.items.some((i) => i.session.id === 'parquet'));
});

test('sub-match semantic similarity alone does NOT lift abstention', () => {
  const sim = new Map([['jwt', SEMANTIC_THRESHOLDS.match - 0.05]]);
  const out = retrieve([AUTH_JWT, UNRELATED], 'completely unrelated dinosaur paleontology dig', 3, {
    semanticSim: sim,
    semanticProvider: NEURAL_PROVIDER_ID,
  });
  assert.equal(out.state, 'no_match');
  assert.equal(out.mode, 'hybrid-semantic');
  assert.equal(out.items.length, 0);
});

test('lexical-only mode reports mode and no provider', () => {
  const out = retrieve([AUTH_JWT], 'jwt access tokens', 3, {});
  assert.equal(out.mode, 'lexical');
  assert.equal(out.provider, undefined);
});

test('configured-but-broken provider reports the explicit fallback state', () => {
  const out = retrieve([AUTH_JWT], 'jwt access tokens', 3, {
    semanticFallback: 'semantic provider failed to load: ENOENT model_quantized.onnx',
  });
  assert.equal(out.mode, 'lexical-fallback');
  assert.match(out.fallbackReason ?? '', /failed to load/);
  // Fallback still serves lexical hits — degraded, not dead.
  assert.equal(out.state, 'match');
});

test('empty query reports browse mode, distinct from relevance search', () => {
  const out = retrieve([AUTH_JWT, UNRELATED], '', 5, {});
  assert.equal(out.mode, 'browse');
  assert.equal(out.items.length, 2);
});

// ---------------------------------------------------------------------------
// RET-004: duplicate handling must respect content, scope and lineage
// ---------------------------------------------------------------------------

test('JWT and cookie decisions with IDENTICAL topics are not collapsed', () => {
  const out = retrieve([AUTH_JWT, AUTH_COOKIE], 'authentication sessions decision', 5, {});
  const ids = out.items.map((i) => i.session.id).sort();
  assert.deepEqual(ids, ['cookie', 'jwt'], 'both decisions must stay visible');
});

test('true duplicates (same contentHash) still collapse', () => {
  const dupe = { ...AUTH_JWT, id: 'jwt-copy' } as CompressedSession;
  const out = retrieve([AUTH_JWT, dupe], 'jwt authentication sessions', 5, {});
  assert.equal(out.items.length, 1, 'content-identical records collapse to one');
});

test('near-identical wording collapses, but different scopes never do', () => {
  const repoScoped = makeSession({
    id: 'rule-repo',
    summary: 'All deploys must be blue green with no in place updates',
    keyTopics: ['deploys', 'policy'],
    scopeLevel: 'repository',
  });
  const orgScoped = makeSession({
    id: 'rule-org',
    summary: 'All deploys must be blue green with no in place updates',
    keyTopics: ['deploys', 'policy'],
    scopeLevel: 'organization',
  });
  const out = retrieve([repoScoped, orgScoped], 'blue green deploys policy', 5, {});
  assert.equal(out.items.length, 2, 'different governance scopes are different records');
});

test('superseding and superseded records are co-retrievable, replacement first', () => {
  const oldCache = makeSession({
    id: 'cache-redis',
    summary: 'Redis cache for the product catalog read path',
    keyTopics: ['catalog', 'cache'],
    supersededBy: 'cache-lru',
  });
  const newCache = makeSession({
    id: 'cache-lru',
    summary: 'Replaced the Redis catalog cache with an in-process LRU cache',
    keyTopics: ['catalog', 'cache'],
    supersedes: 'cache-redis',
  });
  const out = retrieve([oldCache, newCache], 'catalog cache', 5, {});
  const ids = out.items.map((i) => i.session.id);
  assert.ok(ids.includes('cache-lru') && ids.includes('cache-redis'), 'lineage stays reachable');
  assert.equal(ids[0], 'cache-lru', 'current-state ranking prefers the replacement');
});

// ---------------------------------------------------------------------------
// RET-002: embedding compatibility
// ---------------------------------------------------------------------------

test('embeddingCompatible enforces provider, dims and content hash', () => {
  const vec = new Array(384).fill(0.05);
  const meta = { provider: NEURAL_PROVIDER_ID, dims: 384, contentHash: 'abc' };
  assert.ok(embeddingCompatible(meta, vec, NEURAL_PROVIDER_ID, 384, 'abc'));
  assert.ok(!embeddingCompatible(meta, vec, 'other-provider/1#384', 384, 'abc'), 'provider change');
  assert.ok(!embeddingCompatible(meta, vec, NEURAL_PROVIDER_ID, 512, 'abc'), 'dims change');
  assert.ok(!embeddingCompatible(meta, vec, NEURAL_PROVIDER_ID, 384, 'DIFFERENT'), 'stale content');
  assert.ok(
    !embeddingCompatible(meta, vec.slice(0, 100), NEURAL_PROVIDER_ID, 384, 'abc'),
    'vector length mismatch is a controlled miss, never a wrong score',
  );
  assert.ok(!embeddingCompatible(undefined, vec, NEURAL_PROVIDER_ID, 384, 'abc'), 'legacy vector');
});

// ---------------------------------------------------------------------------
// RET-006: cross-client parity including the semantic seam
// ---------------------------------------------------------------------------

test('MCP semantic search falls back identically to lexical when no provider is configured', async () => {
  const db = { version: 2 as const, lastUpdated: 0, sessions: [AUTH_JWT, AUTH_COOKIE, UNRELATED] };
  const lexical = searchSessionsDetailed(db as never, 'authentication sessions', {}, 5);
  const semantic = await searchSessionsSemantic(db as never, 'authentication sessions', {}, 5);
  assert.deepEqual(
    semantic.items.map((i) => i.session.id),
    lexical.items.map((i) => i.session.id),
    'identical ids and order without a provider',
  );
  assert.equal(semantic.state, lexical.state);
});

test('identical injected semantic evidence produces identical outcomes across call sites', () => {
  const sim = new Map([
    ['jwt', 0.7],
    ['cookie', 0.55],
    ['parquet', 0.05],
  ]);
  const adapters = { semanticSim: sim, semanticProvider: NEURAL_PROVIDER_ID };
  const a = retrieve([AUTH_JWT, AUTH_COOKIE, UNRELATED], 'login approach', 5, adapters);
  const b = retrieve([AUTH_COOKIE, UNRELATED, AUTH_JWT], 'login approach', 5, adapters);
  assert.deepEqual(
    a.items.map((i) => [i.session.id, i.relevance, i.evidence]),
    b.items.map((i) => [i.session.id, i.relevance, i.evidence]),
    'candidate input order must not change the outcome',
  );
  assert.equal(a.state, b.state);
});

// ---------------------------------------------------------------------------
// CACHE-001: content-aware cache identity (no model required — a stub
// embedder exercises the exact production seam)
// ---------------------------------------------------------------------------

function stubEmbedder(providerId: string, dims = 8) {
  let calls = 0;
  const embedder = {
    spec: {
      key: 'stub',
      providerId,
      dims,
      pooling: 'mean',
      thresholds: { candidate: 0.3, weak: 0.3, match: 0.5 },
      modelAssets: [],
    },
    providerId,
    dims,
    thresholds: { candidate: 0.3, weak: 0.3, match: 0.5 },
    async embed(text: string) {
      calls++;
      // Deterministic text-derived vector so stale reuse is detectable.
      const v = new Array(dims)
        .fill(0)
        .map((_, i) => ((text.charCodeAt(i % text.length) % 13) + i) / 20);
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    },
    async embedPassage(text: string) {
      return this.embed(text);
    },
    async embedQuery(text: string) {
      return this.embed(text);
    },
  };
  return { embedder: embedder as never, callCount: () => calls };
}

test('CACHE-001 (MCP): content change with SAME id and timestamp recomputes the vector', async () => {
  const { ensureSemanticVectors } = await import('../mcpServer');
  const { embedder, callCount } = stubEmbedder('stub-provider/1#8');
  const session = makeSession({ id: 'cache-probe', summary: 'original summary text' });
  const v1 = (await ensureSemanticVectors([session], embedder, 10)).get('cache-probe')!;
  const callsAfterFirst = callCount();
  // Unchanged content: cached vector reused, no new inference.
  const v1again = (await ensureSemanticVectors([session], embedder, 10)).get('cache-probe')!;
  assert.deepEqual(v1again, v1);
  assert.equal(callCount(), callsAfterFirst, 'unchanged content must not re-embed');
  // Edit the summary while id AND endTime stay identical (the v1.23.0 trap).
  const edited = { ...session, summary: 'completely different content now' } as typeof session;
  const v2 = (await ensureSemanticVectors([edited], embedder, 10)).get('cache-probe')!;
  assert.ok(callCount() > callsAfterFirst, 'content change must trigger recomputation');
  assert.notDeepEqual(v2, v1, 'edited content must not reuse the stale vector');
});

test('CACHE-001 (MCP): a different provider id never reuses cached vectors', async () => {
  const { ensureSemanticVectors } = await import('../mcpServer');
  const session = makeSession({ id: 'cache-probe-2', summary: 'provider switch probe' });
  const a = stubEmbedder('provider-a/1#8');
  await ensureSemanticVectors([session], a.embedder, 10);
  const b = stubEmbedder('provider-b/1#8');
  await ensureSemanticVectors([session], b.embedder, 10);
  assert.equal(b.callCount(), 1, 'new provider must compute its own vector');
});

test('CACHE-001 (extension): persisted vector invalidates on content change, same timestamp', async () => {
  const { embedder, callCount } = stubEmbedder('stub-provider/1#8');
  const session = makeSession({ id: 'ext-cache', summary: 'first version of the fact' });
  // Simulate the extension's persisted-path: stamp a vector + meta for the
  // CURRENT content, then change content without touching endTime.
  session.embedding = await (
    embedder as { embedPassage: (t: string) => Promise<number[]> }
  ).embedPassage('first version of the fact');
  session.embeddingMeta = {
    provider: 'stub-provider/1#8',
    dims: 8,
    contentHash: session.contentHash,
  };
  assert.ok(
    embeddingCompatible(
      session.embeddingMeta,
      session.embedding,
      'stub-provider/1#8',
      8,
      session.contentHash,
    ),
    'fresh vector is compatible',
  );
  const edited = makeSession({ id: 'ext-cache', summary: 'second version of the fact' });
  edited.embedding = session.embedding;
  edited.embeddingMeta = session.embeddingMeta;
  assert.ok(
    !embeddingCompatible(
      edited.embeddingMeta,
      edited.embedding,
      'stub-provider/1#8',
      8,
      edited.contentHash,
    ),
    'content change (same id/time) must invalidate the persisted vector',
  );
  assert.ok(callCount() >= 1);
});

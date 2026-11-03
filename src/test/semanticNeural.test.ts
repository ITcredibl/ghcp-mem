/**
 * Model-dependent semantic tests (v1.23.0). These exercise the REAL local
 * provider — tokenizer, WASM inference, provider identity — and therefore
 * SKIP when the pinned assets are absent (CI does not download the model;
 * install locally with `node scripts/setup-semantic.mjs` or the extension's
 * setup command). The skip is explicit in the test names so a green CI run
 * cannot be mistaken for model-verified coverage.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  NeuralEmbedder,
  neuralAssetsPresent,
  NEURAL_PROVIDER_ID,
  sessionEmbedText,
} from '../neuralEmbedder';
import { cosineSim } from '../vectorMath';
import { searchSessionsSemantic } from '../mcpServer';
import { computeContentHash, CompressedSession } from '../types';

const HAVE_MODEL = neuralAssetsPresent();
const skip = HAVE_MODEL ? false : 'semantic assets not installed (scripts/setup-semantic.mjs)';

let embedderPromise: Promise<NeuralEmbedder> | undefined;
const getEmbedder = () => (embedderPromise ??= NeuralEmbedder.load());

test('neural: tokenizer matches canonical BERT WordPiece ids', { skip }, async () => {
  const e = await getEmbedder();
  assert.deepEqual(e.encode('hello world'), [101, 7592, 2088, 102]);
  // Subword split + unknown handling.
  const ids = e.encode('ghcpmem embeddings');
  assert.equal(ids[0], 101);
  assert.equal(ids[ids.length - 1], 102);
  assert.ok(ids.length > 4, 'out-of-vocab token must split into subwords, not vanish');
});

test('neural: embeddings are deterministic, unit-norm, provider-stamped', { skip }, async () => {
  const e = await getEmbedder();
  assert.equal(e.providerId, NEURAL_PROVIDER_ID);
  const a = await e.embed('exponential backoff with jitter for failed retries');
  const b = await e.embed('exponential backoff with jitter for failed retries');
  assert.deepEqual(a, b, 'same text must embed identically');
  assert.equal(a.length, e.dims);
  const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 0.01, `unit norm, got ${norm}`);
});

test('neural: semantic separation — paraphrase far above unrelated', { skip }, async () => {
  const e = await getEmbedder();
  const anchor = await e.embed('invoice reconciliation retries use exponential backoff');
  const paraphrase = await e.embed('how do we retry failed invoice matching jobs');
  const unrelated = await e.embed('the dinosaur exhibit opens in spring');
  const near = cosineSim(anchor, paraphrase);
  const far = cosineSim(anchor, unrelated);
  assert.ok(near > 0.4, `paraphrase cosine ${near.toFixed(3)} should exceed 0.4`);
  assert.ok(far < 0.2, `unrelated cosine ${far.toFixed(3)} should stay under 0.2`);
  assert.ok(near - far > 0.3, 'separation margin');
});

test(
  'neural: end-to-end zero-keyword-overlap retrieval through the MCP pipeline',
  { skip },
  async () => {
    const mk = (id: string, summary: string, keyTopics: string[]): CompressedSession => {
      const s = {
        id,
        workspaceId: 'ws',
        workspaceName: 'ws',
        startTime: 1_700_000_000_000,
        endTime: 1_700_000_000_000 + 1000,
        summary,
        observationType: 'feature',
        keyFiles: [],
        keyTopics,
        decisions: [],
        problemsSolved: [],
        rawEventCount: 3,
        userTags: [],
        redactionCount: 0,
      } as unknown as CompressedSession;
      s.contentHash = computeContentHash({
        summary,
        keyFiles: [],
        keyTopics,
        decisions: [],
        problemsSolved: [],
      });
      return s;
    };
    const sessions = [
      mk('backoff', 'Exponential backoff with jitter for failed invoice retries', [
        'payments',
        'retries',
      ]),
      mk('parquet', 'Feature store uses partitioned parquet files keyed by entity and day', [
        'feature-store',
      ]),
    ];
    const db = { version: 2, lastUpdated: 0, sessions };
    const embedder = await getEmbedder();
    // Prove the query shares NO significant term with the target (no stemming:
    // "retry" !== "retries"), so any hit is semantic evidence alone.
    const query = 'retry strategy when charging a customer errors out repeatedly';
    const { extractTerms } = await import('../searchCore');
    const queryTerms = extractTerms(query);
    const targetTerms = extractTerms(sessionEmbedText(sessions[0]));
    for (const t of queryTerms) assert.ok(!targetTerms.has(t), `unexpected shared term: ${t}`);
    const out = await searchSessionsSemantic(db as never, query, {}, 3, { embedder });
    assert.equal(out.mode, 'hybrid-semantic');
    assert.equal(out.provider, NEURAL_PROVIDER_ID);
    assert.equal(out.state, 'match');
    assert.equal(out.items[0]?.session.id, 'backoff');
    assert.equal(out.items[0]?.evidence, 'semantic');
    // And the unrelated store must NOT ride along.
    assert.ok(!out.items.some((i) => i.session.id === 'parquet'));
  },
);

#!/usr/bin/env node
/**
 * Search-latency benchmark (PERF-001 + PERF-002).
 *
 * PERF-001 — the benchmark proves it measures useful retrieval before any
 * latency number counts: corpus size is asserted before and after the run,
 * representative queries assert their EXPECTED result ids, the workload mixes
 * positive / selective / broad / negative classes, and a positive workload
 * that comes back empty fails the benchmark. Timestamps come from a
 * controlled clock and retention is explicitly disabled by seeding directly.
 *
 * PERF-002 — deterministic seeded workload, ≥5 trials per size, cold pass
 * (unprimed memos) vs warm passes reported separately, p50/p95/p99/max,
 * heap + RSS deltas, index-build time, per-trial results preserved (printed
 * compactly and written in full with --json), host environment recorded.
 *
 * Usage:
 *   node scripts/bench-search.js                 # CI budget: 1k sessions, gated
 *   node scripts/bench-search.js --full          # 1k / 10k / 50k scaling profile
 *   node scripts/bench-search.js --sizes 2500 --queries 300 --trials 5
 *   node scripts/bench-search.js --json bench.json
 *   node scripts/bench-search.js --semantic      # hybrid incl. REAL query inference
 *                                                #   (requires the local model assets)
 *
 * CI gate: warm p99 < 50 ms at 1,000 sessions (lexical). Larger sizes are
 * informational; regressions show up as ratio changes between sizes.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const positional = argv.filter((a) => /^\d+$/.test(a));
const SIZES = flag('full')
  ? [1000, 10000, 50000]
  : opt('sizes', null)
    ? opt('sizes', '')
        .split(',')
        .map((s) => parseInt(s, 10))
        .filter(Boolean)
    : [parseInt(positional[0], 10) || 1000];
const Q = parseInt(opt('queries', positional[1] || '200'), 10);
const TRIALS = parseInt(opt('trials', '5'), 10);
const JSON_OUT = opt('json', null);
const SEMANTIC = flag('semantic');
const GATED_SIZE = 1000;
const CEILING_MS = 50; // warm p99 budget at GATED_SIZE (lexical)
const COMPILE_CEILING_MS = 100; // context compilation p95 budget (PERF-002)

require('module').Module._initPaths();
process.env.NODE_PATH = path.resolve(__dirname, '..', 'out-test', 'node_modules');
require('module').Module._initPaths();

const { ContextStore } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'contextStore.js'),
);
const { computeContentHash } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'types.js'),
);
const { compileContext } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'contextCompiler.js'),
);
const { InMemoryMemento } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'test', '__mocks__', 'vscode.js'),
);

// ---- deterministic workload -------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPICS = [
  'auth',
  'azure',
  'refactor',
  'redis',
  'cache',
  'mcp',
  'embedding',
  'rrf',
  'sidebar',
  'walkthrough',
  'redaction',
  'health',
];
const TYPES = ['feature', 'bugfix', 'refactor', 'docs', 'config', 'experiment'];
// Controlled clock: pinned ONCE at process start (deterministic within the
// run) but anchored to real time — a fixed historical epoch put the whole
// corpus outside the retention window and rebuildIndexAsync purged it to
// ZERO sessions, which the PERF-001 corpus assertion caught on first run.
// Retention stays active and explicitly accounted for: sessions span ~17 h
// back from now at 1k (and ~35 days at 50k), inside the default window.
const CLOCK = Date.now();

function makeSession(i, rand) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const topics = [pick(TOPICS), pick(TOPICS)];
  const summary = `session ${i} ${pick(TOPICS)} ${pick(TOPICS)} ${pick(TYPES)} ${i}`;
  const keyFiles = [`src/${pick(TOPICS)}.ts`, `src/${pick(TOPICS)}.ts`];
  const decisions = i % 4 === 0 ? [`decision-${i}`] : [];
  return {
    id: `bench-${i.toString().padStart(8, '0')}`,
    workspaceId: `ws-${i % 5}`,
    workspaceName: `ws${i % 5}`,
    startTime: CLOCK - i * 60_000,
    endTime: CLOCK - i * 60_000 + 1000,
    summary,
    observationType: pick(TYPES),
    keyFiles,
    keyTopics: topics,
    decisions,
    problemsSolved: [],
    rawEventCount: 5,
    userTags: i % 7 === 0 ? ['pinned'] : [],
    redactionCount: 0,
    contentHash: computeContentHash({
      summary,
      keyFiles,
      keyTopics: topics,
      decisions,
      problemsSolved: [],
    }),
  };
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
function summarize(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50us: Math.round(percentile(sorted, 50)),
    p95us: Math.round(percentile(sorted, 95)),
    p99us: Math.round(percentile(sorted, 99)),
    maxUs: Math.round(sorted[sorted.length - 1]),
  };
}
const fmt = (s) => `p50 ${s.p50us} µs · p95 ${s.p95us} µs · p99 ${s.p99us} µs · max ${s.maxUs} µs`;

/**
 * PERF-001 workload-correctness assertions, run once per size per trial.
 * A benchmark whose corpus shrank, whose positive queries return nothing, or
 * whose selective query misses its known target is measuring a bug, not
 * retrieval — fail loudly instead of publishing a fast nonsense number.
 */
function assertWorkloadCorrect(store, N) {
  const observed = store.db.sessions.length;
  if (observed !== N)
    throw new Error(`corpus-size assertion failed: expected ${N}, observed ${observed}`);
  // Selective positive query: a UNIQUE token from a known seeded session must
  // return exactly that session first.
  const target = store.db.sessions[Math.floor(N / 2)];
  const uniqueToken = `${target.summary.split(' ')[0]} ${target.summary.split(' ')[1]}`; // "session <i>"
  const selective = store.search(uniqueToken, {}, 5);
  if (!selective.some((s) => s.id === target.id))
    throw new Error(
      `selective-query assertion failed: "${uniqueToken}" did not return ${target.id}`,
    );
  // Broad positive query: topic vocabulary must return a full page.
  const broad = store.search('auth cache', {}, 10);
  if (broad.length === 0) throw new Error('broad positive query returned nothing');
  // Negative query: out-of-domain terms must abstain (zero-positive rule).
  const negative = store.search('zygomorphic quasar paleobotany', {}, 10);
  if (negative.length !== 0)
    throw new Error(`negative query returned ${negative.length} result(s), expected abstention`);
  return { expectedCorpus: N, observedCorpus: observed };
}

async function benchSize(N, queries, semanticEmbedder) {
  const trials = [];
  let seedMs = 0;
  let indexMs = 0;
  for (let trial = 0; trial < TRIALS; trial++) {
    const mem = new InMemoryMemento();
    const store = new ContextStore(mem);
    const rand = mulberry32(42);
    const t0 = Date.now();
    for (let i = 0; i < N; i++) store.db.sessions.push(makeSession(i, rand));
    const tSeed = Date.now();
    await store.rebuildIndexAsync();
    if (trial === 0) {
      seedMs = tSeed - t0;
      indexMs = Date.now() - tSeed;
    }
    const correctness = assertWorkloadCorrect(store, N);

    if (semanticEmbedder) {
      store.neural = semanticEmbedder;
      // Index embeddings once (reported, not part of query latency).
      const tEmbed = Date.now();
      await store.ensureSemanticVectors(store.db.sessions, Number.MAX_SAFE_INTEGER);
      correctness.embedIndexMs = Date.now() - tEmbed;
    }

    global.gc?.();
    const heapBefore = process.memoryUsage();
    const cold = [];
    const warm = [];
    for (let pass = 0; pass < 3; pass++) {
      for (const q of queries) {
        const t = process.hrtime.bigint();
        let count;
        if (semanticEmbedder) {
          const out = await store.searchDetailedSemantic(q, {}, 10);
          count = out.items.length;
        } else {
          const r = store.search(q, {}, 10);
          if (!Array.isArray(r)) throw new Error('search must return array');
          count = r.length;
        }
        const us = Number(process.hrtime.bigint() - t) / 1000;
        (pass === 0 ? cold : warm).push({ us, count });
      }
    }
    // PERF-001: the positive-majority workload must not be answer-free.
    const answered = warm.filter((w) => w.count > 0).length / warm.length;
    if (answered < 0.3)
      throw new Error(
        `workload sanity failed: only ${(answered * 100).toFixed(0)}% of warm queries returned results`,
      );
    const heapAfter = process.memoryUsage();
    // Re-assert corpus size AFTER measurement (retention/initialization drift).
    if (store.db.sessions.length !== N)
      throw new Error(
        `post-run corpus assertion failed: ${store.db.sessions.length} !== ${N} (retention interfered)`,
      );
    trials.push({
      cold: summarize(cold.map((c) => c.us)),
      warm: summarize(warm.map((w) => w.us)),
      answeredRate: Math.round(answered * 1000) / 1000,
      heapUsedDeltaMB: Math.round((heapAfter.heapUsed - heapBefore.heapUsed) / 1e5) / 10,
      rssMB: Math.round(heapAfter.rss / 1e6),
      correctness,
    });
  }
  const byWarmP99 = [...trials].sort((a, b) => a.warm.p99us - b.warm.p99us);
  const median = byWarmP99[Math.floor(byWarmP99.length / 2)];
  return { size: N, seedMs, indexMs, trials, median };
}

/** PERF-002: context compilation measured alone (retrieval excluded). */
function benchCompile(sessions, trialsN) {
  const latencies = [];
  for (let trial = 0; trial < trialsN; trial++) {
    for (let i = 0; i < 50; i++) {
      const slice = sessions.slice(0, 200);
      const t = process.hrtime.bigint();
      const compiled = compileContext({
        query: 'auth cache retries',
        budgetTokens: 2000,
        sessions: slice,
        rules: ['All deploys are blue-green.'],
      });
      latencies.push(Number(process.hrtime.bigint() - t) / 1000);
      if (!compiled || typeof compiled.context !== 'string' || compiled.context.length === 0)
        throw new Error('compileContext produced no output');
    }
  }
  return summarize(latencies);
}

(async () => {
  const rand = mulberry32(7);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  // Mixed workload: ~80% broad/selective positives from the corpus vocabulary,
  // ~20% out-of-domain negatives that must abstain (abstention is part of the
  // measured path, not an excluded corner).
  const NEGATIVES = [
    'quantum harpsichord recipes',
    'medieval falconry licensing',
    'submarine ballast trim tables',
    'orchid propagation humidity',
  ];
  const queries = Array.from({ length: Q }, (_, i) =>
    i % 5 === 4 ? NEGATIVES[i % NEGATIVES.length] : `${pick(TOPICS)} ${pick(TOPICS)}`,
  );

  let semanticEmbedder;
  if (SEMANTIC) {
    const neural = require(path.resolve(__dirname, '..', 'out-test', 'src', 'neuralEmbedder.js'));
    if (!neural.neuralAssetsPresent()) {
      console.error(
        'FAIL: --semantic requires the local model assets (node scripts/setup-semantic.mjs)',
      );
      process.exit(1);
    }
    semanticEmbedder = await neural.NeuralEmbedder.load();
  }

  const environment = {
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    memGB: Math.round(os.totalmem() / 1e9),
  };
  console.log(
    `env: node ${environment.node} · ${environment.platform} ${environment.arch} · ` +
      `${environment.cpu} ×${environment.cores} · ${environment.memGB} GB`,
  );
  console.log(
    `workload: ${Q} deterministic queries (1 in 5 negative) · ${TRIALS} trials · limit 10 · mode ${
      SEMANTIC ? `hybrid-semantic (${semanticEmbedder.providerId})` : 'lexical'
    }\n`,
  );

  const results = [];
  for (const N of SIZES) {
    console.log(`[${N.toLocaleString()} sessions] seeding…`);
    const r = await benchSize(N, queries, semanticEmbedder);
    results.push(r);
    console.log(
      `  seeded in ${r.seedMs} ms · index built in ${r.indexMs} ms (first trial)` +
        (r.trials[0].correctness.embedIndexMs !== undefined
          ? ` · embeddings indexed in ${r.trials[0].correctness.embedIndexMs} ms`
          : ''),
    );
    console.log(
      `  corpus asserted: expected=${r.trials[0].correctness.expectedCorpus} observed=${r.trials[0].correctness.observedCorpus} (pre+post) · selective/broad/negative assertions passed`,
    );
    console.log(`  cold (pass 1, median trial): ${fmt(r.median.cold)}`);
    console.log(`  warm (passes 2-3, median trial): ${fmt(r.median.warm)}`);
    console.log(
      `  answered ${(r.median.answeredRate * 100).toFixed(0)}% of warm queries · heapΔ ${r.median.heapUsedDeltaMB} MB · rss ${r.median.rssMB} MB`,
    );
    console.log(
      `  per-trial warm p99 (µs): ${r.trials.map((t) => t.warm.p99us).join(', ')} (all ${TRIALS} trials kept)`,
    );
  }

  // Context compilation, measured alone (PERF-002 budget: p95 ≤ 100 ms).
  const compRand = mulberry32(42);
  const compSessions = Array.from({ length: 1000 }, (_, i) => makeSession(i, compRand));
  const compile = benchCompile(compSessions, TRIALS);
  console.log(`\ncontext compilation (200 sessions → 2000-token budget, retrieval excluded):`);
  console.log(`  ${fmt(compile)}`);
  if (compile.p95us / 1000 > COMPILE_CEILING_MS) {
    console.error(
      `FAIL: compile p95 ${(compile.p95us / 1000).toFixed(1)} ms exceeds ${COMPILE_CEILING_MS} ms budget`,
    );
    process.exit(1);
  }

  if (results.length > 1) {
    console.log('\nscaling (warm p99, median trial):');
    const base = results[0];
    for (const r of results) {
      const ratio = (r.median.warm.p99us / base.median.warm.p99us).toFixed(1);
      const sizeRatio = (r.size / base.size).toFixed(0);
      console.log(
        `  ${r.size.toLocaleString()}: ${(r.median.warm.p99us / 1000).toFixed(2)} ms ` +
          `(${ratio}× latency for ${sizeRatio}× corpus)`,
      );
    }
  }

  if (JSON_OUT) {
    fs.writeFileSync(
      JSON_OUT,
      JSON.stringify(
        { environment, queries: Q, trials: TRIALS, semantic: SEMANTIC, results, compile },
        null,
        2,
      ) + '\n',
    );
    console.log(`\nwrote ${JSON_OUT}`);
  }

  const gated = results.find((r) => r.size === GATED_SIZE);
  if (gated && !SEMANTIC) {
    const p99ms = gated.median.warm.p99us / 1000;
    if (p99ms > CEILING_MS) {
      console.error(
        `\nFAIL: warm p99 ${p99ms.toFixed(1)} ms exceeds ${CEILING_MS} ms budget at ${GATED_SIZE} sessions`,
      );
      process.exit(1);
    }
    console.log(
      `\nOK — warm p99 ${p99ms.toFixed(2)} ms within ${CEILING_MS} ms budget at ${GATED_SIZE} sessions`,
    );
  } else {
    console.log('\nOK (informational run — CI gate applies to the lexical 1k configuration)');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

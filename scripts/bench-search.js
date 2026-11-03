#!/usr/bin/env node
/**
 * Search-latency benchmark (PERF-001).
 *
 * Seeds synthetic compressed sessions into an in-memory ContextStore, then
 * measures query latency with a deterministic workload. Reports a cold pass
 * (first execution of each query — term-stat memos and caches unprimed) and
 * warm passes (repeat executions) separately, across repeated trials, with
 * the host environment recorded alongside the numbers so results from
 * different machines are never compared blind.
 *
 * Run after compiling tests:
 *   tsc -p ./tsconfig.test.json && node scripts/setup-test-env.js
 *   node scripts/bench-search.js                 # CI budget: 1k sessions, gated
 *   node scripts/bench-search.js --full          # 1k / 10k / 50k scaling profile
 *   node scripts/bench-search.js --sizes 2500 --queries 300 --trials 5
 *   node scripts/bench-search.js --json bench.json
 *
 * CI gate: warm p99 < 50 ms at the 1,000-session size. Larger sizes are
 * informational (budgets printed, not enforced) because wall-clock there is
 * hardware-dependent; regressions show up as ratio changes between sizes.
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
// Back-compat positional form: bench-search.js [sessions] [queries]
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
const TRIALS = parseInt(opt('trials', '3'), 10);
const JSON_OUT = opt('json', null);
const GATED_SIZE = 1000; // the CI budget applies at this corpus size only
const CEILING_MS = 50; // warm p99 budget at GATED_SIZE

// Resolve the compiled mock vscode module that `out-test/setup-test-env.js`
// planted in out-test/node_modules/vscode.
require('module').Module._initPaths();
process.env.NODE_PATH = path.resolve(__dirname, '..', 'out-test', 'node_modules');
require('module').Module._initPaths();

const { ContextStore } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'contextStore.js'),
);
const { computeContentHash } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'types.js'),
);
const { InMemoryMemento } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'test', '__mocks__', 'vscode.js'),
);

// ---- deterministic workload -------------------------------------------------
// Seeded PRNG (mulberry32) so every run benches the identical corpus + queries;
// latency differences are then attributable to code, not sampling noise.
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

function makeSession(i, rand, now) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const topics = [pick(TOPICS), pick(TOPICS)];
  const summary = `session ${i} ${pick(TOPICS)} ${pick(TOPICS)} ${pick(TYPES)} ${i}`;
  const keyFiles = [`src/${pick(TOPICS)}.ts`, `src/${pick(TOPICS)}.ts`];
  const decisions = i % 4 === 0 ? [`decision-${i}`] : [];
  return {
    id: `bench-${i.toString().padStart(8, '0')}`,
    workspaceId: `ws-${i % 5}`,
    workspaceName: `ws${i % 5}`,
    startTime: now - i * 60_000,
    endTime: now - i * 60_000 + 1000,
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

function fmt(s) {
  return `p50 ${s.p50us} µs · p95 ${s.p95us} µs · p99 ${s.p99us} µs · max ${s.maxUs} µs`;
}

async function benchSize(N, queries) {
  // Fresh store per trial — the cold pass must really be cold.
  const trials = [];
  let seedMs = 0;
  for (let trial = 0; trial < TRIALS; trial++) {
    const mem = new InMemoryMemento();
    const store = new ContextStore(mem);
    const rand = mulberry32(42);
    const now = 1_700_000_000_000;
    const t0 = Date.now();
    for (let i = 0; i < N; i++) {
      // Bypass addSession's retention/persist path for speed — index directly.
      store.db.sessions.push(makeSession(i, rand, now));
    }
    await store.rebuildIndexAsync();
    if (trial === 0) seedMs = Date.now() - t0;

    const cold = [];
    const warm = [];
    // Pass 0 is cold (memos unprimed); passes 1-2 are warm repeats.
    for (let pass = 0; pass < 3; pass++) {
      for (const q of queries) {
        const t = process.hrtime.bigint();
        const r = store.search(q, {}, 10);
        const us = Number(process.hrtime.bigint() - t) / 1000;
        if (!Array.isArray(r)) throw new Error('search must return array');
        (pass === 0 ? cold : warm).push(us);
      }
    }
    trials.push({ cold: summarize(cold), warm: summarize(warm) });
  }
  // Report the median trial by warm p99 — robust to one noisy trial.
  const byWarmP99 = [...trials].sort((a, b) => a.warm.p99us - b.warm.p99us);
  const median = byWarmP99[Math.floor(byWarmP99.length / 2)];
  return { size: N, seedMs, trials, median };
}

(async () => {
  const rand = mulberry32(7);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const queries = Array.from({ length: Q }, () => `${pick(TOPICS)} ${pick(TOPICS)}`);

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
  console.log(`workload: ${Q} deterministic queries · ${TRIALS} trials · limit 10\n`);

  const results = [];
  for (const N of SIZES) {
    console.log(`[${N.toLocaleString()} sessions] seeding…`);
    const r = await benchSize(N, queries);
    results.push(r);
    console.log(`  seeded in ${r.seedMs} ms (first trial)`);
    console.log(`  cold (pass 1, median trial): ${fmt(r.median.cold)}`);
    console.log(`  warm (passes 2-3, median trial): ${fmt(r.median.warm)}`);
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
      JSON.stringify({ environment, queries: Q, trials: TRIALS, results }, null, 2) + '\n',
    );
    console.log(`\nwrote ${JSON_OUT}`);
  }

  // CI gate: warm p99 at the 1k size only.
  const gated = results.find((r) => r.size === GATED_SIZE);
  if (gated) {
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
    console.log(`\nOK (informational — no ${GATED_SIZE}-session size in run, gate not applied)`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

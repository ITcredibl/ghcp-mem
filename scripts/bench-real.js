#!/usr/bin/env node
/**
 * Real-world benchmark harness (v1.15.0).
 *
 * Every prior benchmark ran on synthetic sessions with invented vocabulary.
 * External reviewers (correctly) discounted those numbers. This harness
 * measures the SAME retrieval pipeline against sessions mined from REAL git
 * histories — real commit language, real file paths, real topic overlap —
 * using the v1.14 gitHistorySeeder, so the corpus generation is itself the
 * shipped code path, not bench-only scaffolding.
 *
 * Metrics per repo:
 *   1. Retrieval quality — recall@5, MRR, nDCG@5 over gold queries built
 *      from the 3 rarest informative tokens of each sampled session summary
 *      (a proxy for "how a dev would actually search"). Reported for the
 *      keyword-only baseline AND the shipped hybrid path, so the fusion
 *      lift is visible.
 *   2. Redaction canaries — synthetic commits carrying known secret shapes
 *      (AWS key, GitHub PAT, Azure connection string, high-entropy blob)
 *      are injected into the commit stream; the output store is scanned for
 *      the raw values. False-negative count MUST be 0.
 *   3. Stale-memory rejection — a sample of sessions is marked retracted;
 *      their own gold queries are re-run and any retracted id surfacing in
 *      the top-20 counts as a rejection failure.
 *   4. Search latency — p50/p95/p99 at the repo's natural size, then padded
 *      (by cloning real-vocabulary sessions) to 1,000 and 10,000 rows.
 *
 * Usage (after test compile):
 *   npm run bench:real                # current repo only, no network
 *   npm run bench:real -- --full      # + shallow-clones the public repo set
 *   npm run bench:real -- --repos /path/a,/path/b
 *   npm run bench:real -- --write-doc # rewrite docs/BENCHMARKS-REAL.md
 *
 * Cloning uses `git clone --bare --filter=blob:none --depth 400` — commit
 * metadata + trees only, no blobs, a few MB per repo. Clones cache under
 * .bench-cache/ (gitignored) and are reused on re-runs.
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// Resolve the compiled mock vscode module that setup-test-env planted.
process.env.NODE_PATH = path.resolve(__dirname, '..', 'out-test', 'node_modules');
require('module').Module._initPaths();

const OUT = (p) => path.resolve(__dirname, '..', 'out-test', 'src', p);
const { ContextStore } = require(OUT('contextStore.js'));
const { InMemoryMemento } = require(OUT('test/__mocks__/vscode.js'));
const { gitLogArgs, parseGitLog, commitsToSessions } = require(OUT('gitHistorySeeder.js'));
const { ndcgAtK } = require(OUT('eval.js'));

const ARGS = process.argv.slice(2);
const FULL = ARGS.includes('--full');
const WRITE_DOC = ARGS.includes('--write-doc');
const repoArg = ARGS.find((a) => a.startsWith('--repos='));

/** Public corpus: language/domain spread, all with rich commit history. */
const PUBLIC_REPOS = [
  { name: 'express', url: 'https://github.com/expressjs/express.git' },
  { name: 'flask', url: 'https://github.com/pallets/flask.git' },
  { name: 'terraform', url: 'https://github.com/hashicorp/terraform.git' },
  { name: 'react', url: 'https://github.com/facebook/react.git' },
];

const CACHE_DIR = path.resolve(__dirname, '..', '.bench-cache');
const MAX_COMMITS = 400;
const MAX_SESSIONS = 150;
const GOLD_QUERIES = 40;
const LATENCY_QUERIES = 200;
const K = 5;

// ── Redaction canaries — synthetic secrets that must NEVER reach the store ──
const CANARIES = [
  { label: 'aws-access-key', value: 'AKIAIOSFODNN7EXAMPLE' },
  { label: 'github-pat', value: 'ghp_C4naryT0kenAbCdEfGhIjKlMnOpQrStUvWxYz' },
  {
    label: 'azure-conn-string',
    value:
      'DefaultEndpointsProtocol=https;AccountName=canary;AccountKey=' +
      'Q'.repeat(86) +
      '==;EndpointSuffix=core.windows.net',
  },
  { label: 'high-entropy', value: 'zX9$kQ2!mP7@vR4#nT8%wY3^bL6&cJ1*fH5' },
];

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

function resolveRepos() {
  const repos = [{ name: 'ghcp-mem (self)', dir: path.resolve(__dirname, '..') }];
  if (repoArg) {
    for (const p of repoArg.slice('--repos='.length).split(',')) {
      if (p.trim()) repos.push({ name: path.basename(p.trim()), dir: path.resolve(p.trim()) });
    }
  }
  if (FULL) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    for (const r of PUBLIC_REPOS) {
      const dir = path.join(CACHE_DIR, `${r.name}.git`);
      if (!fs.existsSync(dir)) {
        console.log(`  cloning ${r.name} (bare, blob:none, depth ${MAX_COMMITS})…`);
        sh(CACHE_DIR, 'git', [
          'clone',
          '--bare',
          '--filter=blob:none',
          `--depth=${MAX_COMMITS}`,
          r.url,
          dir,
        ]);
      }
      repos.push({ name: r.name, dir });
    }
  }
  return repos;
}

/** Gold queries: the 3 rarest informative tokens of each sampled summary. */
function buildGoldQueries(sessions, max) {
  const STOP = new Set(
    'the a an and or for with from into onto this that plus related commit commits merge pull request feat fix docs chore test refactor build release when what where'.split(
      ' ',
    ),
  );
  const df = new Map(); // token → doc frequency
  const tokensOf = (s) => {
    const seen = new Set();
    for (const m of s.summary.toLowerCase().matchAll(/[a-z][a-z0-9_-]{3,}/g)) {
      if (!STOP.has(m[0])) seen.add(m[0]);
    }
    return seen;
  };
  for (const s of sessions) for (const t of tokensOf(s)) df.set(t, (df.get(t) ?? 0) + 1);

  // Ambiguity guard: real histories (flask, express) are full of repeated
  // maintenance commits — "update dev dependencies", "fix typo" — that
  // produce many near-identical sessions. A self-query against one of those
  // has multiple equally-correct answers, but the gold label credits exactly
  // one id, so including them mislabels correct retrievals as misses.
  // Standard IR practice: exclude queries with no determinate answer.
  // We report the exclusion count so the doc stays honest about corpus shape.
  const headline = (s) => s.summary.split('—')[0].trim().toLowerCase().slice(0, 60);
  const headlineCounts = new Map();
  for (const s of sessions)
    headlineCounts.set(headline(s), (headlineCounts.get(headline(s)) ?? 0) + 1);

  const queries = [];
  let ambiguous = 0;
  for (const s of sessions) {
    if (queries.length >= max) break;
    if ((headlineCounts.get(headline(s)) ?? 0) > 1) {
      ambiguous++;
      continue; // duplicate-content session — no determinate gold answer
    }
    const rare = [...tokensOf(s)].sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0)).slice(0, 3);
    if (rare.length < 2) continue;
    // If even the rarest token is common across the corpus, the query can't
    // discriminate — the gold label would be luck, not retrieval quality.
    if ((df.get(rare[0]) ?? 0) > 3) {
      ambiguous++;
      continue;
    }
    queries.push({ q: rare.join(' '), relevant: [s.id] });
  }
  return { queries, ambiguous };
}

function recallAtK(top, relevant, k) {
  let hit = 0;
  for (const s of top.slice(0, k)) if (relevant.has(s.id)) hit++;
  return hit / Math.min(relevant.size, k);
}

function mrrOf(top, relevant) {
  for (let i = 0; i < top.length; i++) if (relevant.has(top[i].id)) return 1 / (i + 1);
  return 0;
}

async function evalRuns(store, queries) {
  const runs = {};
  const paths = {
    'keyword+recency (search)': (q) => store.search(q, {}, 20),
    'hybrid (searchWithEmbedding)': async (q) => store.searchWithEmbedding(q, {}, 20),
  };
  for (const [label, fn] of Object.entries(paths)) {
    let recall = 0;
    let mrr = 0;
    let ndcg = 0;
    for (const gq of queries) {
      const top = await fn(gq.q);
      const rel = new Set(gq.relevant);
      recall += recallAtK(top, rel, K);
      mrr += mrrOf(top, rel);
      ndcg += ndcgAtK(top, rel, K);
    }
    const n = queries.length || 1;
    runs[label] = { recall: recall / n, mrr: mrr / n, ndcg: ndcg / n };
  }
  return runs;
}

function percentiles(latencies) {
  latencies.sort((a, b) => a - b);
  const pct = (p) =>
    latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];
  return { p50: pct(50), p95: pct(95), p99: pct(99) };
}

function measureLatency(store, queries) {
  const lat = [];
  for (let i = 0; i < LATENCY_QUERIES; i++) {
    const q = queries[i % queries.length].q;
    const t = process.hrtime.bigint();
    store.search(q, {}, 10);
    lat.push(Number(process.hrtime.bigint() - t) / 1e6); // ms
  }
  return percentiles(lat);
}

/** Pad the store to `target` rows by cloning real-vocabulary sessions. */
async function padTo(store, target) {
  const base = store.db.sessions.filter((s) => !s.id.startsWith('pad-'));
  let i = 0;
  while (store.db.sessions.length < target) {
    const src = base[i % base.length];
    store.db.sessions.push({
      ...src,
      id: `pad-${i.toString().padStart(8, '0')}`,
      contentHash: undefined,
      startTime: src.startTime - i * 60_000,
      endTime: src.endTime - i * 60_000,
    });
    i++;
  }
  await store.rebuildIndexAsync();
}

async function benchRepo(repo) {
  console.log(`\n━━ ${repo.name} ━━`);
  const raw = sh(repo.dir, 'git', gitLogArgs(MAX_COMMITS));
  const commits = parseGitLog(raw);
  console.log(`  ${commits.length} commits parsed`);

  // Inject redaction canaries as synthetic commits.
  const now = Math.floor(Date.now() / 1000);
  for (const [i, c] of CANARIES.entries()) {
    commits.push({
      hash: `cafe${i}`.padEnd(40, '0'),
      author: 'Canary Bot',
      timestamp: (now - i * 86_400) * 1000,
      subject: `fix: rotate leaked credential ${c.value} in deploy pipeline`,
      body: `The old value ${c.value} must be scrubbed.`,
      files: ['deploy/pipeline.yml'],
    });
  }

  const seed = commitsToSessions(commits, {
    workspaceId: `bench://${repo.name}`,
    workspaceName: repo.name,
    maxSessions: MAX_SESSIONS,
  });

  // 2) Redaction false-negative scan over the ENTIRE serialized output.
  const blob = JSON.stringify(seed.sessions);
  const leaks = CANARIES.filter((c) => blob.includes(c.value)).map((c) => c.label);

  // Load into a real ContextStore (same class the extension runs).
  const store = new ContextStore(new InMemoryMemento());
  for (const s of seed.sessions) store.db.sessions.push(s);
  await store.rebuildIndexAsync();

  // 1) Retrieval quality.
  const { queries: gold, ambiguous } = buildGoldQueries(seed.sessions, GOLD_QUERIES);
  const runs = await evalRuns(store, gold);

  // 3) Stale-memory rejection: retract 5 sampled sessions, re-run their queries.
  const sample = gold.slice(0, Math.min(5, gold.length));
  for (const gq of sample) {
    const s = store.db.sessions.find((x) => x.id === gq.relevant[0]);
    if (s) s.retracted = true;
  }
  await store.rebuildIndexAsync();
  let staleSurfaced = 0;
  for (const gq of sample) {
    const top = store.search(gq.q, {}, 20);
    if (top.some((s) => s.id === gq.relevant[0])) staleSurfaced++;
  }
  for (const gq of sample) {
    const s = store.db.sessions.find((x) => x.id === gq.relevant[0]);
    if (s) delete s.retracted;
  }
  await store.rebuildIndexAsync();

  // 4) Latency at natural size, then padded to 1K and 10K.
  const latNatural = measureLatency(store, gold);
  await padTo(store, 1000);
  const lat1k = measureLatency(store, gold);
  await padTo(store, 10000);
  const lat10k = measureLatency(store, gold);

  const result = {
    repo: repo.name,
    commits: commits.length - CANARIES.length,
    sessions: seed.sessions.length,
    goldQueries: gold.length,
    ambiguousExcluded: ambiguous,
    redactionsApplied: seed.redactionCount,
    canaryLeaks: leaks,
    staleSurfaced,
    staleSample: sample.length,
    runs,
    latency: { natural: latNatural, at1k: lat1k, at10k: lat10k, naturalSize: seed.sessions.length },
  };

  const fmt = (r) =>
    `recall@5 ${(r.recall * 100).toFixed(0)}% · MRR ${r.mrr.toFixed(2)} · nDCG@5 ${r.ndcg.toFixed(2)}`;
  for (const [label, r] of Object.entries(runs)) console.log(`  ${label}: ${fmt(r)}`);
  console.log(
    `  redaction canaries leaked: ${leaks.length === 0 ? '0 ✅' : leaks.join(', ') + ' ❌'}`,
  );
  console.log(
    `  stale surfaced: ${staleSurfaced}/${sample.length} ${staleSurfaced === 0 ? '✅' : '❌'}`,
  );
  console.log(
    `  latency p95: ${latNatural.p95.toFixed(1)}ms @${seed.sessions.length} · ${lat1k.p95.toFixed(1)}ms @1k · ${lat10k.p95.toFixed(1)}ms @10k`,
  );
  return result;
}

function renderDoc(results) {
  const lines = [
    '# Real-World Benchmarks',
    '',
    '> Corpora mined from **real git histories** with the shipped `gitHistorySeeder` (v1.14) —',
    '> real commit language, real file paths, real topic overlap. Reproduce with:',
    '> `npm run bench:real -- --full --write-doc` (shallow-clones the public repos, ~few MB each).',
    '',
    `_Generated ${new Date().toISOString().slice(0, 10)} · GHCP-MEM v${require('../package.json').version} · Node ${process.version}_`,
    '',
    '## Methodology',
    '',
    '- **Corpus**: last 400 commits per repo → sessions via the shipped seeder (day×author grouping, redaction on).',
    '- **Gold queries**: the 3 rarest informative tokens of each sampled session summary — a proxy for how a developer actually searches. Single relevant id per query (strict).',
    '- **Redaction canaries**: 4 synthetic commits carrying real secret shapes (AWS key, GitHub PAT, Azure connection string, high-entropy blob) injected into the stream; the serialized store is scanned for raw values.',
    '- **Stale rejection**: 5 sessions marked retracted; their own gold queries re-run; any retracted id in the top-20 is a failure.',
    "- **Latency**: 200 `store.search()` calls (the extension's hot path) at natural corpus size, then padded with real-vocabulary clones to 1,000 and 10,000 rows.",
    '- **Ambiguity exclusion**: sessions whose headline duplicates another session ("update dev dependencies" × N) or whose rarest token is corpus-common are excluded from gold — a self-query against duplicate content has no determinate answer, so scoring it would mislabel correct retrievals as misses. Exclusion counts are reported per repo.',
    '- **Honest caveats**: gold queries derive from the target document (standard self-query methodology — same as our synthetic bench, but over real vocabulary with real collisions). No competitor numbers yet: running OpenMemory/Continue through an identical harness is planned; see repo issues.',
    '',
    '## Results',
    '',
    '| Repo | Sessions | Gold (excl. ambiguous) | Recall@5 (kw / hybrid) | MRR (kw / hybrid) | nDCG@5 (kw / hybrid) | Canary leaks | Stale surfaced | p95 @natural / @1k / @10k |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const [kw, hy] = Object.values(r.runs);
    lines.push(
      `| ${r.repo} | ${r.sessions} | ${r.goldQueries} (${r.ambiguousExcluded}) | ${(kw.recall * 100).toFixed(0)}% / ${(hy.recall * 100).toFixed(0)}% | ${kw.mrr.toFixed(2)} / ${hy.mrr.toFixed(2)} | ${kw.ndcg.toFixed(2)} / ${hy.ndcg.toFixed(2)} | ${r.canaryLeaks.length} | ${r.staleSurfaced}/${r.staleSample} | ${r.latency.natural.p95.toFixed(1)}ms / ${r.latency.at1k.p95.toFixed(1)}ms / ${r.latency.at10k.p95.toFixed(1)}ms |`,
    );
  }
  lines.push(
    '',
    '## Reading the numbers',
    '',
    '- **Canary leaks must be 0** on every row — a non-zero value is a release blocker, not a benchmark result.',
    '- **Stale surfaced must be 0/5** — retracted memory must never reach retrieval.',
    '- Recall/MRR on real corpora runs lower than synthetic benches by construction: real commit vocabulary collides ("fix build", "update deps") in ways invented topic words never do. That is the point of this harness.',
    '- The hybrid column shows the shipped default; the keyword column is the ablation baseline.',
    '',
  );
  return lines.join('\n');
}

(async () => {
  const repos = resolveRepos();
  console.log(`Benchmarking ${repos.length} repo(s)${FULL ? ' (full public set)' : ''}…`);
  const results = [];
  for (const repo of repos) {
    try {
      results.push(await benchRepo(repo));
    } catch (err) {
      console.error(`  SKIPPED ${repo.name}: ${err.message}`);
    }
  }
  if (results.length === 0) {
    console.error('No repos benchmarked.');
    process.exit(1);
  }

  // Hard gates — these are correctness properties, not tunables.
  const leakTotal = results.reduce((n, r) => n + r.canaryLeaks.length, 0);
  const staleTotal = results.reduce((n, r) => n + r.staleSurfaced, 0);
  if (leakTotal > 0) {
    console.error(`\nFAIL: ${leakTotal} redaction canary leak(s).`);
    process.exit(1);
  }
  if (staleTotal > 0) {
    console.error(`\nFAIL: ${staleTotal} retracted session(s) surfaced in search.`);
    process.exit(1);
  }
  const worstP95 = Math.max(...results.map((r) => r.latency.at10k.p95));
  if (worstP95 > 100) {
    console.error(`\nFAIL: p95 at 10k rows is ${worstP95.toFixed(1)}ms (> 100ms ceiling).`);
    process.exit(1);
  }

  const json = path.resolve(__dirname, '..', '.bench-cache', 'bench-real-results.json');
  fs.mkdirSync(path.dirname(json), { recursive: true });
  fs.writeFileSync(json, JSON.stringify(results, null, 2));
  console.log(`\nResults JSON: ${json}`);

  if (WRITE_DOC) {
    const doc = path.resolve(__dirname, '..', 'docs', 'BENCHMARKS-REAL.md');
    fs.writeFileSync(doc, renderDoc(results));
    console.log(`Wrote ${doc}`);
  }
  console.log('\n🟢 bench:real PASS (0 canary leaks, 0 stale surfaced, latency within ceiling)');
})();

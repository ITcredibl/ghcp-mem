#!/usr/bin/env node
/**
 * Eval regression gate.
 *
 * Seeds a deterministic synthetic corpus into an in-memory ContextStore,
 * builds self-queries (the same way the in-extension eval command does),
 * then asserts recall@5 / MRR / nDCG@5 meet the floor in
 * scripts/eval-baseline.json (within tolerancePct slack).
 *
 * Designed to fail CI if a ranker change silently regresses retrieval.
 *
 * Optional: pass `--gold <path>` to use a hand-curated gold corpus file
 * (see scripts/eval-gold.json for the schema). The gate then evaluates
 * against the gold set instead of synthetic self-queries.
 *
 * Usage:
 *   node scripts/eval-check.js
 *   node scripts/eval-check.js --gold scripts/eval-gold.json
 */
const path = require('path');
const fs = require('fs');

const baseline = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'eval-baseline.json'), 'utf8'));
const tolerance = (baseline.tolerancePct ?? 5) / 100;

const { ContextStore } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'contextStore.js'),
);
const { computeContentHash } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'types.js'),
);
const { runEvalSuite, runGoldEval } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'eval.js'),
);
const { InMemoryMemento } = require(
  path.resolve(__dirname, '..', 'out-test', 'src', 'test', '__mocks__', 'vscode.js'),
);

// Optional --gold <path> flag for hand-curated corpus mode.
const goldFlagIdx = process.argv.indexOf('--gold');
const goldPath = goldFlagIdx !== -1 ? process.argv[goldFlagIdx + 1] : undefined;

// Deterministic seed corpus: 12 sessions with distinct topics so each query
// has exactly one "relevant" session — keyword search must rank it first.
const CORPUS = [
  {
    topic: 'reciprocal-rank-fusion',
    file: 'contextStore.ts',
    summary: 'Implemented RRF k=60 ranker for hybrid keyword+recency',
  },
  {
    topic: 'azure-storage-connection-string',
    file: 'redactor.ts',
    summary: 'Added Azure storage conn string redaction rule',
  },
  {
    topic: 'jwt-bearer-token-redaction',
    file: 'redactor.ts',
    summary: 'JWT and Bearer token redaction patterns',
  },
  {
    topic: 'mcp-stdio-server',
    file: 'mcpServer.ts',
    summary: 'Implemented stdio MCP server with 4 tools',
  },
  {
    topic: 'session-tree-pinned-tier',
    file: 'sessionsView.ts',
    summary: 'Added pinned tier above date groups in tree view',
  },
  {
    topic: 'walkthrough-onboarding',
    file: 'package.json',
    summary: 'Added VS Code walkthroughs contribution for first-run UX',
  },
  {
    topic: 'github-compatible-mode',
    file: 'types.ts',
    summary: 'Mirror Copilot 28-day retention and repo scoping',
  },
  {
    topic: 'repo-scope-mtime-invalidation',
    file: 'repoScope.ts',
    summary: 'Cache invalidated by .git/config mtime',
  },
  {
    topic: 'markdown-export-diff-friendly',
    file: 'markdownExport.ts',
    summary: 'Diff-friendly session markdown export',
  },
  {
    topic: 'inverted-index-search',
    file: 'contextStore.ts',
    summary: 'Inverted index over tokens for O(1) candidate retrieval',
  },
  {
    topic: 'embedding-cosine-similarity',
    file: 'embeddings.ts',
    summary: 'Cosine sim over local embeddings as RRF input',
  },
  {
    topic: 'health-score-redaction-coverage',
    file: 'health.ts',
    summary: 'Memory health score with redaction coverage and retention headroom',
  },
];

// Optional --corpus <path>: seed from an external corpus file (EVAL-001)
// instead of the built-in 12-session CORPUS. Sessions may carry repoScope,
// supersession links etc.; timestamps are assigned deterministically.
const corpusFlagIdx = process.argv.indexOf('--corpus');
const corpusPath = corpusFlagIdx !== -1 ? process.argv[corpusFlagIdx + 1] : undefined;
// Optional --pipeline mcp|semantic: evaluate the PRODUCTION stdio pipeline
// directly, in addition to the extension-store configurations. 'mcp' is the
// lexical pipeline (searchSessionsDetailed); 'semantic' additionally runs the
// hybrid-semantic pipeline (searchSessionsSemantic) with the LOCAL neural
// provider — it requires the pinned model assets (ghcpMem.setupSemantic /
// scripts/setup-semantic.mjs) and fails with a clear message otherwise.
const pipelineIdx = process.argv.indexOf('--pipeline');
const pipelineArg = pipelineIdx !== -1 ? process.argv[pipelineIdx + 1] : undefined;
const evalMcpPipeline = pipelineArg === 'mcp' || pipelineArg === 'semantic';
const evalSemanticPipeline = pipelineArg === 'semantic';

(async () => {
  const mem = new InMemoryMemento();
  const store = new ContextStore(mem);

  let externalSessions;
  if (corpusPath) {
    const corpus = JSON.parse(fs.readFileSync(path.resolve(corpusPath), 'utf8'));
    externalSessions = corpus.sessions.map((c, i) => ({
      startTime: Date.now() - (corpus.sessions.length - i) * 60_000,
      endTime: Date.now() - (corpus.sessions.length - i) * 60_000 + 1000,
      problemsSolved: [],
      userTags: [],
      rawEventCount: 5,
      redactionCount: 0,
      ...c,
      contentHash: computeContentHash({
        summary: c.summary,
        keyFiles: c.keyFiles ?? [],
        keyTopics: c.keyTopics ?? [],
        decisions: c.decisions ?? [],
        problemsSolved: [],
      }),
    }));
    for (const sess of externalSessions) store.db.sessions.push(sess);
    console.log(
      `  corpus: ${corpusPath} (${corpus.version ?? 'unversioned'}, ${externalSessions.length} sessions)`,
    );
  }

  for (let i = 0; !corpusPath && i < CORPUS.length; i++) {
    const c = CORPUS[i];
    const session = {
      id: `eval-${i.toString().padStart(4, '0')}`,
      workspaceId: 'ws',
      workspaceName: 'ws',
      startTime: Date.now() - (CORPUS.length - i) * 60_000,
      endTime: Date.now() - (CORPUS.length - i) * 60_000 + 1000,
      summary: c.summary,
      observationType: 'feature',
      keyFiles: [`src/${c.file}`],
      keyTopics: [c.topic],
      decisions: [],
      problemsSolved: [],
      rawEventCount: 5,
      userTags: [],
      redactionCount: 0,
      contentHash: computeContentHash({
        summary: c.summary,
        keyFiles: [`src/${c.file}`],
        keyTopics: [c.topic],
        decisions: [],
        problemsSolved: [],
      }),
    };
    store.db.sessions.push(session);
  }
  await store.rebuildIndexAsync();

  const report = goldPath
    ? await runGoldEval(store, JSON.parse(fs.readFileSync(path.resolve(goldPath), 'utf8')).queries)
    : await runEvalSuite(store);
  if (evalMcpPipeline && goldPath) {
    // Evaluate the production stdio pipeline directly over the same sessions.
    const { searchSessionsDetailed } = require(
      path.resolve(__dirname, '..', 'out-test', 'src', 'mcpServer.js'),
    );
    const db = { version: 2, lastUpdated: 0, sessions: store.getAllSessions() };
    const queries = JSON.parse(fs.readFileSync(path.resolve(goldPath), 'utf8')).queries;
    const { runGoldEvalAgainst } = require(
      path.resolve(__dirname, '..', 'out-test', 'src', 'eval.js'),
    );
    report.runs.push(
      await runGoldEvalAgainst('mcp pipeline (local-lexical/1)', queries, (q) =>
        searchSessionsDetailed(db, q, {}, 20).items.map((item) => item.session),
      ),
    );
    if (evalSemanticPipeline) {
      const neural = require(path.resolve(__dirname, '..', 'out-test', 'src', 'neuralEmbedder.js'));
      if (!neural.neuralAssetsPresent()) {
        console.error(
          'FAIL: --pipeline semantic requires the pinned local model assets.\n' +
            '  Install them with: node scripts/setup-semantic.mjs  (~35 MB, checksum-verified)',
        );
        process.exit(1);
      }
      const { searchSessionsSemantic, ensureSemanticVectors } = require(
        path.resolve(__dirname, '..', 'out-test', 'src', 'mcpServer.js'),
      );
      const embedder = await neural.NeuralEmbedder.load();
      // Pre-embed the whole corpus so the measurement covers retrieval, not
      // cold-cache embedding throughput.
      await ensureSemanticVectors(db.sessions, embedder, Number.MAX_SAFE_INTEGER);
      report.runs.push(
        await runGoldEvalAgainst('mcp semantic (onnx-minilm-q8)', queries, async (q) =>
          (await searchSessionsSemantic(db, q, {}, 20, { embedder })).items.map(
            (item) => item.session,
          ),
        ),
      );
    }
  }
  // EVAL-001 provenance: pin what produced these numbers.
  try {
    const { execFileSync } = require('node:child_process');
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    console.log(
      `  provenance: commit=${commit} · embeddings=local-lexical/1 (headless) · k=${report.k}`,
    );
  } catch {
    /* outside a git checkout */
  }
  if (!report.runs.length) {
    console.error('FAIL: eval produced no runs');
    process.exit(1);
  }

  // Synthetic self-queries and the hand-curated gold corpus measure on
  // different scales (gold is deliberately harder), so each mode carries its
  // own committed floor map.
  // Optional --floors-key <name> selects a named floor map (e.g. the held-out
  // paraphrase set measures on a very different scale from the keyword gold set).
  const floorsKeyIdx = process.argv.indexOf('--floors-key');
  const floorsKey =
    floorsKeyIdx !== -1 ? process.argv[floorsKeyIdx + 1] : goldPath ? 'goldFloors' : 'floors';
  const floorMap = baseline[floorsKey];
  if (!floorMap) {
    console.error(`FAIL: scripts/eval-baseline.json has no "${floorsKey}" map for this eval mode`);
    process.exit(1);
  }

  let failed = false;
  for (const run of report.runs) {
    const floor = floorMap[run.label];
    if (!floor) {
      // v1.18.3: a production retrieval configuration without a committed
      // baseline is a gate failure, not a skip — otherwise regressions in the
      // default pipeline sail through while only the keyword baseline is
      // protected.
      console.error(
        `  [FAIL] ${run.label}: recall@${run.k}=${run.recall.toFixed(3)} · MRR=${run.mrr.toFixed(3)} · nDCG@${run.k}=${run.ndcg.toFixed(3)} — no committed baseline in scripts/eval-baseline.json`,
      );
      failed = true;
      continue;
    }
    const recallMin = floor.recall * (1 - tolerance);
    const mrrMin = floor.mrr * (1 - tolerance);
    const ndcgMin = (floor.ndcg ?? 0) * (1 - tolerance);
    const recallOk = run.recall >= recallMin;
    const mrrOk = run.mrr >= mrrMin;
    const ndcgOk = floor.ndcg === undefined || run.ndcg >= ndcgMin;
    const ok = recallOk && mrrOk && ndcgOk;
    const tag = ok ? 'OK  ' : 'FAIL';
    const extras =
      run.precision !== undefined
        ? ` · precision=${run.precision.toFixed(3)} · abstain=${run.abstentionRate.toFixed(3)}${run.negatives > 0 ? ` · falsePos=${run.falsePositiveRate.toFixed(3)} (${run.negatives} neg)` : ''}`
        : '';
    console.log(
      `  [${tag}] ${run.label}: recall@${run.k}=${run.recall.toFixed(3)} (floor ${recallMin.toFixed(3)}) · MRR=${run.mrr.toFixed(3)} (floor ${mrrMin.toFixed(3)}) · nDCG@${run.k}=${run.ndcg.toFixed(3)}${floor.ndcg !== undefined ? ` (floor ${ndcgMin.toFixed(3)})` : ''}${extras}`,
    );
    // EVAL-001: confidence intervals, sample counts, category-level recall.
    if (run.ci && run.positives > 0) {
      const perKind = Object.entries(run.perKind ?? {})
        .sort()
        .map(([kind, v]) => `${kind} ${(v.recall * 100).toFixed(0)}% (n=${v.n})`)
        .join(' · ');
      console.log(
        `         n=${run.positives}+${run.negatives}neg · recall 95% CI [${run.ci.recall[0].toFixed(3)}, ${run.ci.recall[1].toFixed(3)}] · MRR 95% CI [${run.ci.mrr[0].toFixed(3)}, ${run.ci.mrr[1].toFixed(3)}]${perKind ? `\n         by category: ${perKind}` : ''}`,
      );
    }
    const fpOk =
      floor.maxFalsePositiveRate === undefined ||
      run.falsePositiveRate <= floor.maxFalsePositiveRate;
    if (!fpOk) {
      console.error(
        `         falsePositiveRate ${run.falsePositiveRate.toFixed(3)} exceeds ceiling ${floor.maxFalsePositiveRate}`,
      );
    }
    if ((!ok || !fpOk) && run.failures?.length) {
      for (const f of run.failures.slice(0, 8))
        console.error(`         ✗ [${f.kind ?? '?'}] "${f.q}" — ${f.reason}`);
      if (run.failures.length > 8)
        console.error(`         … ${run.failures.length - 8} more failing queries`);
    }
    if (!ok || !fpOk) failed = true;
  }
  if (failed) {
    console.error(
      'Eval regression detected. Investigate ranker changes or update scripts/eval-baseline.json after deliberate improvements.',
    );
    process.exit(1);
  }
  console.log('Eval gate passed.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

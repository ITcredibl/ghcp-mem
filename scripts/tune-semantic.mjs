#!/usr/bin/env node
/* eslint-disable no-console */
//
// DEV-SET threshold tuning for semantic retrieval (RET-003: thresholds are
// selected on development data — this script — and validated once on the
// frozen set). Prints similarity distributions for relevant pairs, hard
// negatives (labeled negative queries vs their top session) and random
// off-target pairs, plus a sweep of candidate/match floors against recall and
// false-positive impact. NEVER run this against the frozen set.
//
// Usage: tsc -p ./tsconfig.test.json && node scripts/tune-semantic.mjs \
//          scripts/eval-corpus-v2.json scripts/eval-dev.json
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(import.meta.url);
const neural = req(resolve(root, 'out-test', 'src', 'neuralEmbedder.js'));
const { cosineSim } = req(resolve(root, 'out-test', 'src', 'vectorMath.js'));

const corpusPath = process.argv[2] ?? 'scripts/eval-corpus-v2.json';
const goldPath = process.argv[3] ?? 'scripts/eval-dev.json';
const corpus = JSON.parse(fs.readFileSync(resolve(root, corpusPath), 'utf8'));
const gold = JSON.parse(fs.readFileSync(resolve(root, goldPath), 'utf8'));

const embedder = await neural.NeuralEmbedder.load();
console.log(`provider: ${embedder.providerId}`);
console.log(`corpus: ${corpus.sessions.length} sessions · queries: ${gold.queries.length}`);

const sessionVec = new Map();
for (const s of corpus.sessions) {
  sessionVec.set(
    s.id,
    await embedder.embed(
      neural.sessionEmbedText({
        summary: s.summary,
        keyTopics: s.keyTopics ?? [],
        decisions: s.decisions ?? [],
      }),
    ),
  );
}

const rel = []; // sims of (query, labeled-relevant session)
const negMax = []; // max sim of each NEGATIVE query to any session
const offTarget = []; // sims of (positive query, non-relevant session)
const perKind = new Map();
for (const q of gold.queries) {
  const qv = await embedder.embed(q.q ?? q.query);
  const sims = new Map();
  for (const [id, v] of sessionVec) sims.set(id, cosineSim(qv, v));
  const relevant = new Set(q.relevant ?? []);
  if (relevant.size === 0) {
    negMax.push(Math.max(...sims.values()));
    continue;
  }
  for (const id of relevant) {
    if (!sims.has(id)) continue;
    rel.push(sims.get(id));
    const bucket = perKind.get(q.kind ?? 'unkinded') ?? [];
    bucket.push(sims.get(id));
    perKind.set(q.kind ?? 'unkinded', bucket);
  }
  for (const [id, sim] of sims) if (!relevant.has(id)) offTarget.push(sim);
}

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (arr) =>
  `n=${arr.length} p5=${pct(arr, 5).toFixed(3)} p25=${pct(arr, 25).toFixed(3)} p50=${pct(arr, 50).toFixed(3)} p75=${pct(arr, 75).toFixed(3)} p95=${pct(arr, 95).toFixed(3)}`;

console.log(`\nrelevant-pair sims:   ${fmt(rel)}`);
console.log(`negative-query MAX:   ${fmt(negMax)}`);
console.log(`off-target sims:      ${fmt(offTarget)}`);
for (const [kind, arr] of [...perKind.entries()].sort()) {
  console.log(`  relevant [${kind}]: ${fmt(arr)}`);
}

console.log(
  '\nmatch-floor sweep (semantic alone): floor → %relevant ≥ floor | %negMax ≥ floor (would serve a negative)',
);
for (const floor of [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5]) {
  const r = rel.filter((x) => x >= floor).length / rel.length;
  const n = negMax.filter((x) => x >= floor).length / negMax.length;
  console.log(
    `  ${floor.toFixed(2)} → relevant ${(r * 100).toFixed(1)}% | negatives served ${(n * 100).toFixed(1)}%`,
  );
}

// ---------------------------------------------------------------------------
// Full-pipeline sweep: run the REAL hybrid pipeline (searchSessionsSemantic)
// per threshold combination against the dev set; report recall@5 / MRR / FP /
// abstention plus per-kind recall, so thresholds are chosen on end-to-end
// behavior, not on pairwise sims.
// ---------------------------------------------------------------------------
const { searchSessionsSemantic, ensureSemanticVectors } = req(
  resolve(root, 'out-test', 'src', 'mcpServer.js'),
);
const retrievalMod = req(resolve(root, 'out-test', 'src', 'retrieval.js'));
const { computeContentHash } = req(resolve(root, 'out-test', 'src', 'types.js'));

const sessions = corpus.sessions.map((c, i) => ({
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
const db = { version: 2, lastUpdated: 0, sessions };
await ensureSemanticVectors(sessions, embedder, Number.MAX_SAFE_INTEGER);

async function evalCombo(t) {
  retrievalMod._setSemanticThresholdsForTuning(t);
  let recalled = 0,
    mrr = 0,
    pos = 0,
    fp = 0,
    neg = 0,
    abstain = 0;
  const kindTotals = new Map(),
    kindHits = new Map();
  for (const q of gold.queries) {
    const out = await searchSessionsSemantic(db, q.q ?? q.query, {}, 5, { embedder });
    const ids = out.items.map((it) => it.session.id);
    const relevant = new Set(q.relevant ?? []);
    if (relevant.size === 0) {
      neg++;
      if (out.state !== 'no_match' && ids.length > 0) fp++;
      continue;
    }
    pos++;
    if (out.state === 'no_match') abstain++;
    const kind = q.kind ?? 'unkinded';
    kindTotals.set(kind, (kindTotals.get(kind) ?? 0) + 1);
    const hitIdx = ids.findIndex((id) => relevant.has(id));
    if (hitIdx !== -1) {
      recalled++;
      mrr += 1 / (hitIdx + 1);
      kindHits.set(kind, (kindHits.get(kind) ?? 0) + 1);
    }
  }
  const perKindStr = [...kindTotals.entries()]
    .sort()
    .map(([k, n]) => `${k} ${(((kindHits.get(k) ?? 0) / n) * 100).toFixed(0)}%`)
    .join(' · ');
  console.log(
    `  cand=${t.candidate} weak=${t.weak} match=${t.match} → recall@5=${(recalled / pos).toFixed(3)} MRR=${(mrr / pos).toFixed(3)} abstain=${(abstain / pos).toFixed(3)} FP=${(fp / neg).toFixed(3)} | ${perKindStr}`,
  );
}

console.log('\nfull-pipeline sweep (dev set):');
for (const combo of [
  { candidate: 0.25, weak: 0.25, match: 0.4 },
  { candidate: 0.25, weak: 0.25, match: 0.45 },
  { candidate: 0.25, weak: 0.25, match: 0.5 },
  { candidate: 0.3, weak: 0.3, match: 0.45 },
  { candidate: 0.3, weak: 0.3, match: 0.5 },
  { candidate: 0.3, weak: 0.3, match: 0.55 },
  { candidate: 0.35, weak: 0.35, match: 0.5 },
  { candidate: 0.2, weak: 0.2, match: 0.45 },
]) {
  await evalCombo(combo);
}

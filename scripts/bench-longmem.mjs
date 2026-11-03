#!/usr/bin/env node
/* eslint-disable no-console */
//
// LongMemEval retrieval adapter (v1.20.0).
//
// The agent-memory market now reports LoCoMo / LongMemEval numbers. This
// harness lets GHCP-MEM speak that language HONESTLY: it ingests a local copy
// of the LongMemEval dataset (each haystack session becomes one memory row)
// and measures the RETRIEVAL LAYER — does search surface the sessions that
// contain the answer evidence?
//
// What it reports:  Recall@k and MRR over `answer_session_ids`.
// What it is NOT:   end-to-end LongMemEval QA accuracy. There is no LLM judge
//                   and no answer generation here, so the numbers are not
//                   comparable to published "LongMemEval accuracy" scores.
//                   Do not quote them as such.
//
// The dataset is not vendored (it is large and third-party). Get it from the
// LongMemEval authors (https://github.com/xiaowu0162/LongMemEval — e.g.
// longmemeval_s.json) and run:
//
//   npm run bench:longmem -- --dataset /path/to/longmemeval_s.json
//   npm run bench:longmem -- --dataset ... --k 10 --limit 50
//
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const datasetPath = arg('dataset');
const k = Math.max(1, Math.min(25, Number(arg('k', '5'))));
const limit = Math.max(1, Number(arg('limit', '100000')));

if (!datasetPath || !existsSync(datasetPath)) {
  console.error(
    [
      '[bench-longmem] no dataset supplied.',
      'Download LongMemEval (e.g. longmemeval_s.json) from the authors:',
      '  https://github.com/xiaowu0162/LongMemEval',
      'then run:  npm run bench:longmem -- --dataset /path/to/longmemeval_s.json',
    ].join('\n'),
  );
  process.exit(1);
}

const { searchSessions } = await import(
  `file://${resolve(root, 'out-test', 'src', 'mcpServer.js')}`
).catch(() => {
  console.error('[bench-longmem] compile first: tsc -p ./tsconfig.test.json');
  process.exit(1);
});

const MAX_SESSION_CHARS = 4000;

/** One haystack session → one memory row (summary truncated and labeled so). */
function toSession(turns, id, date) {
  const text = (Array.isArray(turns) ? turns : [])
    .map((turn) => `${turn.role}: ${turn.content}`)
    .join('\n');
  return {
    id,
    workspaceId: 'longmemeval',
    workspaceName: 'longmemeval',
    startTime: Date.parse(date ?? '') || 0,
    endTime: Date.parse(date ?? '') || 0,
    summary: text.slice(0, MAX_SESSION_CHARS),
    observationType: 'research',
    keyFiles: [],
    keyTopics: [],
    decisions: [],
    problemsSolved: [],
    userTags: [],
    rawEventCount: Array.isArray(turns) ? turns.length : 0,
    redactionCount: 0,
  };
}

const instances = JSON.parse(readFileSync(datasetPath, 'utf8'));
if (!Array.isArray(instances)) {
  console.error('[bench-longmem] expected a JSON array of LongMemEval instances');
  process.exit(1);
}

let evaluated = 0;
let truncatedSessions = 0;
let recallHits = 0;
let mrrSum = 0;
const byType = new Map();

for (const instance of instances.slice(0, limit)) {
  const answerIds = new Set(instance.answer_session_ids ?? []);
  const sessions = (instance.haystack_sessions ?? []).map((turns, index) => {
    const id = instance.haystack_session_ids?.[index] ?? `s${index}`;
    const date = instance.haystack_dates?.[index];
    const row = toSession(turns, id, date);
    if (row.summary.length === MAX_SESSION_CHARS) truncatedSessions++;
    return row;
  });
  if (!answerIds.size || !sessions.length || typeof instance.question !== 'string') continue;

  const db = { version: 2, sessions, lastUpdated: 0 };
  const hits = searchSessions(db, instance.question, {}, k).map((session) => session.id);
  const rank = hits.findIndex((id) => answerIds.has(id));
  evaluated++;
  if (rank !== -1) {
    recallHits++;
    mrrSum += 1 / (rank + 1);
  }
  const type = instance.question_type ?? 'unknown';
  const bucket = byType.get(type) ?? { n: 0, hits: 0 };
  bucket.n++;
  if (rank !== -1) bucket.hits++;
  byType.set(type, bucket);
}

if (evaluated === 0) {
  console.error('[bench-longmem] no evaluable instances found — wrong file format?');
  process.exit(1);
}

console.log(`[bench-longmem] RETRIEVAL-LAYER evaluation over ${evaluated} instance(s)`);
console.log(`  recall@${k}: ${((recallHits / evaluated) * 100).toFixed(1)}%`);
console.log(`  MRR@${k}:    ${(mrrSum / evaluated).toFixed(3)}`);
for (const [type, bucket] of [...byType.entries()].sort()) {
  console.log(
    `  ${type}: ${((bucket.hits / bucket.n) * 100).toFixed(1)}% recall@${k} (${bucket.n})`,
  );
}
if (truncatedSessions > 0) {
  console.log(`  note: ${truncatedSessions} session(s) truncated to ${MAX_SESSION_CHARS} chars`);
}
console.log(
  '  NOT an end-to-end LongMemEval accuracy score (no answer generation, no LLM judge) — do not compare against published QA numbers.',
);

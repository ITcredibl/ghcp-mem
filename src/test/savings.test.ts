import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateSessionTokenSavings,
  estimateSessionTokenSavingsMeasured,
  aggregateTokenSavingsMeasured,
  setTokenCounter,
  hasTokenCounter,
  compareTaskUsage,
  type TaskUsage,
  type TokenSavingsSource,
} from '../savings';

const SAMPLE: TokenSavingsSource = {
  summary: 'refactored the auth middleware to use passwordless tokens',
  keyFiles: ['src/auth.ts', 'src/middleware.ts'],
  keyTopics: ['authentication', 'tokens'],
  decisions: ['drop the shared secret', 'issue short-lived JWTs'],
  problemsSolved: ['token replay window'],
};

test('savings — measured falls back to the chars/4 heuristic when no counter is wired', async () => {
  setTokenCounter(undefined);
  assert.equal(hasTokenCounter(), false);
  const heuristic = estimateSessionTokenSavings(SAMPLE);
  const measured = await estimateSessionTokenSavingsMeasured(SAMPLE);
  // With no real tokenizer wired, both paths use the same chars/4 estimate.
  assert.equal(measured.rawTokens, heuristic.rawTokens);
  assert.equal(measured.compactTokens, heuristic.compactTokens);
  assert.equal(measured.tokensSaved, heuristic.tokensSaved);
});

test('savings — measured uses the wired token counter for exact counts', async () => {
  // Deterministic fake tokenizer: one token per whitespace-delimited word.
  setTokenCounter(async (text) => (text.trim() ? text.trim().split(/\s+/).length : 0));
  try {
    assert.equal(hasTokenCounter(), true);
    const measured = await estimateSessionTokenSavingsMeasured(SAMPLE);
    // Compact = the summary word count; raw = every field's words + overhead.
    const summaryWords = SAMPLE.summary!.trim().split(/\s+/).length;
    assert.equal(measured.compactTokens, summaryWords);
    assert.ok(measured.rawTokens > measured.compactTokens);
    assert.equal(measured.tokensSaved, measured.rawTokens - measured.compactTokens);
  } finally {
    setTokenCounter(undefined);
  }
});

test('savings — a throwing counter degrades to the heuristic without failing', async () => {
  setTokenCounter(async () => {
    throw new Error('tokenizer unavailable');
  });
  try {
    const measured = await estimateSessionTokenSavingsMeasured(SAMPLE);
    const heuristic = estimateSessionTokenSavings(SAMPLE);
    assert.equal(measured.rawTokens, heuristic.rawTokens);
    assert.equal(measured.compactTokens, heuristic.compactTokens);
  } finally {
    setTokenCounter(undefined);
  }
});

test('savings — measured aggregate sums per-session measured savings', async () => {
  setTokenCounter(async (text) => (text.trim() ? text.trim().split(/\s+/).length : 0));
  try {
    const agg = await aggregateTokenSavingsMeasured([SAMPLE, SAMPLE]);
    const one = await estimateSessionTokenSavingsMeasured(SAMPLE);
    assert.equal(agg.sessionCount, 2);
    assert.equal(agg.rawTokens, one.rawTokens * 2);
    assert.equal(agg.tokensSaved, one.tokensSaved * 2);
  } finally {
    setTokenCounter(undefined);
  }
});

test('savings: empty memories do not manufacture avoided tokens', () => {
  assert.equal(estimateSessionTokenSavings({ summary: '' }).tokensSaved, 0);
});

test('savings: explicit payloads account for the complete rendered response', async () => {
  setTokenCounter(undefined);
  const result = await estimateSessionTokenSavingsMeasured({
    rawText: 'x'.repeat(100),
    compactText: 'x'.repeat(120),
    summary: 'tiny',
  });
  assert.equal(result.rawTokens, 25);
  assert.equal(result.compactTokens, 30);
  assert.equal(result.tokensSaved, 0);
  assert.equal(result.measurement, 'estimated');
  assert.equal(result.baseline, 'provided-text');
});

test('savings: net comparisons include auxiliary work and allow negative savings', () => {
  const baseline: TaskUsage = {
    taskId: 'task@revision',
    model: 'same-model',
    source: 'provider',
    qualityPassed: true,
    inputTokens: 900,
    outputTokens: 100,
    auxiliaryTokens: 0,
  };
  assert.equal(
    compareTaskUsage(baseline, { ...baseline, inputTokens: 600, auxiliaryTokens: 200 })
      .savingsPercent,
    10,
  );
  assert.equal(
    compareTaskUsage(baseline, { ...baseline, auxiliaryTokens: 200 }).savingsPercent,
    -20,
  );
  assert.equal(
    compareTaskUsage(baseline, { ...baseline, qualityPassed: false }).savingsPercent,
    null,
  );
  assert.equal(
    compareTaskUsage(baseline, { ...baseline, qualityPassed: 'false' as unknown as boolean })
      .savingsPercent,
    null,
  );
  assert.equal(
    compareTaskUsage({ ...baseline, model: '' }, { ...baseline, model: '' }).savingsPercent,
    null,
  );
  assert.equal(
    compareTaskUsage(baseline, { ...baseline, source: 'estimate' }).savingsPercent,
    null,
  );
  assert.equal(
    compareTaskUsage(baseline, { ...baseline, model: 'different' }).savingsPercent,
    null,
  );
  assert.equal(compareTaskUsage(baseline, { ...baseline, inputTokens: NaN }).savingsPercent, null);
});

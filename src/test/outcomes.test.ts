import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestOutcomes, outcomeAdjustment, recordOutcome, summarizeOutcomes } from '../outcomes';
import { CompressedSession } from '../types';

function mkSession(o: Partial<CompressedSession> = {}): CompressedSession {
  return {
    id: 's1',
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: 1,
    endTime: 2,
    summary: 'demo',
    observationType: 'feature',
    keyFiles: [],
    keyTopics: [],
    decisions: ['use service bus sessions'],
    problemsSolved: [],
    rawEventCount: 0,
    userTags: [],
    redactionCount: 0,
    ...o,
  };
}

test('outcomes: record validates status and decision index', () => {
  const session = mkSession();
  assert.throws(() => recordOutcome(session, { status: 'great' }), /status must be one of/);
  assert.throws(
    () => recordOutcome(session, { status: 'improved', decisionIndex: 5 }),
    /decisionIndex/,
  );
  const outcome = recordOutcome(session, { status: 'improved', decisionIndex: 0 }, 1000);
  assert.equal(outcome.observedAt, 1000);
  assert.equal(session.outcomes?.length, 1);
});

test('outcomes: observations are redacted before storage', () => {
  const session = mkSession();
  recordOutcome(session, {
    status: 'neutral',
    observations: ['latency +14ms with key AKIAIOSFODNN7EXAMPLE'],
  });
  const stored = session.outcomes?.[0].observations[0] ?? '';
  assert.ok(!stored.includes('AKIAIOSFODNN7EXAMPLE'), stored);
  assert.match(stored, /latency \+14ms/);
});

test('outcomes: reporter identity is validated when provided', () => {
  const session = mkSession();
  assert.throws(
    () => recordOutcome(session, { status: 'improved', reportedBy: 'somebody' }),
    /expected/,
  );
  recordOutcome(session, { status: 'improved', reportedBy: 'agent:perf-monitor' });
  assert.equal(session.outcomes?.[0].reportedBy, 'agent:perf-monitor');
});

test('outcomes: latest outcome per target wins', () => {
  const session = mkSession();
  recordOutcome(session, { status: 'improved', decisionIndex: 0 }, 1000);
  recordOutcome(session, { status: 'regressed', decisionIndex: 0 }, 2000);
  recordOutcome(session, { status: 'neutral' }, 1500);
  const latest = latestOutcomes(session);
  assert.equal(latest.get(0)?.status, 'regressed');
  assert.equal(latest.get(-1)?.status, 'neutral');
});

test('outcomes: adjustment is bounded and regression-dominant', () => {
  const improved = mkSession();
  recordOutcome(improved, { status: 'improved', decisionIndex: 0 });
  assert.ok(outcomeAdjustment(improved) > 0);
  const regressed = mkSession();
  recordOutcome(regressed, { status: 'regressed', decisionIndex: 0 });
  assert.ok(outcomeAdjustment(regressed) < 0);
  assert.ok(Math.abs(outcomeAdjustment(regressed)) > outcomeAdjustment(improved));
  assert.equal(outcomeAdjustment(mkSession()), 0);
});

test('outcomes: summarize counts coverage across the store', () => {
  const a = mkSession({ id: 'a' });
  recordOutcome(a, { status: 'improved', decisionIndex: 0 });
  const b = mkSession({ id: 'b', decisions: ['x', 'y'] });
  recordOutcome(b, { status: 'regressed', decisionIndex: 1 });
  const summary = summarizeOutcomes([a, b, mkSession({ id: 'c' })]);
  assert.equal(summary.sessionsWithOutcomes, 2);
  assert.equal(summary.decisionsTotal, 4);
  assert.equal(summary.decisionsWithOutcomes, 2);
  assert.equal(summary.improved, 1);
  assert.equal(summary.regressed, 1);
});

test('outcomes: per-session cap holds', () => {
  const session = mkSession();
  for (let i = 0; i < 20; i++) recordOutcome(session, { status: 'neutral' });
  assert.throws(() => recordOutcome(session, { status: 'neutral' }), /at most 20/);
});

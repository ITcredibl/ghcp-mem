import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMemoryEffectiveness, formatAgentEvalReport } from '../agentEval';
import { recordOutcome } from '../outcomes';
import { CompressedSession } from '../types';

function mkSession(o: Partial<CompressedSession> = {}): CompressedSession {
  return {
    id: o.id ?? Math.random().toString(36).slice(2),
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: 1,
    endTime: 2,
    summary: 'demo',
    observationType: 'feature',
    keyFiles: [],
    keyTopics: [],
    decisions: o.decisions ?? [],
    problemsSolved: [],
    rawEventCount: 0,
    userTags: [],
    redactionCount: 0,
    ...o,
  };
}

test('agentEval: aggregates outcomes, reinforcement, grounding and lifecycle', () => {
  const grounded = mkSession({
    decisions: ['use redis'],
    decisionEvidence: [[{ eventIndex: 0 } as never]],
    usage: { retrieved: 5, lastRetrievedAt: 0, accepted: 2, rejected: 1 },
    lifecycle: 'merged',
  });
  recordOutcome(grounded, { status: 'improved', decisionIndex: 0 });
  const retracted = mkSession({ retracted: true });
  const report = evaluateMemoryEffectiveness([grounded, mkSession(), retracted]);
  assert.equal(report.sessions, 2);
  assert.equal(report.outcomes.decisionsWithOutcomes, 1);
  assert.deepEqual(report.reinforcement, { retrieved: 5, accepted: 2, rejected: 1 });
  assert.equal(report.grounding.decisions, 1);
  assert.equal(report.grounding.decisionsWithEvidence, 1);
  assert.deepEqual(report.lifecycle, { merged: 1, unset: 1 });
});

test('agentEval: report renders percentages and the honesty disclaimer', () => {
  const session = mkSession({ decisions: ['a', 'b'] });
  recordOutcome(session, { status: 'regressed', decisionIndex: 0 });
  const text = formatAgentEvalReport(evaluateMemoryEffectiveness([session]));
  assert.match(text, /decisions with a recorded outcome: 1\/2 \(50%\)/);
  assert.match(text, /1 regressed/);
  assert.match(text, /do not establish that memory improved live model outcomes/);
});

test('agentEval: empty store renders n/a instead of fake math', () => {
  const text = formatAgentEvalReport(evaluateMemoryEffectiveness([]));
  assert.match(text, /0\/0 \(n\/a\)/);
});

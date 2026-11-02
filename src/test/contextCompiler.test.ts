import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileContext } from '../contextCompiler';
import { recordOutcome } from '../outcomes';
import { Lesson } from '../lessons';
import { CompressedSession } from '../types';

function mkSession(o: Partial<CompressedSession> = {}): CompressedSession {
  return {
    id: Math.random().toString(36).slice(2),
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: 1,
    endTime: 2_000_000,
    summary: o.summary ?? 'worked on checkout retries',
    observationType: 'feature',
    keyFiles: ['src/pay.ts'],
    keyTopics: [],
    decisions: ['retry with backoff'],
    problemsSolved: [],
    rawEventCount: 0,
    userTags: [],
    redactionCount: 0,
    ...o,
  };
}

function mkLesson(o: Partial<Lesson> = {}): Lesson {
  return {
    id: o.id ?? Math.random().toString(36).slice(2),
    kind: 'semantic',
    text: o.text ?? 'This project uses PostgreSQL.',
    tags: [],
    sources: ['a'],
    supportCount: 3,
    confidence: 0.9,
    createdAt: 1,
    updatedAt: 2,
    ...o,
  };
}

test('contextCompiler: validates query and budget', () => {
  assert.throws(() => compileContext({ query: ' ', budgetTokens: 1000 }), /requires a query/);
  assert.throws(() => compileContext({ query: 'x', budgetTokens: 10 }), /between 128 and 32000/);
});

test('contextCompiler: rules are mandatory, sessions are budgeted with receipts', () => {
  const sessions = Array.from({ length: 30 }, (_, i) =>
    mkSession({ summary: `session ${i} about checkout ${'detail '.repeat(40)}` }),
  );
  const compiled = compileContext({
    query: 'checkout failures',
    budgetTokens: 400,
    rules: ['Never log card numbers.'],
    sessions,
  });
  assert.ok(compiled.context.includes('RULE: Never log card numbers.'));
  assert.ok(compiled.plan.some((item) => item.kind === 'rule'));
  assert.ok(compiled.omitted.length > 0, 'over-budget sessions must appear as receipts');
  assert.ok(
    compiled.estTokens <= 400 + 50,
    `estTokens ${compiled.estTokens} should respect budget`,
  );
  assert.equal(compiled.measurement, 'utf8-bytes/4-estimate');
});

test('contextCompiler: whole records only — no partial session blocks', () => {
  const session = mkSession({ summary: 'alpha '.repeat(200) });
  const compiled = compileContext({ query: 'alpha', budgetTokens: 150, sessions: [session] });
  const included = compiled.plan.some((item) => item.id === session.id);
  const omitted = compiled.omitted.some((item) => item.id === session.id);
  assert.ok(included !== omitted, 'session must be fully in or fully out');
});

test('contextCompiler: branch-invalid lifecycle sessions are omitted with a reason', () => {
  const speculative = mkSession({
    id: 'spec',
    lifecycle: 'experimental',
    branchName: 'feat/other',
  });
  const compiled = compileContext({
    query: 'checkout',
    budgetTokens: 2000,
    branch: 'main',
    sessions: [speculative],
  });
  assert.equal(
    compiled.plan.some((item) => item.id === 'spec'),
    false,
  );
  const receipt = compiled.omitted.find((item) => item.id === 'spec');
  assert.ok(receipt && /valid only on branch feat\/other/.test(receipt.reason));
});

test('contextCompiler: regressed outcomes sink a session below a clean one', () => {
  const regressed = mkSession({ id: 'bad', summary: 'checkout approach A' });
  recordOutcome(regressed, { status: 'regressed', decisionIndex: 0 });
  const clean = mkSession({ id: 'good', summary: 'checkout approach B' });
  const compiled = compileContext({
    query: 'checkout',
    budgetTokens: 4000,
    sessions: [regressed, clean],
  });
  const order = compiled.plan.filter((item) => item.kind === 'session').map((item) => item.id);
  assert.deepEqual(order, ['good', 'bad']);
});

test('contextCompiler: lessons render and outcomes appear in session blocks', () => {
  const session = mkSession({ id: 'with-outcome' });
  recordOutcome(session, { status: 'improved', decisionIndex: 0, observations: ['p95 -20ms'] });
  const compiled = compileContext({
    query: 'checkout',
    budgetTokens: 4000,
    lessons: [mkLesson()],
    sessions: [session],
  });
  assert.match(compiled.context, /LESSON \(semantic\): This project uses PostgreSQL\./);
  assert.match(compiled.context, /Outcome \(improved, decision 0\): p95 -20ms/);
});

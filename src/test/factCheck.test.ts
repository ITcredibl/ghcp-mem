import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPathClaims,
  factCheckSession,
  factCheckSweep,
  formatFactCheckReport,
} from '../factCheck';
import { CompressedSession } from '../types';

function mkSession(o: Partial<CompressedSession> = {}): CompressedSession {
  return {
    id: o.id ?? Math.random().toString(36).slice(2),
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: 1,
    endTime: 2,
    summary: o.summary ?? 'demo',
    observationType: 'feature',
    keyFiles: o.keyFiles ?? [],
    keyTopics: [],
    decisions: o.decisions ?? [],
    problemsSolved: [],
    rawEventCount: 0,
    userTags: [],
    redactionCount: 0,
    ...o,
  };
}

test('factCheck: extracts workspace-relative path claims, skips traversal and keyFiles', () => {
  const session = mkSession({
    summary: 'Deploy via .github/workflows/ci.yml now',
    decisions: ['moved logic into src/auth/token.ts', 'never read ../outside.txt or /etc/passwd'],
    keyFiles: ['src/auth/token.ts'],
  });
  assert.deepEqual(extractPathClaims(session), ['.github/workflows/ci.yml']);
});

test('factCheck: a session without checkable claims yields undefined', async () => {
  const result = await factCheckSession(mkSession({ summary: 'thought about naming' }), () => true);
  assert.equal(result, undefined);
});

test('factCheck: stale and fresh references are separated', async () => {
  const session = mkSession({
    summary: 'uses .github/workflows/ci.yml and azure-pipelines.yml... wait, docs/old.md too',
    decisions: [],
  });
  const existing = new Set(['.github/workflows/ci.yml']);
  const result = await factCheckSession(session, (p) => existing.has(p), 42);
  assert.ok(result);
  assert.equal(result.checkedAt, 42);
  assert.equal(result.freshRefs, 1);
  assert.deepEqual(result.staleRefs.sort(), ['docs/old.md']);
});

test('factCheck: sweep is bounded, skips retracted, counts stale sessions', async () => {
  const sessions = [
    mkSession({ id: 'ok', summary: 'see docs/live.md' }),
    mkSession({ id: 'stale', summary: 'see docs/gone.md' }),
    mkSession({ id: 'retracted', summary: 'see docs/gone.md', retracted: true }),
  ];
  const sweep = await factCheckSweep(sessions, (p) => p === 'docs/live.md');
  assert.equal(sweep.checked, 2);
  assert.equal(sweep.stale, 1);
  assert.ok(sweep.results.has('stale'));
  assert.ok(!sweep.results.has('retracted'));
});

test('factCheck: report names the stale sessions and stays honest when clean', async () => {
  const staleSweep = await factCheckSweep(
    [mkSession({ id: 'abcdef12', summary: 'docs/x.md' })],
    () => false,
  );
  assert.match(formatFactCheckReport(staleSweep), /abcdef12.*docs\/x\.md/);
  const cleanSweep = await factCheckSweep([mkSession({ summary: 'docs/x.md' })], () => true);
  assert.match(formatFactCheckReport(cleanSweep), /All checkable references still resolve/);
});

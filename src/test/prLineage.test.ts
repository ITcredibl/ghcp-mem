import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gitLineageLogArgs,
  linkSessionsToLineage,
  parseLineageLog,
  parsePrRefs,
  renderLineage,
} from '../prLineage';
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

const SHA = 'a'.repeat(40);

function logChunk(subject: string, body = '', date = 1700000000): string {
  return [SHA, String(date), subject, body].join('\x1f') + '\x1e';
}

test('prLineage: parsePrRefs finds PR and issue references, dedups', () => {
  assert.deepEqual(parsePrRefs('fixed in PR #481 and #481, see #22'), ['481', '22']);
  assert.deepEqual(parsePrRefs('nothing here'), []);
  assert.deepEqual(parsePrRefs('color #fff is not a ref'), []);
});

test('prLineage: gitLineageLogArgs are bounded merge-only args', () => {
  const args = gitLineageLogArgs(99999);
  assert.ok(args.includes('--merges'));
  assert.ok(args.includes('2000'));
});

test('prLineage: parseLineageLog extracts PR number, branch and closed issues', () => {
  const records = parseLineageLog(
    logChunk('Merge pull request #12 from org/feat/auth', 'Fixes #7\nCloses #9'),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].prNumber, '12');
  assert.equal(records[0].sourceBranch, 'feat/auth');
  assert.deepEqual(records[0].issues.sort(), ['7', '9']);
  assert.equal(records[0].mergedAt, 1700000000000);
});

test('prLineage: malformed chunks are skipped', () => {
  assert.deepEqual(parseLineageLog('garbage\x1e'), []);
  assert.deepEqual(parseLineageLog(`${'z'.repeat(40)}\x1fnot-a-date\x1fsubj\x1f\x1e`), []);
});

test('prLineage: sessions link by branch name or explicit PR reference', () => {
  const records = parseLineageLog(logChunk('Merge pull request #12 from org/feat/auth'));
  const byBranch = mkSession({ id: 'branchy', branchName: 'feat/auth' });
  const byRef = mkSession({ id: 'reffy', summary: 'follow-up to PR #12' });
  const unrelated = mkSession({ id: 'nope', branchName: 'main' });
  const chains = linkSessionsToLineage([byBranch, byRef, unrelated], records);
  assert.equal(chains.length, 1);
  assert.deepEqual(chains[0].sessionIds.sort(), ['branchy', 'reffy']);
});

test('prLineage: render produces a readable chain and an honest empty state', () => {
  const chains = linkSessionsToLineage(
    [mkSession({ id: 'branchy', branchName: 'feat/auth' })],
    parseLineageLog(logChunk('Merge pull request #12 from org/feat/auth', 'Fixes #7')),
  );
  const rendered = renderLineage(chains);
  assert.match(rendered, /## PR #12/);
  assert.match(rendered, /closes: #7/);
  assert.match(renderLineage([]), /No PR lineage/);
});

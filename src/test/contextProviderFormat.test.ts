/**
 * Unit tests for the pure formatting/parsing/validation helpers in
 * `contextProviderFormat.ts`. These back the `@mem` slash commands (`/pr`,
 * `/search`, `/correct`, `/ask`) and are security-relevant (git-ref / PR-number
 * whitelisting), so they are pinned here in isolation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CompressedSession, computeContentHash, Evidence } from '../types';
import {
  isSafeGitRef,
  isSafePrNumber,
  formatInjectTimestamp,
  renderTrustBadge,
  renderClaimList,
  splitIdAndText,
  parseInlineFilters,
  synthesize,
} from '../contextProviderFormat';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  const summary = overrides.summary ?? 's';
  const keyFiles = overrides.keyFiles ?? ['src/foo.ts'];
  const keyTopics = overrides.keyTopics ?? [];
  const decisions = overrides.decisions ?? [];
  const problemsSolved = overrides.problemsSolved ?? [];
  const base: CompressedSession = {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    workspaceId: overrides.workspaceId ?? 'ws1',
    workspaceName: overrides.workspaceName ?? 'ws',
    startTime: overrides.startTime ?? Date.now() - 1000,
    endTime: overrides.endTime ?? Date.now(),
    summary,
    observationType: overrides.observationType ?? 'refactor',
    keyFiles,
    keyTopics,
    decisions,
    problemsSolved,
    rawEventCount: overrides.rawEventCount ?? 10,
    userTags: overrides.userTags ?? [],
    redactionCount: overrides.redactionCount ?? 0,
    contentHash:
      overrides.contentHash ??
      computeContentHash({ summary, keyFiles, keyTopics, decisions, problemsSolved }),
  };
  if (overrides.confidence !== undefined) base.confidence = overrides.confidence;
  return base;
}

test('isSafeGitRef — accepts real refs, rejects shell metacharacters', () => {
  for (const ok of ['main', 'feature/x', 'release-1.2.0', 'HEAD~1', 'HEAD^2', 'user/topic_1']) {
    assert.equal(isSafeGitRef(ok), true, `expected ${ok} accepted`);
  }
  for (const bad of ['main; rm -rf /', 'a | b', 'a`whoami`', 'a$(id)', 'a b', 'a\\b', 'a\nb', '']) {
    assert.equal(isSafeGitRef(bad), false, `expected ${JSON.stringify(bad)} rejected`);
  }
});

test('isSafeGitRef — length capped at 200', () => {
  assert.equal(isSafeGitRef('a'.repeat(200)), true);
  assert.equal(isSafeGitRef('a'.repeat(201)), false);
});

test('isSafePrNumber — positive integers only', () => {
  assert.equal(isSafePrNumber('1'), true);
  assert.equal(isSafePrNumber('12345678'), true);
  assert.equal(isSafePrNumber('0'), true);
  assert.equal(isSafePrNumber('123456789'), false); // 9 digits
  assert.equal(isSafePrNumber('12a'), false);
  assert.equal(isSafePrNumber('-1'), false);
  assert.equal(isSafePrNumber(''), false);
});

test('formatInjectTimestamp — M/D/YYYY HH:MM zero-padded local time', () => {
  const ts = new Date(2026, 0, 5, 9, 3).getTime(); // Jan 5 2026 09:03 local
  assert.equal(formatInjectTimestamp(ts), '1/5/2026 09:03');
});

test('renderTrustBadge — emoji thresholds and legacy fallback', () => {
  assert.match(renderTrustBadge(makeSession({ confidence: 0.9 })), /🟢 conf:0\.90/);
  assert.match(renderTrustBadge(makeSession({ confidence: 0.6 })), /🟡 conf:0\.60/);
  assert.match(renderTrustBadge(makeSession({ confidence: 0.2 })), /🔴 conf:0\.20/);
  // no confidence stored → empty badge (legacy sessions keep compact header)
  assert.equal(renderTrustBadge(makeSession()), '');
});

test('renderClaimList — inline evidence with deduped, capped file paths', () => {
  const texts = ['decided A', 'plain B'];
  const ev: Evidence[][] = [
    [
      { kind: 'file_edit', filePath: 'a.ts' },
      { kind: 'file_edit', filePath: 'a.ts' }, // dup collapses
      { kind: 'file_edit', filePath: 'b.ts' },
      { kind: 'file_edit', filePath: 'c.ts' },
      { kind: 'file_edit', filePath: 'd.ts' }, // beyond cap of 3
    ],
    [],
  ];
  const out = renderClaimList(texts, ev);
  assert.equal(out, 'decided A [📎 a.ts, b.ts, c.ts]; plain B');
});

test('renderClaimList — no evidence renders plain text', () => {
  assert.equal(renderClaimList(['x', 'y']), 'x; y');
});

test('splitIdAndText — peels id prefix off the rest', () => {
  assert.deepEqual(splitIdAndText('abc123 the rest of it'), {
    idPrefix: 'abc123',
    text: 'the rest of it',
  });
  assert.deepEqual(splitIdAndText('lonely'), { idPrefix: 'lonely', text: '' });
  assert.deepEqual(splitIdAndText('  padded   text  '), { idPrefix: 'padded', text: 'text' });
  assert.deepEqual(splitIdAndText(''), { idPrefix: '', text: '' });
});

test('parseInlineFilters — extracts type/tag/workspace and strips tokens', () => {
  const { cleaned, filters } = parseInlineFilters('auth bug type:fix tag:wip workspace:true');
  assert.equal(cleaned, 'auth bug');
  assert.equal(filters.type, 'fix');
  assert.equal(filters.tag, 'wip');
  assert.equal(filters.workspaceOnly, true);
});

test('parseInlineFilters — since:7d sets a sinceTs roughly 7 days back', () => {
  const before = Date.now();
  const { cleaned, filters } = parseInlineFilters('cache since:7d');
  assert.equal(cleaned, 'cache');
  assert.ok(filters.sinceTs !== undefined);
  const delta = before - (filters.sinceTs as number);
  const sevenDays = 7 * 86400000;
  assert.ok(Math.abs(delta - sevenDays) < 5000, `expected ~7d window, got ${delta}ms`);
});

test('parseInlineFilters — non-filter colon tokens are preserved', () => {
  const { cleaned, filters } = parseInlineFilters('http://x unknown:val plain');
  assert.equal(filters.type, undefined);
  assert.match(cleaned, /http:\/\/x/);
  assert.match(cleaned, /unknown:val/);
  assert.match(cleaned, /plain/);
});

test('synthesize — aggregates topics, files, decisions, problems', () => {
  const sessions = [
    makeSession({
      keyTopics: ['auth', 'jwt'],
      keyFiles: ['src/auth.ts'],
      decisions: ['use RS256'],
      problemsSolved: ['fixed token expiry'],
    }),
    makeSession({
      keyTopics: ['auth'],
      keyFiles: ['src/mw.ts'],
      decisions: [],
      problemsSolved: [],
    }),
  ];
  const out = synthesize(sessions, 'auth');
  assert.match(out, /2 session\(s\) matching "auth"/);
  assert.match(out, /Known topics:.*auth/);
  assert.match(out, /jwt/);
  assert.match(out, /src\/auth\.ts/);
  assert.match(out, /use RS256/);
  assert.match(out, /fixed token expiry/);
});

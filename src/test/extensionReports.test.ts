/**
 * Unit tests for the pure report builders extracted from `extension.ts` into
 * `extensionReports.ts`. All are string builders with no editor side effects,
 * so they run directly against the vscode mock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CompressedSession, computeContentHash } from '../types';
import {
  buildSessionPreview,
  buildAuditReport,
  formatAgoSimple,
  formatReport,
  formatSessionDetail,
  buildAzureDemoSessions,
  renderCurrentRepoMemoryReport,
} from '../extensionReports';
import { ContextStore } from '../contextStore';
import { InMemoryMemento } from './__mocks__/vscode';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  const summary = overrides.summary ?? 'a concise summary';
  const keyFiles = overrides.keyFiles ?? ['src/foo.ts'];
  const keyTopics = overrides.keyTopics ?? [];
  const decisions = overrides.decisions ?? [];
  const problemsSolved = overrides.problemsSolved ?? [];
  const base: CompressedSession = {
    id: overrides.id ?? 'abcdef0123456789',
    workspaceId: overrides.workspaceId ?? 'ws1',
    workspaceName: overrides.workspaceName ?? 'ws',
    startTime: overrides.startTime ?? Date.now() - 900000,
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
  if (overrides.repoScope !== undefined) base.repoScope = overrides.repoScope;
  if (overrides.repoScopeLabel !== undefined) base.repoScopeLabel = overrides.repoScopeLabel;
  return base;
}

test('buildSessionPreview — headline sections and empty-state fallbacks', () => {
  const md = buildSessionPreview(makeSession({ keyFiles: [], decisions: [] }));
  assert.match(md, /# GHCP-MEM Preview/);
  assert.match(md, /- Session: `abcdef0123456789`/);
  assert.match(md, /## Files\n- _None_/);
  assert.match(md, /## Decisions\n- _None_/);
});

test('buildSessionPreview — lists files and decisions when present', () => {
  const md = buildSessionPreview(
    makeSession({ keyFiles: ['a.ts', 'b.ts'], decisions: ['pick X'] }),
  );
  assert.match(md, /## Files\n- a\.ts\n- b\.ts/);
  assert.match(md, /## Decisions\n- pick X/);
});

test('buildAuditReport — classifies retention reason per session', async () => {
  const store = new ContextStore(new InMemoryMemento() as never);
  await store.addSession(
    makeSession({ id: 'pin00000aaa', summary: 'pinned one', userTags: ['pinned'] }),
  );
  await store.addSession(
    makeSession({ id: 'dec00000bbb', summary: 'decision one', decisions: ['d'], userTags: [] }),
  );
  await store.addSession(
    makeSession({ id: 'top00000ccc', summary: 'topic one', keyTopics: ['t'], userTags: [] }),
  );
  await store.addSession(
    makeSession({
      id: 'rec00000ddd',
      summary: 'recent one',
      keyTopics: [],
      decisions: [],
      userTags: [],
    }),
  );
  const md = buildAuditReport(store);
  assert.match(md, /# GHCP-MEM Memory Audit/);
  assert.match(md, /`pin00000` \| .* \| Pinned/);
  assert.match(md, /`dec00000` \| .* \| Decision-bearing/);
  assert.match(md, /`top00000` \| .* \| Topic-bearing/);
  assert.match(md, /`rec00000` \| .* \| Recent activity/);
});

test('formatAgoSimple — minute, hour and day buckets', () => {
  const now = Date.now();
  assert.equal(formatAgoSimple(now - 5 * 60_000), '5m ago');
  assert.equal(formatAgoSimple(now - 3 * 3_600_000), '3h ago');
  assert.equal(formatAgoSimple(now - 2 * 86_400_000), '2d ago');
});

test('formatReport — stats block plus recent sessions, newest first', async () => {
  const store = new ContextStore(new InMemoryMemento() as never);
  const older = makeSession({ id: 'older000', summary: 'older work', endTime: Date.now() - 10000 });
  const newer = makeSession({ id: 'newer000', summary: 'newer work', endTime: Date.now() });
  await store.addSession(older);
  await store.addSession(newer);
  const md = formatReport(store.getStats(), [older, newer]);
  assert.match(md, /# GHCP-MEM — Context Report/);
  assert.match(md, /- Total sessions: \*\*2\*\*/);
  // reversed: newest rendered before oldest
  assert.ok(md.indexOf('newer work') < md.indexOf('older work'));
});

test('formatReport — empty recent list yields no-sessions note', () => {
  const store = new ContextStore(new InMemoryMemento() as never);
  const md = formatReport(store.getStats(), []);
  assert.match(md, /_No sessions yet\._/);
});

test('formatSessionDetail — renders trust, files, decisions and azure block', () => {
  const md = formatSessionDetail(
    makeSession({
      confidence: 0.9,
      keyFiles: ['a.ts'],
      keyTopics: ['auth'],
      decisions: ['use RS256'],
      problemsSolved: ['fixed expiry'],
      userTags: ['wip'],
    }),
  );
  assert.match(md, /### \[refactor\]/);
  assert.match(md, /\*\*Trust:\*\* 🟢 confidence 0\.90/);
  assert.match(md, /\*\*Files:\*\* a\.ts/);
  assert.match(md, /\*\*Decisions:\*\*/);
  assert.match(md, /\*\*Solved:\*\*/);
  assert.match(md, /\*\*Tags:\*\* wip/);
});

test('buildAzureDemoSessions — five tagged demo sessions with azure context', () => {
  const demos = buildAzureDemoSessions();
  assert.equal(demos.length, 5);
  for (const s of demos) {
    assert.ok(s.userTags.includes('demo') && s.userTags.includes('azure'));
    assert.ok(s.azureContext);
    assert.equal(s.azureContext?.subscriptionName, 'contoso-dev');
  }
  assert.deepEqual(
    demos.map((s) => s.observationType),
    ['infra', 'deployment', 'bugfix', 'refactor', 'security'],
  );
});

test('renderCurrentRepoMemoryReport — empty vs populated', () => {
  assert.equal(renderCurrentRepoMemoryReport([]), '# No memory for this repo yet.');
  const md = renderCurrentRepoMemoryReport([
    makeSession({
      repoScopeLabel: 'my-repo',
      observationType: 'feature',
      decisions: ['ship it'],
    }),
  ]);
  assert.match(md, /# Repo memory — my-repo/);
  assert.match(md, /\*\*1\*\* sessions captured/);
  assert.match(md, /- \*\*feature\*\*: 1/);
  assert.match(md, /\*\*Decisions:\*\*/);
});

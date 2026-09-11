/**
 * Unit tests for the pure session renderers in `sessionRender.ts`. The three
 * render functions take a VS Code `ChatResponseStream`; we substitute a tiny
 * collector that captures the emitted markdown so the output can be asserted
 * without a running editor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as vscode from 'vscode';

import { CompressedSession, computeContentHash } from '../types';
import {
  formatAgo,
  memoryConfidence,
  renderIndexRow,
  renderCompact,
  renderFull,
} from '../sessionRender';

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
    startTime: overrides.startTime ?? Date.now() - 60000,
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
  if (overrides.branchName !== undefined) base.branchName = overrides.branchName;
  if (overrides.azureContext !== undefined) base.azureContext = overrides.azureContext;
  return base;
}

/** Collector standing in for a ChatResponseStream — only `.markdown` is used. */
function collector(): { text: () => string; stream: vscode.ChatResponseStream } {
  const state = { out: '' };
  const stream = {
    markdown(v: string | vscode.MarkdownString) {
      state.out += typeof v === 'string' ? v : v.value;
    },
  } as unknown as vscode.ChatResponseStream;
  return { text: () => state.out, stream };
}

test('formatAgo — minutes, hours, days buckets', () => {
  const now = Date.now();
  assert.match(formatAgo(now - 5 * 60_000), /^5m ago$/);
  assert.match(formatAgo(now - 3 * 3_600_000), /^3h ago$/);
  assert.match(formatAgo(now - 2 * 86_400_000), /^2d ago$/);
});

test('memoryConfidence — scales with independent signals', () => {
  const high = makeSession({
    userTags: ['x'],
    decisions: ['d'],
    problemsSolved: ['p'],
    keyTopics: ['t'],
    observationType: 'feature',
  });
  assert.equal(memoryConfidence(high).label, 'high confidence');

  const medium = makeSession({
    decisions: ['d'],
    keyTopics: ['t'],
    keyFiles: ['f.ts'],
    observationType: 'unknown',
    userTags: [],
    problemsSolved: [],
  });
  assert.equal(memoryConfidence(medium).label, 'medium confidence');

  const low = makeSession({
    userTags: [],
    decisions: [],
    problemsSolved: [],
    keyTopics: [],
    keyFiles: [],
    observationType: 'unknown',
  });
  assert.equal(memoryConfidence(low).label, 'low confidence');
});

test('renderIndexRow — one-line row with type, short id, confidence', () => {
  const c = collector();
  renderIndexRow(makeSession({ observationType: 'feature', userTags: ['wip'] }), c.stream);
  const out = c.text();
  assert.match(out, /\*\*\[feature\]\*\*/);
  assert.match(out, /`abcdef01`/); // 8-char id prefix
  assert.match(out, /🏷️ wip/);
  assert.match(out, /confidence/);
});

test('renderCompact — header, files and topics sections', () => {
  const c = collector();
  renderCompact(
    makeSession({ keyFiles: ['src/a.ts', 'src/b.ts'], keyTopics: ['auth', 'jwt'] }),
    c.stream,
  );
  const out = c.text();
  assert.match(out, /### \[refactor\]/);
  assert.match(out, /\*\*Files:\*\*.*`src\/a\.ts`/);
  assert.match(out, /\*\*Topics:\*\* auth, jwt/);
});

test('renderFull — structured detail incl. token-savings and decisions', () => {
  const c = collector();
  renderFull(
    makeSession({
      branchName: 'feature/x',
      decisions: ['use RS256'],
      problemsSolved: ['fixed expiry'],
      keyTopics: ['auth'],
    }),
    c.stream,
  );
  const out = c.text();
  assert.match(out, /## Session `abcdef0123456789`/);
  assert.match(out, /\*\*Branch:\*\* `feature\/x`/);
  assert.match(out, /Estimated token savings:/);
  assert.match(out, /### Decisions\n- use RS256/);
  assert.match(out, /### Problems Solved\n- fixed expiry/);
});

test('renderFull — azure context block appears when present', () => {
  const c = collector();
  renderFull(
    makeSession({
      azureContext: {
        subscriptionName: 'sub-a',
        resourceGroup: 'rg-a',
        resourceIds: ['/subscriptions/x/rg/a'],
      } as CompressedSession['azureContext'],
    }),
    c.stream,
  );
  const out = c.text();
  assert.match(out, /\*\*Azure:\*\*.*sub=sub-a/);
  assert.match(out, /rg=rg-a/);
  assert.match(out, /Resource IDs \(1\)/);
});

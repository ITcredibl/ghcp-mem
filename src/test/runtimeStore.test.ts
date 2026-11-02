import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryMemento } from './__mocks__/vscode';
import { ContextStore } from '../contextStore';
import { parsePolicy } from '../orgPolicy';
import { CompressedSession, computeContentHash } from '../types';

function makeSession(overrides: Partial<CompressedSession> = {}): CompressedSession {
  const summary = overrides.summary ?? 'checkout retry work';
  const keyFiles = overrides.keyFiles ?? ['a.ts'];
  const keyTopics = overrides.keyTopics ?? ['checkout'];
  const decisions = overrides.decisions ?? [];
  const problemsSolved = overrides.problemsSolved ?? [];
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    workspaceId: 'ws1',
    workspaceName: 'ws',
    startTime: Date.now() - 1000,
    endTime: Date.now(),
    summary,
    observationType: 'refactor',
    keyFiles,
    keyTopics,
    decisions,
    problemsSolved,
    rawEventCount: 10,
    userTags: [],
    redactionCount: 0,
    contentHash: computeContentHash({ summary, keyFiles, keyTopics, decisions, problemsSolved }),
    ...overrides,
  };
}

function quietStore(): ContextStore {
  const store = new ContextStore(new InMemoryMemento() as any);
  (store as any).syncToDisk = async () => {};
  return store;
}

test('ContextStore — branch-confined lifecycle memories vanish off their branch', async () => {
  const store = quietStore();
  // Each row needs distinct content: addSession dedups identical contentHash,
  // and retrieval collapses near-duplicate topic/file sets.
  await store.addSession(
    makeSession({
      id: 'spec',
      lifecycle: 'experimental',
      branchName: 'feat/auth',
      summary: 'checkout retry experiment',
      keyFiles: ['spec.ts'],
      keyTopics: ['checkout', 'experiment'],
    }),
  );
  await store.addSession(
    makeSession({
      id: 'legacy',
      summary: 'checkout legacy notes',
      keyFiles: ['legacy.ts'],
      keyTopics: ['checkout', 'legacy'],
    }),
  );
  await store.addSession(
    makeSession({
      id: 'landed',
      lifecycle: 'merged',
      branchName: 'feat/auth',
      summary: 'checkout retry landed',
      keyFiles: ['landed.ts'],
      keyTopics: ['checkout', 'landed'],
    }),
  );

  store.setCurrentBranch('main');
  const onMain = store.search('checkout', {}, 10).map((s) => s.id);
  assert.ok(!onMain.includes('spec'), 'experimental feat/auth memory must not leak onto main');
  assert.ok(onMain.includes('legacy'), 'pre-1.20 sessions keep their old behavior');
  assert.ok(onMain.includes('landed'), 'merged memories are branch-independent');

  store.setCurrentBranch('feat/auth');
  assert.ok(
    store
      .search('checkout', {}, 10)
      .map((s) => s.id)
      .includes('spec'),
    'the capture branch still sees its own experimental memory',
  );

  store.setCurrentBranch(undefined);
  assert.ok(
    store
      .search('checkout', {}, 10)
      .map((s) => s.id)
      .includes('spec'),
    'without branch info the filter stays off',
  );
});

test('ContextStore — committed org policy gates writes by scope and author kind', async () => {
  const store = quietStore();
  store.setOrgPolicy(
    parsePolicy(
      JSON.stringify({ version: 1, scopes: { organization: { write: ['human'], read: 'all' } } }),
    ),
  );
  await store.addSession(
    makeSession({ scopeLevel: 'organization', author: 'human:seyi', summary: 'org standard' }),
  );
  await assert.rejects(
    store.addSession(makeSession({ scopeLevel: 'organization', author: 'claude:reviewer' })),
    /policy denied the write/,
  );
  // Unrestricted levels stay writable.
  await store.addSession(makeSession({ author: 'claude:reviewer', summary: 'repo note' }));
  assert.equal(store.getAllSessions().length, 2);
});

test('ContextStore — clearing the policy restores default-allow', async () => {
  const store = quietStore();
  store.setOrgPolicy(
    parsePolicy(
      JSON.stringify({ version: 1, scopes: { repository: { write: ['human'], read: 'all' } } }),
    ),
  );
  await assert.rejects(store.addSession(makeSession({ author: 'agent:bot' })));
  store.setOrgPolicy(undefined);
  await store.addSession(makeSession({ author: 'agent:bot' }));
  assert.equal(store.getAllSessions().length, 1);
});

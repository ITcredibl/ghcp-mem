import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorFromHumanName,
  canReadScoped,
  filterByScope,
  normalizeScopeStamp,
  parseAuthor,
} from '../memoryScope';
import { CompressedSession } from '../types';

function mkSession(o: Partial<CompressedSession> = {}): CompressedSession {
  return {
    id: Math.random().toString(36).slice(2),
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: 1,
    endTime: 2,
    summary: 'demo',
    observationType: 'feature',
    keyFiles: [],
    keyTopics: [],
    decisions: [],
    problemsSolved: [],
    rawEventCount: 0,
    userTags: [],
    redactionCount: 0,
    ...o,
  };
}

test('memoryScope: parseAuthor accepts kind:name, rejects junk', () => {
  assert.deepEqual(parseAuthor('claude:reviewer'), { kind: 'claude', name: 'reviewer' });
  assert.deepEqual(parseAuthor('human:seyi'), { kind: 'human', name: 'seyi' });
  assert.throws(() => parseAuthor('reviewer'), /expected "<kind>:<name>"/);
  assert.throws(() => parseAuthor('gpt:reviewer'), /expected/);
  assert.throws(() => parseAuthor('human:has spaces'), /expected/);
  assert.throws(() => parseAuthor(42), /kind one of/);
});

test('memoryScope: authorFromHumanName slugs git identities, never invents one', () => {
  assert.equal(authorFromHumanName('Oluseyi Kofoworola'), 'human:oluseyi-kofoworola');
  assert.equal(authorFromHumanName('  '), undefined);
  assert.equal(authorFromHumanName(undefined), undefined);
});

test('memoryScope: agent-scoped memories are private to their author', () => {
  const mine = mkSession({ scopeLevel: 'agent', author: 'claude:reviewer' });
  assert.ok(canReadScoped(mine, { author: 'claude:reviewer' }));
  assert.equal(canReadScoped(mine, { author: 'copilot:architect' }), false);
  assert.equal(canReadScoped(mine, {}), false);
});

test('memoryScope: human review surfaces can audit agent-scoped memories', () => {
  const mine = mkSession({ scopeLevel: 'agent', author: 'claude:reviewer' });
  assert.ok(canReadScoped(mine, { humanReview: true }));
});

test('memoryScope: non-agent scopes are locally readable by anyone', () => {
  for (const scopeLevel of ['organization', 'team', 'repository', 'user', 'task'] as const) {
    assert.ok(canReadScoped(mkSession({ scopeLevel }), {}));
  }
  assert.ok(canReadScoped(mkSession(), {}));
});

test('memoryScope: filterByScope drops only foreign agent memories', () => {
  const sessions = [
    mkSession({ id: 'shared' }),
    mkSession({ id: 'mine', scopeLevel: 'agent', author: 'claude:reviewer' }),
    mkSession({ id: 'theirs', scopeLevel: 'agent', author: 'cursor:impl' }),
  ];
  const visible = filterByScope(sessions, { author: 'claude:reviewer' }).map((s) => s.id);
  assert.deepEqual(visible, ['shared', 'mine']);
});

test('memoryScope: normalizeScopeStamp validates, and agent scope demands an author', () => {
  assert.deepEqual(normalizeScopeStamp({ scopeLevel: 'team', author: 'human:seyi' }), {
    scopeLevel: 'team',
    author: 'human:seyi',
  });
  assert.deepEqual(normalizeScopeStamp({}), {});
  assert.throws(() => normalizeScopeStamp({ scopeLevel: 'galaxy' }), /Invalid scope level/);
  assert.throws(() => normalizeScopeStamp({ scopeLevel: 'agent' }), /require an author/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fuseRanks,
  FusionInput,
  NEUTRAL_FUSION_WEIGHTS,
  FUSION_K,
  FUSION_HALF_LIFE_MS,
} from '../searchCore';
import { searchSessions } from '../mcpServer';

function input(o: Partial<FusionInput> & { id: string }): FusionInput {
  return {
    endTime: 0,
    keywordRank: 0,
    recencyRank: 0,
    workspaceMatch: false,
    matchRatio: 0,
    confidence: 0.5,
    retrieved: 0,
    accepted: 0,
    rejected: 0,
    superseded: false,
    hasDecisions: false,
    hasProblems: false,
    ...o,
  };
}

test('fuseRanks — deterministic RRF + decay for a single input', () => {
  const now = 1_000_000_000_000;
  const [r] = fuseRanks(
    [input({ id: 'a', endTime: now, keywordRank: 0, recencyRank: 0 })],
    NEUTRAL_FUSION_WEIGHTS,
    {
      now,
    },
  );
  // rrf = 1/(K+0) [keyword] + 1/(K+0) [recency]; decay = 2^0 * 0.3.
  const expected = 1 / FUSION_K + 1 / FUSION_K + 1 * 0.3;
  assert.ok(Math.abs(r.score - expected) < 1e-12, `got ${r.score}, want ${expected}`);
  assert.equal(r.signals.keyword, 1 / FUSION_K);
  assert.equal(r.signals.recency, 1);
});

test('fuseRanks — sorts by score desc, tie-broken by endTime', () => {
  const now = 2_000_000_000_000;
  const out = fuseRanks(
    [
      input({ id: 'older', endTime: now - 1000, keywordRank: 0, recencyRank: 1 }),
      input({ id: 'newer', endTime: now, keywordRank: 0, recencyRank: 0 }),
    ],
    NEUTRAL_FUSION_WEIGHTS,
    { now },
  );
  assert.equal(out[0].id, 'newer');
  assert.equal(out[1].id, 'older');
});

test('fuseRanks — supersession pushes an otherwise-equal row down', () => {
  const now = 3_000_000_000_000;
  const out = fuseRanks(
    [
      input({ id: 'live', endTime: now, keywordRank: 0, recencyRank: 0 }),
      input({ id: 'dead', endTime: now, keywordRank: 0, recencyRank: 0, superseded: true }),
    ],
    NEUTRAL_FUSION_WEIGHTS,
    { now },
  );
  assert.equal(out[0].id, 'live');
  assert.ok(out[1].score < out[0].score - 0.29);
});

test('fuseRanks — decay halves the recency signal after one half-life', () => {
  const now = 4_000_000_000_000;
  const [r] = fuseRanks(
    [input({ id: 'a', endTime: now - FUSION_HALF_LIFE_MS, keywordRank: 0, recencyRank: 0 })],
    NEUTRAL_FUSION_WEIGHTS,
    { now },
  );
  assert.ok(Math.abs(r.signals.recency - 0.5) < 1e-12);
});

// --- Parity: the MCP path now carries the signals it used to drop --------

function mkSession(o: any = {}) {
  return {
    id: o.id ?? Math.random().toString(36).slice(2),
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: o.startTime ?? Date.now() - 1000,
    endTime: o.endTime ?? Date.now(),
    summary: o.summary ?? 'demo',
    observationType: o.observationType ?? 'feature',
    keyFiles: o.keyFiles ?? [],
    keyTopics: o.keyTopics ?? [],
    decisions: o.decisions ?? [],
    problemsSolved: o.problemsSolved ?? [],
    userTags: o.userTags ?? [],
    redactionCount: 0,
    rawEventCount: 0,
    confidence: o.confidence,
    supersededBy: o.supersededBy,
    retracted: o.retracted,
  };
}

test('mcpServer.searchSessions — superseded session ranks below its live twin', () => {
  const now = Date.now();
  const db = {
    version: 2,
    lastUpdated: now,
    sessions: [
      mkSession({
        id: 'dead',
        summary: 'authentication rework',
        keyTopics: ['auth'],
        endTime: now,
        supersededBy: 'live',
      }),
      mkSession({
        id: 'live',
        summary: 'authentication rework',
        keyTopics: ['auth'],
        endTime: now,
      }),
    ],
  };
  const hits = searchSessions(db, 'authentication', {}, 5);
  assert.equal(hits[0].id, 'live');
});

test('mcpServer.searchSessions — higher confidence wins an otherwise-equal match', () => {
  const now = Date.now();
  const db = {
    version: 2,
    lastUpdated: now,
    sessions: [
      mkSession({
        id: 'low',
        summary: 'authentication rework',
        keyTopics: ['auth'],
        endTime: now,
        confidence: 0.2,
      }),
      mkSession({
        id: 'high',
        summary: 'authentication rework',
        keyTopics: ['auth'],
        endTime: now,
        confidence: 0.95,
      }),
    ],
  };
  const hits = searchSessions(db, 'authentication', {}, 5);
  assert.equal(hits[0].id, 'high');
});

test('mcpServer.searchSessions — retracted sessions are never surfaced', () => {
  const now = Date.now();
  const db = {
    version: 2,
    lastUpdated: now,
    sessions: [
      mkSession({
        id: 'gone',
        summary: 'authentication rework',
        keyTopics: ['auth'],
        endTime: now,
        retracted: true,
      }),
      mkSession({
        id: 'kept',
        summary: 'authentication rework',
        keyTopics: ['auth'],
        endTime: now - 5000,
      }),
    ],
  };
  const hits = searchSessions(db, 'authentication', {}, 5);
  assert.ok(hits.every((h) => h.id !== 'gone'));
  assert.equal(hits[0].id, 'kept');
});

test('mcpServer.searchSessions — match-ratio lifts a fuller match over a partial one', () => {
  const now = Date.now();
  const db = {
    version: 2,
    lastUpdated: now,
    sessions: [
      mkSession({
        id: 'partial',
        summary: 'authentication notes',
        keyTopics: ['auth'],
        endTime: now,
      }),
      mkSession({
        id: 'full',
        summary: 'authentication token refresh',
        keyTopics: ['auth', 'token'],
        endTime: now - 10000,
      }),
    ],
  };
  // "full" matches both query terms but is older; the match-ratio + keyword
  // signals should still float it to the top over the newer 1-term match.
  const hits = searchSessions(db, 'authentication token', {}, 5);
  assert.equal(hits[0].id, 'full');
});

/**
 * Regression tests for the independent v1.20.0 review's two confirmed
 * weaknesses: retrieval returning confident nonsense instead of abstaining,
 * and citation being conflated with factual validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { searchSessions, decisionGrounding } from '../mcpServer';
import { extractTerms } from '../searchCore';

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
    ...o,
  };
}

const PROBE_SESSIONS = [
  mkSession({
    id: 'invoices',
    summary: 'Use Service Bus sessions for ordered invoice processing',
    keyTopics: ['servicebus', 'invoice', 'fifo'],
  }),
  mkSession({
    id: 'blob',
    summary: 'Store uploaded images in Azure Blob Storage with SAS tokens',
    keyTopics: ['blob', 'storage', 'upload', 'images'],
  }),
  mkSession({
    id: 'aca',
    summary: 'Deploy the API to Azure Container Apps with managed identity',
    keyTopics: ['deploy', 'containerapps', 'identity'],
  }),
];

test('searchCore: compound identifiers also index their parts', () => {
  const terms = extractTerms('reciprocal-rank-fusion snake_case_name plain');
  for (const expected of [
    'reciprocal-rank-fusion',
    'reciprocal',
    'rank',
    'fusion',
    'snake',
    'case',
    'name',
    'plain',
  ]) {
    assert.ok(terms.has(expected), `missing term: ${expected}`);
  }
});

test('retrieval: a query matching nothing returns NOTHING, not recency filler', () => {
  const db = { version: 2, lastUpdated: 0, sessions: PROBE_SESSIONS };
  assert.deepEqual(searchSessions(db, 'Which dinosaur fossils exist?', {}, 5), []);
  // The empty query keeps its browse semantics (recency list).
  assert.equal(searchSessions(db, '', {}, 5).length, 3);
  // A real match still works.
  assert.equal(searchSessions(db, 'invoice order', {}, 5)[0]?.id, 'invoices');
});

test('retrieval: every returned result matched at least one query term', () => {
  const db = { version: 2, lastUpdated: 0, sessions: PROBE_SESSIONS };
  const hits = searchSessions(db, 'uploaded pictures storage', {}, 5);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, 'blob');
  assert.ok(!hits.some((s) => s.id === 'invoices'));
});

test('MCP search tool abstains with an explicit no_confident_match receipt', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghcp-mem-abstain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'sessions.json');
  writeFileSync(file, JSON.stringify({ version: 2, lastUpdated: 0, sessions: PROBE_SESSIONS }));
  const child = spawnSync(process.execPath, [join(__dirname, '..', 'mcpServer.js')], {
    input:
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'ghcpMem_search',
          arguments: { query: 'Which database stores dinosaur fossils?' },
        },
      }) + '\n',
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, GHCP_MEM_STORE_PATH: file },
  });
  assert.equal(child.status, 0, child.stderr);
  const response = JSON.parse(child.stdout.split('\n').find((l) => l.trim())!);
  const body = JSON.parse(response.result.content[0].text);
  assert.equal(body.count, 0);
  assert.equal(body.no_confident_match, true);
  assert.match(body.note, /No stored memory matches/);
  assert.equal(response.result.structuredContent.no_confident_match, true);
});

test('grounding: decisions are labeled cited/uncited, and the label is provenance only', () => {
  const session = mkSession({
    decisions: ['use postgres', 'uncited hot take'],
    decisionEvidence: [[{ eventIndex: 3 }], []],
  });
  assert.deepEqual(decisionGrounding(session), ['cited', 'uncited']);
  // Sessions with no evidence arrays (explicit MCP writes, imports) are all uncited.
  assert.deepEqual(decisionGrounding(mkSession({ decisions: ['a', 'b'] })), ['uncited', 'uncited']);
});

test('grounding: MCP search results carry decisionGrounding per decision', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghcp-mem-grounding-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'sessions.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      lastUpdated: 0,
      sessions: [
        mkSession({
          id: 'g1',
          summary: 'postgres decision record',
          keyTopics: ['postgres'],
          decisions: ['use postgres'],
          decisionEvidence: [[{ eventIndex: 0 }]],
        }),
      ],
    }),
  );
  const child = spawnSync(process.execPath, [join(__dirname, '..', 'mcpServer.js')], {
    input:
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'ghcpMem_search', arguments: { query: 'postgres' } },
      }) + '\n',
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, GHCP_MEM_STORE_PATH: file },
  });
  assert.equal(child.status, 0, child.stderr);
  const body = JSON.parse(
    JSON.parse(child.stdout.split('\n').find((l) => l.trim())!).result.content[0].text,
  );
  assert.deepEqual(body.results[0].decisionGrounding, ['cited']);
});

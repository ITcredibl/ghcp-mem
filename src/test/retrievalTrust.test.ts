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

test('retrieval: extension store and MCP server calibrate identically (parity)', async () => {
  const { InMemoryMemento } = await import('./__mocks__/vscode');
  const { ContextStore } = await import('../contextStore');
  const store = new ContextStore(new InMemoryMemento() as never);
  (store as never as { syncToDisk: () => Promise<void> }).syncToDisk = async () => {};
  for (const session of PROBE_SESSIONS) {
    await store.addSession({ ...session, contentHash: undefined } as never);
  }
  const db = { version: 2, lastUpdated: 0, sessions: PROBE_SESSIONS };
  for (const probe of [
    'invoice order',
    'Where should we keep uploaded pictures?',
    'What is the Azure dinosaur fossil database?',
    'Which database stores dinosaur fossils?',
    'what should they have been',
  ]) {
    const viaStore = store.search(probe, {}, 5).map((s) => s.id);
    const viaMcp = searchSessions(db, probe, {}, 5).map((s) => s.id);
    // The decision that matters is serve-vs-abstain and the top hit — the two
    // paths rank with different signal sets, but must never disagree on
    // whether a query deserves ANY answer.
    assert.equal(
      viaStore.length === 0,
      viaMcp.length === 0,
      `paths disagree on abstention for "${probe}": store=[${viaStore}] mcp=[${viaMcp}]`,
    );
    if (viaMcp.length > 0) assert.equal(viaStore[0], viaMcp[0], `top hit differs for "${probe}"`);
  }
});

test('retrieval: incidental single-word overlap abstains (review v1.21.0 probe)', () => {
  const db = { version: 2, lastUpdated: 0, sessions: PROBE_SESSIONS };
  // "Azure" appears in real memories, but one shared word out of four
  // significant terms is incidental overlap — abstain, never bluff.
  assert.deepEqual(searchSessions(db, 'What is the Azure dinosaur fossil database?', {}, 5), []);
  // Stopwords don't count toward coverage, so a short natural question whose
  // meaningful words DO match still resolves.
  const hits = searchSessions(db, 'Where should we keep uploaded pictures?', {}, 5);
  assert.equal(hits[0]?.id, 'blob');
  // Matching only stopword-grade words never returns anything.
  assert.deepEqual(searchSessions(db, 'what should they have been', {}, 5), []);
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

test('retrieval: shared-term boundary cases are labeled low-confidence, not bluffed (v1.21.1 review)', (t) => {
  // "Azure dinosaur fossils" legitimately matches one significant term of
  // three — lexical retrieval cannot KNOW the query is out-of-domain (that is
  // the published paraphrase gap), so the honest contract is a per-result
  // coverage receipt plus an explicit low-confidence warning.
  const dir = mkdtempSync(join(tmpdir(), 'ghcp-mem-weak-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'sessions.json');
  writeFileSync(file, JSON.stringify({ version: 2, lastUpdated: 0, sessions: PROBE_SESSIONS }));
  const run = (query: string) => {
    const child = spawnSync(process.execPath, [join(__dirname, '..', 'mcpServer.js')], {
      input:
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'ghcpMem_search', arguments: { query } },
        }) + '\n',
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, GHCP_MEM_STORE_PATH: file },
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(
      JSON.parse(child.stdout.split('\n').find((l) => l.trim())!).result.content[0].text,
    );
  };
  const weak = run('Azure dinosaur fossils');
  assert.equal(weak.low_confidence, true, 'boundary overlap must be flagged');
  assert.match(weak.note, /treat as a lead, not an answer/);
  assert.ok(weak.results.every((r: { termCoverage: number }) => r.termCoverage <= 0.5));
  // "invoice order": coverage is exactly 0.5 ('order' ≠ 'ordered' without
  // stemming) — at the threshold, so correct AND unflagged.
  const mid = run('invoice order');
  assert.equal(mid.low_confidence, undefined, 'at-threshold matches carry no warning');
  assert.equal(mid.results[0].termCoverage, 0.5);
  const strong = run('ordered invoice processing');
  assert.equal(strong.low_confidence, undefined, 'confident matches carry no warning');
  assert.equal(strong.results[0].termCoverage, 1);
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

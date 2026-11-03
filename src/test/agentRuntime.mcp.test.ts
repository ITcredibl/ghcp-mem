/**
 * End-to-end checks for the v1.20.0 MCP surfaces: resources, prompts, the
 * context compiler / knowledge-graph tools, lifecycle + outcome writes,
 * agent-scope privacy and committed-org-policy enforcement. Each test spawns
 * the real stdio server process, the same way external clients run it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function mkSession(o: any = {}) {
  return {
    id: o.id ?? Math.random().toString(36).slice(2),
    workspaceId: 'ws',
    workspaceName: 'ws',
    startTime: o.startTime ?? Date.now() - 1000,
    endTime: o.endTime ?? Date.now(),
    summary: o.summary ?? 'demo',
    observationType: o.observationType ?? 'feature',
    keyFiles: o.keyFiles ?? ['a.ts'],
    keyTopics: o.keyTopics ?? ['x'],
    decisions: o.decisions ?? [],
    problemsSolved: o.problemsSolved ?? [],
    userTags: o.userTags ?? [],
    redactionCount: 0,
    rawEventCount: 0,
    ...o,
  };
}

interface ServeOptions {
  sessions?: unknown[];
  lessons?: unknown[];
  env?: Record<string, string>;
  dir: string;
}

/** Run the stdio server with one request per line; returns parsed responses by id. */
function serve(requests: object[], options: ServeOptions): Map<number, any> {
  const file = join(options.dir, 'sessions.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      sessions: options.sessions ?? [],
      lessons: options.lessons ?? [],
      lastUpdated: 0,
    }),
  );
  const child = spawnSync(process.execPath, [join(__dirname, '..', 'mcpServer.js')], {
    input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, GHCP_MEM_STORE_PATH: file, ...options.env },
  });
  assert.equal(child.status, 0, child.stderr);
  const responses = new Map<number, any>();
  for (const line of child.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line);
    responses.set(parsed.id, parsed);
  }
  return responses;
}

function toolResult(response: any): any {
  assert.ok(!response.error, JSON.stringify(response.error));
  return JSON.parse(response.result.content[0].text);
}

function rpc(id: number, method: string, params?: object): object {
  return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
}

test('MCP initialize advertises resources and prompts capabilities', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghcp-mem-caps-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const responses = serve([rpc(1, 'initialize')], { dir });
  assert.deepEqual(responses.get(1).result.capabilities, {
    tools: {},
    resources: {},
    prompts: {},
  });
});

test('MCP initialize negotiates the protocol version per spec', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghcp-mem-proto-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const responses = serve(
    [
      rpc(1, 'initialize', { protocolVersion: '2025-06-18' }),
      rpc(2, 'initialize', { protocolVersion: '2024-11-05' }),
      rpc(3, 'initialize', { protocolVersion: '2031-01-01' }),
      rpc(4, 'initialize'),
    ],
    { dir },
  );
  // A supported requested revision is echoed back.
  assert.equal(responses.get(1).result.protocolVersion, '2025-06-18');
  assert.equal(responses.get(2).result.protocolVersion, '2024-11-05');
  // Unknown or absent → the server's latest supported revision.
  assert.equal(responses.get(3).result.protocolVersion, '2026-07-28');
  assert.equal(responses.get(4).result.protocolVersion, '2026-07-28');
});

test('MCP tool results carry structured content alongside text', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghcp-mem-structured-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const responses = serve(
    [rpc(1, 'tools/call', { name: 'ghcpMem_search', arguments: { query: 'auth' } })],
    { dir, sessions: [mkSession({ summary: 'auth notes' })] },
  );
  const result = responses.get(1).result;
  const fromText = JSON.parse(result.content[0].text);
  assert.ok(result.structuredContent, 'structuredContent missing');
  assert.deepEqual(result.structuredContent, fromText, 'both representations must agree');
  assert.equal(result.structuredContent.count, 1);
});

test('MCP resources list and read over the live store', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghcp-mem-res-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessions = [
    mkSession({
      decisions: ['use managed identity'],
      lifecycle: 'merged',
      outcomes: [
        {
          status: 'improved',
          observedAt: Date.now(),
          decisionIndex: 0,
          observations: ['0 incidents'],
        },
      ],
    }),
  ];
  const responses = serve(
    [
      rpc(1, 'resources/list'),
      rpc(2, 'resources/read', { uri: 'memory://repo/decisions' }),
      rpc(3, 'resources/read', { uri: 'memory://repo/outcomes' }),
      rpc(4, 'resources/read', { uri: 'memory://repo/nope' }),
    ],
    { dir, sessions },
  );
  const uris = responses.get(1).result.resources.map((r: any) => r.uri);
  assert.ok(uris.includes('memory://repo/decisions'));
  assert.ok(uris.includes('memory://repo/lessons'));
  const decisions = responses.get(2).result.contents[0].text;
  assert.match(decisions, /use managed identity/);
  assert.match(decisions, /merged/);
  assert.match(decisions, /outcome: improved/);
  assert.match(responses.get(3).result.contents[0].text, /improved: 0 incidents/);
  assert.ok(responses.get(4).error, 'unknown resource must error');
});

test('MCP prompts list, require declared arguments, and render', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghcp-mem-prompts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const responses = serve(
    [
      rpc(1, 'prompts/list'),
      rpc(2, 'prompts/get', { name: 'architecture-recall', arguments: { topic: 'AuthService' } }),
      rpc(3, 'prompts/get', { name: 'architecture-recall' }),
      rpc(4, 'prompts/get', { name: 'resume-task' }),
    ],
    { dir },
  );
  const names = responses
    .get(1)
    .result.prompts.map((p: any) => p.name)
    .sort();
  assert.deepEqual(names, [
    'architecture-recall',
    'incident-context',
    'memory-review',
    'resume-task',
  ]);
  assert.match(responses.get(2).result.messages[0].content.text, /AuthService/);
  assert.ok(responses.get(3).error, 'missing required argument must error');
  assert.match(responses.get(4).result.messages[0].content.text, /ghcpMem_task_status/);
});

test('MCP compile budgets context and reports branch-validity omissions', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghcp-mem-compile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessions = [
    mkSession({
      id: 'mainline',
      summary: 'checkout retry fixed',
      lifecycle: 'merged',
      keyTopics: ['checkout', 'retry'],
    }),
    mkSession({
      id: 'spec',
      summary: 'checkout experiment',
      lifecycle: 'experimental',
      branchName: 'feat/other',
      keyTopics: ['checkout', 'experiment'],
    }),
  ];
  const responses = serve(
    [
      rpc(1, 'tools/call', {
        name: 'ghcpMem_compile',
        arguments: { query: 'checkout', branch: 'main' },
      }),
    ],
    { dir, sessions },
  );
  const compiled = toolResult(responses.get(1));
  assert.match(compiled.context, /checkout retry fixed/);
  assert.ok(compiled.plan.some((item: any) => item.id === 'mainline'));
  assert.ok(
    compiled.omitted.some((item: any) => item.id === 'spec' && /feat\/other/.test(item.reason)),
    JSON.stringify(compiled.omitted),
  );
  assert.equal(compiled.measurement, 'utf8-bytes/4-estimate');
});

test('MCP knowledge graph answers neighborhoods and paths', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghcp-mem-graph-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessions = [
    mkSession({ id: 'aaa', keyFiles: ['src/order.ts'], decisions: ['cache via redis'] }),
  ];
  const responses = serve(
    [
      rpc(1, 'tools/call', { name: 'ghcpMem_knowledge_graph', arguments: {} }),
      rpc(2, 'tools/call', {
        name: 'ghcpMem_knowledge_graph',
        arguments: { focus: 'file:src/order.ts', to: 'decision:aaa:0' },
      }),
      rpc(3, 'tools/call', {
        name: 'ghcpMem_knowledge_graph',
        arguments: { focus: 'file:src/order.ts', format: 'mermaid' },
      }),
    ],
    { dir, sessions },
  );
  const summary = toolResult(responses.get(1));
  assert.ok(summary.nodes >= 3 && summary.edges >= 2);
  const path = toolResult(responses.get(2)).path.map((node: any) => node.id);
  assert.deepEqual(path, ['file:src/order.ts', 'session:aaa', 'decision:aaa:0']);
  assert.match(toolResult(responses.get(3)).mermaid, /^flowchart TD/);
});

test('MCP lifecycle + outcome writes persist, respect the write gate and the state machine', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghcp-mem-writes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessions = [mkSession({ id: 'target', decisions: ['ship it'], lifecycle: 'implemented' })];

  const denied = serve(
    [
      rpc(1, 'tools/call', {
        name: 'ghcpMem_set_lifecycle',
        arguments: { id: 'target', lifecycle: 'merged' },
      }),
    ],
    { dir, sessions },
  );
  assert.ok(denied.get(1).error, 'writes must be disabled without the opt-in');

  const env = { GHCP_MEM_ALLOW_MCP_WRITE: 'true', GHCP_MEM_AGENT_ID: 'agent:verifier' };
  const allowed = serve(
    [
      rpc(1, 'tools/call', {
        name: 'ghcpMem_set_lifecycle',
        arguments: { id: 'target', lifecycle: 'merged' },
      }),
      rpc(2, 'tools/call', {
        name: 'ghcpMem_record_outcome',
        arguments: {
          id: 'target',
          status: 'improved',
          decisionIndex: 0,
          observations: ['p95 -20ms'],
        },
      }),
      rpc(3, 'tools/call', {
        name: 'ghcpMem_set_lifecycle',
        arguments: { id: 'target', lifecycle: 'proposed' },
      }),
    ],
    { dir, sessions, env },
  );
  assert.equal(toolResult(allowed.get(1)).lifecycle, 'merged');
  assert.equal(toolResult(allowed.get(2)).outcome.reportedBy, 'agent:verifier');
  assert.ok(allowed.get(3).error, 'illegal transition must be rejected');
  const stored = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'));
  assert.equal(stored.sessions[0].lifecycle, 'merged');
  assert.equal(stored.sessions[0].outcomes?.length, 1);
  assert.equal(stored.sessions.length, 1, 'writes must never drop other rows');
});

test('MCP agent-scoped memories are private to their author identity', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghcp-mem-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessions = [
    mkSession({ id: 'shared', summary: 'auth notes shared', keyTopics: ['auth', 'shared'] }),
    mkSession({
      id: 'private',
      summary: 'auth notes private scratch',
      keyTopics: ['auth', 'scratch'],
      scopeLevel: 'agent',
      author: 'claude:reviewer',
    }),
  ];
  const request = [rpc(1, 'tools/call', { name: 'ghcpMem_search', arguments: { query: 'auth' } })];
  const asOwner = toolResult(
    serve(request, { dir, sessions, env: { GHCP_MEM_AGENT_ID: 'claude:reviewer' } }).get(1),
  );
  assert.equal(asOwner.count, 2);
  const asStranger = toolResult(
    serve(request, { dir, sessions, env: { GHCP_MEM_AGENT_ID: 'cursor:impl' } }).get(1),
  );
  assert.equal(asStranger.count, 1);
  assert.equal(asStranger.results[0].id, 'shared');
});

test('MCP store honors the committed org policy and fails closed on a broken one', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghcp-mem-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const policyPath = join(dir, 'policy.json');
  writeFileSync(
    policyPath,
    JSON.stringify({ version: 1, scopes: { organization: { write: ['human'], read: 'all' } } }),
  );
  const store = (scopeLevel?: string) =>
    rpc(1, 'tools/call', {
      name: 'ghcpMem_store',
      arguments: { summary: 'org-wide standard', ...(scopeLevel ? { scopeLevel } : {}) },
    });
  const envBase = { GHCP_MEM_ALLOW_MCP_WRITE: 'true', GHCP_MEM_POLICY_FILE: policyPath };

  const deniedKind = serve([store('organization')], {
    dir,
    env: { ...envBase, GHCP_MEM_AGENT_ID: 'claude:reviewer' },
  });
  assert.match(deniedKind.get(1).error.message, /policy denied/);

  const allowedHuman = serve([store('organization')], {
    dir,
    env: { ...envBase, GHCP_MEM_AGENT_ID: 'human:seyi' },
  });
  assert.equal(toolResult(allowedHuman.get(1)).stored, true);

  const repoLevel = serve([store()], {
    dir,
    env: { ...envBase, GHCP_MEM_AGENT_ID: 'claude:reviewer' },
  });
  assert.equal(toolResult(repoLevel.get(1)).stored, true, 'unrestricted level stays writable');

  writeFileSync(policyPath, '{broken');
  const broken = serve([store()], { dir, env: envBase });
  assert.ok(broken.get(1).error, 'invalid policy must fail closed on the MCP write surface');
});

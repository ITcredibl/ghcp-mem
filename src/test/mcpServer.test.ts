import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKey, serializeDb, deserializeDb, isEncryptedEnvelope } from '../storageCrypto';
import { searchSessions, timelineSessions, TOOLS, redactPersistedStrings } from '../mcpServer';

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
  };
}

test('mcpServer — TOOLS catalog exposes the full surface', () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'ghcpMem_cancel_task',
    'ghcpMem_checkpoint',
    'ghcpMem_compile',
    'ghcpMem_compile_context',
    'ghcpMem_complete_task',
    'ghcpMem_conflicts',
    'ghcpMem_delete',
    'ghcpMem_entity',
    'ghcpMem_explain',
    'ghcpMem_get',
    'ghcpMem_graph',
    'ghcpMem_knowledge_graph',
    'ghcpMem_lessons',
    'ghcpMem_lineage',
    'ghcpMem_purge_task',
    'ghcpMem_recent',
    'ghcpMem_record_outcome',
    'ghcpMem_resume',
    'ghcpMem_route',
    'ghcpMem_search',
    'ghcpMem_set_lifecycle',
    'ghcpMem_snippets',
    'ghcpMem_start_task',
    'ghcpMem_store',
    'ghcpMem_task_status',
    'ghcpMem_timeline',
    'ghcpMem_update_task',
  ]);
});

test('mcpServer — searchSessions ranks exact topic match above noise', () => {
  const db = {
    version: 2,
    lastUpdated: Date.now(),
    sessions: [
      mkSession({ summary: 'authentication rework', keyTopics: ['auth'] }),
      mkSession({ summary: 'ui tweaks', keyTopics: ['colors'] }),
    ],
  };
  const hits = searchSessions(db, 'authentication', {}, 5);
  assert.ok(hits.length >= 1);
  assert.match(hits[0].summary, /authentication/);
});

test('mcpServer — searchSessions respects type filter', () => {
  const db = {
    version: 2,
    lastUpdated: Date.now(),
    sessions: [
      mkSession({ summary: 'bug', observationType: 'bugfix' }),
      mkSession({ summary: 'feat', observationType: 'feature' }),
    ],
  };
  const hits = searchSessions(db, '', { type: 'bugfix' }, 5);
  assert.ok(hits.every((h) => h.observationType === 'bugfix'));
});

test('mcpServer — searchSessions respects sinceDays filter', () => {
  const db = {
    version: 2,
    lastUpdated: Date.now(),
    sessions: [
      mkSession({ summary: 'old', endTime: Date.now() - 40 * 24 * 60 * 60 * 1000 }),
      mkSession({ summary: 'new' }),
    ],
  };
  const hits = searchSessions(db, '', { sinceDays: 7 }, 5);
  assert.ok(hits.every((h) => h.summary !== 'old'));
});

test('mcpServer — timelineSessions returns most recent first', () => {
  const now = Date.now();
  const db = {
    version: 2,
    lastUpdated: now,
    sessions: [
      mkSession({ id: 'old', summary: 'old', endTime: now - 3 * 24 * 60 * 60 * 1000 }),
      mkSession({ id: 'mid', summary: 'mid', endTime: now - 2 * 24 * 60 * 60 * 1000 }),
      mkSession({ id: 'new', summary: 'new', endTime: now - 1 * 24 * 60 * 60 * 1000 }),
    ],
  };
  const hits = timelineSessions(db as any, 7, 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'new');
  assert.equal(hits[1].id, 'mid');
});

// ---------------------------------------------------------------------------
// v1.10.2 — MCP write path redaction (ghcpMem_store no longer persists raw).
// Before v1.10.2 the MCP `ghcpMem_store` handler took external-client input
// (Cursor / Claude Desktop / Cline) verbatim and pushed it into sessions.json,
// bypassing every secret rule that the in-process VS Code surface enforces.
// These tests pin the new behaviour: the same redactor that protects the
// in-process write surface also gates every MCP write.
// ---------------------------------------------------------------------------

test('mcpServer.redactPersistedStrings — masks an AWS key in summary', () => {
  const { redacted, count } = redactPersistedStrings({
    summary: 'Set AKIAIOSFODNN7EXAMPLE on the build runner',
    keyFiles: ['ci/setup.sh'],
  });
  assert.match(redacted.summary as string, /\[REDACTED:aws-access-key\]/);
  assert.deepEqual(redacted.keyFiles, ['ci/setup.sh']);
  assert.ok(count >= 1, 'redactionCount should reflect the AWS hit');
});

test('mcpServer.redactPersistedStrings — masks secrets inside an array', () => {
  const { redacted, count } = redactPersistedStrings({
    summary: 'innocent',
    decisions: [
      'use bcrypt cost 12',
      'rotate ghp_1234567890abcdefghijklmnopqrstuvwxyzAB last sprint',
    ],
  });
  const decs = redacted.decisions as string[];
  assert.equal(decs[0], 'use bcrypt cost 12');
  assert.match(decs[1], /\[REDACTED:github-token\]/);
  assert.ok(count >= 1);
});

test('mcpServer.redactPersistedStrings — pass-through preserves clean input + 0 count', () => {
  const { redacted, count } = redactPersistedStrings({
    summary: 'refactor cart checkout',
    keyFiles: ['src/cart.ts'],
    keyTopics: ['cart'],
    decisions: ['extract usePricing()'],
    problemsSolved: ['shipping address race'],
    userTags: ['demo'],
  });
  assert.equal(count, 0);
  assert.equal(redacted.summary, 'refactor cart checkout');
  assert.deepEqual(redacted.keyTopics, ['cart']);
});

test('mcpServer.redactPersistedStrings — drops non-string array entries', () => {
  const { redacted } = redactPersistedStrings({
    decisions: ['fine', 42, null, undefined, 'also fine'] as unknown as string[],
  });
  // Implementation skips non-strings rather than passing them through —
  // protects against MCP clients sending malformed array items.
  assert.deepEqual(redacted.decisions, ['fine', 'also fine']);
});

test('MCP writes preserve encryption and fail closed without a key', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'ghcp-mem-security-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const key = generateKey();
  const file = join(directory, 'sessions.json');
  const original = serializeDb(
    { version: 2, sessions: [mkSession({ id: 'original' })], lastUpdated: 0 },
    key,
    'passphrase',
    Buffer.alloc(16, 1),
  );
  const request =
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'ghcpMem_store', arguments: { summary: 'new memory' } },
    }) + '\n';
  for (const suppliedKey of ['', generateKey().toString('hex'), key.toString('hex')]) {
    writeFileSync(file, original);
    const child = spawnSync(process.execPath, [join(__dirname, '..', 'mcpServer.js')], {
      input: request,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        GHCP_MEM_STORE_PATH: file,
        GHCP_MEM_ALLOW_MCP_WRITE: 'true',
        GHCP_MEM_READONLY: 'false',
        GHCP_MEM_KEY: suppliedKey,
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const after = readFileSync(file, 'utf8');
    assert.ok(isEncryptedEnvelope(after));
    if (suppliedKey !== key.toString('hex')) {
      assert.equal(after, original);
      assert.ok(JSON.parse(child.stdout).error);
    } else {
      const decoded = deserializeDb<{ sessions: { id: string }[] }>(after, key);
      assert.equal(decoded?.sessions.length, 2);
      assert.equal(JSON.parse(after).mode, 'passphrase');
      assert.equal(JSON.parse(after).salt, Buffer.alloc(16, 1).toString('hex'));
    }
  }
});

test('MCP delete rejects absent and ambiguous ids without changing the store', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'ghcp-mem-delete-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'sessions.json');
  const original = JSON.stringify({
    version: 2,
    sessions: [mkSession({ id: 'shared-one' }), mkSession({ id: 'shared-two' })],
    lastUpdated: 0,
  });
  for (const args of [{}, { id: '' }, { id: ' ' }, { id: 'shared-' }]) {
    writeFileSync(file, original);
    const child = spawnSync(process.execPath, [join(__dirname, '..', 'mcpServer.js')], {
      input:
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'ghcpMem_delete', arguments: args },
        }) + '\n',
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        GHCP_MEM_STORE_PATH: file,
        GHCP_MEM_ALLOW_MCP_WRITE: 'true',
        GHCP_MEM_READONLY: 'false',
      },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.ok(JSON.parse(child.stdout).error);
    assert.equal(readFileSync(file, 'utf8'), original);
  }
});

test('MCP timeline excludes retracted records', () => {
  const db = {
    version: 2,
    lastUpdated: 0,
    sessions: [{ ...mkSession(), retracted: true }, mkSession({ id: 'visible' })],
  };
  assert.deepEqual(
    timelineSessions(db).map((session) => session.id),
    ['visible'],
  );
});

test('MCP serializes pipelined writes and hides retractions on every ordinary read', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'ghcp-mem-pipeline-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'sessions.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      sessions: [{ ...mkSession({ id: 'withdrawn' }), retracted: true }],
      lastUpdated: 0,
    }),
  );
  const calls = [
    { name: 'ghcpMem_store', arguments: { summary: 'first' } },
    { name: 'ghcpMem_store', arguments: { summary: 'second' } },
    { name: 'ghcpMem_recent', arguments: {} },
    { name: 'ghcpMem_get', arguments: { id: 'withdrawn' } },
  ];
  const input =
    calls
      .map((params, index) =>
        JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params }),
      )
      .join('\n') + '\n';
  const child = spawnSync(process.execPath, [join(__dirname, '..', 'mcpServer.js')], {
    input,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      GHCP_MEM_STORE_PATH: file,
      GHCP_MEM_ALLOW_MCP_WRITE: 'true',
      GHCP_MEM_READONLY: 'false',
    },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessions.length, 3);
  const replies = child.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(JSON.parse(replies[2].result.content[0].text).count, 2);
  assert.ok(JSON.parse(replies[3].result.content[0].text).error);
});

test('MCP supports bounded discovery, batched detail, and runtime schema rejection', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'ghcp-mem-budget-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'sessions.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      sessions: [
        mkSession({ id: 'one', summary: 'authentication' }),
        mkSession({ id: 'two', summary: 'authentication updates' }),
      ],
      lastUpdated: 0,
    }),
  );
  const calls = [
    {
      name: 'ghcpMem_search',
      arguments: { query: 'authentication', detail: 'index', maxTokens: 200 },
    },
    { name: 'ghcpMem_get', arguments: { ids: ['one', 'two'], maxTokens: 2400 } },
    { name: 'ghcpMem_get', arguments: { id: 7 } },
    { name: 'ghcpMem_store', arguments: {} },
  ];
  const input =
    calls
      .map((params, index) =>
        JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params }),
      )
      .join('\n') + '\n';
  const child = spawnSync(process.execPath, [join(__dirname, '..', 'mcpServer.js')], {
    input,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, GHCP_MEM_STORE_PATH: file, GHCP_MEM_READONLY: 'true' },
  });
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const discovery = JSON.parse(replies[0].result.content[0].text);
  assert.ok(Math.ceil(Buffer.byteLength(replies[0].result.content[0].text, 'utf8') / 4) <= 200);
  assert.match(discovery.receipt.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(replies[1].result.content[0].text).count, 2);
  assert.ok(replies[2].error);
  assert.ok(replies[3].error);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeHook } from '../agentBridge';

test('harness adapters capture only allowlisted metadata and bind it to a repository', () => {
  for (const [harness, event, payload] of [
    [
      'copilot',
      'postToolUse',
      {
        sessionId: 'session',
        toolName: 'read_file',
        toolCallId: 'call',
        toolArgs: { password: 'sensitive-input' },
        toolResult: 'sensitive-output',
        prompt: 'private-prompt',
      },
    ],
    [
      'claude',
      'PostToolUse',
      {
        session_id: 'session',
        tool_name: 'Read',
        tool_use_id: 'call',
        tool_input: 'sensitive-input',
        tool_response: 'sensitive-output',
        prompt: 'private-prompt',
      },
    ],
  ] as const) {
    const result = normalizeHook(harness, event, payload, 'repo', 1000);
    assert.equal(result.repoScope, 'repo');
    assert.doesNotMatch(JSON.stringify(result), /sensitive-input|sensitive-output|private-prompt/);
    assert.deepEqual(result.decisions, []);
    assert.equal(result.id, normalizeHook(harness, event, payload, 'repo', 2000).id);
  }
});

test('harness adapters reject unknown contracts, mismatched events and missing scope', () => {
  assert.throws(() => normalizeHook('codex', 'PostToolUse', {}, 'repo'));
  assert.throws(() => normalizeHook('copilot', 'PostToolUse', {}, 'repo'));
  assert.throws(() =>
    normalizeHook(
      'claude',
      'PostToolUse',
      { session_id: 'session', hook_event_name: 'PreCompact' },
      'repo',
    ),
  );
  assert.throws(() => normalizeHook('claude', 'PostToolUse', { session_id: 'session' }, ''));
});

test('bridge persists checkpoints and opt-in metadata while preserving corrupt stores', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'ghcp-mem-agent-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'sessions.json');
  const env = {
    ...process.env,
    GHCP_MEM_STORE_PATH: file,
    GHCP_MEM_REPO_SCOPE: 'repo',
    GHCP_MEM_ALLOW_HOOK_CAPTURE: 'false',
  };
  const checkpoint = {
    harness: 'ci',
    taskId: 'release',
    repoScope: 'repo',
    commit: 'a'.repeat(40),
    stage: 'attempted',
    summary: 'Rollout pending validation',
    evidence: [],
    nextActions: ['Run health check'],
  };
  const bridge = spawnSync(
    process.execPath,
    [join(__dirname, '..', 'agentBridge.js'), 'checkpoint'],
    { input: JSON.stringify(checkpoint), encoding: 'utf8', timeout: 10000, env },
  );
  assert.equal(bridge.status, 0, bridge.stderr);
  const seed = spawnSync(process.execPath, [join(__dirname, '..', 'ciSeeder.js')], {
    input: bridge.stdout,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(seed.status, 0, seed.stderr);
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(persisted.sessions[0].checkpoint.authority, 'none');
  const input = JSON.stringify({
    sessionId: 'hook-session',
    toolName: 'read_file',
    toolCallId: 'call',
    toolArgs: { secret: 'must-not-persist' },
  });
  const command = [join(__dirname, '..', 'agentBridge.js'), 'hook', 'copilot', 'postToolUse'];
  const disabled = spawnSync(process.execPath, command, {
    input,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.equal(disabled.stdout.trim(), '{}');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessions.length, 1);
  const enabled = spawnSync(process.execPath, command, {
    input,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...env, GHCP_MEM_ALLOW_HOOK_CAPTURE: 'true' },
  });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessions.length, 2);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /must-not-persist/);
  writeFileSync(file, 'corrupt store');
  const rejected = spawnSync(process.execPath, [join(__dirname, '..', 'ciSeeder.js')], {
    input: bridge.stdout,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  assert.notEqual(rejected.status, 0);
  assert.equal(readFileSync(file, 'utf8'), 'corrupt store');
});

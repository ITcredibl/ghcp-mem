#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createCheckpoint } from './agentCheckpoint';
import { redact } from './redactor';
import type { CompressedSession } from './types';

export function normalizeHook(
  harness: string,
  event: string,
  value: unknown,
  repoScope: string,
  now = Date.now(),
): CompressedSession {
  if (harness !== 'copilot' && harness !== 'claude') throw new Error('Unsupported hook harness');
  const allowed =
    harness === 'copilot'
      ? ['sessionStart', 'postToolUse', 'preCompact', 'sessionEnd']
      : ['SessionStart', 'PostToolUse', 'PreCompact', 'SessionEnd'];
  if (!allowed.includes(event)) throw new Error('Unsupported lifecycle event');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid hook payload');
  const input = value as Record<string, unknown>;
  const sessionId = harness === 'copilot' ? input.sessionId : input.session_id;
  const suppliedEvent = harness === 'copilot' ? input.hookEventName : input.hook_event_name;
  if (suppliedEvent !== undefined && suppliedEvent !== event)
    throw new Error('Hook event does not match adapter');
  if (typeof sessionId !== 'string' || sessionId.length > 200 || !sessionId.trim())
    throw new Error('Hook requires a session identifier');
  if (!repoScope.trim() || repoScope.length > 300)
    throw new Error('Explicit repository scope is required');
  const scope = redact(repoScope, { redactSecrets: true, honorPrivateTags: true }).text;
  const rawTool = harness === 'copilot' ? input.toolName : input.tool_name;
  const tool =
    typeof rawTool === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(rawTool)
      ? redact(rawTool, { redactSecrets: true, honorPrivateTags: true }).text
      : 'unspecified';
  const summary = `${harness} lifecycle event ${event}; tool: ${tool}. Metadata only; no task completion inferred.`;
  const correlation = harness === 'copilot' ? input.toolCallId : input.tool_use_id;
  const id = createHash('sha256')
    .update(JSON.stringify([scope, harness, sessionId, event, correlation ?? now]))
    .digest('hex');
  return {
    id,
    workspaceId: scope,
    workspaceName: scope,
    repoScope: scope,
    startTime: now,
    endTime: now,
    summary,
    observationType: 'research',
    keyFiles: [],
    keyTopics: [harness, 'lifecycle'],
    decisions: [],
    problemsSolved: [],
    userTags: ['agent-hook', harness],
    rawEventCount: 1,
    redactionCount: 0,
  };
}

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input, 'utf8') > 65536) throw new Error('Bridge input exceeds 64 KiB');
  }
  const value: unknown = JSON.parse(input);
  if (process.argv[2] === 'checkpoint') {
    const checkpoint = createCheckpoint(value);
    process.stdout.write(
      JSON.stringify({
        sessions: [
          {
            id: checkpoint.digest,
            workspaceId: checkpoint.repoScope,
            workspaceName: checkpoint.repoScope,
            repoScope: checkpoint.repoScope,
            startTime: checkpoint.createdAt,
            endTime: checkpoint.createdAt,
            summary: checkpoint.summary,
            observationType: 'deployment',
            userTags: ['checkpoint', checkpoint.harness],
            checkpoint,
          },
        ],
        seedLabel: 'agent-checkpoint',
      }) + '\n',
    );
    return;
  }
  if (process.argv[2] !== 'hook')
    throw new Error('Use checkpoint or hook <copilot|claude> <event>');
  if (process.env.GHCP_MEM_ALLOW_HOOK_CAPTURE !== 'true') {
    process.stdout.write('{}\n');
    return;
  }
  const session = normalizeHook(
    process.argv[3],
    process.argv[4],
    value,
    process.env.GHCP_MEM_REPO_SCOPE ?? '',
  );
  const child = spawnSync(process.execPath, [join(__dirname, 'ciSeeder.js')], {
    input: JSON.stringify({ sessions: [session], seedLabel: 'agent-hook' }),
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 65536,
  });
  if (child.error || child.status !== 0)
    throw new Error('Hook capture failed; store unchanged or unavailable');
  process.stdout.write('{}\n');
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `[ghcp-mem-agent] ${error instanceof Error ? error.message : 'Bridge failed'}\n`,
    );
    process.exitCode = 1;
  });
}

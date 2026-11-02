import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { handleTaskTool } from '../taskTools';
import type { AgentTask } from '../taskRuntime';

test('task tools enforce launcher identity and complete a cross-agent workflow without trusting client privilege claims', async (context) => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'task-tools-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const worktree = join(directory, 'repo');
  await fs.mkdir(worktree);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=' + join(directory, 'no-hooks'),
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  git('init');
  await fs.writeFile(join(worktree, 'source.txt'), 'original');
  git('add', 'source.txt');
  git(
    '-c',
    'user.name=Task Test',
    '-c',
    'user.email=task@example.invalid',
    'commit',
    '-m',
    'Initial',
  );
  const env = {
    GHCP_MEM_TASK_ACTOR: 'copilot',
    GHCP_MEM_REPO_SCOPE: 'repo',
    GHCP_MEM_TASK_WORKTREE: worktree,
    GHCP_MEM_TASK_PATH: join(directory, 'tasks'),
    GHCP_MEM_TASK_ALLOW_PLAINTEXT: 'true',
    GHCP_MEM_ALLOW_MCP_WRITE: 'true',
  };
  const start = {
    requestId: 'start',
    goal: 'Implement authentication',
    visibility: 'shared',
    steps: [{ id: 'build', title: 'Build middleware' }],
    acceptanceCriteria: [{ id: 'test', text: 'Authentication tests pass' }],
  };
  const task = (await handleTaskTool('ghcpMem_start_task', start, { env })) as AgentTask;
  const nextEnv = { ...env, GHCP_MEM_TASK_ACTOR: 'claude' };
  const resumed = (await handleTaskTool(
    'ghcpMem_resume',
    { taskId: task.id },
    { env: nextEnv },
  )) as { goal: string };
  assert.equal(resumed.goal, start.goal);
  await assert.rejects(
    handleTaskTool(
      'ghcpMem_update_task',
      { taskId: task.id, expectedRevision: 1, requestId: 'spoof', changes: {}, canVerify: true },
      { env: nextEnv },
    ),
    /Unknown task argument/,
  );
  const updated = (await handleTaskTool(
    'ghcpMem_update_task',
    {
      taskId: task.id,
      expectedRevision: 1,
      requestId: 'done',
      changes: { steps: [{ id: 'build', title: 'Build middleware', status: 'done' }] },
    },
    { env: nextEnv },
  )) as AgentTask;
  const complete = {
    taskId: task.id,
    expectedRevision: updated.revision,
    requestId: 'verified',
    evidence: [{ criterionId: 'test', reference: 'ci/42', outcome: 'passed' }],
  };
  await assert.rejects(
    handleTaskTool('ghcpMem_complete_task', complete, { env: nextEnv }),
    /verifier/,
  );
  const completed = (await handleTaskTool('ghcpMem_complete_task', complete, {
    env: { ...env, GHCP_MEM_TASK_ACTOR: 'ci', GHCP_MEM_TASK_ALLOW_VERIFY: 'true' },
  })) as AgentTask;
  assert.equal(completed.status, 'completed');
  const packet = await handleTaskTool(
    'ghcpMem_compile_context',
    { taskId: task.id, maxTokens: 1800 },
    { env: nextEnv },
  );
  assert.ok(Math.ceil(Buffer.byteLength(JSON.stringify(packet, null, 2), 'utf8') / 4) <= 1800);
  await assert.rejects(
    handleTaskTool(
      'ghcpMem_task_status',
      { taskId: task.id },
      { env: { ...nextEnv, GHCP_MEM_REPO_SCOPE: 'other' } },
    ),
    /unavailable/,
  );
  const memoryPath = join(directory, 'sessions.json');
  const memory = {
    id: 'auth-memory',
    workspaceId: 'repo',
    workspaceName: 'repo',
    repoScope: 'repo',
    branchName: completed.scope.branch,
    startTime: Date.now(),
    endTime: Date.now(),
    summary: 'Authentication relevant policy',
    observationType: 'feature',
    keyFiles: [],
    keyTopics: ['authentication'],
    decisions: [],
    problemsSolved: [],
    userTags: [],
    redactionCount: 0,
    rawEventCount: 1,
  };
  await fs.writeFile(
    memoryPath,
    JSON.stringify({
      version: 2,
      sessions: [
        memory,
        {
          ...memory,
          id: 'other-repo',
          repoScope: 'other',
          summary: 'Authentication forbidden-repository',
        },
        {
          ...memory,
          id: 'other-branch',
          branchName: 'different-branch',
          summary: 'Authentication forbidden-branch',
        },
      ],
      lastUpdated: Date.now(),
    }),
  );
  const calls = [
    { name: 'ghcpMem_resume', arguments: { taskId: task.id } },
    { name: 'ghcpMem_compile_context', arguments: { taskId: task.id, maxTokens: 1800 } },
  ];
  const child = spawnSync(process.execPath, [join(__dirname, '..', 'mcpServer.js')], {
    input:
      calls
        .map((params, index) =>
          JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params }),
        )
        .join('\n') + '\n',
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      ...nextEnv,
      GHCP_MEM_TASK_KEY: undefined,
      GHCP_MEM_STORE_PATH: memoryPath,
      GHCP_MEM_READONLY: 'true',
    },
  });
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(JSON.parse(replies[0].result.content[0].text).status, 'completed');
  const compiled = JSON.parse(replies[1].result.content[0].text);
  assert.equal(compiled.receipt.sourceRevision, completed.revision);
  assert.match(replies[1].result.content[0].text, /Authentication relevant policy/);
  assert.doesNotMatch(child.stdout, /forbidden-repository|forbidden-branch/);
  assert.ok(Math.ceil(Buffer.byteLength(replies[1].result.content[0].text, 'utf8') / 4) <= 1800);
});

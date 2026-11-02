import { homedir } from 'node:os';
import { join } from 'node:path';
import { TaskJournal } from './taskJournal';
import { observeExecutionScope, resumeTask, compileTaskContext } from './taskContext';
import { taskObject, type AgentTask, type TaskPrincipal, type ExecutionScope } from './taskRuntime';
import type { CompressedSession } from './types';

interface Field {
  type: 'string' | 'integer' | 'object' | 'array';
  description: string;
  items?: { type: 'object' | 'string' };
}

export interface TaskTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Field>;
    required: string[];
    additionalProperties: false;
  };
}

const taskId: Field = { type: 'string', description: 'Full task id returned by start_task.' };
const expectedRevision: Field = {
  type: 'integer',
  description: 'Last observed task revision. Stale writes are rejected.',
};
const requestId: Field = {
  type: 'string',
  description: 'Unique idempotency key, reused only when retrying the identical request.',
};
const changes: Field = {
  type: 'object',
  description:
    'Task changes: steps [{id,title,status,blocker?}], blockers, decisions, modifiedFiles, or explicit rebind:true. Rebinding invalidates earlier completion claims.',
};
const mutation = { taskId, expectedRevision, requestId };

function descriptor(
  name: string,
  description: string,
  properties: Record<string, Field>,
  required = Object.keys(properties),
): TaskTool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  };
}

export const TASK_TOOLS: TaskTool[] = [
  descriptor(
    'ghcpMem_start_task',
    'Start a durable, repository/worktree-bound task. Private by default. Identity, scope, write and verifier policy come from the trusted launcher, never tool arguments.',
    {
      requestId,
      goal: { type: 'string', description: 'Task intent; redacted before persistence.' },
      acceptanceCriteria: {
        type: 'array',
        items: { type: 'object' },
        description: 'Nonempty list of {id,text} acceptance criteria.',
      },
      steps: {
        type: 'array',
        items: { type: 'object' },
        description: 'Optional plan entries {id,title,status?,blocker?}.',
      },
      visibility: {
        type: 'string',
        description: 'private (owner only, default) or shared (same repository principals).',
      },
    },
    ['requestId', 'goal', 'acceptanceCriteria'],
  ),
  descriptor(
    'ghcpMem_task_status',
    'Read durable task state after principal/repository authorization. Reported progress is not independent verification.',
    { taskId },
  ),
  descriptor(
    'ghcpMem_update_task',
    'Apply a revision-checked task update. Scope drift requires explicit rebind:true and fresh acceptance evidence.',
    { ...mutation, changes },
  ),
  descriptor(
    'ghcpMem_checkpoint',
    'Durably checkpoint task progress. Does not grant permissions or mark a task complete. Scope must match the observed Git worktree.',
    {
      ...mutation,
      summary: { type: 'string', description: 'Current progress summary.' },
      nextActions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of next-action strings, maximum ten.',
      },
      expiresAt: {
        type: 'integer',
        description: 'Optional expiry in epoch milliseconds, within seven days.',
      },
    },
    ['taskId', 'expectedRevision', 'requestId', 'summary', 'nextActions'],
  ),
  descriptor(
    'ghcpMem_resume',
    'Resume a task using observed branch, commit, worktree and dirty-tree state. Returns revalidation_required on drift; never executes actions.',
    { taskId },
  ),
  descriptor(
    'ghcpMem_compile_context',
    'Compile a policy-filtered task context packet with goal, blockers, acceptance criteria, selected evidence and historical memory. Returns a provenance receipt under an estimated token budget.',
    {
      taskId,
      maxTokens: {
        type: 'integer',
        description:
          'Estimated token budget, 128–32000; default 1800. Mandatory intent/policy must fit.',
      },
    },
    ['taskId'],
  ),
  descriptor(
    'ghcpMem_complete_task',
    'Complete only when all steps and acceptance criteria pass. Requires launcher-authorized verification capability; evidence remains attributed to that verifier, not independently attested.',
    {
      ...mutation,
      evidence: {
        type: 'array',
        items: { type: 'object' },
        description: 'One {criterionId,reference,outcome:"passed"} per acceptance criterion.',
      },
    },
  ),
  descriptor(
    'ghcpMem_cancel_task',
    'Cancel a task without granting execution authority or undoing external effects.',
    mutation,
  ),
  descriptor(
    'ghcpMem_purge_task',
    'Owner-only deletion of task history, including every journal revision and incomplete temporary event. Leaves a content-free tombstone to prevent replay resurrection. Does not erase external backups.',
    mutation,
  ),
];

export function isTaskTool(name: string): boolean {
  return TASK_TOOLS.some((tool) => tool.name === name);
}

function argumentsFor(name: string, value: unknown): Record<string, unknown> {
  const tool = TASK_TOOLS.find((entry) => entry.name === name);
  if (!tool) throw new Error('Unknown task tool');
  const input = taskObject(value);
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 65536)
    throw new Error('Task request exceeds 64 KiB');
  for (const required of tool.inputSchema.required)
    if (input[required] === undefined) throw new Error(`Missing task argument: ${required}`);
  for (const [key, item] of Object.entries(input)) {
    const field = tool.inputSchema.properties[key];
    if (!field) throw new Error(`Unknown task argument: ${key}`);
    if (field.type === 'array') {
      if (!Array.isArray(item)) throw new Error(`Invalid task array: ${key}`);
    } else if (field.type === 'integer') {
      if (typeof item !== 'number' || !Number.isSafeInteger(item))
        throw new Error(`Invalid task integer: ${key}`);
    } else if (field.type === 'object') taskObject(item);
    else if (typeof item !== 'string') throw new Error(`Invalid task string: ${key}`);
  }
  return input;
}

export async function handleTaskTool(
  name: string,
  value: unknown,
  options: {
    env?: NodeJS.ProcessEnv;
    memories?: (
      task: AgentTask,
      principal: TaskPrincipal,
      scope: ExecutionScope,
    ) => Promise<CompressedSession[]>;
  } = {},
): Promise<unknown> {
  const args = argumentsFor(name, value);
  const env = options.env ?? process.env;
  const actor = env.GHCP_MEM_TASK_ACTOR;
  const repoScope = env.GHCP_MEM_REPO_SCOPE;
  if (!actor || !repoScope)
    throw new Error(
      'Task tools require launcher-bound GHCP_MEM_TASK_ACTOR and GHCP_MEM_REPO_SCOPE',
    );
  const principal: TaskPrincipal = {
    id: actor,
    repoScope,
    canWrite: env.GHCP_MEM_ALLOW_MCP_WRITE === 'true' && env.GHCP_MEM_READONLY !== 'true',
    canVerify: env.GHCP_MEM_TASK_ALLOW_VERIFY === 'true',
  };
  const hex = env.GHCP_MEM_TASK_KEY;
  if (hex !== undefined && !/^[a-f0-9]{64}$/i.test(hex))
    throw new Error('Invalid task encryption key');
  const journal = new TaskJournal(
    env.GHCP_MEM_TASK_PATH ?? join(homedir(), '.ghcp-mem', 'tasks'),
    principal,
    {
      key: hex ? Buffer.from(hex, 'hex') : undefined,
      allowPlaintext: env.GHCP_MEM_TASK_ALLOW_PLAINTEXT === 'true',
    },
  );
  if (name === 'ghcpMem_task_status') return journal.read(args.taskId as string);
  if (name === 'ghcpMem_purge_task')
    return journal.purge(
      args.taskId as string,
      args.expectedRevision as number,
      args.requestId as string,
    );
  const worktree = env.GHCP_MEM_TASK_WORKTREE;
  if (!worktree) throw new Error('Task execution requires a launcher-bound GHCP_MEM_TASK_WORKTREE');
  const scope = await observeExecutionScope(worktree, repoScope);
  if (name === 'ghcpMem_start_task') return journal.start(args, scope, args.requestId as string);
  const id = args.taskId as string;
  if (name === 'ghcpMem_resume' || name === 'ghcpMem_compile_context') {
    const task = await journal.read(id);
    if (name === 'ghcpMem_resume') return resumeTask(task, principal, scope);
    const memories = (await options.memories?.(task, principal, scope)) ?? [];
    return compileTaskContext(
      task,
      principal,
      scope,
      args.maxTokens as number | undefined,
      memories,
    ).packet;
  }
  const action =
    name === 'ghcpMem_update_task'
      ? 'update'
      : name === 'ghcpMem_checkpoint'
        ? 'checkpoint'
        : name === 'ghcpMem_complete_task'
          ? 'complete'
          : 'cancel';
  return journal.mutate(
    id,
    args.expectedRevision as number,
    args.requestId as string,
    action,
    name === 'ghcpMem_update_task' ? args.changes : args,
    scope,
  );
}

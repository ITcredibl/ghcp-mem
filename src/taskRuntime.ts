import { createHash } from 'node:crypto';
import { redact } from './redactor';

export interface TaskPrincipal {
  id: string;
  repoScope: string;
  canWrite: boolean;
  canVerify: boolean;
}

export interface ExecutionScope {
  repoScope: string;
  worktreeId: string;
  branch: string;
  headCommit: string;
  dirtyTreeDigest: string;
}

export interface TaskStep {
  id: string;
  title: string;
  status: 'pending' | 'done' | 'blocked';
  blocker?: string;
}

export interface TaskVerification {
  criterionId: string;
  reference: string;
  outcome: 'passed' | 'failed';
}

export interface AgentTask {
  version: 1;
  authority: 'none';
  id: string;
  revision: number;
  owner: string;
  visibility: 'private' | 'shared';
  goal: string;
  status: 'running' | 'blocked' | 'verification_required' | 'completed' | 'cancelled';
  scope: ExecutionScope;
  baseCommit: string;
  steps: TaskStep[];
  acceptanceCriteria: { id: string; text: string }[];
  blockers: string[];
  decisions: string[];
  modifiedFiles: string[];
  checkpoint?: { summary: string; nextActions: string[]; expiresAt: number; scope: ExecutionScope };
  verification?: {
    actor: string;
    provenance: 'launcher-authorized';
    evidence: TaskVerification[];
    scope: ExecutionScope;
  };
  createdAt: number;
  updatedAt: number;
}

export function taskObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

export function taskText(value: unknown, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('Invalid task text');
  const clean = redact(value.trim(), { redactSecrets: true, honorPrivateTags: true }).text;
  if (!clean.trim()) throw new Error('Task text is empty after redaction');
  return clean;
}

function texts(value: unknown, maxItems = 30): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error('Invalid task text list');
  return value.map((entry) => taskText(entry));
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,120}$/.test(value))
    throw new Error('Invalid task identifier');
  if (redact(value, { redactSecrets: true, honorPrivateTags: true }).text !== value)
    throw new Error('Identifiers must not contain secrets');
  return value;
}

function plan(value: unknown): TaskStep[] {
  if (!Array.isArray(value) || value.length > 50)
    throw new Error('A plan must contain at most 50 steps');
  const steps = value.map((entry): TaskStep => {
    const item = taskObject(entry);
    const status = item.status ?? 'pending';
    if (status !== 'pending' && status !== 'done' && status !== 'blocked')
      throw new Error('Invalid step status');
    const blocker = item.blocker === undefined ? undefined : taskText(item.blocker);
    if (status === 'blocked' && !blocker) throw new Error('Blocked steps require a reason');
    return {
      id: identifier(item.id),
      title: taskText(item.title),
      status,
      ...(blocker ? { blocker } : {}),
    };
  });
  if (new Set(steps.map((step) => step.id)).size !== steps.length)
    throw new Error('Duplicate step id');
  return steps;
}

export function validateExecutionScope(value: unknown): ExecutionScope {
  const input = taskObject(value);
  if (
    typeof input.headCommit !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.headCommit)
  )
    throw new Error('A full commit hash is required');
  if (typeof input.dirtyTreeDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(input.dirtyTreeDigest))
    throw new Error('A dirty-tree digest is required');
  return {
    repoScope: taskText(input.repoScope, 300),
    worktreeId: identifier(input.worktreeId),
    branch: taskText(input.branch, 300),
    headCommit: input.headCommit.toLowerCase(),
    dirtyTreeDigest: input.dirtyTreeDigest.toLowerCase(),
  };
}

export function scopeMatches(left: ExecutionScope, right: ExecutionScope): boolean {
  return (
    left.repoScope === right.repoScope &&
    left.worktreeId === right.worktreeId &&
    left.branch === right.branch &&
    left.headCommit === right.headCommit &&
    left.dirtyTreeDigest === right.dirtyTreeDigest
  );
}

export function assertTaskAccess(task: AgentTask, principal: TaskPrincipal, write = false): void {
  if (
    principal.repoScope !== task.scope.repoScope ||
    (task.visibility === 'private' && principal.id !== task.owner)
  )
    throw new Error('Task unavailable in this principal scope');
  if (write && !principal.canWrite) throw new Error('Task writes are disabled by launcher policy');
}

export function startTask(
  value: unknown,
  principal: TaskPrincipal,
  scopeValue: ExecutionScope,
  id: string,
  now: number,
): AgentTask {
  const input = taskObject(value);
  const scope = validateExecutionScope(scopeValue);
  if (!principal.canWrite || !principal.id || principal.repoScope !== scope.repoScope)
    throw new Error('Task start is not authorized');
  if (
    !Array.isArray(input.acceptanceCriteria) ||
    !input.acceptanceCriteria.length ||
    input.acceptanceCriteria.length > 30
  )
    throw new Error('Acceptance criteria are required');
  const acceptanceCriteria = input.acceptanceCriteria.map((entry) => {
    const item = taskObject(entry);
    return { id: identifier(item.id), text: taskText(item.text) };
  });
  if (new Set(acceptanceCriteria.map((item) => item.id)).size !== acceptanceCriteria.length)
    throw new Error('Duplicate acceptance criterion');
  const visibility = input.visibility ?? 'private';
  if (visibility !== 'private' && visibility !== 'shared')
    throw new Error('Invalid task visibility');
  return {
    version: 1,
    authority: 'none',
    id,
    revision: 1,
    owner: principal.id,
    visibility,
    goal: taskText(input.goal),
    status: 'running',
    scope,
    baseCommit: scope.headCommit,
    steps: plan(input.steps ?? []),
    acceptanceCriteria,
    blockers: [],
    decisions: [],
    modifiedFiles: [],
    createdAt: now,
    updatedAt: now,
  };
}

export type TaskAction = 'update' | 'checkpoint' | 'complete' | 'cancel';

export function transitionTask(
  previous: AgentTask,
  action: TaskAction,
  value: unknown,
  principal: TaskPrincipal,
  scopeValue: ExecutionScope,
  now: number,
): AgentTask {
  assertTaskAccess(previous, principal, true);
  if (previous.status === 'completed' || previous.status === 'cancelled')
    throw new Error('Task is terminal; start a new task');
  const input = taskObject(value);
  const scope = validateExecutionScope(scopeValue);
  if (scope.repoScope !== previous.scope.repoScope)
    throw new Error('Cannot move a task to another repository');
  const drifted = !scopeMatches(previous.scope, scope);
  if (drifted && !(action === 'update' && input.rebind === true))
    throw new Error('Execution scope changed; explicitly rebind and revalidate');
  const task = structuredClone(previous);
  task.revision++;
  task.updatedAt = now;
  if (drifted) {
    task.scope = scope;
    task.status = 'verification_required';
    delete task.verification;
    delete task.checkpoint;
    task.steps = task.steps.map((step) => ({ id: step.id, title: step.title, status: 'pending' }));
  }
  if (action === 'update') {
    if (input.steps !== undefined) task.steps = plan(input.steps);
    if (input.blockers !== undefined) task.blockers = texts(input.blockers);
    if (input.decisions !== undefined) task.decisions = texts(input.decisions);
    if (input.modifiedFiles !== undefined) {
      task.modifiedFiles = texts(input.modifiedFiles);
      if (
        task.modifiedFiles.some((file) =>
          /(^[\\/]|^[a-zA-Z]:|(^|[\\/])\.\.([\\/]|$)|\0)/.test(file),
        )
      )
        throw new Error('Modified paths must be workspace-relative');
    }
    task.status =
      task.blockers.length || task.steps.some((step) => step.status === 'blocked')
        ? 'blocked'
        : drifted || task.status === 'verification_required'
          ? 'verification_required'
          : 'running';
  } else if (action === 'checkpoint') {
    const expiresAt = input.expiresAt ?? now + 86_400_000;
    if (
      typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + 7 * 86_400_000
    )
      throw new Error('Invalid checkpoint expiry');
    task.checkpoint = {
      summary: taskText(input.summary),
      nextActions: texts(input.nextActions, 10),
      expiresAt,
      scope,
    };
  } else if (action === 'complete') {
    if (!principal.canVerify) throw new Error('Completion requires a launcher-authorized verifier');
    if (task.blockers.length || task.steps.some((step) => step.status !== 'done'))
      throw new Error('Unfinished or blocked work cannot be completed');
    if (!Array.isArray(input.evidence) || input.evidence.length > 30)
      throw new Error('Completion evidence is required');
    const evidence = input.evidence.map((entry): TaskVerification => {
      const item = taskObject(entry);
      if (item.outcome !== 'passed' && item.outcome !== 'failed')
        throw new Error('Invalid verification outcome');
      return {
        criterionId: identifier(item.criterionId),
        reference: taskText(item.reference, 500),
        outcome: item.outcome,
      };
    });
    if (
      new Set(evidence.map((item) => item.criterionId)).size !== evidence.length ||
      evidence.some(
        (item) =>
          item.outcome !== 'passed' ||
          !task.acceptanceCriteria.some((criterion) => criterion.id === item.criterionId),
      ) ||
      task.acceptanceCriteria.some(
        (criterion) =>
          !evidence.some((item) => item.criterionId === criterion.id && item.outcome === 'passed'),
      )
    )
      throw new Error('Every acceptance criterion needs distinct passing evidence');
    task.verification = { actor: principal.id, provenance: 'launcher-authorized', evidence, scope };
    task.status = 'completed';
  } else if (action === 'cancel') {
    task.status = 'cancelled';
  } else {
    throw new Error('Unsupported task transition');
  }
  return task;
}

export function taskDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

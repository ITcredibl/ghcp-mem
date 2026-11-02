import { createHash } from 'node:crypto';
import { redact } from './redactor';

export interface AgentCheckpoint {
  version: 1;
  authority: 'none';
  harness: 'copilot' | 'claude' | 'codex' | 'ci';
  taskId: string;
  repoScope: string;
  commit: string;
  stage: 'planned' | 'attempted' | 'deployed' | 'verified' | 'failed';
  summary: string;
  nextActions: string[];
  evidence: {
    kind: 'test' | 'artifact' | 'approval' | 'rollback';
    reference: string;
    outcome: 'passed' | 'failed' | 'unknown';
  }[];
  createdAt: number;
  expiresAt: number;
  digest: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new Error('Invalid checkpoint text');
  return redact(value.trim(), { redactSecrets: true, honorPrivateTags: true }).text;
}

function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T))
    throw new Error('Invalid checkpoint enum');
  return value as T;
}

export function createCheckpoint(value: unknown, now = Date.now()): AgentCheckpoint {
  const input = object(value);
  const commit = text(input.commit, 64);
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error('Checkpoint requires a full commit hash');
  const expiresAt = input.expiresAt ?? now + 86_400_000;
  if (
    !Number.isSafeInteger(now) ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + 7 * 86_400_000
  )
    throw new Error('Checkpoint expiry must be within seven days');
  if (!Array.isArray(input.evidence) || input.evidence.length > 20)
    throw new Error('Checkpoint evidence must be a bounded array');
  if (!Array.isArray(input.nextActions) || input.nextActions.length > 10)
    throw new Error('Checkpoint nextActions must be a bounded array');
  const evidence: AgentCheckpoint['evidence'] = input.evidence.map((entry) => {
    const item = object(entry);
    return {
      kind: choice(item.kind, ['test', 'artifact', 'approval', 'rollback']),
      reference: text(item.reference, 500),
      outcome: choice(item.outcome, ['passed', 'failed', 'unknown']),
    };
  });
  const stage = choice(input.stage, ['planned', 'attempted', 'deployed', 'verified', 'failed']);
  if (
    stage === 'verified' &&
    (!evidence.some((item) => item.kind === 'test' && item.outcome === 'passed') ||
      !evidence.some(
        (item) => item.kind === 'artifact' && /^sha256:[a-f0-9]{64}$/i.test(item.reference),
      ) ||
      evidence.some((item) => item.outcome === 'failed'))
  ) {
    throw new Error(
      'Verified checkpoints require a passing test, an artifact digest, and no failed evidence',
    );
  }
  const body: Omit<AgentCheckpoint, 'digest'> = {
    version: 1,
    authority: 'none',
    harness: choice(input.harness, ['copilot', 'claude', 'codex', 'ci']),
    taskId: text(input.taskId, 120),
    repoScope: text(input.repoScope, 300),
    commit: commit.toLowerCase(),
    stage,
    summary: text(input.summary, 2000),
    nextActions: input.nextActions.map((action) => text(action, 500)),
    evidence,
    createdAt: now,
    expiresAt,
  };
  return { ...body, digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

export function verifyCheckpoint(
  value: unknown,
  scope: { repoScope: string; commit: string; now?: number },
): { valid: boolean; reason?: string } {
  try {
    const input = object(value);
    if (input.version !== 1 || input.authority !== 'none')
      return { valid: false, reason: 'Unsupported checkpoint or authority' };
    const canonical = createCheckpoint(input, input.createdAt as number);
    if (canonical.digest !== input.digest)
      return { valid: false, reason: 'Checkpoint digest mismatch' };
    if (canonical.repoScope !== scope.repoScope || canonical.commit !== scope.commit.toLowerCase())
      return { valid: false, reason: 'Repository or commit differs; revalidate evidence' };
    const now = scope.now ?? Date.now();
    if (!Number.isSafeInteger(now) || canonical.createdAt > now || canonical.expiresAt <= now)
      return { valid: false, reason: 'Checkpoint is expired or future-dated' };
    return { valid: true };
  } catch {
    return { valid: false, reason: 'Malformed checkpoint' };
  }
}

/**
 * Organization memory policy (v1.20.0) — governed, hierarchical control over
 * who may write and read each memory scope level.
 *
 * The policy is a committed workspace file (`.github/memory/policy.json`), so
 * it is reviewed like code and travels with the repository — no SaaS backend.
 * Absent or invalid policy falls back to the permissive default (everything
 * allowed), preserving pre-1.20 behavior; enforcement is strictly opt-in by
 * committing the file.
 *
 * Pure module — no vscode imports; callers read the file and pass the text.
 */
import { AUTHOR_KINDS, AuthorKind, parseAuthor, SCOPE_LEVELS } from './memoryScope';
import { CompressedSession, MemoryScopeLevel } from './types';

export const POLICY_FILE = '.github/memory/policy.json';
const MAX_POLICY_BYTES = 64 * 1024;

export interface ScopeRule {
  /** Author kinds allowed to write memories at this scope ('all' = anyone). */
  write: AuthorKind[] | 'all';
  /** Author kinds allowed to read memories at this scope ('all' = anyone). */
  read: AuthorKind[] | 'all';
}

export interface OrgMemoryPolicy {
  version: 1;
  scopes: Partial<Record<MemoryScopeLevel, ScopeRule>>;
}

export function defaultPolicy(): OrgMemoryPolicy {
  return { version: 1, scopes: {} };
}

function parseKindList(value: unknown, field: string): AuthorKind[] | 'all' {
  if (value === 'all') return 'all';
  if (!Array.isArray(value) || value.length > AUTHOR_KINDS.length)
    throw new Error(`${field} must be 'all' or an array of author kinds`);
  return value.map((entry) => {
    if (!(AUTHOR_KINDS as readonly string[]).includes(entry as string))
      throw new Error(`${field} contains unknown author kind: ${String(entry)}`);
    return entry as AuthorKind;
  });
}

/** Parse and validate a policy file's text. Throws with a precise reason. */
export function parsePolicy(raw: string): OrgMemoryPolicy {
  if (Buffer.byteLength(raw, 'utf8') > MAX_POLICY_BYTES)
    throw new Error('Policy file exceeds 64 KiB');
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Policy must be a JSON object');
  const input = parsed as Record<string, unknown>;
  if (input.version !== 1) throw new Error('Unsupported policy version — expected 1');
  const scopes: OrgMemoryPolicy['scopes'] = {};
  const rawScopes = input.scopes ?? {};
  if (!rawScopes || typeof rawScopes !== 'object' || Array.isArray(rawScopes))
    throw new Error('policy.scopes must be an object');
  for (const [level, rule] of Object.entries(rawScopes)) {
    if (!(SCOPE_LEVELS as readonly string[]).includes(level))
      throw new Error(`Unknown scope level in policy: ${level}`);
    if (!rule || typeof rule !== 'object' || Array.isArray(rule))
      throw new Error(`policy.scopes.${level} must be an object`);
    const entry = rule as Record<string, unknown>;
    scopes[level as MemoryScopeLevel] = {
      write: parseKindList(entry.write ?? 'all', `policy.scopes.${level}.write`),
      read: parseKindList(entry.read ?? 'all', `policy.scopes.${level}.read`),
    };
  }
  return { version: 1, scopes };
}

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

function evaluate(
  policy: OrgMemoryPolicy,
  action: 'read' | 'write',
  scopeLevel: MemoryScopeLevel | undefined,
  author: string | undefined,
): PolicyDecision {
  const level = scopeLevel ?? 'repository';
  const rule = policy.scopes[level];
  if (!rule) return { allowed: true, reason: `no ${level} rule — default allow` };
  const allowedKinds = rule[action];
  if (allowedKinds === 'all') return { allowed: true, reason: `${level}.${action} allows all` };
  if (!author)
    return {
      allowed: false,
      reason: `${level}.${action} requires an attributed author (${allowedKinds.join(', ')})`,
    };
  const kind = parseAuthor(author).kind;
  return allowedKinds.includes(kind)
    ? { allowed: true, reason: `${level}.${action} allows ${kind}` }
    : { allowed: false, reason: `${level}.${action} denies ${kind}` };
}

export function evaluateWrite(
  policy: OrgMemoryPolicy,
  stamp: { scopeLevel?: MemoryScopeLevel; author?: string },
): PolicyDecision {
  return evaluate(policy, 'write', stamp.scopeLevel, stamp.author);
}

export function evaluateRead(
  policy: OrgMemoryPolicy,
  session: Pick<CompressedSession, 'scopeLevel' | 'author'>,
  accessorAuthor: string | undefined,
): PolicyDecision {
  return evaluate(policy, 'read', session.scopeLevel, accessorAuthor);
}

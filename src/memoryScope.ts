/**
 * Memory scope + author identity (v1.20.0).
 *
 * Multiple agents now share one store over MCP. Scope levels say how far a
 * memory travels (organization → … → agent); the author field says WHO
 * learned it, in attributed `kind:name` form. The one hard access rule:
 * an `agent`-scoped memory is private to the author that wrote it — other
 * agents never see another agent's scratch memory, while humans reviewing
 * the store locally still can (it is their machine and their audit trail).
 *
 * Pure module — no vscode imports.
 */
import { redact } from './redactor';
import { CompressedSession, MemoryScopeLevel } from './types';

export const SCOPE_LEVELS: readonly MemoryScopeLevel[] = [
  'organization',
  'team',
  'repository',
  'branch',
  'user',
  'task',
  'agent',
];

export const AUTHOR_KINDS = [
  'human',
  'copilot',
  'claude',
  'cursor',
  'cline',
  'windsurf',
  'agent',
  'system',
] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

export interface MemoryAuthor {
  kind: AuthorKind;
  name: string;
}

const AUTHOR_RE = new RegExp(`^(${AUTHOR_KINDS.join('|')}):([a-zA-Z0-9._-]{1,64})$`);

export function isScopeLevel(value: unknown): value is MemoryScopeLevel {
  return typeof value === 'string' && (SCOPE_LEVELS as readonly string[]).includes(value);
}

/** Parse and validate an attributed author string; throws with the expected shape. */
export function parseAuthor(raw: unknown): MemoryAuthor {
  if (typeof raw !== 'string')
    throw new Error(`Author must be "<kind>:<name>" with kind one of ${AUTHOR_KINDS.join(', ')}`);
  const match = AUTHOR_RE.exec(raw);
  if (!match)
    throw new Error(`Invalid author "${raw}" — expected "<kind>:<name>" (e.g. claude:reviewer)`);
  if (redact(raw, { redactSecrets: true, honorPrivateTags: true }).text !== raw)
    throw new Error('Author identity must not contain secrets');
  return { kind: match[1] as AuthorKind, name: match[2] };
}

export function formatAuthor(author: MemoryAuthor): string {
  return `${author.kind}:${author.name}`;
}

/**
 * Best-effort author from a free-form human name (e.g. git user.name).
 * Returns undefined rather than inventing an identity it cannot sanitize.
 */
export function authorFromHumanName(name: string | undefined): string | undefined {
  const slug = name
    ?.trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 64);
  if (!slug) return undefined;
  try {
    return formatAuthor(parseAuthor(`human:${slug}`));
  } catch {
    return undefined;
  }
}

export interface ScopeAccessor {
  /** The caller's attributed identity, when known. */
  author?: string;
  /** True for a local human review surface (sidebar, @mem, reports). */
  humanReview?: boolean;
}

/**
 * Whether `accessor` may read this memory under its scope rules.
 * Only `agent` scope restricts today: private to its author, except for the
 * local human review surfaces. Every other level is readable locally —
 * cross-boundary distribution is governed by ./orgPolicy and team-sync
 * export filters, not by this predicate.
 */
export function canReadScoped(session: CompressedSession, accessor: ScopeAccessor): boolean {
  if (session.scopeLevel !== 'agent') return true;
  if (accessor.humanReview) return true;
  return !!session.author && !!accessor.author && session.author === accessor.author;
}

/** Filter helper used by the MCP server and retrieval surfaces. */
export function filterByScope(
  sessions: readonly CompressedSession[],
  accessor: ScopeAccessor,
): CompressedSession[] {
  return sessions.filter((session) => canReadScoped(session, accessor));
}

/**
 * Validate the optional scope/author stamp on an incoming memory write.
 * Returns normalized values; throws on malformed input so write surfaces
 * reject instead of storing something retrieval cannot reason about.
 */
export function normalizeScopeStamp(input: { scopeLevel?: unknown; author?: unknown }): {
  scopeLevel?: MemoryScopeLevel;
  author?: string;
} {
  const out: { scopeLevel?: MemoryScopeLevel; author?: string } = {};
  if (input.scopeLevel !== undefined) {
    if (!isScopeLevel(input.scopeLevel))
      throw new Error(`Invalid scope level — expected one of ${SCOPE_LEVELS.join(', ')}`);
    out.scopeLevel = input.scopeLevel;
  }
  if (input.author !== undefined) out.author = formatAuthor(parseAuthor(input.author));
  if (out.scopeLevel === 'agent' && !out.author)
    throw new Error('agent-scoped memories require an author (kind:name)');
  return out;
}

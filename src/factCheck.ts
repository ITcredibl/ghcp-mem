/**
 * Autonomous memory verification (v1.20.0) — periodically ask "is this memory
 * still true?" against the workspace itself, beyond the existing keyFiles
 * validator.
 *
 * Scope is deliberately narrow and honest: we verify only claims the module
 * can actually observe — workspace-relative paths referenced in a session's
 * summary/decisions still existing. A missing reference never deletes or
 * rewrites a memory; it stamps an advisory `factCheck` result that reporting
 * and context compilation surfaces display, and the janitor refreshes weekly.
 *
 * Pure module — filesystem access is injected so unit tests use fakes.
 */
import { CompressedSession } from './types';

export interface FactCheckResult {
  checkedAt: number;
  /** Referenced paths that no longer exist in the workspace. */
  staleRefs: string[];
  /** Count of referenced paths that still resolve. */
  freshRefs: number;
}

/** Narrow interface over the host filesystem — true when the path exists. */
export type PathExists = (workspaceRelativePath: string) => PromiseLike<boolean> | boolean;

const PATH_RE = /(?:^|[\s"'`(])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8})(?=$|[\s"'`),.;:])/g;
const MAX_REFS_PER_SESSION = 12;

/** Extract workspace-relative path claims from a session's text surfaces. */
export function extractPathClaims(session: CompressedSession): string[] {
  const text = [session.summary, ...session.decisions, ...session.problemsSolved].join('\n');
  const refs = new Set<string>();
  for (const match of text.matchAll(PATH_RE)) {
    const path = match[1];
    if (path.includes('..') || path.startsWith('/')) continue;
    refs.add(path);
    if (refs.size >= MAX_REFS_PER_SESSION) break;
  }
  // keyFiles are already covered by the validator — avoid double-reporting.
  for (const file of session.keyFiles) refs.delete(file);
  return [...refs];
}

/** Verify one session's path claims. Returns undefined when it makes no checkable claims. */
export async function factCheckSession(
  session: CompressedSession,
  exists: PathExists,
  now = Date.now(),
): Promise<FactCheckResult | undefined> {
  const claims = extractPathClaims(session);
  if (!claims.length) return undefined;
  const staleRefs: string[] = [];
  let freshRefs = 0;
  for (const claim of claims) {
    if (await exists(claim)) freshRefs++;
    else staleRefs.push(claim);
  }
  return { checkedAt: now, staleRefs, freshRefs };
}

export interface FactCheckSweep {
  checked: number;
  stale: number;
  results: Map<string, FactCheckResult>;
}

/**
 * Sweep a set of sessions (newest first is the caller's choice). Bounded so a
 * weekly janitor pass stays cheap even on large stores.
 */
export async function factCheckSweep(
  sessions: readonly CompressedSession[],
  exists: PathExists,
  options: { maxSessions?: number; now?: number } = {},
): Promise<FactCheckSweep> {
  const limit = Math.max(1, Math.min(500, options.maxSessions ?? 100));
  const results = new Map<string, FactCheckResult>();
  let stale = 0;
  for (const session of sessions.slice(0, limit)) {
    if (session.retracted) continue;
    const result = await factCheckSession(session, exists, options.now);
    if (!result) continue;
    results.set(session.id, result);
    if (result.staleRefs.length > 0) stale++;
  }
  return { checked: results.size, stale, results };
}

export function formatFactCheckReport(sweep: FactCheckSweep): string {
  const lines = [
    '# Memory fact-check',
    '',
    `Checked ${sweep.checked} session(s) with verifiable path claims; ${sweep.stale} reference paths that no longer exist.`,
    '',
  ];
  for (const [id, result] of sweep.results) {
    if (!result.staleRefs.length) continue;
    lines.push(`- \`${id.slice(0, 8)}\`: stale refs ${result.staleRefs.join(', ')}`);
  }
  if (sweep.stale === 0) lines.push('_All checkable references still resolve._');
  return lines.join('\n');
}

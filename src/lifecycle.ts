/**
 * Memory lifecycle (v1.20.0) — branch/worktree-aware validity for memories.
 *
 * Parallel agents work on parallel branches. A decision captured on
 * `feature/auth-v2` is real on that branch but speculative everywhere else
 * until the work merges. Lifecycle states encode that: states below `merged`
 * confine a memory to the branch it was captured on; `merged`/`deployed`
 * promote it repo-wide; `deprecated`/`reverted` keep it for audit but
 * down-rank it everywhere.
 *
 * Pure module — no vscode imports. Legacy sessions (no `lifecycle`) keep
 * pre-1.20 behavior: valid on every branch, weight 1.
 */
import { CompressedSession, MemoryLifecycle } from './types';

export const LIFECYCLE_STATES: readonly MemoryLifecycle[] = [
  'proposed',
  'experimental',
  'implemented',
  'verified',
  'merged',
  'deployed',
  'deprecated',
  'reverted',
];

/** States at or above which a memory is presumed valid on every branch. */
const BRANCH_INDEPENDENT: ReadonlySet<MemoryLifecycle> = new Set([
  'merged',
  'deployed',
  'deprecated',
  'reverted',
]);

const TRANSITIONS: Record<MemoryLifecycle, readonly MemoryLifecycle[]> = {
  proposed: ['experimental', 'implemented', 'deprecated'],
  experimental: ['implemented', 'deprecated', 'reverted'],
  implemented: ['verified', 'merged', 'deprecated', 'reverted'],
  verified: ['merged', 'deprecated', 'reverted'],
  merged: ['deployed', 'deprecated', 'reverted'],
  deployed: ['deprecated', 'reverted'],
  deprecated: [],
  // A reverted decision can be re-proposed — the audit trail stays intact
  // because the transition is recorded on the same session.
  reverted: ['proposed'],
};

/** Ranking multiplier per state. Legacy (undefined) is 1. */
const WEIGHTS: Record<MemoryLifecycle, number> = {
  proposed: 0.8,
  experimental: 0.85,
  implemented: 0.95,
  verified: 1,
  merged: 1,
  deployed: 1,
  deprecated: 0.4,
  reverted: 0.3,
};

export function isLifecycleState(value: unknown): value is MemoryLifecycle {
  return typeof value === 'string' && (LIFECYCLE_STATES as readonly string[]).includes(value);
}

/** Whether `from → to` is an allowed lifecycle transition. Unset `from` may enter any state. */
export function canTransition(from: MemoryLifecycle | undefined, to: MemoryLifecycle): boolean {
  if (!isLifecycleState(to)) return false;
  if (from === undefined) return true;
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

/**
 * Apply a lifecycle transition to a session, enforcing the state machine.
 * Throws on an illegal transition so callers surface the reason verbatim.
 */
export function transitionLifecycle(
  session: CompressedSession,
  to: MemoryLifecycle,
): CompressedSession {
  if (!canTransition(session.lifecycle, to)) {
    throw new Error(
      `Illegal lifecycle transition ${session.lifecycle ?? '(unset)'} → ${to}; allowed: ${(session.lifecycle ? TRANSITIONS[session.lifecycle] : LIFECYCLE_STATES).join(', ') || '(none)'}`,
    );
  }
  session.lifecycle = to;
  return session;
}

/**
 * Branch validity: is this memory presumed valid on `currentBranch`?
 * - No lifecycle (legacy) → valid everywhere (pre-1.20 behavior).
 * - merged/deployed/deprecated/reverted → valid everywhere (weighting still applies).
 * - Otherwise → valid only on the branch it was captured on; a session with
 *   no recorded branch cannot be confined, so it stays valid.
 */
export function isBranchValid(session: CompressedSession, currentBranch?: string): boolean {
  if (!session.lifecycle) return true;
  if (BRANCH_INDEPENDENT.has(session.lifecycle)) return true;
  if (!session.branchName || !currentBranch) return true;
  return session.branchName === currentBranch;
}

export function lifecycleWeight(lifecycle?: MemoryLifecycle): number {
  return lifecycle ? WEIGHTS[lifecycle] : 1;
}

/**
 * Default lifecycle for a freshly captured session: work on a mainline branch
 * is `implemented` (it exists in the integration line); work on any other
 * branch is `experimental` until merged. No branch info → undefined (legacy
 * semantics), never a guess.
 */
export function defaultLifecycleForBranch(branch?: string): MemoryLifecycle | undefined {
  if (!branch) return undefined;
  return branch === 'main' || branch === 'master' ? 'implemented' : 'experimental';
}

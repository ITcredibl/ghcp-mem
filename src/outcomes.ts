/**
 * Outcome memory (v1.20.0) — record whether a remembered decision actually
 * worked, instead of only that it was made.
 *
 * Outcomes are append-only annotations on a session: the original decision
 * text is never rewritten, so the audit trail survives. The latest outcome
 * per target (a specific decision index, or the whole session) is the
 * operative one; `outcomeAdjustment` turns it into a bounded confidence
 * delta that display and context-compilation surfaces can apply.
 *
 * Pure module — no vscode imports. All free text is redacted before storage.
 */
import { redact } from './redactor';
import { parseAuthor, formatAuthor } from './memoryScope';
import { CompressedSession, MemoryOutcome } from './types';

export const OUTCOME_STATUSES = ['improved', 'regressed', 'neutral', 'unknown'] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

const MAX_OUTCOMES_PER_SESSION = 20;
const MAX_OBSERVATIONS = 10;
const MAX_OBSERVATION_CHARS = 300;

export interface OutcomeInput {
  status: unknown;
  decisionIndex?: unknown;
  observations?: unknown;
  reportedBy?: unknown;
}

function isStatus(value: unknown): value is OutcomeStatus {
  return typeof value === 'string' && (OUTCOME_STATUSES as readonly string[]).includes(value);
}

/** Validate, redact and append an outcome to a session (mutates in place). */
export function recordOutcome(
  session: CompressedSession,
  input: OutcomeInput,
  now = Date.now(),
): MemoryOutcome {
  if (!isStatus(input.status))
    throw new Error(`Outcome status must be one of ${OUTCOME_STATUSES.join(', ')}`);
  let decisionIndex: number | undefined;
  if (input.decisionIndex !== undefined) {
    if (
      typeof input.decisionIndex !== 'number' ||
      !Number.isSafeInteger(input.decisionIndex) ||
      input.decisionIndex < 0 ||
      input.decisionIndex >= session.decisions.length
    )
      throw new Error(
        `decisionIndex must reference one of the session's ${session.decisions.length} decision(s)`,
      );
    decisionIndex = input.decisionIndex;
  }
  const rawObservations = input.observations ?? [];
  if (!Array.isArray(rawObservations) || rawObservations.length > MAX_OBSERVATIONS)
    throw new Error(`observations must be an array of at most ${MAX_OBSERVATIONS} strings`);
  const observations = rawObservations.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || entry.length > MAX_OBSERVATION_CHARS)
      throw new Error(`Each observation must be 1–${MAX_OBSERVATION_CHARS} characters`);
    return redact(entry.trim(), { redactSecrets: true, honorPrivateTags: true }).text;
  });
  const outcome: MemoryOutcome = {
    status: input.status,
    observedAt: now,
    ...(decisionIndex !== undefined ? { decisionIndex } : {}),
    observations,
    ...(input.reportedBy !== undefined
      ? { reportedBy: formatAuthor(parseAuthor(input.reportedBy)) }
      : {}),
  };
  const outcomes = session.outcomes ?? [];
  if (outcomes.length >= MAX_OUTCOMES_PER_SESSION)
    throw new Error(`A session holds at most ${MAX_OUTCOMES_PER_SESSION} outcomes`);
  outcomes.push(outcome);
  session.outcomes = outcomes;
  return outcome;
}

/** The operative (latest) outcome per target: decision index, or -1 for whole-session. */
export function latestOutcomes(session: CompressedSession): Map<number, MemoryOutcome> {
  const latest = new Map<number, MemoryOutcome>();
  for (const outcome of session.outcomes ?? []) {
    const key = outcome.decisionIndex ?? -1;
    const current = latest.get(key);
    if (!current || outcome.observedAt >= current.observedAt) latest.set(key, outcome);
  }
  return latest;
}

/**
 * Bounded confidence delta from recorded outcomes, in [-0.3, +0.15].
 * Regressions weigh heavier than improvements on purpose: a memory that
 * demonstrably misled should sink faster than a confirmed one rises.
 */
export function outcomeAdjustment(session: CompressedSession): number {
  let delta = 0;
  for (const outcome of latestOutcomes(session).values()) {
    if (outcome.status === 'improved') delta += 0.05;
    else if (outcome.status === 'regressed') delta -= 0.15;
  }
  return Math.max(-0.3, Math.min(0.15, delta));
}

export interface OutcomeSummary {
  sessionsWithOutcomes: number;
  decisionsTotal: number;
  decisionsWithOutcomes: number;
  improved: number;
  regressed: number;
  neutral: number;
  unknown: number;
}

/** Aggregate outcome coverage across the store (used by agent evaluation). */
export function summarizeOutcomes(sessions: readonly CompressedSession[]): OutcomeSummary {
  const summary: OutcomeSummary = {
    sessionsWithOutcomes: 0,
    decisionsTotal: 0,
    decisionsWithOutcomes: 0,
    improved: 0,
    regressed: 0,
    neutral: 0,
    unknown: 0,
  };
  for (const session of sessions) {
    summary.decisionsTotal += session.decisions.length;
    const latest = latestOutcomes(session);
    if (latest.size > 0) summary.sessionsWithOutcomes++;
    for (const [key, outcome] of latest) {
      if (key >= 0) summary.decisionsWithOutcomes++;
      summary[outcome.status]++;
    }
  }
  return summary;
}

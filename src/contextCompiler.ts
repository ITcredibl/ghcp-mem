/**
 * Context compiler (v1.20.0) — "give me the optimal context for this task
 * within N tokens", not "give me memories".
 *
 * Takes the already-ranked raw material (project rules, consolidated lessons,
 * retrieved sessions) and compiles one bounded context block with an explicit
 * plan: what went in, why, at what estimated cost — and an omission receipt
 * for everything that did not fit. Whole items are included or omitted, never
 * split, so a session's decision is never quoted without its evidence line.
 *
 * Priority order is deliberate and fixed:
 *   1. project rules (mandatory — kept even if they alone exceed the budget)
 *   2. lessons (durable, cheapest-per-token knowledge)
 *   3. sessions, reordered by retrieval rank × lifecycle weight × outcome delta
 *
 * Pure module — no vscode imports, no model calls. Token counts are the
 * repo-standard UTF-8-bytes/4 estimate, not a provider-tokenizer guarantee.
 */
import { estimatedContextTokens } from './contextBudget';
import { lifecycleWeight, isBranchValid } from './lifecycle';
import { latestOutcomes, outcomeAdjustment } from './outcomes';
import { Lesson, rankLessons } from './lessons';
import { CompressedSession } from './types';

export interface CompileInput {
  /** The task or question the context is being compiled for. */
  query: string;
  /** Estimated token budget for the entire compiled block. */
  budgetTokens: number;
  /** Current branch, for lifecycle branch-validity filtering. */
  branch?: string;
  /** Mandatory team rules (always included, in order). */
  rules?: readonly string[];
  /** Consolidated lessons, any order (re-ranked here). */
  lessons?: readonly Lesson[];
  /** Candidate sessions in retrieval-rank order (best first). */
  sessions?: readonly CompressedSession[];
  /** Cap on lessons considered before budgeting (default 8). */
  maxLessons?: number;
}

export interface ContextPlanItem {
  kind: 'rule' | 'lesson' | 'session';
  id: string;
  estTokens: number;
  reason: string;
}

export interface CompiledContext {
  context: string;
  estTokens: number;
  plan: ContextPlanItem[];
  omitted: ContextPlanItem[];
  measurement: 'utf8-bytes/4-estimate';
}

function renderSessionBlock(session: CompressedSession): string {
  const lines = [
    `### [${session.observationType}] ${new Date(session.endTime).toISOString().slice(0, 10)} — ${session.id.slice(0, 8)}`,
    session.summary,
  ];
  if (session.lifecycle) lines.push(`Lifecycle: ${session.lifecycle}`);
  if (session.keyFiles.length) lines.push(`Files: ${session.keyFiles.slice(0, 6).join(', ')}`);
  if (session.decisions.length)
    lines.push(`Decisions: ${session.decisions.slice(0, 4).join(' | ')}`);
  for (const outcome of session.outcomes ?? []) {
    lines.push(
      `Outcome (${outcome.status}${outcome.decisionIndex !== undefined ? `, decision ${outcome.decisionIndex}` : ''}): ${outcome.observations.join('; ') || 'no observations recorded'}`,
    );
  }
  return lines.join('\n');
}

function sessionPriority(session: CompressedSession, retrievalRank: number): number {
  const base = 1 / (1 + retrievalRank);
  return base * lifecycleWeight(session.lifecycle) + outcomeAdjustment(session);
}

/** Compile a bounded context block from pre-retrieved material. */
export function compileContext(input: CompileInput): CompiledContext {
  if (
    typeof input.query !== 'string' ||
    !input.query.trim() ||
    !Number.isSafeInteger(input.budgetTokens) ||
    input.budgetTokens < 128 ||
    input.budgetTokens > 32000
  )
    throw new Error('compileContext requires a query and a budget between 128 and 32000 tokens');

  const plan: ContextPlanItem[] = [];
  const omitted: ContextPlanItem[] = [];
  const blocks: string[] = [];
  const header = `## Compiled context for: ${input.query.trim()}\n`;
  let estTokens = estimatedContextTokens(header);

  const consider = (
    item: Omit<ContextPlanItem, 'estTokens'>,
    text: string,
    mandatory = false,
  ): void => {
    const estimate = estimatedContextTokens(text) + 1;
    if (!mandatory && estTokens + estimate > input.budgetTokens) {
      omitted.push({ ...item, estTokens: estimate });
      return;
    }
    blocks.push(text);
    estTokens += estimate;
    plan.push({ ...item, estTokens: estimate });
  };

  for (const [index, rule] of (input.rules ?? []).entries()) {
    consider(
      { kind: 'rule', id: `rule-${index + 1}`, reason: 'mandatory project rule' },
      `RULE: ${rule}`,
      true,
    );
  }

  for (const lesson of rankLessons(input.lessons ?? []).slice(0, input.maxLessons ?? 8)) {
    consider(
      {
        kind: 'lesson',
        id: lesson.id,
        reason: `${lesson.kind} lesson, support ${lesson.supportCount}, confidence ${lesson.confidence.toFixed(2)}`,
      },
      `LESSON (${lesson.kind}): ${lesson.text}`,
    );
  }

  // A decision that demonstrably misled (latest outcome: regressed) sinks
  // below every clean candidate as a class — a small score delta is not
  // enough for evidence of failure.
  const regressed = (session: CompressedSession): number =>
    [...latestOutcomes(session).values()].some((outcome) => outcome.status === 'regressed') ? 1 : 0;
  const candidates = (input.sessions ?? [])
    .map((session, rank) => ({ session, rank, priority: sessionPriority(session, rank) }))
    .filter(({ session }) => {
      if (isBranchValid(session, input.branch)) return true;
      omitted.push({
        kind: 'session',
        id: session.id,
        estTokens: 0,
        reason: `lifecycle ${session.lifecycle} valid only on branch ${session.branchName}`,
      });
      return false;
    })
    .sort((a, b) => regressed(a.session) - regressed(b.session) || b.priority - a.priority);

  for (const { session, rank, priority } of candidates) {
    consider(
      {
        kind: 'session',
        id: session.id,
        reason: `retrieval rank ${rank + 1}, priority ${priority.toFixed(3)}`,
      },
      renderSessionBlock(session),
    );
  }

  return {
    context: header + blocks.join('\n\n'),
    estTokens,
    plan,
    omitted,
    measurement: 'utf8-bytes/4-estimate',
  };
}

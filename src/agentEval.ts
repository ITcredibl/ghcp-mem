/**
 * Agent-performance evaluation (v1.20.0) — measure what the store can
 * actually evidence about memory helping, and say plainly what it cannot.
 *
 * Grounded signals only:
 *   - outcome coverage: how many remembered decisions have recorded results,
 *     and how those results split (improved / regressed / neutral / unknown)
 *   - reinforcement: explicit /accept vs /reject marks on retrieved memories
 *   - grounding: decisions carrying evidence citations
 *   - lifecycle hygiene: how much of the store is merged/verified vs speculative
 *
 * None of this establishes live-model causality — the report states that in
 * its own output rather than implying it.
 *
 * Pure module — no vscode imports.
 */
import { summarizeOutcomes, OutcomeSummary } from './outcomes';
import { CompressedSession } from './types';

export interface AgentEvalReport {
  sessions: number;
  outcomes: OutcomeSummary;
  reinforcement: { retrieved: number; accepted: number; rejected: number };
  grounding: { decisions: number; decisionsWithEvidence: number };
  lifecycle: Record<string, number>;
}

export function evaluateMemoryEffectiveness(
  sessions: readonly CompressedSession[],
): AgentEvalReport {
  const active = sessions.filter((session) => !session.retracted);
  const reinforcement = { retrieved: 0, accepted: 0, rejected: 0 };
  const grounding = { decisions: 0, decisionsWithEvidence: 0 };
  const lifecycle: Record<string, number> = {};
  for (const session of active) {
    reinforcement.retrieved += session.usage?.retrieved ?? 0;
    reinforcement.accepted += session.usage?.accepted ?? 0;
    reinforcement.rejected += session.usage?.rejected ?? 0;
    grounding.decisions += session.decisions.length;
    grounding.decisionsWithEvidence += (session.decisionEvidence ?? []).filter(
      (evidence) => Array.isArray(evidence) && evidence.length > 0,
    ).length;
    const state = session.lifecycle ?? 'unset';
    lifecycle[state] = (lifecycle[state] ?? 0) + 1;
  }
  return {
    sessions: active.length,
    outcomes: summarizeOutcomes(active),
    reinforcement,
    grounding,
    lifecycle,
  };
}

function pct(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${Math.round((part / whole) * 100)}%`;
}

export function formatAgentEvalReport(report: AgentEvalReport): string {
  const o = report.outcomes;
  const r = report.reinforcement;
  const g = report.grounding;
  const lines = [
    '# Memory effectiveness report',
    '',
    `Store: ${report.sessions} active session(s).`,
    '',
    '## Outcome coverage',
    `- decisions with a recorded outcome: ${o.decisionsWithOutcomes}/${o.decisionsTotal} (${pct(o.decisionsWithOutcomes, o.decisionsTotal)})`,
    `- results: ${o.improved} improved, ${o.regressed} regressed, ${o.neutral} neutral, ${o.unknown} unknown`,
    '',
    '## Reinforcement (explicit /accept and /reject marks)',
    `- retrievals: ${r.retrieved}; accepted: ${r.accepted}; rejected: ${r.rejected}` +
      (r.accepted + r.rejected > 0
        ? ` (acceptance ${pct(r.accepted, r.accepted + r.rejected)})`
        : ''),
    '',
    '## Grounding',
    `- decisions citing captured evidence: ${g.decisionsWithEvidence}/${g.decisions} (${pct(g.decisionsWithEvidence, g.decisions)})`,
    '',
    '## Lifecycle distribution',
    ...Object.entries(report.lifecycle)
      .sort(([, a], [, b]) => b - a)
      .map(([state, count]) => `- ${state}: ${count}`),
    '',
    '_These are store-observable signals. They do not establish that memory improved live model outcomes; that requires matched runs with provider usage data (see `npm run measure:savings`)._',
  ];
  return lines.join('\n');
}

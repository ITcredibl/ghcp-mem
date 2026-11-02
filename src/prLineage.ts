/**
 * PR / issue lineage (v1.20.0) — issue → PR → merge → sessions, derived
 * entirely from local git history and stored memory. Local-first: no GitHub
 * API calls, no tokens. Callers run git themselves (the same pattern as
 * gitHistorySeeder) and hand the output to the pure parsers here.
 *
 * Pure module — no vscode imports, no child processes.
 */
import { CompressedSession } from './types';

/** Extract referenced PR/issue numbers from free text ("PR #481", "#443"). */
export function parsePrRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(/(?:^|[\s(])#(\d{1,6})\b|\bPR\s*#?(\d{1,6})\b/gi)) {
    refs.add(match[1] ?? match[2]);
  }
  return [...refs];
}

/** git arguments for the lineage pass — merge commits only, machine-separable. */
export function gitLineageLogArgs(maxCommits = 200): string[] {
  const bounded = Math.max(1, Math.min(2000, Math.floor(maxCommits)));
  return [
    'log',
    '--merges',
    '-n',
    String(bounded),
    '--date=unix',
    '--pretty=format:%H%x1f%ad%x1f%s%x1f%b%x1e',
  ];
}

export interface MergeRecord {
  commit: string;
  mergedAt: number;
  subject: string;
  /** PR number when the merge subject follows the GitHub convention. */
  prNumber?: string;
  /** Source branch from "Merge pull request #N from owner/branch". */
  sourceBranch?: string;
  /** Issues closed via Fixes/Closes/Resolves trailers in the body. */
  issues: string[];
}

export function parseLineageLog(stdout: string): MergeRecord[] {
  const records: MergeRecord[] = [];
  for (const chunk of stdout.split('\x1e')) {
    const [commit, date, subject = '', body = ''] = chunk.trim().split('\x1f');
    if (!commit || !/^[a-f0-9]{7,64}$/i.test(commit)) continue;
    const mergedAt = Number(date) * 1000;
    if (!Number.isFinite(mergedAt) || mergedAt <= 0) continue;
    const gh = /^Merge pull request #(\d{1,6}) from (\S+)/.exec(subject);
    const issues = new Set<string>();
    for (const match of (subject + '\n' + body).matchAll(
      /\b(?:fixes|closes|resolves)\s+#(\d{1,6})\b/gi,
    )) {
      issues.add(match[1]);
    }
    records.push({
      commit,
      mergedAt,
      subject: subject.slice(0, 200),
      ...(gh ? { prNumber: gh[1], sourceBranch: gh[2].replace(/^[^/]+\//, '') } : {}),
      issues: [...issues],
    });
  }
  return records;
}

export interface LineageChain {
  prNumber: string;
  issues: string[];
  commit: string;
  mergedAt: number;
  subject: string;
  sourceBranch?: string;
  /** Session ids linked by branch name or an explicit PR reference. */
  sessionIds: string[];
}

/** Join merge records with stored sessions into issue → PR → sessions chains. */
export function linkSessionsToLineage(
  sessions: readonly CompressedSession[],
  records: readonly MergeRecord[],
): LineageChain[] {
  const chains: LineageChain[] = [];
  for (const record of records) {
    if (!record.prNumber) continue;
    const sessionIds = sessions
      .filter((session) => {
        if (record.sourceBranch && session.branchName === record.sourceBranch) return true;
        return parsePrRefs(`${session.summary} ${session.decisions.join(' ')}`).includes(
          record.prNumber as string,
        );
      })
      .map((session) => session.id);
    chains.push({
      prNumber: record.prNumber,
      issues: record.issues,
      commit: record.commit,
      mergedAt: record.mergedAt,
      subject: record.subject,
      ...(record.sourceBranch ? { sourceBranch: record.sourceBranch } : {}),
      sessionIds,
    });
  }
  return chains.sort((a, b) => b.mergedAt - a.mergedAt);
}

export function renderLineage(chains: readonly LineageChain[]): string {
  if (!chains.length) return '_No PR lineage found in the local merge history._';
  const lines: string[] = ['# PR lineage (local git history)', ''];
  for (const chain of chains) {
    lines.push(
      `## PR #${chain.prNumber} — ${chain.subject}`,
      `- merged: ${new Date(chain.mergedAt).toISOString()} (\`${chain.commit.slice(0, 10)}\`)`,
    );
    if (chain.sourceBranch) lines.push(`- branch: ${chain.sourceBranch}`);
    if (chain.issues.length) lines.push(`- closes: ${chain.issues.map((i) => `#${i}`).join(', ')}`);
    lines.push(
      chain.sessionIds.length
        ? `- sessions: ${chain.sessionIds.map((id) => id.slice(0, 8)).join(', ')}`
        : '- sessions: none linked',
      '',
    );
  }
  return lines.join('\n');
}

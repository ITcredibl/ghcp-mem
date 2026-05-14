import { CompressedSession } from './types';

/**
 * Diff-friendly markdown export for a single session.
 *
 * Goals (rebase recommendation #6):
 * - Stable, deterministic output (sorted arrays, ISO timestamps) so two exports
 *   of the same session produce byte-identical markdown.
 * - One field per line where possible — minimizes noisy diff hunks when a
 *   session is updated incrementally.
 * - Pure function: no I/O, no clock reads, no `Date.now()` — only data from
 *   the session itself.
 */
export function exportSessionMarkdown(s: CompressedSession): string {
  const lines: string[] = [];
  lines.push(`# Session ${s.id}`);
  lines.push('');
  lines.push(`- type: ${s.observationType}`);
  lines.push(`- start: ${new Date(s.startTime).toISOString()}`);
  lines.push(`- end: ${new Date(s.endTime).toISOString()}`);
  lines.push(`- workspace: ${s.workspaceName || s.workspaceId || '(none)'}`);
  if (s.repoScopeLabel) lines.push(`- repo: ${s.repoScopeLabel}`);
  if (s.repoScope) lines.push(`- repoScope: ${s.repoScope}`);
  lines.push(`- redactions: ${s.redactionCount ?? 0}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(s.summary.trim());
  lines.push('');

  const sections: Array<[string, string[] | undefined]> = [
    ['Key Files', s.keyFiles],
    ['Key Topics', s.keyTopics],
    ['Decisions', s.decisions],
    ['Problems Solved', s.problemsSolved],
    ['User Tags', s.userTags],
  ];
  for (const [title, arr] of sections) {
    if (!arr || arr.length === 0) continue;
    lines.push(`## ${title}`);
    lines.push('');
    // Sort copy for stable output (compare-friendly).
    for (const item of [...arr].sort()) lines.push(`- ${item}`);
    lines.push('');
  }

  if (s.azureContext) {
    lines.push('## Azure Context');
    lines.push('');
    const az = s.azureContext;
    if (az.subscriptionName) lines.push(`- subscription: ${az.subscriptionName}`);
    else if (az.subscriptionId) lines.push(`- subscriptionId: ${az.subscriptionId}`);
    if (az.tenantId) lines.push(`- tenantId: ${az.tenantId}`);
    if (az.resourceGroup) lines.push(`- resourceGroup: ${az.resourceGroup}`);
    if (az.defaultLocation) lines.push(`- location: ${az.defaultLocation}`);
    if (az.subsystems && az.subsystems.length > 0) {
      lines.push(`- subsystems: ${[...az.subsystems].sort().join(', ')}`);
    }
    if (az.resourceIds && az.resourceIds.length > 0) {
      lines.push('');
      lines.push('### Resource IDs');
      for (const r of [...az.resourceIds].sort()) lines.push(`- ${r}`);
    }
    if (az.notes) {
      lines.push('');
      lines.push(`> ${az.notes.replace(/\n/g, ' ').trim()}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Export multiple sessions, sorted by start time (oldest first) for stable diffs. */
export function exportSessionsMarkdown(sessions: CompressedSession[]): string {
  const sorted = [...sessions].sort((a, b) => a.startTime - b.startTime);
  return sorted.map(exportSessionMarkdown).join('\n\n---\n\n');
}
